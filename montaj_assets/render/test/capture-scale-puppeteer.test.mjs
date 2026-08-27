// render/test/capture-scale-puppeteer.test.mjs
//
// Plan verification item 4 (2026-08-26 overlay-color-quality): prove that
// Chrome, wired exactly the way renderChunk wires it, HONOURS a fractional
// deviceScaleFactor — i.e. that a 1440p project's captureScale of 4/3 comes
// back as a screenshot buffer on the output's own pixel grid (2560×1440), not
// rounded, floored, or silently clamped to an integer scale.
//
// This is the one claim in the plan that unit tests structurally cannot reach:
// captureScaleFor() returning 4/3 proves the arithmetic, but says nothing
// about what Chrome does with a non-integer value. If Chrome quantised it,
// the capture would stop matching the output and the compose scale would stop
// being an identity — quietly, behind a green unit suite. So this test drives
// a real Puppeteer session and measures the actual pixels that come back.
//
// The deviceScaleFactor is deliberately derived through the REAL
// captureScaleFor (render.js) rather than hardcoded, so this test also
// discriminates against the shipped formula: reverting captureScaleFor to the
// old unconditional 2, or rounding its ratio, changes the buffer dimensions
// and fails the assertions below.
//
// Kept in sync by hand with renderChunk (renderer.js): launch args match
// launchBrowser(), and the capture is a full-viewport page.screenshot(), which
// is exactly how frames are captured there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer'
import { captureScaleFor } from '../render.js'

// Parse actual pixel dimensions out of a PNG buffer's IHDR chunk.
// Signature check first so a non-PNG failure reads as what it is rather than
// as a bizarre dimension mismatch.
function pngDimensions(buf) {
  const b = Buffer.from(buf)
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < sig.length; i++) {
    if (b[i] !== sig[i]) throw new Error('screenshot is not a PNG')
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// Each case: a project settings.resolution, the design canvas renderChunk
// would be handed for it (1080 short edge at the output's aspect), and the
// screenshot dimensions Chrome must return for the compose scale to be an
// identity. The fractional case is the point of the file; the integer case
// proves the harness measures rather than that nothing threw.
const CASES = [
  {
    label: '1440p landscape → fractional 4/3 honoured exactly',
    resolution: [2560, 1440],
    viewport: { width: 1920, height: 1080 },
    expectedScale: 4 / 3,
    expectedPixels: { width: 2560, height: 1440 },
  },
  {
    label: '4K portrait → integer 2 (the pre-existing identity case)',
    resolution: [2160, 3840],
    viewport: { width: 1080, height: 1920 },
    expectedScale: 2,
    expectedPixels: { width: 2160, height: 3840 },
  },
]

test('Chrome honours captureScaleFor deviceScaleFactor exactly (plan item 4)', { timeout: 120_000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'montaj-capture-scale-test-'))
  // Minimal opaque page, loaded over file:// like a real bundled overlay. The
  // content is irrelevant to the dimension contract; the background makes an
  // accidentally-blank capture visible if this ever needs debugging.
  const htmlPath = join(workDir, 'index.html')
  writeFileSync(htmlPath, '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;width:100%;height:100%;background:#123456}</style>'
    + '</head><body></body></html>')

  // Same args as launchBrowser() in renderer.js — kept in sync by hand.
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--allow-file-access-from-files'],
    protocolTimeout: 300000,
  })

  try {
    for (const c of CASES) {
      const scale = captureScaleFor(c.resolution)
      // Guard the input before measuring Chrome with it, so a formula
      // regression reads as "formula changed", not as a Chrome mystery.
      // Tolerance-free where exact, epsilon only for the irrational-free but
      // non-representable 4/3.
      assert.ok(
        Math.abs(scale - c.expectedScale) < 1e-12,
        `${c.label}: captureScaleFor(${JSON.stringify(c.resolution)}) should be ${c.expectedScale}, got ${scale}`
      )

      const page = await browser.newPage()
      try {
        // The renderChunk wiring under test: CSS viewport at design size,
        // device pixels at captureScale.
        await page.setViewport({ width: c.viewport.width, height: c.viewport.height, deviceScaleFactor: scale })
        await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })

        // Half of the supersampling contract: the CSS coordinate space must
        // stay at design size regardless of deviceScaleFactor, or overlay JSX
        // would lay out differently per output resolution.
        const cssSize = await page.evaluate(() => [window.innerWidth, window.innerHeight])
        assert.deepEqual(
          cssSize, [c.viewport.width, c.viewport.height],
          `${c.label}: CSS viewport must stay at design size under dsf ${scale}, got ${cssSize}`
        )

        // The other half, and the reason this file exists: the capture buffer
        // must land on the OUTPUT's pixel grid, exactly.
        const shot = await page.screenshot({ omitBackground: false })
        const dims = pngDimensions(shot)
        assert.deepEqual(
          dims, c.expectedPixels,
          `${c.label}: screenshot must be ${c.expectedPixels.width}×${c.expectedPixels.height} `
          + `(viewport ${c.viewport.width}×${c.viewport.height} at dsf ${scale}), got ${dims.width}×${dims.height} — `
          + `Chrome did not honour the deviceScaleFactor exactly, so the compose scale is not an identity`
        )
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

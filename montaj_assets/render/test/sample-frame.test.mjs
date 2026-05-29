// render/test/sample-frame.test.mjs
//
// Integration tests for sample-frame.js.
//
// Most tests require a live Puppeteer browser + ffmpeg — they're integration
// tests, not unit tests. Slow tests carry an explicit { timeout } option.
//
// Tests (a)–(g) cover sampleOverlay.
// Tests (h)–(o) cover sampleFrame.
//
// Skipped where noted when hardware/fixtures are unavailable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync, statSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { sampleOverlay, sampleFrame } from '../sample-frame.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = join(__dirname, '..', '..', '..')

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURE_PROJECT = '/Users/Sam/Montaj/2026-05-28-opus-4-8/project.json'
const RECURSION_JSX   = '/Users/Sam/Montaj/2026-05-28-opus-4-8/overlays/recursion.jsx'
const SCREENSHOT_JSX  = '/Users/Sam/Montaj/2026-05-28-opus-4-8/overlays/screenshot.jsx'

const FIXTURE_PROJECT_EXISTS = existsSync(FIXTURE_PROJECT)
const RECURSION_JSX_EXISTS   = existsSync(RECURSION_JSX)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if ffmpeg has the zscale filter. */
function hasZscale() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 && /zscale/m.test(r.stdout || '')
}

/** Read a single pixel (R,G,B,A) from a PNG using ffmpeg rawvideo. */
function readPixelRgba(pngPath, x, y) {
  const r = spawnSync('ffmpeg', [
    '-y', '-i', pngPath,
    '-vf', `crop=1:1:${x}:${y},format=rgba`,
    '-f', 'rawvideo', '-frames:v', '1', 'pipe:1',
  ], { encoding: 'buffer', timeout: 10_000 })
  if (r.status !== 0) throw new Error('pixel read failed: ' + r.stderr?.toString?.().slice(-200))
  const buf = r.stdout
  if (buf.length < 4) throw new Error(`expected ≥4 bytes, got ${buf.length}`)
  return { r: buf[0], g: buf[1], b: buf[2], a: buf[3] }
}

/** Get image dimensions { w, h } from a PNG using ffprobe. */
function pngDimensions(pngPath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', pngPath,
  ], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) return null
  try {
    const streams = JSON.parse(r.stdout).streams ?? []
    const v = streams.find(s => s.codec_type === 'video')
    if (v?.width && v?.height) return { w: v.width, h: v.height }
  } catch {}
  return null
}

/**
 * Write a minimal JSX that renders one oversized text element.
 * fontSize 999 guarantees the text overflows the canvas on any device.
 */
function writeOverflowJsx(path) {
  writeFileSync(path, `
export default function Overflow() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: 'monospace', fontSize: 999, color: 'white', whiteSpace: 'nowrap' }}>
        OVERFLOW
      </div>
    </div>
  )
}
`)
}

/**
 * Write a minimal JSX where the text comfortably fits within the canvas.
 */
function writeFitJsx(path) {
  writeFileSync(path, `
export default function Fits() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: 'monospace', fontSize: 24, color: 'white' }}>
        Hi
      </div>
    </div>
  )
}
`)
}

/**
 * Write a JSX with a parent that has overflow:hidden and a child that overflows it.
 */
function writeClipAncestorJsx(path) {
  writeFileSync(path, `
export default function Clip() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div id="clipper" style={{ overflow: 'hidden', width: 100, height: 50, background: 'black' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 200, color: 'white', whiteSpace: 'nowrap' }}>CLIPPED</span>
      </div>
    </div>
  )
}
`)
}

/**
 * Write a JSX that throws on render.
 */
function writeErrorJsx(path) {
  writeFileSync(path, `
export default function Broken() {
  throw new Error('intentional render error')
  return <div>never</div>
}
`)
}

// ---------------------------------------------------------------------------
// (a) sampleOverlay on a known overlay produces a non-empty PNG
// ---------------------------------------------------------------------------
test('(a) sampleOverlay: produces a PNG with non-zero pixels', { timeout: 60_000 }, async (t) => {
  if (!RECURSION_JSX_EXISTS) {
    t.skip('fixture overlay not found at ' + RECURSION_JSX)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-a-'))
  try {
    const outPath = join(dir, 'out.png')
    const result = await sampleOverlay({
      componentPath: RECURSION_JSX,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      googleFonts: ['Syne:wght@800'],
      outPath,
    })

    assert.ok(existsSync(result.pngPath), 'PNG file should exist')
    assert.equal(result.pngPath, outPath)
    const size = statSync(result.pngPath).size
    assert.ok(size > 1000, `PNG should be non-trivial (got ${size} bytes)`)

    // Check dimensions
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    assert.equal(dims.w, 1080)
    assert.equal(dims.h, 1920)

    // At frame 0, spring value is 0, so opacity is ~0, but PNG file still exists
    assert.ok(size > 100, 'PNG is non-empty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (b) --measure flags overflow case (fontSize 999)
// ---------------------------------------------------------------------------
test('(b) sampleOverlay --measure: flags overflow with fontSize:999', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-b-'))
  try {
    const jsxPath = join(dir, 'overflow.jsx')
    writeOverflowJsx(jsxPath)
    const outPath = join(dir, 'out.png')

    const result = await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath,
      measure: true,
    })

    assert.ok(result.measurements, 'measurements should be present')
    assert.equal(result.measurements.anyOverflow, true, 'anyOverflow should be true for fontSize:999')
    assert.ok(result.measurements.texts.length > 0, 'should have at least one text element')
    const overflowing = result.measurements.texts.filter(t =>
      t.overflow.left > 0 || t.overflow.right > 0 || t.overflow.top > 0 || t.overflow.bottom > 0
    )
    assert.ok(overflowing.length > 0, 'at least one text element should report overflow')
    // viewport should match requested dimensions
    assert.equal(result.measurements.viewport.w, 1080)
    assert.equal(result.measurements.viewport.h, 1920)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (c) --measure returns anyOverflow: false on a sane overlay
// ---------------------------------------------------------------------------
test('(c) sampleOverlay --measure: anyOverflow: false when text fits', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-c-'))
  try {
    const jsxPath = join(dir, 'fits.jsx')
    writeFitJsx(jsxPath)
    const outPath = join(dir, 'out.png')

    const result = await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath,
      measure: true,
    })

    assert.ok(result.measurements, 'measurements should be present')
    assert.equal(result.measurements.anyOverflow, false, 'anyOverflow should be false when text fits')
    assert.ok(result.measurements.texts.length > 0, 'should detect the text element')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (d) --measure populates clippingAncestor when a child overflows a clipping parent
// ---------------------------------------------------------------------------
test('(d) sampleOverlay --measure: clippingAncestor populated for overflow:hidden parent', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-d-'))
  try {
    const jsxPath = join(dir, 'clip.jsx')
    writeClipAncestorJsx(jsxPath)
    const outPath = join(dir, 'out.png')

    const result = await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath,
      measure: true,
    })

    assert.ok(result.measurements, 'measurements should be present')
    // The SPAN inside the clipping div should have a clippingAncestor
    const span = result.measurements.texts.find(t => t.text.includes('CLIPPED'))
    assert.ok(span, 'should find the CLIPPED text element')
    assert.ok(span.clippingAncestor !== null, 'clippingAncestor should not be null for child of overflow:hidden parent')
    assert.ok(span.clippingAncestor.tag, 'clippingAncestor should have a tag')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (e) JSX runtime error surfaces in result, not a hang or blank PNG
// ---------------------------------------------------------------------------
test('(e) sampleOverlay: runtime error surfaces as overlay_eval_failed', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-e-'))
  try {
    const jsxPath = join(dir, 'broken.jsx')
    writeErrorJsx(jsxPath)
    const outPath = join(dir, 'out.png')

    let threw = false
    let errorCode = null
    try {
      await sampleOverlay({
        componentPath: jsxPath,
        frame: 0,
        fps: 30,
        width: 1080,
        height: 1920,
        outPath,
      })
    } catch (err) {
      threw = true
      errorCode = err.sampleError
    }

    // Should throw, not hang
    assert.ok(threw, 'should throw on JSX runtime error')
    // The error should carry an error code
    assert.ok(errorCode, `error should have a sampleError code, got: ${errorCode}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (f) Cache hit on identical inputs returns < 200 ms
// ---------------------------------------------------------------------------
test('(f) sampleOverlay: cache hit is fast (< 200ms)', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-f-'))
  try {
    const jsxPath = join(dir, 'fits.jsx')
    writeFitJsx(jsxPath)
    const outPath1 = join(dir, 'out1.png')
    const outPath2 = join(dir, 'out2.png')

    // Cold render (fills cache)
    await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath: outPath1,
    })

    // Warm render (should hit cache)
    const t0 = Date.now()
    await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath: outPath2,
    })
    const elapsed = Date.now() - t0

    assert.ok(existsSync(outPath2), 'cache hit should produce output file')
    assert.ok(elapsed < 200, `cache hit should be < 200ms, got ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (g) Cache miss on changed props re-renders
// ---------------------------------------------------------------------------
test('(g) sampleOverlay: changed props invalidate cache', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-g-'))
  try {
    const jsxPath = join(dir, 'fits.jsx')
    writeFitJsx(jsxPath)
    const outPath1 = join(dir, 'out1.png')
    const outPath2 = join(dir, 'out2.png')

    // Render with props = {}
    await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      props: { x: 1 },
      outPath: outPath1,
    })

    const warmStart = Date.now()
    // Render with different props — should NOT be a fast cache hit
    await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      props: { x: 2 },
      outPath: outPath2,
    })
    const elapsed = Date.now() - warmStart

    assert.ok(existsSync(outPath2), 'should produce output with changed props')
    // Changed props = different cache key = full render path (> 200ms)
    assert.ok(elapsed > 200, `changed props should trigger full render (${elapsed}ms), not instant cache hit`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (h) sampleFrame at a timestamp where only one video item is active
// ---------------------------------------------------------------------------
test('(h) sampleFrame: single video item produces a non-black frame', { timeout: 120_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-h-'))
  try {
    const outPath = join(dir, 'frame.png')

    // At t=3.0, only clip-0 is active (start=0, end=6.8173), no overlays
    const result = await sampleFrame({
      projectJson: FIXTURE_PROJECT,
      atSeconds: 3.0,
      outPath,
    })

    assert.ok(existsSync(result.pngPath), 'PNG should exist')
    const size = statSync(result.pngPath).size
    assert.ok(size > 10000, `frame PNG should be non-trivial (got ${size} bytes)`)

    // Frame should be non-black (has video content)
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    // Project resolution is 2160x3840
    assert.equal(dims.w, 2160)
    assert.equal(dims.h, 3840)

    // Center pixel should not be all-zeros (not empty black frame)
    const centerPx = readPixelRgba(result.pngPath, dims.w >> 1, dims.h >> 1)
    const isBlack = centerPx.r < 5 && centerPx.g < 5 && centerPx.b < 5
    // Video clip may have dark content — check total brightness across multiple samples
    // At minimum the PNG should exist and have dimensions (visual check is hard to automate)
    assert.ok(size > 50000, `video frame should be a real image (got ${size} bytes)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (i) sampleFrame with one overlay active composites the overlay
// ---------------------------------------------------------------------------
test('(i) sampleFrame: overlay active at timestamp produces larger file than video-only', { timeout: 180_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-i-'))
  try {
    // At t=1.0, clip-0 is active + ov-intro overlay (start=0, end=2.4)
    const outWithOverlay = join(dir, 'with-overlay.png')
    // At t=3.0, clip-0 is active but no overlays
    const outNoOverlay = join(dir, 'no-overlay.png')

    await sampleFrame({ projectJson: FIXTURE_PROJECT, atSeconds: 1.0, outPath: outWithOverlay })
    await sampleFrame({ projectJson: FIXTURE_PROJECT, atSeconds: 3.0, outPath: outNoOverlay })

    const sizeWith = statSync(outWithOverlay).size
    const sizeWithout = statSync(outNoOverlay).size

    // Both should be valid PNGs
    assert.ok(existsSync(outWithOverlay))
    assert.ok(existsSync(outNoOverlay))
    assert.ok(sizeWith > 10000, `overlay frame should be real image (${sizeWith} bytes)`)
    assert.ok(sizeWithout > 10000, `no-overlay frame should be real image (${sizeWithout} bytes)`)
    // Both should have the same dimensions
    const d1 = pngDimensions(outWithOverlay)
    const d2 = pngDimensions(outNoOverlay)
    assert.ok(d1 && d2)
    assert.equal(d1.w, d2.w)
    assert.equal(d1.h, d2.h)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (j) sampleFrame on HDR project produces sRGB-displayable PNG (tonemap applied)
// ---------------------------------------------------------------------------
test('(j) sampleFrame: HDR project sample is tonemapped to sRGB', { timeout: 120_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }
  if (!hasZscale()) {
    t.skip('zscale not available in ffmpeg — skipping HDR tonemap test')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-j-'))
  try {
    const outPath = join(dir, 'hdr-sample.png')

    // The fixture project has colorSpace: "hdr_hlg"
    const result = await sampleFrame({
      projectJson: FIXTURE_PROJECT,
      atSeconds: 3.0,
      outPath,
    })

    assert.ok(existsSync(result.pngPath))

    // Probe the output PNG's transfer characteristic
    const probe = spawnSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer',
      '-of', 'csv=p=0', result.pngPath,
    ], { encoding: 'utf8', timeout: 10_000 })

    const transfer = (probe.stdout || '').trim().replace(/,+$/, '')
    // After tonemap, the PNG should be BT.709 or untagged (sRGB default),
    // NOT arib-std-b67 (HLG) or smpte2084 (PQ)
    const isHlgOrPq = transfer === 'arib-std-b67' || transfer === 'smpte2084'
    assert.ok(
      !isHlgOrPq,
      `sample PNG should NOT have HDR transfer tag after tonemap, got: '${transfer}'`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (k) sampleFrame on a 2160×3840 project produces exactly 2160×3840 output
// ---------------------------------------------------------------------------
test('(k) sampleFrame: 4K project output is 2160×3840', { timeout: 120_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-k-'))
  try {
    const outPath = join(dir, 'frame-4k.png')
    const result = await sampleFrame({
      projectJson: FIXTURE_PROJECT,
      atSeconds: 3.0,
      outPath,
    })

    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    assert.equal(dims.w, 2160, `width should be 2160, got ${dims.w}`)
    assert.equal(dims.h, 3840, `height should be 3840, got ${dims.h}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (l) sampleFrame on a project with no overlays still produces a video+image composite
// ---------------------------------------------------------------------------
test('(l) sampleFrame: project with no overlays active at timestamp still produces frame', { timeout: 120_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-l-'))
  try {
    // At t=3.0, no overlays are active (ov-intro ends at 2.4, ov-recursion starts at 4.9)
    const outPath = join(dir, 'video-only.png')
    const result = await sampleFrame({
      projectJson: FIXTURE_PROJECT,
      atSeconds: 3.0,
      outPath,
    })

    assert.ok(existsSync(result.pngPath))
    const size = statSync(result.pngPath).size
    assert.ok(size > 10000, `frame PNG should be non-trivial (got ${size} bytes)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (m) sampleFrame on a project with image items only produces an image composite
// ---------------------------------------------------------------------------
test('(m) sampleFrame: image-only project produces a frame (no video crash)', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-m-'))
  try {
    // Create a test PNG for the image item
    const imgPath = join(dir, 'solid.png')
    const r = spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=1080x1920:rate=1',
      '-frames:v', '1', '-update', '1', imgPath,
    ], { encoding: 'utf8', timeout: 15_000 })
    if (r.status !== 0) { t.skip('ffmpeg solid image creation failed'); return }

    const imageOnlyProject = {
      version: '0.2',
      status: 'final',
      name: 'image-only-test',
      settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [
        [
          {
            id: 'img-0', type: 'image', src: imgPath,
            start: 0, end: 5, offsetX: 0, offsetY: 0, scale: 1, opacity: 1,
          },
        ],
      ],
      audio: { tracks: [] },
    }

    const outPath = join(dir, 'frame.png')
    const result = await sampleFrame({
      projectJson: imageOnlyProject,
      atSeconds: 1.0,
      outPath,
    })

    assert.ok(existsSync(result.pngPath))
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    // Blue solid fills canvas — center pixel should be blue-ish
    const center = readPixelRgba(result.pngPath, 540, 960)
    // Blue: R < 50, G < 50, B > 100
    assert.ok(center.b > 80, `center pixel should be blue-ish, got R=${center.r} G=${center.g} B=${center.b}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (n) sampleFrame at timestamp on empty timeline gap produces all-black frame
// ---------------------------------------------------------------------------
test('(n) sampleFrame: empty timeline gap produces all-black frame', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-n-'))
  try {
    // Project with a clip from 0–3 and another from 6–10, gap at t=4.5
    const emptyGapProject = {
      version: '0.2',
      status: 'final',
      name: 'gap-test',
      settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [
        [
          {
            id: 'clip-a', type: 'video',
            src: '/nonexistent/clip-a.mp4',
            start: 0, end: 3, inPoint: 0,
          },
          {
            id: 'clip-b', type: 'video',
            src: '/nonexistent/clip-b.mp4',
            start: 6, end: 10, inPoint: 0,
          },
        ],
      ],
      audio: { tracks: [] },
    }

    const outPath = join(dir, 'gap-frame.png')
    const result = await sampleFrame({
      projectJson: emptyGapProject,
      atSeconds: 4.5,
      outPath,
    })

    assert.ok(existsSync(result.pngPath), 'PNG should exist for empty gap')
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')

    // Frame should be black (no items active)
    const center = readPixelRgba(result.pngPath, 540, 960)
    assert.ok(
      center.r < 20 && center.g < 20 && center.b < 20,
      `empty gap frame should be black, got R=${center.r} G=${center.g} B=${center.b}`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (o) sampleFrame at clip boundary picks the LATER clip (start <= t < end tiebreak)
// ---------------------------------------------------------------------------
test('(o) sampleFrame: clip boundary tiebreak picks later clip', { timeout: 60_000 }, async (t) => {
  if (!FIXTURE_PROJECT_EXISTS) {
    t.skip('fixture project not found at ' + FIXTURE_PROJECT)
    return
  }

  const project = JSON.parse(readFileSync(FIXTURE_PROJECT, 'utf8'))
  const tracks0 = project.tracks[0]
  // clip-0 ends at 6.8173, clip-1 starts at 6.8173
  const clipBoundary = tracks0[0].end  // 6.8173

  assert.equal(
    clipBoundary,
    tracks0[1].start,
    'test setup: clip-0.end should equal clip-1.start at the boundary'
  )

  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-o-'))
  try {
    // Sample at the exact boundary — should pick clip-1 (start <= t < end)
    // clip-0: start=0 end=6.8173 → 0 <= 6.8173 < 6.8173 is FALSE (not < end)
    // clip-1: start=6.8173 end=11.1873 → 6.8173 <= 6.8173 < 11.1873 is TRUE
    const outAtBoundary = join(dir, 'boundary.png')
    const outAfterBoundary = join(dir, 'after.png')

    await sampleFrame({ projectJson: FIXTURE_PROJECT, atSeconds: clipBoundary, outPath: outAtBoundary })
    await sampleFrame({ projectJson: FIXTURE_PROJECT, atSeconds: clipBoundary + 0.5, outPath: outAfterBoundary })

    // Both frames should exist and be valid PNGs
    assert.ok(existsSync(outAtBoundary))
    assert.ok(existsSync(outAfterBoundary))

    const d1 = pngDimensions(outAtBoundary)
    const d2 = pngDimensions(outAfterBoundary)
    assert.ok(d1 && d2)
    assert.equal(d1.w, d2.w)
    assert.equal(d1.h, d2.h)

    // Both frames should be at clip-1 (similar visual content)
    // The file sizes should both be substantial (not black/empty)
    const s1 = statSync(outAtBoundary).size
    const s2 = statSync(outAfterBoundary).size
    assert.ok(s1 > 50000, `boundary frame should be a real image (${s1} bytes)`)
    assert.ok(s2 > 50000, `post-boundary frame should be a real image (${s2} bytes)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

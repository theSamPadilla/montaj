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
// (a)-(g) are ungated — each authors its own throwaway JSX inline into a temp
// dir, so they run everywhere including CI. (a) used to point at a machine-local
// `recursion.jsx` that existed nowhere (not even on the author's machine), so it
// skipped forever; it now writes a solid-fill overlay and asserts real pixels.
//
// (h)-(l) and (o) used to be gated on a machine-local project.json
// (FIXTURE_PROJECT_EXISTS) that did not exist even on the author's machine, so
// they silently skipped everywhere, including CI. T9 replaced that fixture
// with `makeSyntheticFixture` below — small ffmpeg-generated media built fresh
// into each test's own temp dir — so every one of them now actually executes
// in CI (ffmpeg is installed there; see .github/workflows/ci.yml). (n) never
// depended on the missing fixture and is unchanged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync,
  existsSync, rmSync, statSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { sampleOverlay, sampleFrame } from '../sample-frame.js'
import { resolveAt } from '@bycrux/timeline-core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = join(__dirname, '..', '..', '..')

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
 * Build a small synthetic project + backing media, entirely inside `dir`, so
 * tests (h)-(l),(o) don't depend on any machine-local fixture. Two solid-color
 * clips (red then blue, back to back on track 0) plus a tiny JSX overlay
 * (track 1, active over the first ~1s) — enough to exercise sampleFrame's
 * video-item, image-item-absent, and overlay-item paths without a real source
 * video. Colors are deliberately distinct and solid so a single sampled pixel
 * proves WHICH clip was resolved, not just that ffmpeg produced *some* frame.
 *
 * Kept intentionally tiny (64×64 source, 3s clips) — these run in CI on every
 * `node --test` invocation of this file, so cost matters.
 *
 * @param {string} dir
 * @param {{ colorSpace?: string, resolution?: [number, number] }} [opts]
 * @returns {{ project: object, clipARaw: string, clipBRaw: string } | null}
 *   `null` when ffmpeg couldn't synthesize the sources — callers should skip
 *   the test rather than fail it (this is an environment-capability check,
 *   not a machine-local-path one: ffmpeg is a hard requirement of this whole
 *   test file already, via readPixelRgba/pngDimensions/hasZscale above).
 */
function makeSyntheticFixture(dir, opts = {}) {
  const { colorSpace = 'sdr_bt709', resolution = [480, 854] } = opts
  const clipARaw = join(dir, 'clip-a.mp4')
  const clipBRaw = join(dir, 'clip-b.mp4')
  const overlayJsx = join(dir, 'overlay.jsx')
  writeFitJsx(overlayJsx)

  // For an HDR project, tag the source itself as HLG. sample-frame.js's tonemap
  // filter chain opens with `zscale=t=linear`, which needs a real source
  // transfer characteristic to linearize FROM — an untagged source (ffmpeg's
  // lavfi `color=` default) makes zscale fail with "no path between
  // colorspaces" before it ever gets to tonemap. `-color_primaries`/
  // `-color_trc` alone don't reliably stick on an h264 stream; `-x264-params`
  // does. Real HDR sources (HLG/PQ camera footage) always carry these tags for
  // real, which is the whole reason this filter chain exists.
  const hdrArgs = colorSpace === 'hdr_hlg'
    ? ['-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc']
    : []

  for (const [color, out] of [['red', clipARaw], ['blue', clipBRaw]]) {
    const r = spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=c=${color}:size=64x64:rate=30:duration=3`,
      '-pix_fmt', 'yuv420p', ...hdrArgs, out,
    ], { encoding: 'utf8', timeout: 15_000 })
    if (r.status !== 0) return null
  }

  const project = {
    version: '0.2',
    status: 'final',
    name: 'synthetic-corpus-fixture',
    settings: { resolution, fps: 30, colorSpace },
    tracks: [
      [
        { id: 'clip-0', type: 'video', src: clipARaw, start: 0, end: 3, inPoint: 0 },
        { id: 'clip-1', type: 'video', src: clipBRaw, start: 3, end: 6, inPoint: 0 },
      ],
      [
        { id: 'ov-intro', type: 'overlay', src: overlayJsx, start: 0, end: 1, offsetX: 0, offsetY: 0, scale: 1 },
      ],
    ],
    audio: { tracks: [] },
  }
  return { project, clipARaw, clipBRaw }
}

/**
 * Write a minimal JSX that paints a solid, fully-opaque field over the whole
 * canvas plus a text run. Used by (a) to assert sampleOverlay emits a PNG with
 * genuinely non-zero pixels — a transparent overlay would still produce a valid
 * PNG, so the fill is what makes the assertion mean something.
 */
function writeSolidJsx(path) {
  writeFileSync(path, `
export default function Solid() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#2244cc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: 'monospace', fontSize: 96, color: 'white' }}>
        SOLID
      </div>
    </div>
  )
}
`)
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
test('(a) sampleOverlay: produces a PNG with non-zero pixels', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-a-'))
  try {
    const jsxPath = join(dir, 'solid.jsx')
    writeSolidJsx(jsxPath)
    const outPath = join(dir, 'out.png')

    const result = await sampleOverlay({
      componentPath: jsxPath,
      frame: 0,
      fps: 30,
      width: 1080,
      height: 1920,
      outPath,
    })

    assert.ok(existsSync(result.pngPath), 'PNG file should exist')
    assert.equal(result.pngPath, outPath)

    // Check dimensions
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    assert.equal(dims.w, 1080)
    assert.equal(dims.h, 1920)

    // Non-zero PIXELS, not just a non-zero file size: a fully transparent
    // overlay still writes a valid (small) PNG, so assert the actual fill
    // colour landed. #2244cc, opaque.
    const px = readPixelRgba(result.pngPath, 40, 40)
    assert.ok(px, 'should be able to read a pixel back')
    assert.equal(px.a, 255, 'fill should be fully opaque')
    assert.ok(px.b > px.r, `expected a blue-dominant fill, got rgba(${px.r},${px.g},${px.b},${px.a})`)
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
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-h-'))
  try {
    const fixture = makeSyntheticFixture(dir)
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    const outPath = join(dir, 'frame.png')

    // At t=1.5, only clip-0 (red, 0-3s) is active; ov-intro ends at 1s so no
    // overlay is active either.
    const result = await sampleFrame({
      projectJson: fixture.project,
      atSeconds: 1.5,
      outPath,
    })

    assert.ok(existsSync(result.pngPath), 'PNG should exist')

    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    assert.equal(dims.w, 480)
    assert.equal(dims.h, 854)

    // Center pixel should be red-ish (clip-0's solid color), not black.
    const centerPx = readPixelRgba(result.pngPath, dims.w >> 1, dims.h >> 1)
    assert.ok(
      centerPx.r > 150 && centerPx.g < 100 && centerPx.b < 100,
      `center pixel should be red-ish (clip-0), got R=${centerPx.r} G=${centerPx.g} B=${centerPx.b}`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (i) sampleFrame with one overlay active composites the overlay
// ---------------------------------------------------------------------------
test('(i) sampleFrame: overlay active at timestamp produces larger file than video-only', { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-i-'))
  try {
    const fixture = makeSyntheticFixture(dir)
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    // At t=0.5, clip-0 is active + ov-intro overlay (start=0, end=1)
    const outWithOverlay = join(dir, 'with-overlay.png')
    // At t=2.0, clip-0 is active but no overlays
    const outNoOverlay = join(dir, 'no-overlay.png')

    await sampleFrame({ projectJson: fixture.project, atSeconds: 0.5, outPath: outWithOverlay })
    await sampleFrame({ projectJson: fixture.project, atSeconds: 2.0, outPath: outNoOverlay })

    const sizeWith = statSync(outWithOverlay).size
    const sizeWithout = statSync(outNoOverlay).size

    // Both should be valid PNGs
    assert.ok(existsSync(outWithOverlay))
    assert.ok(existsSync(outNoOverlay))
    // An absolute byte threshold doesn't suit these solid-color synthetic
    // clips — a flat color frame compresses far smaller than a real video
    // frame ever would. Compare the two against EACH OTHER instead, which is
    // what the test's own name asserts: the overlay's white "Hi" text adds
    // detail a perfectly flat canvas doesn't have, so it must compress worse
    // (i.e. produce a larger file) than the video-only frame.
    assert.ok(
      sizeWith > sizeWithout,
      `overlay frame (${sizeWith} bytes) should be larger than video-only frame (${sizeWithout} bytes)`
    )
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
  if (!hasZscale()) {
    t.skip('zscale not available in ffmpeg — skipping HDR tonemap test')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-j-'))
  try {
    // sample-frame.js's HDR tonemap branch is gated on project.settings.colorSpace
    // alone (isHdr(projectColorSpace)) — it doesn't inspect the source file's own
    // tagged transfer characteristic, so a plain SDR-encoded synthetic clip run
    // through an 'hdr_hlg' project genuinely exercises the same zscale/tonemap
    // ffmpeg chain production HDR sources hit. What this proves: the filter chain
    // is syntactically valid and ffmpeg accepts it, and the resulting PNG is not
    // left tagged HDR — exactly what this test always asserted.
    const fixture = makeSyntheticFixture(dir, { colorSpace: 'hdr_hlg' })
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    const outPath = join(dir, 'hdr-sample.png')

    const result = await sampleFrame({
      projectJson: fixture.project,
      atSeconds: 1.5,
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
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-k-'))
  try {
    // The output canvas size comes straight from settings.resolution — it does
    // not depend on the source media's own resolution (ffmpeg's scale filter
    // fits whatever it's given), so the tiny 64×64 synthetic sources are enough
    // to exercise the real 4K canvas math end to end.
    const fixture = makeSyntheticFixture(dir, { resolution: [2160, 3840] })
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    const outPath = join(dir, 'frame-4k.png')
    const result = await sampleFrame({
      projectJson: fixture.project,
      atSeconds: 1.5,
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
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-l-'))
  try {
    const fixture = makeSyntheticFixture(dir)
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    // At t=2.0, no overlays are active (ov-intro ends at 1.0)
    const outPath = join(dir, 'video-only.png')
    const result = await sampleFrame({
      projectJson: fixture.project,
      atSeconds: 2.0,
      outPath,
    })

    assert.ok(existsSync(result.pngPath))

    // A solid-color synthetic frame compresses far below the old fixture-derived
    // "non-trivial size" threshold (a real, detailed video frame doesn't
    // compress nearly as well as a flat color does), so pin actual content
    // instead: center pixel should be red-ish (clip-0), not black/empty.
    const dims = pngDimensions(result.pngPath)
    assert.ok(dims, 'should be readable PNG')
    const centerPx = readPixelRgba(result.pngPath, dims.w >> 1, dims.h >> 1)
    assert.ok(
      centerPx.r > 150 && centerPx.g < 100 && centerPx.b < 100,
      `center pixel should be red-ish (clip-0), got R=${centerPx.r} G=${centerPx.g} B=${centerPx.b}`
    )
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
  // --- Part 1: structural, no media — pin the resolver's OWN tiebreak decision ---
  //
  // sample-frame.js's item-selection loop now delegates directly to
  // resolveAt(project, atSeconds, {variant:'render'}) (see sample-frame.js, T9),
  // whose containsTime predicate is `start <= t < end`. Asserting that decision
  // here, on a project shaped like the shared timeline-core corpus (nonexistent
  // `/corpus/...` srcs, matching fixtures/README.md's convention — no real media
  // needed to check WHICH item gets selected), pins the exact rule sample-frame
  // depends on: deterministic, sub-millisecond, and immune to ffmpeg/puppeteer
  // flakiness. This is the "encode as a corpus golden" the tiebreak needed —
  // this file can't add to the actual timeline-core/fixtures/ corpus (out of
  // T9's writable scope), so the pin lives here instead, in the same shape.
  const boundaryProject = {
    version: '0.2',
    status: 'final',
    name: 'boundary-tiebreak-corpus',
    settings: { resolution: [480, 854], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      [
        { id: 'clip-0', type: 'video', src: '/corpus/clip-0.mp4', start: 0, end: 3, inPoint: 0 },
        { id: 'clip-1', type: 'video', src: '/corpus/clip-1.mp4', start: 3, end: 6, inPoint: 0 },
      ],
    ],
    audio: { tracks: [] },
  }
  const tracks0 = boundaryProject.tracks[0]
  const clipBoundary = tracks0[0].end // 3

  assert.equal(
    clipBoundary,
    tracks0[1].start,
    'test setup: clip-0.end should equal clip-1.start at the boundary'
  )

  // clip-0: start=0 end=3 → 0 <= 3 < 3 is FALSE (not < end) → inactive
  // clip-1: start=3 end=6 → 3 <= 3 < 6 is TRUE → active
  const atScene = resolveAt(boundaryProject, clipBoundary, { variant: 'render' })
  assert.equal(atScene.items.length, 1, 'exactly one item active at the boundary')
  assert.equal(atScene.items[0].item.id, 'clip-1', 'later clip wins the boundary tie')

  const beforeScene = resolveAt(boundaryProject, clipBoundary - 0.001, { variant: 'render' })
  assert.equal(beforeScene.items[0].item.id, 'clip-0', 'earlier clip active just before the boundary')

  // --- Part 2: full pipeline, real media — the same rule end to end through sampleFrame ---
  //
  // Complements Part 1 with a genuine pixel check: red is clip-0, blue is
  // clip-1, so a wrong tiebreak (picking clip-0 at t=3) is visible as the wrong
  // color, not just inferred from file size like this test used to do.
  const dir = mkdtempSync(join(tmpdir(), 'montaj-sf-test-o-'))
  try {
    const fixture = makeSyntheticFixture(dir)
    if (!fixture) { t.skip('ffmpeg synthetic source generation failed'); return }

    const clipBoundarySecs = fixture.project.tracks[0][0].end // 3
    const outAtBoundary = join(dir, 'boundary.png')
    const outAfterBoundary = join(dir, 'after.png')

    await sampleFrame({ projectJson: fixture.project, atSeconds: clipBoundarySecs, outPath: outAtBoundary })
    await sampleFrame({ projectJson: fixture.project, atSeconds: clipBoundarySecs + 0.5, outPath: outAfterBoundary })

    assert.ok(existsSync(outAtBoundary))
    assert.ok(existsSync(outAfterBoundary))

    const d1 = pngDimensions(outAtBoundary)
    const d2 = pngDimensions(outAfterBoundary)
    assert.ok(d1 && d2)
    assert.equal(d1.w, d2.w)
    assert.equal(d1.h, d2.h)

    // Both frames should be blue-ish (clip-1) — the earlier-clip red must NOT show.
    const p1 = readPixelRgba(outAtBoundary, d1.w >> 1, d1.h >> 1)
    const p2 = readPixelRgba(outAfterBoundary, d2.w >> 1, d2.h >> 1)
    assert.ok(p1.b > 150 && p1.r < 100, `boundary frame should be blue-ish (clip-1), got R=${p1.r} G=${p1.g} B=${p1.b}`)
    assert.ok(p2.b > 150 && p2.r < 100, `post-boundary frame should be blue-ish (clip-1), got R=${p2.r} G=${p2.g} B=${p2.b}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

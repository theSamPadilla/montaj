// render/test/encode-segment.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeSegment,
  buildVideoItemFilterParts,
  buildColorConversionFilter,
  buildVividLutChain,
  hasZscale,
  hasLut3d,
} from '../encode-segment.js'
import { lutPath, MASTER_LOOK } from '../look.js'
import {
  COLOR_SPACE_SPECS,
  ALL_COLOR_SPACES,
  DEFAULT_COLOR_SPACE,
} from '../color-space.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('encodeSegment is a function', async () => {
  assert.equal(typeof encodeSegment, 'function')
})

test('dry-run: black canvas when no items', async () => {
  const seg = { start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30 }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('color=black')))
  assert.ok(result.inputs.some(f => f.includes('anullsrc')))
  assert.ok(result.filterParts.some(f => f.includes('setparams=colorspace=bt709')))
})

test('dry-run: item opacity applies colorchannelmixer', async () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/a.mp4', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 0.5, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('colorchannelmixer=aa=0.5')))
})

test('dry-run: multi-item segment layers both items', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'image', src: '/bg.jpg', start: 0, end: 5, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0, trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Both items produce overlay filters
  const overlayFilters = result.filterParts.filter(f => f.includes('overlay='))
  assert.equal(overlayFilters.length, 2)
  // Second item should have scale * vw ≈ 576 (0.3 * 1920, rounded to even)
  assert.ok(result.filterParts.some(f => f.includes('scale=576:324')))
})

test('dry-run: overlay scales to output canvas (×scale), offset positioned', async () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [
      { webmPath: '/ov.mkv', startSeconds: 0, endSeconds: 5, isCaption: false,
        scale: 0.8, offsetX: 10, offsetY: -5 },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Overlay sizes to the OUTPUT canvas × scale (even-rounded), matching the
  // image/video item path — 1920*0.8=1536, 1080*0.8=864. Not a design→output
  // multiplier (the design canvas size is irrelevant to the target dims).
  assert.ok(result.filterParts.some(f => f.includes('scale=1536:864')))
  // Offset math: x = round(1920 * (0.5*(1-0.8) + 10/100)) = round(1920 * 0.2) = 384
  assert.ok(result.filterParts.some(f => f.includes('overlay=x=384')))
})

test('dry-run: overlay downscales to a sub-1080 output (regression: 464×832 crop)', async () => {
  // A full-frame overlay (scale 1) is rendered on the 1080-design canvas but the
  // output here is 464×832. It MUST be scaled down to fill 464×832 — the prior
  // pixelRatio = max(1, round(464/1080)) = 1 left it at design size, so the
  // compositor cropped a 464-wide corner out of the 1080 overlay (giant, clipped
  // text). Even-rounded for yuv420.
  const seg = {
    start: 0, end: 5, items: [], overlays: [
      { webmPath: '/ov.mkv', startSeconds: 0, endSeconds: 5, isCaption: false, scale: 1 },
    ], vw: 464, vh: 832, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(
    result.filterParts.some(f => f.includes('scale=464:832')),
    'overlay must shrink to the sub-1080 output canvas, not stay at design size',
  )
})

test('dry-run: .mov input uses format=auto for alpha preservation', async () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/nobg.mov', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('format=auto')))
})

// ---------------------------------------------------------------------------
// sourceCrop crop/zoom primitive (clips workflow vertical reframe)
// ---------------------------------------------------------------------------

// Helper: the full filter string for the first video item
function videoFilter(parts) { return parts.join(';') }

test('sourceCrop inserts a crop filter sized from source dims, before scale', async () => {
  const item = {
    type: 'video', src: '/src.mp4', start: 0, end: 5, inPoint: 0,
    scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
    sourceCrop: { x: 0.25, y: 0.0, w: 0.5, h: 1.0 },
    sourceWidth: 1920, sourceHeight: 1080,
  }
  const { filterParts } = buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]',
    { segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false })
  const f = videoFilter(filterParts)
  // 0.5*1920=960 wide, 1080 tall, x=0.25*1920=480, y=0
  assert.match(f, /crop=960:1080:480:0/, 'crop sized/positioned from source dims')
  assert.ok(f.indexOf('crop=960:1080:480:0') < f.indexOf('scale='), 'crop precedes scale')
})

test('no sourceCrop → no crop filter (unchanged behavior)', async () => {
  const item = { type: 'video', src: '/src.mp4', start: 0, end: 5, inPoint: 0,
    scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
  const { filterParts } = buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]',
    { segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false })
  assert.doesNotMatch(videoFilter(filterParts), /crop=/)
})

test('sourceCrop without source dims is a no-op (cannot compute pixels)', async () => {
  const item = { type: 'video', src: '/src.mp4', start: 0, end: 5, inPoint: 0,
    scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
    sourceCrop: { x: 0.25, y: 0, w: 0.5, h: 1.0 } }  // no sourceWidth/Height
  const { filterParts } = buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]',
    { segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false })
  assert.doesNotMatch(videoFilter(filterParts), /crop=/)
})

// ---------------------------------------------------------------------------
// Multi-track audio mixing
// ---------------------------------------------------------------------------

test('dry-run: two unmuted video items produce amix filter', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Both items should contribute audio (two aresample filters)
  const audioFilters = result.filterParts.filter(f => f.includes('sample_rates=48000'))
  assert.equal(audioFilters.length, 2, 'both items should extract audio')
  // Should use amix to combine them
  assert.ok(
    result.filterParts.some(f => f.includes('amix=inputs=2')),
    'two audio sources should be mixed via amix'
  )
  // No anullsrc — real audio is present
  assert.ok(!result.inputs.some(f => f.includes('anullsrc')), 'should not generate silent audio')
})

test('dry-run: muted item excluded from audio mix', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Only one audio extraction (the unmuted item)
  const audioFilters = result.filterParts.filter(f => f.includes('sample_rates=48000'))
  assert.equal(audioFilters.length, 1, 'only unmuted item should extract audio')
  // No amix needed — single source
  assert.ok(
    !result.filterParts.some(f => f.includes('amix')),
    'single audio source should not use amix'
  )
})

test('dry-run: per-item volume preserved in multi-audio mix', async () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false, volume: 0.5 },
      { type: 'video', src: '/fg.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 1, scale: 0.4, offsetX: 0, offsetY: 0, opacity: 1, muted: false, volume: 1.0 },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('volume=0.5')), 'first item volume=0.5')
  assert.ok(result.filterParts.some(f => f.includes('volume=1')), 'second item volume=1.0')
  // normalize=0 preserves individual volumes instead of auto-normalizing
  assert.ok(
    result.filterParts.some(f => f.includes('normalize=0')),
    'amix should use normalize=0 to preserve per-item volumes'
  )
})

// ---------------------------------------------------------------------------
// Opaque overlays preserve underlying audio (regression: full-screen
// animations silenced the voiceover underneath)
// ---------------------------------------------------------------------------

test('dry-run: opaqueVideo segment keeps the clip audio but drops its video', async () => {
  // An opaque overlay covers the frame; the underlying clip's voiceover MUST
  // still be sourced. opaqueVideo gates only the video compositing.
  const seg = {
    start: 0, end: 5, opaqueVideo: true, items: [
      { type: 'video', src: '/vo.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [
      { webmPath: '/anim.mkv', startSeconds: 0, endSeconds: 5, isCaption: false, opaque: true },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Audio is extracted from the clip ...
  assert.ok(
    result.filterParts.some(f => f.includes('sample_rates=48000')),
    'clip audio must be extracted under an opaque overlay',
  )
  // ... and NOT replaced with silence.
  assert.ok(
    !result.inputs.some(f => f.includes('anullsrc')),
    'opaque segment with an underlying clip must not generate silent audio',
  )
  // The clip's input is present (so its audio stream is available) ...
  assert.ok(result.inputs.includes('/vo.mp4'), 'clip input must be added for audio')
  // ... but its VIDEO is not composited (no per-item fit/pad filter).
  assert.ok(
    !result.filterParts.some(f => f.includes('force_original_aspect_ratio')),
    'opaque overlay replaces the frame — the clip video must not be composited',
  )
  // The opaque overlay itself still composites over the black canvas.
  assert.ok(result.inputs.includes('/anim.mkv'), 'opaque overlay input present')
})

test('dry-run: opaqueVideo over a gap (no items) still yields silence', async () => {
  // No underlying clip → nothing to source → silence is correct.
  const seg = {
    start: 0, end: 3, opaqueVideo: true, items: [], overlays: [
      { webmPath: '/anim.mkv', startSeconds: 0, endSeconds: 3, isCaption: false, opaque: true },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('anullsrc')), 'no underlying clip → silent audio')
})

// ---------------------------------------------------------------------------
// Color-space-aware encoding (Task 5 of color-space-aware-pipeline plan)
// ---------------------------------------------------------------------------

test('segment encoder emits libx264 for sdr_bt709 project', async () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.args.includes('libx264'), 'args should include libx264')
  assert.ok(result.args.includes('yuv420p'), 'args should include yuv420p')
  // Stream-level color metadata for SDR
  assert.ok(result.args.includes('bt709'), 'args should include bt709 color metadata')
  // Per-frame setparams for SDR
  assert.ok(
    result.filterParts.some(f => f.includes('setparams=colorspace=bt709')),
    'filterParts should include bt709 setparams'
  )
})

test('segment encoder emits libx265 for hdr_hlg project', async () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'hdr_hlg',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.args.includes('libx265'), 'args should include libx265')
  assert.ok(result.args.includes('yuv420p10le'), 'args should include yuv420p10le')
  // HLG uses arib-std-b67 transfer; expect it surfaced via x265-params (encoder
  // params) and via the per-frame setparams filter.
  assert.ok(
    result.args.some(a => typeof a === 'string' && a.includes('arib-std-b67')),
    'args should include arib-std-b67 (HLG transfer)'
  )
  assert.ok(
    result.filterParts.some(f => f.includes('arib-std-b67')),
    'filterParts should include arib-std-b67 setparams'
  )
  // Stream-level color metadata for HDR
  assert.ok(result.args.includes('bt2020'), 'args should include bt2020 primaries')
  assert.ok(result.args.includes('bt2020nc'), 'args should include bt2020nc colorspace')
})

test('per-item filter preserves source aspect via decrease-fit + center pad', async () => {
  // The per-item video filter must apply force_original_aspect_ratio=decrease
  // followed by a centered pad. Without this, mismatched-aspect sources
  // (e.g. a 720x1280 portrait clip dropped into a 1920x1080 landscape canvas)
  // get force-stretched to fill, distorting the picture.
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/portrait.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const filterStr = result.filterParts.join(';')
  assert.ok(
    filterStr.includes('force_original_aspect_ratio=decrease'),
    'filter must use decrease-fit so portrait sources do not stretch into landscape canvases',
  )
  assert.ok(
    filterStr.includes('pad=1920:1080:(ow-iw)/2:(oh-ih)/2'),
    'filter must center-pad to the item box (1920x1080 here) so the fitted image is letterbox/pillarbox-centered',
  )
})

// ---------------------------------------------------------------------------
// The Montaj Vivid HDR→SDR chain (SP6b decision 8a)
//
// These pin the SAME literals tests/test_normalize.py pins on the Python side.
// Two runtimes emit this chain (lib/normalize.py at intake, this file at
// render) and they must not drift, so the strings are asserted in both suites
// rather than only where each is produced. If you change one, the other's
// assertions are the ones that will tell you.
// ---------------------------------------------------------------------------

test('hdr source in sdr project applies the Vivid LUT in the segment filter', async () => {
  // HLG source (color_transfer = 'arib-std-b67') in an SDR project must inject
  // the LUT chain into the per-item filter graph. Pre-SP6b this was
  // tonemap=hable:desat=0, which now survives only as a no-lut3d fallback.
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/iphone-hdr.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        colorTransfer: 'arib-std-b67' },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const filterStr = result.filterParts.join(';')
  assert.ok(filterStr.includes('zscale=matrixin=2020_ncl:rangein=limited:range=full'),
    'filter should open the conversion with the 2020→full-range unpack')
  assert.ok(filterStr.includes(`lut3d=file=${lutPath()}:interp=tetrahedral`),
    'filter should apply the master-look cube with tetrahedral interpolation')
  assert.ok(filterStr.includes('zscale=t=bt709:m=bt709:p=bt709:rin=full:r=tv'),
    'filter should retag to limited-range Rec.709 after the LUT')
  assert.ok(!filterStr.includes('tonemap=hable'),
    'the Hable tonemap is a fallback now — it must not appear when lut3d is available')
})

test('decision 8a: format=rgb48le comes BEFORE lut3d, not after', () => {
  // The load-bearing pin. Without rgb48le ahead of it, ffmpeg feeds 8-bit into
  // the LUT and quantizes the grade — a subtle, banding-shaped regression that
  // no "is the filter present" assertion would catch. Index comparison, not
  // substring presence, is the whole point of this test.
  const vf = buildVividLutChain('hdr_hlg')
  assert.ok(vf.includes('format=rgb48le'), 'chain must pin 16-bit RGB before the LUT')
  assert.ok(vf.includes('lut3d='), 'chain must apply a LUT')
  assert.ok(vf.indexOf('format=rgb48le') < vf.indexOf('lut3d='),
    `format=rgb48le must precede lut3d, got: ${vf}`)
})

test('vivid chain: HLG arm is the verbatim production chain with no PQ pre-step', () => {
  const vf = buildVividLutChain('hdr_hlg')
  assert.equal(
    vf,
    'zscale=matrixin=2020_ncl:rangein=limited:range=full,'
    + 'format=rgb48le,'
    + `lut3d=file=${lutPath()}:interp=tetrahedral,`
    + 'zscale=t=bt709:m=bt709:p=bt709:rin=full:r=tv',
  )
  assert.ok(!vf.includes('smpte2084'), 'an HLG source needs no PQ conversion')
})

test('vivid chain: PQ arm prepends the PQ→HLG step at the LUT design white', () => {
  // The LUT is graded for HLG input, so PQ has to be converted first — at
  // 1000 nit, the same white the SP6a generator's OOTF used.
  const vf = buildVividLutChain('hdr_pq')
  assert.ok(vf.startsWith('zscale=tin=smpte2084:t=arib-std-b67:npl=1000,'),
    `PQ arm must open with the PQ→HLG pre-step, got: ${vf}`)
  assert.ok(vf.indexOf('tin=smpte2084') < vf.indexOf('lut3d='),
    'the PQ conversion must happen before the LUT, not after')
})

test('vivid chain: the trailing retag sets t=/m=/p= explicitly, not just range', () => {
  // zscale only overrides an axis it is explicitly given; an omitted axis keeps
  // the HDR source's tag, and that frame tag then beats the encoder's own
  // -color_trc/-color_primaries flags. Dropping t=/p= here produced files
  // reporting arib-std-b67/bt2020 over bt709 pixels (found during T2).
  for (const src of ['hdr_hlg', 'hdr_pq']) {
    const vf = buildVividLutChain(src)
    assert.ok(vf.endsWith('zscale=t=bt709:m=bt709:p=bt709:rin=full:r=tv'),
      `${src}: chain must end with the full retag, got: ${vf}`)
    assert.ok(vf.indexOf('lut3d=') < vf.lastIndexOf('zscale=t=bt709'),
      `${src}: the retag must come after the LUT`)
  }
})

test('vivid chain: a curve id selects that cube; omitting it uses the master look', () => {
  const master = buildVividLutChain('hdr_hlg')
  const neutral = buildVividLutChain('hdr_hlg', 'vivid1-neutral')
  assert.ok(master.includes(`lut3d=file=${lutPath(MASTER_LOOK)}:`))
  assert.ok(neutral.includes(`lut3d=file=${lutPath('vivid1-neutral')}:`))
  assert.notEqual(master, neutral, 'a non-default curve must change the chain')
  assert.equal(buildVividLutChain('hdr_hlg', null), master, 'null curve → master look')
})

test('fallbacks: no lut3d keeps the Hable chain, no zscale keeps the bare tonemap', () => {
  // A build missing either filter must degrade to exactly what it did before
  // SP6b rather than naming a filter it cannot run.
  const noLut = buildColorConversionFilter('hdr_hlg', 'sdr_bt709', true, { hasLut3d: false })
  assert.equal(
    noLut,
    'zscale=t=linear:npl=100,format=gbrpf32le,'
    + 'zscale=p=bt709,tonemap=hable:desat=0,'
    + 'zscale=t=bt709:m=bt709:r=tv',
  )
  const noZscale = buildColorConversionFilter('hdr_hlg', 'sdr_bt709', false, { hasLut3d: false })
  assert.equal(noZscale, 'format=p010le,tonemap=hable:desat=0')
  assert.ok(!noLut.includes('lut3d') && !noZscale.includes('lut3d'))
})

test('non-HDR→SDR conversions are untouched by the LUT migration', () => {
  // SP6b only replaced the tone-map arm. The stretch and cross arms must still
  // emit exactly what they always did — nothing here goes through a cube.
  assert.equal(buildColorConversionFilter('sdr_bt709', 'hdr_hlg', true),
    'zscale=t=arib-std-b67:p=bt2020:m=bt2020nc')
  assert.equal(buildColorConversionFilter('sdr_bt709', 'hdr_pq', true),
    'zscale=t=smpte2084:p=bt2020:m=bt2020nc')
  assert.equal(buildColorConversionFilter('hdr_hlg', 'hdr_pq', true), 'zscale=t=smpte2084')
  assert.equal(buildColorConversionFilter('hdr_pq', 'hdr_hlg', true), 'zscale=t=arib-std-b67')
  assert.equal(buildColorConversionFilter('sdr_bt709', 'sdr_bt709', true), '')
})

// ---------------------------------------------------------------------------
// Step ordering: crop → scale → convert → pad (SP6b T6, MASTER's ~9× fix)
// ---------------------------------------------------------------------------

test('ordering: the conversion runs AFTER scale and BEFORE pad', async () => {
  // Pre-SP6b the conversion sat at the head of the chain, so a 4K source
  // feeding a 1080 canvas tone-mapped ~9× the pixels it would keep. Geometry
  // now runs first. Asserted by index, because "all four steps are present" was
  // already true of the slow order — position is the entire change.
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/iphone-hdr.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        colorTransfer: 'arib-std-b67',
        sourceCrop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        sourceWidth: 3840, sourceHeight: 2160 },
    ], overlays: [], vw: 1080, vh: 1920, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const chain = result.filterParts.find((p) => p.includes('lut3d='))
  assert.ok(chain, 'expected a per-item chain carrying the conversion')

  const iCrop  = chain.indexOf('crop=')
  const iScale = chain.indexOf('scale=')
  const iConv  = chain.indexOf('zscale=matrixin=')
  const iPad   = chain.indexOf('pad=')
  assert.ok(iCrop >= 0 && iScale >= 0 && iConv >= 0 && iPad >= 0,
    `expected crop, scale, conversion and pad in: ${chain}`)
  assert.ok(iCrop < iScale, `crop must precede scale: ${chain}`)
  assert.ok(iScale < iConv, `scale must precede the conversion (the ~9× fix): ${chain}`)
  assert.ok(iConv < iPad, `the conversion must precede pad: ${chain}`)
})

test('ordering: pad stays after the conversion so letterbox bars are never graded', async () => {
  // pad synthesizes black bars. Generated after the conversion they are black
  // in the destination space and stay black; generated before it they would be
  // pushed through the cube with the picture and come out tinted by whatever
  // the grade does to 0,0,0. An aspect-mismatched source is what makes this
  // reachable — a matching one pads nothing. The end-to-end proof that the bars
  // really are black is the HLG fixture in sample-frame.test.mjs.
  const seg = {
    start: 0, end: 3, items: [
      // 16:9 source into a 9:16 canvas → real letterbox bars.
      { type: 'video', src: '/landscape-hdr.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        colorTransfer: 'arib-std-b67' },
    ], overlays: [], vw: 1080, vh: 1920, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const chain = result.filterParts.find((p) => p.includes('lut3d='))
  assert.ok(chain)
  assert.ok(chain.indexOf('lut3d=') < chain.indexOf('pad='),
    `pad must come after the LUT or the bars get graded: ${chain}`)
  assert.ok(chain.includes('pad=1080:1920:(ow-iw)/2:(oh-ih)/2'),
    'the centered pad to the item box must survive the reorder')
})

test('ordering: an SDR source in an SDR project emits no conversion step at all', async () => {
  // The reorder must be invisible when there is nothing to convert — this is
  // exactly why the frozen encode-args goldens did not move (see the SP6b note
  // in encode-args-golden.test.mjs).
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/plain.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        sourceCrop: { x: 0, y: 0, w: 0.5, h: 0.5 },
        sourceWidth: 1920, sourceHeight: 1080 },
    ], overlays: [], vw: 1080, vh: 1920, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const chain = result.filterParts.find((p) => p.includes('scale='))
  assert.ok(chain)
  assert.ok(!chain.includes('zscale='), `no conversion expected, got: ${chain}`)
  assert.match(chain, /setpts=PTS-STARTPTS,crop=[^,]+,scale=[^,]+,pad=/,
    `SDR chain must stay setpts,crop,scale,pad: ${chain}`)
})

test('ordering: a converted item pins even scale dims; an unconverted one does not', async () => {
  // The companion to the reorder. Decrease-fit computes the un-pinned dimension
  // from the aspect ratio and can return an odd one, which zscale refuses on
  // subsampled formats ("dimensions must be divisible by subsampling factor")
  // — a hard encode failure, not a color artifact. Running the conversion after
  // scale is what newly exposes that, so converted items get
  // force_divisible_by=2.
  //
  // The negative half matters just as much: adding it unconditionally would
  // change the scale string on every SDR render and break the frozen
  // encode-args goldens for no reason.
  const mk = (colorTransfer) => ({
    start: 0, end: 3, items: [
      { type: 'video', src: '/clip.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        ...(colorTransfer ? { colorTransfer } : {}) },
    ], overlays: [], vw: 1080, vh: 1920, fps: 30,
    colorSpace: 'sdr_bt709',
  })
  const hdr = await encodeSegment(mk('arib-std-b67'), '/tmp/test.mp4', { _dryRun: true })
  const hdrChain = hdr.filterParts.find((p) => p.includes('lut3d='))
  assert.match(hdrChain, /force_original_aspect_ratio=decrease:force_divisible_by=2,/,
    `converted items must pin even dims before zscale: ${hdrChain}`)

  const sdr = await encodeSegment(mk(null), '/tmp/test.mp4', { _dryRun: true })
  const sdrChain = sdr.filterParts.find((p) => p.includes('scale='))
  assert.ok(!sdrChain.includes('force_divisible_by'),
    `unconverted items must keep the original scale string: ${sdrChain}`)
})

test('encodeSegment threads sdrCurve down to the item conversion', async () => {
  // T7 renders derived SDR renditions with a non-default curve; this is the
  // wire it travels on.
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/iphone-hdr.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        colorTransfer: 'arib-std-b67' },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const withCurve = await encodeSegment(seg, '/tmp/test.mp4',
    { _dryRun: true, sdrCurve: 'vivid1-neutral' })
  const withDefault = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(withCurve.filterParts.join(';').includes(`lut3d=file=${lutPath('vivid1-neutral')}:`))
  assert.ok(withDefault.filterParts.join(';').includes(`lut3d=file=${lutPath(MASTER_LOOK)}:`))
})

// Parity check between Python and JS loaders. Both read the same JSON schema
// (montaj_assets/schemas/color_space.json), but each applies its own normalization
// (Python tuples vs JS frozen arrays; snake_case vs camelCase). This test
// catches drift in either loader — e.g., one freezes nested arrays and the
// other doesn't, or one drops a field during conversion.
test('JS and Python emit the SAME Vivid chain, character for character', async () => {
  // The strongest form of the two-runtimes-must-not-drift rule. Both suites pin
  // the literals separately (that catches most drift on its own), but two
  // independently-correct-looking chains can still differ in an option order or
  // a separator, and the difference would surface as "the export doesn't match
  // the preview" long after the change that caused it. So: ask Python for its
  // chain and compare the actual strings.
  //
  // Skips rather than fails when Python can't be reached — the render package
  // ships and is tested standalone (see the golden file's note on hermetic
  // suites), so a missing interpreter is an environment gap, not a regression.
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const pyChains = spawnSync('python3', ['-c', `
import json
import lib.normalize as nm
nm._has_zscale = lambda: True
nm._has_lut3d = lambda: True
print(json.dumps({
    src: nm._build_tonemap_vf_to_sdr(src)[0] for src in ("hdr_hlg", "hdr_pq")
}))
`], { cwd: repoRoot, encoding: 'utf8' })

  if (pyChains.status !== 0) {
    console.log(`  (skipped: python side unavailable — ${(pyChains.stderr || '').trim().slice(-200)})`)
    return
  }
  const py = JSON.parse(pyChains.stdout)
  for (const src of ['hdr_hlg', 'hdr_pq']) {
    assert.equal(
      buildVividLutChain(src), py[src],
      `${src}: encode-segment.js and lib/normalize.py disagree on the Vivid chain`,
    )
  }
})

test('JS and Python loaders agree on the schema', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')

  // Dump Python SPECS as snake_case JSON. `default` is dumped separately to
  // assert against DEFAULT_COLOR_SPACE on the JS side.
  const pyDump = spawnSync('python3', ['-c', `
import json
from lib.types.colorspace import SPECS, ALL_COLOR_SPACES, DEFAULT_COLOR_SPACE
out = {
    "default": DEFAULT_COLOR_SPACE,
    "all": list(ALL_COLOR_SPACES),
    "specs": {
        k: {
            "key": v["key"],
            "transfer_values": list(v["transfer_values"]),
            "pix_fmts": list(v["pix_fmts"]),
            "encoder": v["encoder"],
            "output_pix_fmt": v["output_pix_fmt"],
            "encoder_params": dict(v["encoder_params"]),
            "output_color_args": list(v["output_color_args"]),
            "setparams": v["setparams"],
        } for k, v in SPECS.items()
    },
}
print(json.dumps(out))
`], { cwd: repoRoot, encoding: 'utf8' })

  assert.equal(pyDump.status, 0, `python loader spawn failed: ${pyDump.stderr}`)
  const py = JSON.parse(pyDump.stdout)

  // Convert JS COLOR_SPACE_SPECS (camelCase, frozen) back to snake_case for
  // structural comparison.
  const jsSnake = (() => {
    const out = {}
    for (const [k, v] of Object.entries(COLOR_SPACE_SPECS)) {
      // Reverse the camelCase conversion done in color-space.js's buildSpecs:
      // outputPixFmt → output_pix_fmt, transferValues → transfer_values, etc.
      // encoderArgs is the FLATTENED argv form; the Python side's encoder_params
      // is the dict source. Reconstruct the dict by walking pairs.
      const encoderParams = {}
      for (let i = 0; i < v.encoderArgs.length; i += 2) {
        const key = v.encoderArgs[i].replace(/^-/, '')
        encoderParams[key] = v.encoderArgs[i + 1]
      }
      out[k] = {
        key: v.key,
        transfer_values: [...v.transferValues],
        pix_fmts: [...v.pixFmts],
        encoder: v.encoder,
        output_pix_fmt: v.outputPixFmt,
        encoder_params: encoderParams,
        output_color_args: [...v.outputColorArgs],
        setparams: v.setparams,
      }
    }
    return out
  })()

  assert.equal(DEFAULT_COLOR_SPACE, py.default, 'DEFAULT_COLOR_SPACE drift')
  assert.deepEqual([...ALL_COLOR_SPACES], py.all, 'ALL_COLOR_SPACES drift')
  assert.deepEqual(jsSnake, py.specs, 'COLOR_SPACE_SPECS drift between Python and JS loaders')
})

// ---------------------------------------------------------------------------
// PCM per-segment audio (replaces AAC: see CHANGELOG and the comment above
// Step 5 in encode-segment.js for the audio-pop root cause)
// ---------------------------------------------------------------------------

// Tight assertion helper: codec_flag is the value immediately after `-c:a`
// in args — avoids false positives from the string appearing in any other
// flag, comment, or filter-graph position.
function audioCodec(args) {
  const i = args.indexOf('-c:a')
  return i >= 0 ? args[i + 1] : null
}

test('segment audio is encoded as pcm_s16le, not aac (single source)', async () => {
  // PCM has no framing, no priming, and no edit-list metadata for the concat
  // demuxer to mishandle — segment seams stop carrying encoder/container
  // artifacts. The final concat pass in compose.js still re-encodes to AAC
  // once at the very end.
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/clip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'segment audio codec must be pcm_s16le')
})

test('segment audio is pcm_s16le on the anullsrc (silent) path', async () => {
  // Codec change applies uniformly — a segment with no audio sources still
  // gets pcm_s16le silence, so the concat-time AAC pass sees a consistent
  // codec across every segment.
  const seg = {
    start: 0, end: 3, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('anullsrc')),
    'silent path is exercised (sanity check on the test setup)')
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'silent-path segment audio codec must be pcm_s16le, not aac')
})

test('segment audio is pcm_s16le on the multi-source amix path', async () => {
  // Two unmuted sources → amix → encoder. Codec must still be PCM so the
  // mixed-mode segments compose with single-source segments cleanly.
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('amix=inputs=2')),
    'amix path is exercised (sanity check on the test setup)')
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'amix-path segment audio codec must be pcm_s16le')
})

test('per-item audio filter includes atrim=0:${duration} for sample-accurate trim', async () => {
  // ffmpeg input seek + -accurate_seek (default on transcode) produces
  // sample-accurate output, but `atrim` makes the contract explicit in the
  // filter chain so it survives future filter changes. Without an explicit
  // trim, a decoder that emits an extra trailing frame (e.g. on flush) would
  // leak past the segment's declared duration into the concat-built audio.
  //
  // Use a frame-aligned fractional duration of the kind the planner actually
  // emits (after the prior sub-frame quantization fix, segment durations are
  // multiples of 1/fps — so 21/30 = 0.7s exact float, 22/30 = 0.7333… float).
  // Pick the latter so the assertion locks in handling of a non-terminating
  // decimal serialization rather than the friendly 0.7 case.
  const start = 4 + 22/30        // arbitrary mid-stream
  const end   = start + 22/30    // 22 frames @ 30fps → 0.7333… seconds
  const duration = end - start
  const seg = {
    start, end, items: [
      { type: 'video', src: '/clip.mp4', start, end, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  const audioFilter = result.filterParts.find(f => f.includes('sample_rates=48000'))
  assert.ok(audioFilter, 'per-item audio filter chain must exist')
  assert.ok(audioFilter.includes(`atrim=0:${duration}`),
    `per-item audio filter must include atrim=0:${duration} — got: ${audioFilter}`)
  // atrim must come BEFORE asetpts=PTS-STARTPTS — the order locks the
  // sample range against the input PTS (which starts at the seek point),
  // not the zero-based PTS produced by asetpts.
  assert.ok(audioFilter.indexOf('atrim=') < audioFilter.indexOf('asetpts='),
    `atrim must precede asetpts in the per-item filter — got: ${audioFilter}`)
})

// ---------------------------------------------------------------------------
// item.hasAudio stamping (render.js pre-probes audio presence per unique
// source once and stamps it onto every item sharing that src — see the
// audioCache loop in render.js). A stamped value must win over the
// per-segment fileHasAudio ffprobe / the dry-run "assume audio present"
// default; an unstamped item must keep exactly the previous behavior.
// ---------------------------------------------------------------------------

test('encodeSegment honors a stamped item.hasAudio=false', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/silent.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        hasAudio: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // No per-item audio filter chain — hasAudio:false overrides the dry-run
  // "assume audio present" default.
  assert.ok(
    !result.filterParts.some(f => f.includes('sample_rates=48000')),
    'stamped hasAudio:false must suppress the per-item audio filter even in dry-run',
  )
  // No real audio source → falls back to silence.
  assert.ok(result.inputs.some(f => f.includes('anullsrc')), 'no audio source → silent path')
})

test('encodeSegment honors a stamped item.hasAudio=true', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/withaudio.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        hasAudio: true },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(
    result.filterParts.some(f => f.includes('sample_rates=48000')),
    'stamped hasAudio:true must produce the per-item audio filter',
  )
  assert.ok(!result.inputs.some(f => f.includes('anullsrc')), 'audio source present → no silent path')
})

test('encodeSegment without a stamped hasAudio keeps current dry-run behavior', async () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/unstamped.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Unstamped item in dry-run mode still assumes audio present — matches
  // the pre-existing `opts._dryRun || fileHasAudio(...)` fallback.
  assert.ok(
    result.filterParts.some(f => f.includes('sample_rates=48000')),
    'unstamped item in dry-run mode should still assume audio present (unchanged behavior)',
  )
})

test('single audioclean source with vol=1 still routes through the encoder path', async () => {
  // Regression: the previous stream-copy fast path triggered on exactly this
  // signature (one item, src ends with _audioclean.mp4, volume==1). It was
  // the source of the intra-clip audio pop because the input seek landed at
  // the nearest AAC frame (up to ~21ms early) and the concat demuxer dropped
  // the per-segment edit list when re-encoding. Removing the fast path means
  // this segment now runs through the same filter+encode path as everything
  // else, so the output is sample-accurate PCM.
  const seg = {
    start: 4.733, end: 5.433, items: [
      { type: 'video', src: '/IMG_6201_2_audioclean.mp4',
        start: 4.733, end: 5.433, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
        muted: false, volume: 1.0 },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = await encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Per-item audio filter chain MUST exist (it is the encoder path).
  assert.ok(
    result.filterParts.some(f => f.includes('sample_rates=48000')),
    'audioclean+vol=1 must still go through the per-item filter chain — stream-copy fast path was the audio-pop bug',
  )
  // -c:a copy MUST NOT appear (it was the stream-copy fast path).
  const cIdx = result.args.indexOf('-c:a')
  assert.ok(cIdx >= 0, 'args must include -c:a')
  assert.notEqual(result.args[cIdx + 1], 'copy',
    'audioclean+vol=1 must not stream-copy audio anymore')
  assert.equal(result.args[cIdx + 1], 'pcm_s16le',
    'audioclean+vol=1 must encode to pcm_s16le like every other segment')
})

// ---------------------------------------------------------------------------
// End-to-end: an aspect-mismatched HDR source really does letterbox to black
//
// Every other ordering test above reads a filter STRING. This one runs ffmpeg,
// because the property that matters is a pixel value: with pad after the
// conversion the bars are synthesized in the destination space and stay black;
// with pad before it they would go through the cube and come out tinted by
// whatever the grade maps 0,0,0 to. A string assertion can't tell those apart
// once someone "simplifies" the chain, and a tinted letterbox is the kind of
// thing that ships.
//
// Deliberately not a corpus fixture: the Vivid chain embeds an absolute path to
// the .cube, so an HDR fixture in the frozen encode-args goldens would bake in a
// machine-specific string (see the hazard note in encode-args-golden.test.mjs).
// ---------------------------------------------------------------------------

test('e2e: aspect-mismatched HLG source letterboxes to true black, output tagged bt709',
  { timeout: 180_000 }, async (t) => {
  if (!hasZscale() || !hasLut3d()) {
    t.skip('ffmpeg lacks zscale and/or lut3d — skipping the Vivid e2e encode')
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-es-hdr-'))
  try {
    // A landscape HLG source into a portrait canvas — the only shape that
    // produces bars. Tagged for real via -x264-params: `-color_trc` alone does
    // not reliably stick on an h264 stream, and the conversion needs a genuine
    // HLG source to be meaningful. Mid-grey rather than a primary so the LUT
    // has something to actually move.
    const src = path.join(dir, 'landscape-hlg.mp4')
    const mk = spawnSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x8080a0:size=320x180:rate=30:duration=2',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      src,
    ], { encoding: 'utf8', timeout: 60_000 })
    if (mk.status !== 0) { t.skip('ffmpeg could not synthesize the HLG source'); return }

    const out = path.join(dir, 'segment.mp4')
    const seg = {
      start: 0, end: 1, items: [
        { type: 'video', src, start: 0, end: 1, inPoint: 0, trackIdx: 0,
          scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
          colorTransfer: 'arib-std-b67', hasAudio: false },
      ], overlays: [], vw: 360, vh: 640, fps: 30,
      colorSpace: 'sdr_bt709',
    }
    await encodeSegment(seg, out)
    assert.ok(existsSync(out), 'the segment encode produced no file')

    // The container must claim SDR — the trailing zscale retag is what makes
    // this true, and it is exactly what silently regressed during T2.
    const probe = spawnSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer,color_primaries',
      '-of', 'csv=p=0', out,
    ], { encoding: 'utf8', timeout: 20_000 })
    assert.match(probe.stdout.trim(), /bt709,bt709/,
      `segment should be tagged bt709/bt709, got '${probe.stdout.trim()}'`)

    // Read pixels from a PNG rather than cropping the mp4 directly — ffmpeg
    // 8.1.2 fails to configure a 1x1 crop straight off an h264 stream.
    const png = path.join(dir, 'frame.png')
    const grab = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', out, '-frames:v', '1', png],
      { encoding: 'utf8', timeout: 30_000 })
    assert.equal(grab.status, 0, `frame grab failed: ${grab.stderr}`)

    const px = (x, y) => {
      const r = spawnSync('ffmpeg', [
        '-y', '-v', 'error', '-i', png,
        '-vf', `crop=1:1:${x}:${y},format=rgb24`,
        '-f', 'rawvideo', '-frames:v', '1', 'pipe:1',
      ], { encoding: 'buffer', timeout: 20_000 })
      assert.equal(r.status, 0, `pixel read at ${x},${y} failed`)
      return { r: r.stdout[0], g: r.stdout[1], b: r.stdout[2] }
    }

    // 320x180 fitted into 360x640 → 360x202 picture, centered: bars above
    // y≈219 and below y≈421.
    for (const [x, y, where] of [[180, 40, 'top bar'], [180, 600, 'bottom bar']]) {
      const p = px(x, y)
      assert.ok(p.r <= 4 && p.g <= 4 && p.b <= 4,
        `${where} should be black, got rgb(${p.r}, ${p.g}, ${p.b}) — `
        + 'if this is tinted, pad moved ahead of the color conversion')
    }
    const mid = px(180, 320)
    assert.ok(mid.r + mid.g + mid.b > 60,
      `picture area should carry the graded source, got rgb(${mid.r}, ${mid.g}, ${mid.b})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

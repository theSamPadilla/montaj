// render/test/encode-segment.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment, buildVideoItemFilterParts } from '../encode-segment.js'
import {
  COLOR_SPACE_SPECS,
  ALL_COLOR_SPACES,
  DEFAULT_COLOR_SPACE,
} from '../color-space.js'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('encodeSegment is a function', () => {
  assert.equal(typeof encodeSegment, 'function')
})

test('dry-run: black canvas when no items', () => {
  const seg = { start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30 }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('color=black')))
  assert.ok(result.inputs.some(f => f.includes('anullsrc')))
  assert.ok(result.filterParts.some(f => f.includes('setparams=colorspace=bt709')))
})

test('dry-run: item opacity applies colorchannelmixer', () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/a.mp4', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 0.5, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('colorchannelmixer=aa=0.5')))
})

test('dry-run: multi-item segment layers both items', () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'image', src: '/bg.jpg', start: 0, end: 5, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0, trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Both items produce overlay filters
  const overlayFilters = result.filterParts.filter(f => f.includes('overlay='))
  assert.equal(overlayFilters.length, 2)
  // Second item should have scale * vw ≈ 576 (0.3 * 1920, rounded to even)
  assert.ok(result.filterParts.some(f => f.includes('scale=576:324')))
})

test('dry-run: overlay scales to output canvas (×scale), offset positioned', () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [
      { webmPath: '/ov.mkv', startSeconds: 0, endSeconds: 5, isCaption: false,
        scale: 0.8, offsetX: 10, offsetY: -5 },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Overlay sizes to the OUTPUT canvas × scale (even-rounded), matching the
  // image/video item path — 1920*0.8=1536, 1080*0.8=864. Not a design→output
  // multiplier (the design canvas size is irrelevant to the target dims).
  assert.ok(result.filterParts.some(f => f.includes('scale=1536:864')))
  // Offset math: x = round(1920 * (0.5*(1-0.8) + 10/100)) = round(1920 * 0.2) = 384
  assert.ok(result.filterParts.some(f => f.includes('overlay=x=384')))
})

test('dry-run: overlay downscales to a sub-1080 output (regression: 464×832 crop)', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(
    result.filterParts.some(f => f.includes('scale=464:832')),
    'overlay must shrink to the sub-1080 output canvas, not stay at design size',
  )
})

test('dry-run: .mov input uses format=auto for alpha preservation', () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/nobg.mov', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('format=auto')))
})

// ---------------------------------------------------------------------------
// sourceCrop crop/zoom primitive (clips workflow vertical reframe)
// ---------------------------------------------------------------------------

// Helper: the full filter string for the first video item
function videoFilter(parts) { return parts.join(';') }

test('sourceCrop inserts a crop filter sized from source dims, before scale', () => {
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

test('no sourceCrop → no crop filter (unchanged behavior)', () => {
  const item = { type: 'video', src: '/src.mp4', start: 0, end: 5, inPoint: 0,
    scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
  const { filterParts } = buildVideoItemFilterParts(item, 1080, 1920, 0, '[base]',
    { segStart: 0, duration: 5, projectColorSpace: 'sdr_bt709', zscaleAvailable: false })
  assert.doesNotMatch(videoFilter(filterParts), /crop=/)
})

test('sourceCrop without source dims is a no-op (cannot compute pixels)', () => {
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

test('dry-run: two unmuted video items produce amix filter', () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('dry-run: muted item excluded from audio mix', () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0,
        trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Only one audio extraction (the unmuted item)
  const audioFilters = result.filterParts.filter(f => f.includes('sample_rates=48000'))
  assert.equal(audioFilters.length, 1, 'only unmuted item should extract audio')
  // No amix needed — single source
  assert.ok(
    !result.filterParts.some(f => f.includes('amix')),
    'single audio source should not use amix'
  )
})

test('dry-run: per-item volume preserved in multi-audio mix', () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/bg.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false, volume: 0.5 },
      { type: 'video', src: '/fg.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 1, scale: 0.4, offsetX: 0, offsetY: 0, opacity: 1, muted: false, volume: 1.0 },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('dry-run: opaqueVideo segment keeps the clip audio but drops its video', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('dry-run: opaqueVideo over a gap (no items) still yields silence', () => {
  // No underlying clip → nothing to source → silence is correct.
  const seg = {
    start: 0, end: 3, opaqueVideo: true, items: [], overlays: [
      { webmPath: '/anim.mkv', startSeconds: 0, endSeconds: 3, isCaption: false, opaque: true },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('anullsrc')), 'no underlying clip → silent audio')
})

// ---------------------------------------------------------------------------
// Color-space-aware encoding (Task 5 of color-space-aware-pipeline plan)
// ---------------------------------------------------------------------------

test('segment encoder emits libx264 for sdr_bt709 project', () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('segment encoder emits libx265 for hdr_hlg project', () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'hdr_hlg',
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('per-item filter preserves source aspect via decrease-fit + center pad', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('hdr source in sdr project triggers tonemap in segment filter', () => {
  // HLG source (color_transfer = 'arib-std-b67') in an SDR project must inject
  // the zscale tonemap chain into the per-item filter graph.
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/iphone-hdr.mp4', start: 0, end: 3, inPoint: 0,
        trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false,
        colorTransfer: 'arib-std-b67' },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
    colorSpace: 'sdr_bt709',
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Tonemap chain: zscale t=linear → format=gbrpf32le → zscale p=bt709 → tonemap=hable → zscale t=bt709
  const filterStr = result.filterParts.join(';')
  assert.ok(filterStr.includes('zscale=t=linear'), 'filter should include zscale=t=linear')
  assert.ok(filterStr.includes('tonemap=hable'), 'filter should include tonemap=hable')
  assert.ok(filterStr.includes('zscale=t=bt709'), 'filter should end with zscale=t=bt709')
})

// Parity check between Python and JS loaders. Both read the same JSON schema
// (montaj_assets/schemas/color_space.json), but each applies its own normalization
// (Python tuples vs JS frozen arrays; snake_case vs camelCase). This test
// catches drift in either loader — e.g., one freezes nested arrays and the
// other doesn't, or one drops a field during conversion.
test('JS and Python loaders agree on the schema', () => {
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

test('segment audio is encoded as pcm_s16le, not aac (single source)', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'segment audio codec must be pcm_s16le')
})

test('segment audio is pcm_s16le on the anullsrc (silent) path', () => {
  // Codec change applies uniformly — a segment with no audio sources still
  // gets pcm_s16le silence, so the concat-time AAC pass sees a consistent
  // codec across every segment.
  const seg = {
    start: 0, end: 3, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('anullsrc')),
    'silent path is exercised (sanity check on the test setup)')
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'silent-path segment audio codec must be pcm_s16le, not aac')
})

test('segment audio is pcm_s16le on the multi-source amix path', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('amix=inputs=2')),
    'amix path is exercised (sanity check on the test setup)')
  assert.equal(audioCodec(result.args), 'pcm_s16le',
    'amix-path segment audio codec must be pcm_s16le')
})

test('per-item audio filter includes atrim=0:${duration} for sample-accurate trim', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

test('single audioclean source with vol=1 still routes through the encoder path', () => {
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
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
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

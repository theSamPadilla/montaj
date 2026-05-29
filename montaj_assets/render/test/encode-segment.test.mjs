// render/test/encode-segment.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment } from '../encode-segment.js'
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

test('dry-run: overlay positioning uses pixelRatio, offset, scale', () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [
      { webmPath: '/ov.mkv', startSeconds: 0, endSeconds: 5, isCaption: false,
        scale: 0.8, pixelRatio: 2, offsetX: 10, offsetY: -5 },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // pixelRatio*scale = 1.6 → scale filter should reference 1.6
  assert.ok(result.filterParts.some(f => f.includes('scale=iw*1.6:ih*1.6')))
  // Offset math: x = round(1920 * (0.5*(1-0.8) + 10/100)) = round(1920 * 0.2) = 384
  assert.ok(result.filterParts.some(f => f.includes('overlay=x=384')))
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

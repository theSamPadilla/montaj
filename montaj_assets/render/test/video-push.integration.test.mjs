// PL89 push_in: a talking-head clip with keyed `scale` and `offsetY` (a slow push), through the REAL video chain
// (buildVideoItemFilterParts' animated geometry: scale eval=frame, pad, overlay; no crop), in the real binary.
// A keyed crop on a deeper-than-8-bit clip came out magenta on alternate frames (render-crop-10bit); a push takes
// another path, and this proves it keeps the source's chroma on every frame, on an HLG 10-bit clip and an SDR one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildVideoItemFilterParts } from '../encode-segment.js'

const CW = 180
const CH = 320

function capabilityReason() {
  const filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  for (const f of ['zscale', 'signalstats']) if (!new RegExp(`\\b${f}\\b`).test(filters)) return `ffmpeg lacks ${f}`
  return null
}
const REASON = capabilityReason()
const SKIP = REASON ? { skip: REASON } : {}

// push_in's keys: scale 1.00 to 1.07 and offsetY keeping 35% of the height put, over the item (here 1 s)
const PUSH = [
  { prop: 'scale', points: [{ t: 0, value: 1 }, { t: 1, value: 1.07 }] },
  { prop: 'offsetY', points: [{ t: 0, value: 0 }, { t: 1, value: 1.05 }] },
]
const FLAT = (fmt, tags) => `color=0x3060a0:size=360x640:rate=25:duration=1,format=${fmt},setparams=${tags}:range=tv`

/** Every frame's mean U and V at `label`, in 8 bits. */
function chromaPerFrame(inputs, graph, label) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'info', '-nostdin', ...inputs,
    '-filter_complex', `${graph}${label}format=yuv420p,signalstats,metadata=mode=print:file=-[out]`,
    '-map', '[out]', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  const u = [...r.stdout.matchAll(/signalstats\.UAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  const v = [...r.stdout.matchAll(/signalstats\.VAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  return u.map((x, i) => [x, v[i]])
}

function chainParts(item, opts) {
  const warn = console.warn
  console.warn = () => {}
  const base = { segStart: 0, duration: 1, projectColorSpace: 'sdr_bt709', zscaleAvailable: true, lut3dAvailable: true, sdrCurve: null }
  try { return buildVideoItemFilterParts(item, CW, CH, 1, '[canvas]', { ...base, ...opts }) } finally { console.warn = warn }
}

for (const [name, source, probedPixFmt, colorTransfer, projectColorSpace, canvasFmt] of [
  ['an HLG yuv420p10le clip in an HLG project', FLAT('yuv420p10le', 'color_trc=arib-std-b67:color_primaries=bt2020:colorspace=bt2020nc'),
    'yuv420p10le', 'arib-std-b67', 'hdr_hlg', 'yuv420p10le'],
  ['an SDR yuv420p clip in an SDR project', FLAT('yuv420p', 'color_trc=bt709:color_primaries=bt709:colorspace=bt709'),
    'yuv420p', 'bt709', 'sdr_bt709', 'yuv420p'],
]) {
  test(`a push (keyed scale and offsetY) on ${name} keeps the source's chroma on every frame`, { timeout: 60_000, ...SKIP }, () => {
    const [want] = chromaPerFrame(['-f', 'lavfi', '-i', source], '', '[0:v]')
    const item = { type: 'video', src: 'lavfi-placeholder', start: 0, duration: 1, scale: 1, offsetX: 0, offsetY: 0,
      sourceWidth: 360, sourceHeight: 640, probedPixFmt, colorTransfer, keyframes: PUSH }
    const { filterParts } = chainParts(item, { projectColorSpace })
    assert.ok(filterParts.join(';').includes('eval=frame'), 'the push goes through the animated chain')
    const got = chromaPerFrame(['-f', 'lavfi', '-i', `color=black:size=${CW}x${CH}:rate=25:duration=1,format=${canvasFmt}`,
      '-f', 'lavfi', '-i', source], `${filterParts.join(';')};`, '[iv1]')
    assert.equal(got.length, 25)
    const bad = got.flatMap(([u, v], i) => (Math.max(Math.abs(u - want[0]), Math.abs(v - want[1])) > 3 ? [`frame ${i}: U ${u} V ${v}`] : []))
    assert.deepEqual(bad, [], `chroma off the source's (U ${want[0]} V ${want[1]})`)
  })
}

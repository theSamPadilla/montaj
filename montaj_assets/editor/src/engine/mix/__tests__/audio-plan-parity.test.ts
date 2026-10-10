/**
 * §190 T3: the audio plan, held to the export's own code.
 *
 * Nothing about the export is hand-copied here. Each spec runs the function
 * that builds the export's ffmpeg graph and reads the export's mapping back
 * OUT of what it produced: render/mix-audio.js for lanes (`-ss`/`-to`,
 * `adelay`, `volume`, `afade`, `sidechaincompress`), and render.js's
 * `collectAllItems` plus encode-segment.js's `encodeSegment` (dry run) for the
 * clips (`-ss` and `atrim`, `atempo`, `volume`, the crossfade ramp). The plan
 * side is read through the MixSegment contract (mix-protocol.ts: fade-in from
 * `tlStart`, fade-out ending at `tlEnd`, the two multiplied, shaped by
 * `exportFadeGain`), which mix-processor-source.test.ts holds the worklet to.
 */
import { describe, it, expect, vi } from 'vitest'
import { audioWindow } from '@bycrux/timeline-core'
// @ts-expect-error -- the export's own module: plain JS, no declarations
import * as mixAudio from '../../../../../render/mix-audio.js'
// @ts-expect-error -- as above
import * as encode from '../../../../../render/encode-segment.js'
// @ts-expect-error -- as above
import * as render from '../../../../../render/render.js'
import type { AudioTrack, EditorProject, VisualItem, VisualTrack } from '../../../schema'
import { exportFadeGain, type MixCurve, type MixSegment } from '../mix-protocol'
import { buildMixPlan, exportDuckParams, type ConformLookup } from '../audio-plan'

// render.js loads the overlay bundler (esbuild, which refuses jsdom's realm)
// and the Chrome capture at import. `collectAllItems` uses neither, so those
// two modules alone are stubbed; everything the audio path runs is real.
vi.mock('../../../../../render/bundle.js', () => ({ bundleComponent: vi.fn(), cleanupBundle: vi.fn() }))
vi.mock('../../../../../render/renderer.js', () => ({
  renderAllSegments: vi.fn(),
  planChunks: vi.fn(),
  currentRenderPlan: vi.fn(),
  stopSignal: vi.fn(),
}))

const SR = 48000

const exportLaneInputs: (tracks: AudioTrack[]) => string[] = mixAudio.buildAudioTrackInputs
const exportLaneFilters: (
  tracks: AudioTrack[],
  baseInputIdx: number,
  label: string,
) => { filterParts: string[]; audioLabel: string } = mixAudio.buildAudioTrackFilters
const collectAllItems: (project: unknown) => {
  imageItems: Array<Record<string, unknown>>
  videoItems: Array<Record<string, unknown>>
} = render.collectAllItems
const encodeSegment: (
  segment: Record<string, unknown>,
  out: string,
  opts: { _dryRun: true },
) => Promise<{ inputs: string[]; filterParts: string[] }> = encode.encodeSegment

/** Every source conformed, `seconds` long (60 s unless named). */
function lookupAll(seconds: Record<string, number> = {}): ConformLookup {
  return (src) => ({
    url: `${src}.pcm`,
    format: 'pcm_s16le',
    sampleRate: SR,
    channels: 2,
    frames: Math.round((seconds[src] ?? 60) * SR),
  })
}

const SHAPE_NAME: Record<string, MixCurve> = { tri: 'linear', exp: 'exp', log: 'log' }

// ── The plan side, read through the MixSegment contract ─────────────────────

/** Whether segment `s` sounds at timeline `t`: inside its span and short of its frames. */
function planAudible(s: MixSegment, t: number): boolean {
  if (!(t >= s.tlStart && t < (s.tlEnd as number))) return false
  const src = (s.srcIn ?? 0) + (t - s.tlStart) * (s.speed ?? 1)
  return src < (s.frames as number) / (s.sampleRate ?? 48000)
}

/** Segment `s`'s level at timeline `t`: base gain times both fades. */
function planGain(s: MixSegment, t: number): number {
  let g = s.gain ?? 1
  if ((s.fadeIn ?? 0) > 0) {
    const x = (t - s.tlStart) / (s.fadeIn as number)
    if (x < 1) g *= exportFadeGain(s.curveIn ?? s.curve ?? 'exp', x)
  }
  if ((s.fadeOut ?? 0) > 0) {
    const y = ((s.tlEnd as number) - t) / (s.fadeOut as number)
    if (y < 1) g *= exportFadeGain(s.curveOut ?? s.curve ?? 'exp', y)
  }
  return g
}

// ── Lanes: mix-audio.js ─────────────────────────────────────────────────────

interface ExportLane {
  start: number
  /** Source seconds at `start`. */
  ss: number
  /** `-to`, the source position the input stops at, or null for the end of the file. */
  to: number | null
  volume: number
  fadeIn: { st: number; d: number; curve: MixCurve } | null
  fadeOut: { st: number; d: number; curve: MixCurve } | null
  duck: { threshold: number; ratio: number; attack: number; release: number } | null
}

/** The export's lane, read back out of the args and graph mix-audio.js builds for it. */
function exportLane(track: AudioTrack): ExportLane {
  const args = exportLaneInputs([track])
  const argAfter = (flag: string) => {
    const i = args.indexOf(flag)
    return i < 0 ? null : Number(args[i + 1])
  }
  const graph = exportLaneFilters([track], 1, '[0:a]').filterParts.join(';')
  const num = (re: RegExp) => {
    const m = re.exec(graph)
    return m ? Number(m[1]) : null
  }
  const fade = (kind: 'in' | 'out') => {
    const m = new RegExp(`afade=t=${kind}:st=([^:]+):d=([^:]+):curve=(\\w+)`).exec(graph)
    return m ? { st: Number(m[1]), d: Number(m[2]), curve: SHAPE_NAME[m[3]] } : null
  }
  const sc = /sidechaincompress=threshold=([^:]+):ratio=([^:]+):attack=([^:]+):release=([^[\]]+)\[/.exec(graph)
  return {
    start: (num(/adelay=(\d+):/) as number) / 1000,
    ss: argAfter('-ss') ?? 0,
    to: argAfter('-to'),
    volume: num(/volume=([^,[\]]+)/) as number,
    fadeIn: fade('in'),
    fadeOut: fade('out'),
    duck: sc ? { threshold: Number(sc[1]), ratio: Number(sc[2]), attack: Number(sc[3]), release: Number(sc[4]) } : null,
  }
}

function exportLaneAudible(e: ExportLane, fileS: number, t: number): boolean {
  if (t < e.start) return false
  const src = e.ss + (t - e.start)
  return src < fileS && (e.to === null || src < e.to)
}

/** afade's gain: an in-fade from `st` over `d`; an out-fade the mirror, holding 0 past `st + d`. */
function exportLaneGain(e: ExportLane, t: number): number {
  let g = e.volume
  if (e.fadeIn) g *= exportFadeGain(e.fadeIn.curve, (t - e.fadeIn.st) / e.fadeIn.d)
  if (e.fadeOut) g *= exportFadeGain(e.fadeOut.curve, (e.fadeOut.st + e.fadeOut.d - t) / e.fadeOut.d)
  return g
}

function laneProject(lanes: AudioTrack[]): EditorProject {
  return { id: 'p', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: [], audio: { tracks: lanes } }
}

// Every shape a lane can carry on disk (render/test/audio-window-parity's set,
// starts in whole milliseconds because adelay is), plus fades, curves, levels
// and files shorter than the span.
// Typed loosely on purpose: on disk these fields can be null or a string.
const LANES: Array<{ name: string; track: Record<string, unknown>; fileS?: number }> = [
  { name: 'no end', track: { start: 4 } },
  { name: 'nothing but src', track: {} },
  { name: 'end == start', track: { start: 4, end: 4 } },
  { name: 'end < start', track: { start: 4, end: 2 } },
  { name: 'end null', track: { start: 4, end: null } },
  { name: 'end non-numeric', track: { start: 4, end: '9' } },
  { name: 'no end, inPoint/outPoint', track: { start: 2, inPoint: 3, outPoint: 8 } },
  { name: 'explicit end', track: { start: 27, end: 31 } },
  { name: 'explicit end, inPoint', track: { start: 5.25, end: 15, inPoint: 2 } },
  { name: 'outPoint short of the span', track: { start: 10, end: 20, inPoint: 5, outPoint: 12 } },
  { name: 'outPoint past the span', track: { start: 10, end: 20, inPoint: 10, outPoint: 60 } },
  { name: 'outPoint 0', track: { start: 1, outPoint: 0 } },
  { name: 'outPoint before inPoint', track: { start: 1, end: 9, inPoint: 5, outPoint: 3 } },
  { name: 'negative inPoint', track: { start: 3, end: 8, inPoint: -1 } },
  { name: 'file shorter than the span', track: { start: 2, end: 20 }, fileS: 10 },
  {
    name: 'fades with curves',
    track: { start: 5.25, end: 15, fadeIn: 1.5, fadeOut: 2, fadeInCurve: 'log', fadeOutCurve: 'linear' },
  },
  { name: 'an offset bed with the default curve (KNOWN-DIVERGENCES D2)', track: { start: 27.67, end: 53.8, fadeOut: 3.08 } },
  { name: 'fade-out anchored past an outPoint', track: { start: 10, end: 20, inPoint: 5, outPoint: 12, fadeOut: 5 } },
  { name: 'fade-out past the end of a short file', track: { start: 2, end: 20, fadeOut: 12, fadeOutCurve: 'log' }, fileS: 10 },
  { name: 'fade-out with no end to anchor it', track: { start: 5, fadeOut: 1, fadeIn: 0.5 } },
  { name: 'fade-in longer than the lane', track: { start: 2, end: 3, fadeIn: 4, fadeInCurve: 'linear' } },
  { name: 'fades overlapping across the whole lane', track: { start: 1, end: 2, fadeIn: 1, fadeOut: 1 } },
  { name: 'volume above 1', track: { start: 0, end: 5, volume: 1.7 } },
  { name: 'ducked, faded', track: { start: 5, end: 9, fadeIn: 1, fadeOut: 1, ducking: { enabled: true } } },
]

function sampleTimes(edges: number[]): number[] {
  const ts: number[] = []
  for (let t = -1; t <= 70; t += 0.05) ts.push(Math.round(t * 1000) / 1000)
  for (const edge of edges) if (Number.isFinite(edge)) ts.push(edge - 1e-6, edge + 1e-6)
  return ts
}

describe('lanes == the export (mix-audio.js)', () => {
  for (const { name, track, fileS = 60 } of LANES) {
    it(`${name} ${JSON.stringify(track)}`, () => {
      const t = { id: 'L', src: '/a/L.m4a', ...track } as AudioTrack
      const e = exportLane(t)
      const seg = buildMixPlan(laneProject([t]), lookupAll({ '/a/L.m4a': fileS })).plan.segments[0]
      const edges = [e.start, e.start + fileS - e.ss, e.to === null ? NaN : e.start + e.to - e.ss]
      if (e.fadeIn) edges.push(e.fadeIn.st + e.fadeIn.d)
      if (e.fadeOut) edges.push(e.fadeOut.st, e.fadeOut.st + e.fadeOut.d)
      let audible = 0
      for (const time of sampleTimes(edges)) {
        const want = exportLaneAudible(e, fileS, time)
        const got = seg !== undefined && planAudible(seg, time)
        expect(got, `audible at ${time}: plan ${got}, export ${want}`).toBe(want)
        // And the preview's own per-tick answer agrees, within the file.
        expect(audioWindow(t, time).active && (e.ss + (time - e.start) < fileS)).toBe(want)
        if (!want) continue
        audible++
        const gp = planGain(seg!, time)
        const ge = exportLaneGain(e, time)
        expect(Math.abs(gp - ge), `gain at ${time}: plan ${gp}, export ${ge}`).toBeLessThan(1e-9)
      }
      // A shape that plays must have been sampled playing.
      if (seg !== undefined) expect(audible).toBeGreaterThan(0)
    })
  }

  it('a muted lane has no segment, as the export has no input for it', () => {
    const lanes = [
      { id: 'a', src: '/a/a.m4a', start: 0, end: 5, muted: true },
      { id: 'b', src: '/a/b.m4a', start: 0, end: 5 },
    ] as AudioTrack[]
    expect(exportLaneInputs(lanes).filter((a) => a.startsWith('/a/'))).toEqual(['/a/b.m4a'])
    expect(buildMixPlan(laneProject(lanes), lookupAll()).plan.segments.map((s) => s.id)).toEqual(['lane:b'])
  })
})

describe('ducking == the export (mix-audio.js sidechaincompress)', () => {
  const DUCKINGS: Array<Record<string, unknown>> = [
    { enabled: true },
    // Depths whose 10^(-depth/20) has a fraction under one half (1.41, 3.16,
    // 11.2), so a ratio rounded any other way than the export's shows.
    { enabled: true, depth: -3 },
    { enabled: true, depth: -10 },
    { enabled: true, depth: -21 },
    { enabled: true, depth: -6 },
    { enabled: true, depth: -18, attack: 0.05, release: 1.2 },
    { enabled: true, depth: -26 },
    { enabled: true, depth: -60 },
    { enabled: true, depth: 6 },
    { enabled: true, depth: null },
  ]
  for (const ducking of DUCKINGS) {
    it(`the same options: ${JSON.stringify(ducking)}`, () => {
      const t = { id: 'L', src: '/a/L.m4a', start: 1, end: 9, ducking } as AudioTrack
      const e = exportLane(t).duck!
      const seg = buildMixPlan(laneProject([t]), lookupAll()).plan.segments[0]
      expect(seg.duck).toEqual({ threshold: e.threshold, ratio: e.ratio, attackMs: e.attack, releaseMs: e.release })
      expect(exportDuckParams(ducking as AudioTrack['ducking'])).toEqual(seg.duck)
    })
  }

  it('not ducked when ducking is off or absent', () => {
    for (const ducking of [{ enabled: false, depth: -12 }, undefined]) {
      const t = { id: 'L', src: '/a/L.m4a', start: 1, end: 9, ducking } as AudioTrack
      expect(exportLane(t).duck).toBeNull()
      expect(buildMixPlan(laneProject([t]), lookupAll()).plan.segments[0].duck).toBeUndefined()
    }
  })

  it('each ducked lane is keyed by what the export keys it by: the clips and the unmuted lanes before it', () => {
    const lanes = [
      { id: 'vo', src: '/a/vo.m4a', start: 0, end: 9 },
      { id: 'off', src: '/a/off.m4a', start: 0, end: 9, muted: true },
      { id: 'music', src: '/a/music.m4a', start: 0, end: 9, ducking: { enabled: true } },
      { id: 'sfx', src: '/a/sfx.m4a', start: 2, end: 3 },
      { id: 'bed', src: '/a/bed.m4a', start: 0, end: 9, ducking: { enabled: true, depth: -6 } },
    ] as AudioTrack[]
    // The export: follow every label through the graph to the sources it carries.
    const unmuted = lanes.filter((l) => !l.muted)
    const parts = exportLaneFilters(lanes, 1, '[0:a]').filterParts
    const carries = new Map<string, Set<string>>([['[0:a]', new Set(['clips'])]])
    const exportKey = new Map<string, Set<string>>()
    for (const part of parts) {
      const labels = [...part.matchAll(/\[([^\]]+)\]/g)].map((m) => `[${m[1]}]`)
      const out = labels[labels.length - 1]
      const ins = labels.slice(0, -1)
      // Lane inputs are numbered from 1; input 0 is the clips' audio.
      const laneIn = /^\[([1-9]\d*):a\]/.exec(part)
      if (/asplit=2/.test(part)) {
        for (const l of labels.slice(1)) carries.set(l, new Set(carries.get(labels[0])))
      } else if (laneIn) {
        carries.set(out, new Set([unmuted[Number(laneIn[1]) - 1].id]))
      } else if (/sidechaincompress/.test(part)) {
        exportKey.set([...carries.get(ins[0])!][0], carries.get(ins[1])!)
        carries.set(out, new Set(carries.get(ins[0])))
      } else {
        carries.set(out, new Set(ins.flatMap((l) => [...carries.get(l)!])))
      }
    }
    expect([...exportKey.keys()]).toEqual(['music', 'bed'])

    // The plan: a ducked segment's key is every segment at a lower stage.
    const project: EditorProject = {
      ...laneProject(lanes),
      tracks: [{ id: 't0', items: [{ id: 'A', type: 'video', src: '/m/A.mp4', start: 0, end: 9 }] }],
    }
    const segs = buildMixPlan(project, lookupAll()).plan.segments
    const nameOf = (s: MixSegment) => (s.id.startsWith('clip:') ? 'clips' : s.id.slice('lane:'.length))
    for (const [lane, key] of exportKey) {
      const ducked = segs.find((s) => s.id === `lane:${lane}`)!
      expect(ducked.duck, lane).toBeTruthy()
      const planKey = new Set(segs.filter((s) => (s.stage ?? 0) < (ducked.stage ?? 0)).map(nameOf))
      expect([...planKey].sort(), lane).toEqual([...key].sort())
    }
  })
})

// ── Clips: render.js collectAllItems + encode-segment.js encodeSegment ──────

interface ExportClipAudio {
  /** Source seconds at the segment's start, and consumed over it. */
  srcStart: number
  srcDur: number
  speed: number
  volume: number
  /** The crossfade ramp at segment-local `t`, or null when the chain has none. */
  ramp: ((t: number) => number) | null
}

/** The audio chains one dry-run segment encode built, by item source. */
async function exportSegmentAudio(items: Array<Record<string, unknown>>, start: number, end: number) {
  const active = items.filter((i) => (i.start as number) < end && (i.end as number) > start)
  const { inputs, filterParts } = await encodeSegment(
    { start, end, items: active, overlays: [], vw: 1080, vh: 1920, fps: 30 },
    '/nonexistent/segment.mp4',
    { _dryRun: true },
  )
  // Input index -> [its source, its input seek].
  const byInput: Array<{ src: string; ss: number }> = []
  let ss = 0
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] === '-ss') ss = Number(inputs[i + 1])
    if (inputs[i] === '-i') {
      byInput.push({ src: inputs[i + 1], ss })
      ss = 0
    }
  }
  const out = new Map<string, ExportClipAudio>()
  for (const part of filterParts) {
    const head = /^\[(\d+):a:0\]/.exec(part)
    if (!head) continue
    const input = byInput[Number(head[1])]
    const trim = /atrim=(?:start=([^:]+):duration=|0:)([^,]+)/.exec(part)!
    const tempo = [...part.matchAll(/atempo=([^,]+)/g)].reduce((p, m) => p * Number(m[1]), 1)
    const vol = /,volume=([^,']+),/.exec(part)!
    const xf = /volume='(1-\()?(?:([^+*']+)\+)?([^*']+)\*t\)?'/.exec(part)
    const ramp = xf
      ? (t: number) => {
          const p = Number(xf[2] ?? 0) + Number(xf[3]) * t
          return xf[1] ? 1 - p : p
        }
      : null
    out.set(input.src, {
      srcStart: input.ss + Number(trim[1] ?? 0),
      srcDur: Number(trim[2]),
      speed: tempo,
      volume: Number(vol[1]),
      ramp,
    })
  }
  return out
}

const v = (id: string, start: number, end: number, over: Partial<VisualItem> = {}): VisualItem => ({
  id,
  type: 'video',
  src: `/m/${id}.mp4`,
  start,
  end,
  ...over,
})

// One project with every clip shape: a main-track crossfade into a clip at
// speed 2, a butt cut into one at speed 0.5, a video-into-image crossfade,
// overlay-track videos crossfading at their own levels (one above 1, one sped
// up), a track volume, a muted clip and a muted track. A clip in two pairs back
// to back has its own project below (TWO_PAIR_PROJECT).
const CLIP_PROJECT: EditorProject = {
  id: 'p',
  status: 'draft',
  settings: { resolution: [1080, 1920] },
  tracks: [
    {
      id: 't0',
      volume: 0.9,
      items: [
        v('A', 0, 5, { inPoint: 1 }),
        v('B', 4, 9, { inPoint: 3, speed: 2, volume: 0.7 }),
        v('C', 9, 12, { speed: 0.5 }),
        { id: 'I', type: 'image', src: '/m/I.png', start: 11.5, end: 14 },
        v('D', 14, 15, { muted: true }),
      ],
    },
    {
      id: 't1',
      items: [v('O', 2, 6, { volume: 1.8, inPoint: 10 }), v('P', 5.5, 8, { inPoint: 4, speed: 1.25 })],
    },
    { id: 't2', muted: true, items: [v('M', 0, 3)] },
  ] as VisualTrack[],
}

// Segment boundaries at every item edge, plus points strictly inside the
// crossfades and the clips, as an overlay or caption boundary would cut them.
const CUTS = [0, 1.7, 2, 3, 4, 4.4, 5, 5.5, 5.8, 6, 7.25, 8, 9, 10.2, 11.5, 11.8, 12, 14, 15]

/** Plan vs export, segment by segment: the same sources, source windows, speed, level and crossfade ramp. */
async function compareClipsToExport(project: EditorProject, cuts: number[]) {
  const plan = buildMixPlan(project, lookupAll()).plan.segments
  const planBySrc = new Map(plan.map((s) => [s.url.replace(/\.pcm$/, ''), s]))
  // As compose.js:88 hands them to the encoder: images, then videos.
  const { imageItems, videoItems } = collectAllItems(project)
  const items = [...imageItems, ...videoItems]
  let chains = 0
  let ramps = 0
  for (let c = 0; c < cuts.length - 1; c++) {
    const [s, e] = [cuts[c], cuts[c + 1]]
    const exported = await exportSegmentAudio(items, s, e)
    const planned = plan.filter((p) => p.tlStart < e && (p.tlEnd as number) > s)
    expect([...exported.keys()].sort(), `sources heard in [${s}, ${e}]`).toEqual(
      planned.map((p) => p.url.replace(/\.pcm$/, '')).sort(),
    )
    for (const [src, x] of exported) {
      const p = planBySrc.get(src)!
      const where = `${p.id} in [${s}, ${e}]`
      chains++
      expect(x.srcStart, `${where}: source start`).toBeCloseTo((p.srcIn ?? 0) + (s - p.tlStart) * (p.speed ?? 1), 9)
      expect(x.srcDur, `${where}: source consumed`).toBeCloseTo((e - s) * (p.speed ?? 1), 9)
      expect(x.speed, `${where}: speed`).toBeCloseTo(p.speed ?? 1, 12)
      expect(x.volume, `${where}: level`).toBeCloseTo(p.gain ?? 1, 12)
      if (x.ramp) ramps++
      // The export steps its ramp once per audio frame (`eval=frame`); the
      // mixer runs it per sample. The ramp itself is what must agree.
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const t = f * (e - s)
        const want = (p.gain ?? 1) * (x.ramp ? x.ramp(t) : 1)
        const got = planGain(p, s + t)
        expect(Math.abs(got - want), `${where}: level at ${s + t}: plan ${got}, export ${want}`).toBeLessThan(1e-9)
      }
    }
  }
  return { chains, ramps, planIds: plan.map((p) => p.id).sort() }
}

// A→B then B→C with B in both pairs: the incoming side of the first and the
// outgoing side of the second. The export once kept only B's second role and
// hard-cut A→B (§195); both must ramp, as the plan does.
const TWO_PAIR_PROJECT: EditorProject = {
  id: 'p2',
  status: 'draft',
  settings: { resolution: [1080, 1920] },
  tracks: [{ id: 't0', items: [v('A', 0, 5), v('B', 4, 9, { inPoint: 2 }), v('C', 8, 12)] }] as VisualTrack[],
}

describe('clips == the export (collectAllItems + encodeSegment)', () => {
  it('per segment: the same source window, speed, level and crossfade ramp; muted clips silent in both', async () => {
    const { chains, ramps, planIds } = await compareClipsToExport(CLIP_PROJECT, CUTS)
    // The fixture exercised what it is for: audio chains in every clip shape, and ramps.
    expect(chains).toBeGreaterThan(15)
    expect(ramps).toBe(10)
    expect(planIds).toEqual(['clip:A', 'clip:B', 'clip:C', 'clip:O', 'clip:P'])
  })

  it('a clip in two transitions back to back: both ramp in the export as in the plan', async () => {
    const { ramps, planIds } = await compareClipsToExport(TWO_PAIR_PROJECT, [0, 4, 4.5, 5, 8, 8.5, 9, 12])
    // A→B over [4, 5] and B→C over [8, 9], each cut in two: 2 chains ramp per piece.
    expect(ramps).toBe(8)
    expect(planIds).toEqual(['clip:A', 'clip:B', 'clip:C'])
  })
})

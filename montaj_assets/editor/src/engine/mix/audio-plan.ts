/**
 * §190 T3: the project's audio plan, built from the timeline for the mixer.
 *
 * This is the contract between the plan builder and the engine wiring. The
 * builder is pure: project + what has been conformed in, MixPlan out. The
 * engine owns fetching conform status and deciding when to hand the plan to
 * MixClock.
 *
 * ## Every rule is the export's
 *
 * Read off the code that renders the file, and held to that code by
 * `__tests__/audio-plan-parity.test.ts` (which runs the export's own functions,
 * nothing hand-copied):
 *
 * | Plan                          | Export                                                                 |
 * |-------------------------------|------------------------------------------------------------------------|
 * | which clips are heard         | `video` items on ENABLED tracks, main and overlay alike, track mute and volume folded in (`effectiveItemAudio`): render.js:1328, 1417; encode-segment.js:2154-2155 |
 * | a clip's source mapping       | source `inPoint + (t - start) * speed` over `[start, end]`: encode-segment.js:1293 (`actualIn`), 1353 (`srcDur`), 2222-2223 (`atempo`) |
 * | crossfade audio               | per track, over every image and video pair `transitionPairs` finds: the outgoing clip `1 - p`, the incoming `p`, linear over the pair's span: render.js:1508-1518; encode-segment.js:2211-2217 |
 * | a lane's window               | timeline-core `audioSourceWindow`: mix-audio.js:133-136                |
 * | a lane's fades                | `afade` starting at `start`, and ending at the DECLARED `end` (none without one), curves `tri`/`exp`/`log`: mix-audio.js:82-109 |
 * | a lane's volume and mute      | `volume=`, a muted lane left out of the mix: mix-audio.js:155-158      |
 * | ducking                       | `sidechaincompress` keyed by the mix built before the lane: mix-audio.js:162-179 (see `stage` and `duck` in mix-protocol.ts) |
 *
 * ## The sources are the ORIGINALS
 *
 * `item.src` and `track.src`, with `inPoint` in original-source seconds, which
 * is what every item stores (schema.ts; timeline-core source-window.js). The
 * preview's `proxySrc` is never used. The export may decode the picture from
 * `normalizedSrc` (a windowed re-encode, rebased) or `nobg_src` (remove_bg.py
 * muxes the original's audio into it), but the audio is the original's either
 * way, so the conform (T1) is of `src` and the mapping needs no rebase.
 *
 * ## Muted: left out, not gain 0
 *
 * The Worker's `sig` (mix-worker-source.ts `sigOf`) leaves gain out, so a
 * gain-0 segment would toggle for free: same version, same stream, a 10 ms
 * ramp. But it would also be fetched, converted, stretched (B-roll is often
 * speed-edited, and WSOLA is the Worker's costliest stage) and posted, all to
 * be multiplied by zero, and muted B-roll is the common case. And it would need
 * a conform, so a muted main-track clip with none yet would hold the engine on
 * today's path for nothing. So a muted clip or lane has no segment, as the
 * export has no input for it. The cost moves to the toggle: an unmute adds a
 * segment (a new version, one block's fetch, unless the Worker's cache still
 * holds it, then the worklet's 5 ms ramp-in), and a mute drops it at once, so
 * an engine that wants a mute to ramp sends `setParams({ [id]: { mute: true } })`
 * before the new plan. `audioSourcePaths` still lists muted sources, so an
 * unmute finds its conform waiting.
 *
 * ## One thing the plan does NOT follow the export into
 *
 * - **`loop`.** The export never reads it (timeline-core KNOWN-DIVERGENCES
 *   `loop-not-rendered-transition-dead-field`), so a looped clip's audio runs
 *   on through its source here too, as it exports.
 *
 * A clip in two pairs back to back (the incoming side of one crossfade and the
 * outgoing side of the next) gets both ramps, as the resolver's `crossfadesAt`
 * gives the picture both blends and, since §195, the export stamps both spans
 * (render.js `collectAllItems`); the parity spec holds the two together.
 */
import { audioSourceWindow, transitionPairs } from '@bycrux/timeline-core'
import type { AudioTrack, EditorProject, VisualItem, VisualTrack } from '../../schema'
import { effectiveItemAudio, enabledTracks, trackItems } from '../../video/timeline/timeline-model'
import type { MixCurve, MixDuck, MixPcmFormat, MixPlan, MixSegment } from './mix-protocol'

/** One source's conformed PCM, as `GET /api/audio/conformed` reports it. */
export interface ConformedSource {
  /** URL the Worker range-fetches (page-relative is fine; MixClock resolves it). */
  url: string
  format: MixPcmFormat
  sampleRate: number
  channels: number
  /** Total frames in the conformed file. Every segment built from it carries this. */
  frames: number
  /** The source has no audio stream, or only silence: no segment is built for it. */
  silent?: boolean
}

/** A source path as the project names it → its conform, or null while it has none (yet, or ever). */
export type ConformLookup = (src: string) => ConformedSource | null

export interface ProjectMixPlan {
  plan: MixPlan
  /** Main-track sources with audio that the plan needed but `lookup` had no conform for. */
  unconformedMain: string[]
  /** Lane (audio track) sources the plan left out for want of a conform; they keep today's playback. */
  unconformedLanes: string[]
  /** Overlay-track video sources the plan left out for want of a conform; they keep today's playback. */
  unconformedOverlays: string[]
}

/** The clips' audio mixes at this stage; lane `i` of `audio.tracks` at `i + 1`, the export's order. */
export const CLIP_STAGE = 0

/** The `threshold=` the export passes to sidechaincompress (mix-audio.js:176). */
export const EXPORT_DUCK_THRESHOLD = 0.02

/** Segment id of a video item's audio, main or overlay track. Stable across rebuilds. */
export function clipSegmentId(itemId: string): string {
  return `clip:${itemId}`
}

/** Segment id of an audio lane (`project.audio.tracks[]`). Stable across rebuilds. */
export function laneSegmentId(trackId: string): string {
  return `lane:${trackId}`
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The editor's fade shape → the mixer's, defaulting as mix-audio.js:41-43 does. */
function fadeCurve(shape: unknown): MixCurve {
  return shape === 'linear' || shape === 'log' || shape === 'exp' ? shape : 'exp'
}

/**
 * A track's `ducking` → the export's sidechaincompress options, as
 * mix-audio.js:162-171 computes them: depth -12 dB, attack 0.3 s and release
 * 0.5 s by default, and `ratio = clamp(round(10^(-depth / 20)), 1, 20)`, so
 * every depth below about -26 dB ducks as -26 dB does. A value that is not a
 * finite number takes the default (the export would hand ffmpeg a NaN and fail).
 */
export function exportDuckParams(ducking: AudioTrack['ducking']): MixDuck | null {
  if (!ducking?.enabled) return null
  const depthDb = finite(ducking.depth) ?? -12
  const attack = finite(ducking.attack) ?? 0.3
  const release = finite(ducking.release) ?? 0.5
  return {
    threshold: EXPORT_DUCK_THRESHOLD,
    ratio: Math.min(20, Math.max(1, Math.round(10 ** (-depthDb / 20)))),
    attackMs: attack * 1000,
    releaseMs: release * 1000,
  }
}

/**
 * Every source path whose audio the plan may need, for the conform request
 * when a project opens: every video item's `src` on every track and every
 * lane's, deduped in first-seen order. Muted items and skipped tracks too, so
 * an unmute or a re-enable finds its conform ready rather than sending the
 * main track back to today's path while one runs.
 */
export function audioSourcePaths(project: EditorProject): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (src: unknown) => {
    if (typeof src !== 'string' || src === '' || seen.has(src)) return
    seen.add(src)
    out.push(src)
  }
  for (const items of trackItems(project)) {
    for (const item of items) if (item?.type === 'video') add(item.src)
  }
  const lanes = project.audio?.tracks
  if (Array.isArray(lanes)) for (const lane of lanes) add(lane?.src)
  return out
}

export function buildMixPlan(project: EditorProject, lookup: ConformLookup): ProjectMixPlan {
  const segments: MixSegment[] = []
  const unconformedMain: string[] = []
  const unconformedLanes: string[] = []
  const unconformedOverlays: string[] = []

  // Ids must be unique in a plan; a duplicate item id (a malformed project)
  // takes a suffix, and the first holder keeps the plain one.
  const used = new Set<string>()
  const uniqueId = (base: string) => {
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}#${n}`
    used.add(id)
    return id
  }
  const addOnce = (list: string[], src: string) => {
    if (!list.includes(src)) list.push(src)
  }

  enabledTracks(project).forEach((track, ti) => {
    const items = track.items ?? []
    const byItem = new Map<unknown, MixSegment>()
    for (const item of items) {
      const seg = clipSegment(track, item, lookup, ti === 0 ? unconformedMain : unconformedOverlays, addOnce)
      if (seg === null) continue
      seg.id = uniqueId(seg.id)
      segments.push(seg)
      byItem.set(item, seg)
    }
    // Complementary linear ramps over each pair's span, per track, the pairs
    // found among image and video clips alike (a video crossfading into an
    // image still fades its sound out): render.js:1508-1518.
    const clips = items.filter((it) => it.type === 'image' || it.type === 'video')
    for (const pair of transitionPairs(clips)) {
      const span = pair.end - pair.start
      const from = byItem.get(pair.from)
      const to = byItem.get(pair.to)
      // The outgoing clip's fade-out ends at its own end, which IS the pair's;
      // the incoming clip's fade-in starts at its own start, the pair's start.
      if (from) {
        from.fadeOut = span
        from.curveOut = 'linear'
      }
      if (to) {
        to.fadeIn = span
        to.curveIn = 'linear'
      }
    }
  })

  const lanes = project.audio?.tracks
  if (Array.isArray(lanes)) {
    lanes.forEach((lane, i) => {
      const seg = laneSegment(lane, i, lookup, unconformedLanes, addOnce)
      if (seg === null) return
      seg.id = uniqueId(seg.id)
      segments.push(seg)
    })
  }

  return { plan: { segments }, unconformedMain, unconformedLanes, unconformedOverlays }
}

function sourceFields(c: ConformedSource, frames = c.frames) {
  return { url: c.url, format: c.format, sampleRate: c.sampleRate, channels: c.channels, frames }
}

/**
 * A video item's audio, or null when it has none to play. The window is the
 * item's span on the timeline, `[start, end]`, reading the source from
 * `inPoint` at `speed` source seconds per timeline second; past the end of the
 * file it is silence, as the export pads it (encode-segment.js:2325).
 */
function clipSegment(
  track: VisualTrack,
  item: VisualItem,
  lookup: ConformLookup,
  unconformed: string[],
  addOnce: (list: string[], src: string) => void,
): MixSegment | null {
  if (item?.type !== 'video' || typeof item.src !== 'string' || item.src === '') return null
  const start = finite(item.start)
  const end = finite(item.end)
  if (start === null || end === null || !(end > start)) return null
  const { volume, muted } = effectiveItemAudio(track, item)
  if (muted) return null
  const c = lookup(item.src)
  if (c === null) {
    addOnce(unconformed, item.src)
    return null
  }
  if (c.silent || !(c.frames > 0)) return null
  // A negative inPoint is no seek at the clip's start (twoStageSeek, encode-segment.js:122).
  const srcIn = Math.max(0, finite(item.inPoint) ?? 0)
  if (srcIn * c.sampleRate >= c.frames) return null // starts past its audio: silent throughout
  const speed = finite(item.speed)
  return {
    id: clipSegmentId(item.id),
    ...sourceFields(c),
    tlStart: start,
    tlEnd: end,
    srcIn,
    speed: speed !== null && speed > 0 ? speed : 1,
    gain: finite(volume) ?? 1,
    stage: CLIP_STAGE,
  }
}

/**
 * A lane, or null when it has nothing to play. `audioSourceWindow` decides
 * where it plays; it stops at whichever of `end`, `outPoint` and the end of
 * the file comes first.
 *
 * The fade-out ENDS at the declared `end` (mix-audio.js:105-107), which can lie
 * past where the source stops (an `outPoint` short of the span, or a file
 * shorter than it). So with a fade-out the segment runs to `end`, and
 * `frames` stops the source at the `outPoint` instead: the Worker reads
 * nothing past `frames` and plays silence there, which is where the export's
 * `-to` cuts the input. The one shape this cannot express: a fade-out longer
 * than the lane's `end` itself, where the export clamps its start to 0
 * (`Math.max(0, end - fadeOut)`) and the fade then ends after `end`.
 */
function laneSegment(
  lane: AudioTrack,
  index: number,
  lookup: ConformLookup,
  unconformed: string[],
  addOnce: (list: string[], src: string) => void,
): MixSegment | null {
  if (!lane || typeof lane !== 'object' || lane.muted) return null
  if (typeof lane.src !== 'string' || lane.src === '') return null
  const c = lookup(lane.src)
  if (c === null) {
    addOnce(unconformed, lane.src)
    return null
  }
  if (c.silent || !(c.frames > 0)) return null
  const win = audioSourceWindow(lane)
  const srcStop = Math.min(win.outPoint ?? Infinity, c.frames / c.sampleRate)
  if (!(srcStop > win.inPoint)) return null
  const audibleEnd = win.start + (srcStop - win.inPoint)
  const fadeIn = Math.max(0, finite(lane.fadeIn) ?? 0)
  const fadeOut = win.end !== null ? Math.max(0, finite(lane.fadeOut) ?? 0) : 0
  const frames = win.outPoint !== null ? Math.min(c.frames, Math.round(win.outPoint * c.sampleRate)) : c.frames
  const seg: MixSegment = {
    id: laneSegmentId(lane.id),
    ...sourceFields(c, frames),
    tlStart: win.start,
    tlEnd: fadeOut > 0 && win.end !== null ? win.end : audibleEnd,
    srcIn: win.inPoint,
    speed: 1,
    gain: finite(lane.volume) ?? 1,
    stage: CLIP_STAGE + 1 + index,
  }
  if (fadeIn > 0) {
    seg.fadeIn = fadeIn
    seg.curveIn = fadeCurve(lane.fadeInCurve)
  }
  if (fadeOut > 0) {
    seg.fadeOut = fadeOut
    seg.curveOut = fadeCurve(lane.fadeOutCurve)
  }
  const duck = exportDuckParams(lane.ducking)
  if (duck !== null) seg.duck = duck
  return seg
}

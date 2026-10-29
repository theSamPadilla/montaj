// render/nle/timeline.js
/**
 * The Montaj timeline as an EDITOR timeline: a flat, frame-quantised model that
 * the FCP7 XML writer (`nle/xmeml.js`) and the graphics renderer read to hand
 * an edit to Premiere Pro or DaVinci Resolve.
 *
 * `buildNleTimeline(project, { projectDir })` is pure: no disk, no ffprobe, no
 * clock, and the project is never mutated. Every timing decision is taken from
 * `@bycrux/timeline-core` and the render's own helpers rather than restated, so
 * the export can never disagree with the render about what is on screen:
 *
 *   - track access     project-tracks.js (`enabledTracks`, `withEnabledItemTracks`,
 *                      `effectiveItemAudio`): a disabled track is skipped, both
 *                      `tracks` shapes are read, track volume/mute fold in.
 *   - frames           `frameGrid(fps)`; see QUANTISATION below.
 *   - duration         `visualDuration` over the enabled tracks (render.js's
 *                      `getTotalDurationSeconds`).
 *   - source windows   `sourceWindow` / `seekTime` with the 'render' variant.
 *   - crossfades       `transitionPairs`, the one definition of a crossfade.
 *   - audio windows    `audioSourceWindow`, the one definition of where an
 *                      `audio.tracks` entry plays.
 *   - geometry         `geometryFor` / `imageFitFor`, the static placement.
 *   - paths            `resolveProjectSrc` (project-paths.js), the rule
 *                      render.js and sample-frame.js resolve `src` with.
 *
 * ── QUANTISATION ────────────────────────────────────────────────────────────
 *
 * A timeline time `t` (seconds) lands on frame
 *
 *     frameGrid(fps).frameOf(frameGrid(fps).boundary(t))  ==  max(0, round(t * fps))
 *
 * which is exactly the render's segment planner (`boundariesFrom`, used by
 * segment-plan.js): every item edge is snapped to the NEAREST frame and floored
 * at the timeline origin. Spans are half-open `[startFrame, endFrame)`. The
 * render then shows on frame f whatever covers it, which is also what
 * `resolveAt` reports at the frame's centre `(f + 0.5) / fps`; the test suite
 * checks both, frame by frame. `fps` is `settings.fps || 30`, as render.js.
 *
 * Source positions are NOT quantised: `sourceIn`/`sourceOut` are seconds in the
 * source file, `sourceIn` being where the render seeks on the clip's first
 * frame (`seekTime`, i.e. `inPoint + speed * max(0, t - start)`) and
 * `sourceOut = sourceIn + speed * (endFrame - startFrame) / fps`, so a clip's
 * source length always matches its frame length. It can differ from a stored
 * `outPoint` by under a frame, which the render never reads either.
 *
 * ── Z-ORDER ─────────────────────────────────────────────────────────────────
 *
 * `videoTracks` is bottom to top, in the order the render composites: every
 * clip track (video and image items, `tracks[0]` first), THEN every graphics
 * track (overlay items, again in track order). The render draws all overlays
 * over all clips whatever their track index (encode-segment.js steps 2 and 3;
 * sample-frame.js says the same), so a graphic on `tracks[1]` sits above a
 * video on `tracks[2]` here too. Captions are topmost and kept apart in
 * `captionsTrack`.
 *
 * One editor track cannot hold two overlapping clips, but a Montaj track can:
 * nested clips on `tracks[0]`, overlapping overlays, three clips live at once.
 * Such items SPILL to extra lanes, one editor track each, placed directly above
 * their Montaj track's first lane. An item goes one lane above every earlier
 * item (in document order) it overlaps, so the later item is on top, which is
 * `resolveAt`'s same-track order (its stable sort keeps document order).
 *
 * ── CROSSFADES ──────────────────────────────────────────────────────────────
 *
 * A crossfade is two neighbouring clips overlapping on one track
 * (`transitionPairs`; an overlap of 1 ms or less is a hard cut). An editor
 * track cannot overlap two clips, so each pair becomes two ABUTTING clips cut
 * at the overlap's midpoint, `cutFrame = startFrame + floor(durationFrames/2)`,
 * plus a `Transition` spanning the whole overlap `[startFrame, endFrame)`. The
 * outgoing clip's media past the cut and the incoming clip's media before it
 * are the transition's handles, and both exist because the items really did
 * cover the overlap. An overlap that rounds to zero frames is a hard cut, as in
 * the render, whose frame-deduped boundaries leave no frame to blend. Pairs
 * whose overlaps intersect (three clips live at once, which validate rejects)
 * and pairs whose sides land on different lanes are not transitions: both
 * clips keep their full spans and spill.
 *
 * Overlays never form a `Transition`: an overlay crossfade is real `opacity`
 * keyframe data on the items (activation.js, "crossfades are stamped for CLIPS
 * ONLY").
 *
 * ── SOUND ───────────────────────────────────────────────────────────────────
 *
 * Every video clip gets a linked `AudioClip` (`muted: true` when the clip or its
 * track is muted: the editor gets the clip disabled) on a `'video'` audio track that mirrors its video lane, with the same window
 * and the same transitions. Whether the file has an audio stream is not
 * knowable here; the writer's probe drops the clip when it has none, as the
 * render's `hasAudio` check does. Where only one side of a crossfade has sound,
 * the render fades that side alone across the whole overlap (encode-segment.js,
 * the linear `volume` ramp gated on the pair), so its audio clip keeps its full
 * span over the overlap and carries a linear fade instead of a transition.
 *
 * Every `audio.tracks` entry becomes its own audio track.
 *
 * ── LEFT OUT ────────────────────────────────────────────────────────────────
 *
 * What a clip loses in the editor is listed in its `unsupported`, so the writer
 * can put a marker on it naming each one; what the whole edit loses is in
 * `warnings`. Only what the RENDER honours is listed.
 *
 *   'keyframes:<prop>'   a keyframed property; the clip carries its static value.
 *                        Opacity and the mask props (maskX..maskFeather) are
 *                        listed on every clip.
 *   'mask'               a clip's mask (non-graphic clips).
 *   'blendMode:<mode>'   a blend mode other than normal (non-graphic clips).
 *   'loop'               a looping video (the editor preview loops it).
 *   'remove_bg'          background removal with no cutout file yet: the
 *                        original, background and all, is linked.
 *   'remove_bg:nobg_src' the cutout (`nobg_src`) is linked in place of the
 *                        original, as the render does.
 *   'motionBlur'         on graphics and captions when `settings.motionBlur` > 1
 *                        (the only layers the render blurs), plus one warning.
 *   'ducking'            an `audio.tracks` entry ducked under speech.
 *
 * Project warnings: an HDR `colorSpace`, `settings.motionBlur`,
 * `settings.loudness`, a rounded `fps`, and every item skipped or degraded.
 */
import {
  frameGrid,
  sourceWindow,
  seekTime,
  transitionPairs,
  visualDuration,
  audioSourceWindow,
  geometryFor,
  imageFitFor,
  isFullFrameCrop,
  opaqueReplacesPicture,
  maskAt,
  MASK_KEYFRAME_PROPS,
  MASK_POINTS_PROP,
  blendModeOf,
} from '@bycrux/timeline-core'
import { enabledTracks, withEnabledItemTracks, effectiveItemAudio } from '../project-tracks.js'
import { resolveProjectSrc } from '../project-paths.js'
import { isHdr, DEFAULT_COLOR_SPACE } from '../color-space.js'
import { resolveMotionBlur } from '../motion-blur.js'

/**
 * @typedef {Object} NleTimeline
 * @property {number} fps            Sequence frame rate: `settings.fps || 30`, a whole number.
 * @property {number} width          `settings.resolution[0]` (default 1080).
 * @property {number} height         `settings.resolution[1]` (default 1920).
 * @property {string} colorSpace     `settings.colorSpace ?? 'sdr_bt709'`.
 * @property {number} motionBlur     `settings.motionBlur`, 1 = off.
 * @property {number} durationFrames The render's length: `visualDuration` over enabled tracks, quantised.
 *   `audio.tracks` can run past it, as they can past the render's picture.
 * @property {NleVideoTrack[]} videoTracks  Bottom to top. See Z-ORDER.
 * @property {NleCaptionsTrack | null} captionsTrack  Topmost; null without caption segments.
 * @property {NleAudioTrack[]} audioTracks  Linked video sound first (in video track order), then `audio.tracks`.
 * @property {Object<string, NleSource>} sources  Every distinct media file, keyed by absolute path, for the probe.
 * @property {string[]} warnings      What the whole edit loses, and every item skipped.
 */

/**
 * @typedef {Object} NleVideoTrack
 * @property {number} index       Position in `videoTracks`, 0 = bottom.
 * @property {'footage' | 'layer' | 'graphics'} role
 *   'footage' = clips of `tracks[0]`; 'layer' = clips of `tracks[1+]`; 'graphics' = overlays of any track.
 * @property {number} trackIndex  The Montaj track the clips come from.
 * @property {number} lane        0, or the spill lane (see Z-ORDER).
 * @property {NleClip[]} clips    By `startFrame`, never overlapping.
 * @property {NleTransition[]} transitions
 */

/**
 * @typedef {Object} NleClip
 * @property {string} id          The item's `id` (made unique when missing or repeated).
 * @property {'video' | 'image' | 'graphic'} kind  'graphic' = an overlay (JSX); the graphics renderer turns it into a clip.
 * @property {number} trackIndex  Montaj track index.
 * @property {number} itemIndex   Index in that track's `items`.
 * @property {string} src         Absolute. Video: the ORIGINAL file (never `normalizedSrc`), or the
 *   `nobg_src` cutout when background removal is on. Image: the image. Graphic: the JSX component.
 * @property {number} startFrame  Sequence frame, inclusive.
 * @property {number} endFrame    Sequence frame, exclusive.
 * @property {number | null} sourceIn   Video: seconds in `src`. Graphic: seconds on the overlay's own
 *   clock (0 unless it starts before the timeline). Image: null.
 * @property {number | null} sourceOut  `sourceIn + speed * (endFrame - startFrame) / fps`; null for images.
 * @property {number} speed       Video `speed` (default 1); 1 for images and graphics.
 * @property {number | null} volume  Video: clip volume x track volume (`effectiveItemAudio`). Else null.
 * @property {boolean | null} muted  Video: clip or track muted. Else null.
 * @property {number} opacity     Static `opacity`, default 1.
 * @property {NleTransform} transform  Static placement (`geometryFor`).
 * @property {{x: number, y: number, w: number, h: number} | null} crop
 *   `sourceCrop` as fractions of the displayed source; null when absent, full-frame, or (video) without
 *   `sourceWidth`/`sourceHeight`, which the render drops too.
 * @property {{width: number, height: number} | null} sourceSize  Video `sourceWidth`/`sourceHeight` (display size).
 * @property {boolean} opaque     Graphic covering the whole canvas opaquely (`opaqueReplacesPicture`).
 * @property {string[]} unsupported  What this clip loses in the editor. See LEFT OUT.
 */

/**
 * @typedef {Object} NleTransform
 * @property {number} scale    Uniform scale (percent-of-frame box, see timeline-core geometry.js).
 * @property {number} scaleX   `scaleX ?? scale ?? 1`.
 * @property {number} scaleY   `scaleY ?? scale ?? 1`.
 * @property {number} offsetX  Percent of frame width.
 * @property {number} offsetY  Percent of frame height.
 * @property {number} rotation Degrees, clockwise.
 * @property {'cover' | 'contain' | 'fill' | null} fit  Video 'contain'; image its fit; graphic null.
 */

/**
 * @typedef {Object} NleTransition
 * @property {number} trackIndex  Montaj track index.
 * @property {number} lane
 * @property {string} fromClipId  The outgoing clip, which ends at `cutFrame`.
 * @property {string} toClipId    The incoming clip, which starts at `cutFrame`.
 * @property {number} startFrame  The overlap's first frame.
 * @property {number} cutFrame    `startFrame + floor(durationFrames / 2)`.
 * @property {number} endFrame    The overlap's end, exclusive.
 * @property {number} durationFrames  `endFrame - startFrame`, at least 1.
 */

/**
 * @typedef {Object} NleCaptionsTrack
 * @property {NleCaptionsClip[]} clips  One placeholder; the graphics renderer renders the caption layer into it.
 */

/**
 * @typedef {Object} NleCaptionsClip
 * @property {string} id
 * @property {'captions'} kind
 * @property {number} startFrame    The first segment's start.
 * @property {number} endFrame      The last segment's end, clipped to `durationFrames`.
 * @property {number} sourceIn      Timeline seconds at `startFrame` (captions run on timeline time).
 * @property {number} sourceOut     Timeline seconds at `endFrame`.
 * @property {number} segmentCount  Segments with a numeric start and end.
 * @property {string | null} style
 * @property {string[]} unsupported
 */

/**
 * @typedef {Object} NleAudioTrack
 * @property {number} index            Position in `audioTracks`.
 * @property {'video' | 'audio.tracks'} source
 * @property {number | null} trackIndex  'video': the Montaj visual track. Else null.
 * @property {number | null} lane        'video': the video lane it mirrors. Else null.
 * @property {number | null} audioIndex  'audio.tracks': index in `project.audio.tracks`. Else null.
 * @property {NleAudioClip[]} clips
 * @property {NleTransition[]} transitions  Cross fades mirroring the video transitions ('video' only).
 */

/**
 * @typedef {Object} NleAudioClip
 * @property {string} id         Linked: `<clip id>:audio`. Else the track's `id`, or `audio-<i>`.
 * @property {string} src        Absolute.
 * @property {number} startFrame
 * @property {number | null} endFrame   null = plays to the end of its file (no `end`, no `outPoint`).
 * @property {number} sourceIn   Seconds in `src`.
 * @property {number | null} sourceOut  null with `endFrame`.
 * @property {number} speed
 * @property {number} volume     Linear gain.
 * @property {boolean} muted     An `audio.tracks` entry that is muted (the render skips it).
 * @property {number} fadeInFrames
 * @property {number} fadeOutFrames
 * @property {'linear' | 'log' | 'exp' | null} fadeInCurve   null when there is no fade-in.
 * @property {'linear' | 'log' | 'exp' | null} fadeOutCurve  null when there is no fade-out.
 * @property {string | null} linkedClipId  The video clip whose sound this is.
 * @property {string[]} unsupported
 */

/**
 * @typedef {Object} NleSource
 * @property {string} firstSeenItem  The id of the first clip that uses the file.
 * @property {'video' | 'image' | 'audio'} kind
 */

/** The shape of the render's default fade (mix-audio.js, `ffmpegFadeCurve`). */
const DEFAULT_FADE_CURVE = 'exp'

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Build the editor timeline for `project`.
 *
 * @param {object} project  A Montaj project (either `tracks` shape).
 * @param {{ projectDir: string }} options  The folder holding project.json; relative paths resolve against it.
 * @returns {NleTimeline}
 */
export function buildNleTimeline(project, { projectDir } = /** @type {any} */ ({})) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new TypeError('buildNleTimeline: options.projectDir is required')
  }
  const warnings = []
  const settings = project?.settings ?? {}

  const fps = sequenceFps(settings.fps, warnings)
  const grid = frameGrid(fps)
  /** @param {number} t @returns {number} */
  const toFrame = (t) => grid.frameOf(grid.boundary(t))

  const resolution = Array.isArray(settings.resolution) ? settings.resolution : []
  const width = resolution[0] ?? 1080
  const height = resolution[1] ?? 1920
  const colorSpace = settings.colorSpace ?? DEFAULT_COLOR_SPACE
  const motionBlur = projectMotionBlur(settings.motionBlur, warnings)
  if (isHdr(colorSpace)) {
    warnings.push(`HDR project (${colorSpace}): the footage is linked as shot; the render's colour conversion and look are not applied`)
  }
  if (motionBlur > 1) {
    warnings.push(`motion blur (${motionBlur} sub-frames) is not in the timeline: graphics and captions are marked`)
  }
  if (settings.loudness !== undefined && settings.loudness !== null) {
    warnings.push(`loudness normalization (${settings.loudness} LUFS) of the final mix is not in the timeline`)
  }

  const durationFrames = toFrame(visualDuration(withEnabledItemTracks(project ?? {})))

  /** @type {Object<string, NleSource>} */
  const sources = {}
  const noteSource = (src, id, kind) => { if (!(src in sources)) sources[src] = { firstSeenItem: id, kind } }
  const uniqueId = idAllocator()

  const ctx = { fps, toFrame, projectDir, motionBlur, warnings, uniqueId, noteSource }

  const clipTracks = []
  const graphicTracks = []
  const linkedAudioTracks = []
  enabledTracks(project ?? {}).forEach((track, trackIndex) => {
    if (track.enabled === false) return
    const { clipLanes, graphicLanes, audioLanes } = buildTrack(track, trackIndex, ctx)
    clipTracks.push(...clipLanes)
    graphicTracks.push(...graphicLanes)
    linkedAudioTracks.push(...audioLanes)
  })

  // A project.json still carrying the retired `renderMode: 'ffmpeg-drawtext'`
  // is not looked at: the field is ignored and the project builds as usual.
  const videoTracks = [...clipTracks, ...graphicTracks].map((t, index) => ({ index, ...t }))

  const captionsTrack = buildCaptions(project?.captions, durationFrames, ctx)

  const audioTracks = [
    ...linkedAudioTracks,
    ...buildAudioTracks(project?.audio?.tracks, ctx),
  ].map((t, index) => ({ index, ...t }))

  return {
    fps,
    width,
    height,
    colorSpace,
    motionBlur,
    durationFrames,
    videoTracks,
    captionsTrack,
    audioTracks,
    sources,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `settings.fps || 30` (render.js), rounded with a warning when not whole: an editor timebase is an integer. */
function sequenceFps(raw, warnings) {
  const fps = raw || 30
  if (Number.isInteger(fps) && fps > 0) return fps
  const rounded = Math.max(1, Math.round(Number(fps)) || 30)
  warnings.push(`settings.fps ${JSON.stringify(raw)} is not a whole number; the sequence runs at ${rounded} fps`)
  return rounded
}

/** `resolveMotionBlur` (the render's own check); an invalid value, which fails the render, warns here. */
function projectMotionBlur(raw, warnings) {
  try {
    return resolveMotionBlur(raw)
  } catch (e) {
    warnings.push(`${e.message}; exported without motion blur`)
    return 1
  }
}

/** Ids unique across every clip and audio clip, so the writer can use them as XML ids. */
function idAllocator() {
  const used = new Set()
  return (wanted, fallback) => {
    let id = typeof wanted === 'string' && wanted.length > 0 ? wanted : fallback
    if (used.has(id)) {
      let n = 2
      while (used.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    used.add(id)
    return id
  }
}

// ---------------------------------------------------------------------------
// Visual tracks
// ---------------------------------------------------------------------------

const KIND_OF_TYPE = { video: 'video', image: 'image', overlay: 'graphic' }

/**
 * One Montaj track → its clip lanes, graphics lanes and linked-audio lanes.
 *
 * Every entry below starts life as `{ item, itemIndex, kind, id, startFrame,
 * endFrame, ... }` with its RAW quantised span; crossfades then trim the
 * spans, lanes are assigned, and only then are source windows computed, from
 * the final frames.
 */
function buildTrack(track, trackIndex, ctx) {
  const { toFrame, warnings, uniqueId } = ctx
  const clipEntries = []
  const graphicEntries = []

  ;(track.items ?? []).forEach((item, itemIndex) => {
    const kind = KIND_OF_TYPE[item?.type]
    const label = `track ${trackIndex} item ${item?.id ?? itemIndex}`
    if (!kind) {
      warnings.push(`${label}: type ${JSON.stringify(item?.type)} is not exported`)
      return
    }
    if (!finite(item.start) || !finite(item.end)) {
      warnings.push(`${label}: start/end are not numbers; skipped`)
      return
    }
    const startFrame = toFrame(item.start)
    const endFrame = toFrame(item.end)
    // Nothing of it reaches a frame of the render (sub-frame, or before 0).
    if (endFrame <= startFrame) return

    const entry = { item, itemIndex, kind, startFrame, endFrame, rawStartFrame: startFrame, rawEndFrame: endFrame, lane: 0 }
    if (kind === 'video') {
      entry.link = linkView(item, ctx.projectDir)
      const { src } = sourceWindow(entry.link, 'render')
      if (!src) {
        warnings.push(`${label}: video has no src; skipped`)
        return
      }
      entry.src = src
    } else {
      if (!item.src) {
        warnings.push(`${label}: ${item.type} has no src; skipped`)
        return
      }
      entry.src = resolveProjectSrc(item.src, ctx.projectDir)
    }
    entry.id = uniqueId(item.id, `track${trackIndex}-item${itemIndex}`)
    ;(kind === 'graphic' ? graphicEntries : clipEntries).push(entry)
  })

  // The render pairs over the track's raw image/video items (render.js
  // collectAllItems, activation.js transitionPairsFor), so pair over the same.
  const clipItems = (track.items ?? []).filter((it) => it?.type === 'image' || it?.type === 'video')
  const crossfades = planCrossfades(clipEntries, clipItems, trackIndex, ctx)
  layOutLanes(clipEntries, crossfades, trackIndex, warnings)
  assignLanes(graphicEntries)

  const clipLanes = lanesOf(clipEntries).map((entries, lane) => ({
    role: trackIndex === 0 ? 'footage' : 'layer',
    trackIndex,
    lane,
    clips: entries.map((e) => toClip(e, track, trackIndex, ctx)),
    transitions: crossfades.filter((x) => x.ok && x.from.lane === lane).map((x) => transitionOf(x, trackIndex, lane)),
  }))
  const graphicLanes = lanesOf(graphicEntries).map((entries, lane) => ({
    role: 'graphics',
    trackIndex,
    lane,
    clips: entries.map((e) => toClip(e, track, trackIndex, ctx)),
    transitions: [],
  }))

  const audioLanes = []
  lanesOf(clipEntries).forEach((entries, lane) => {
    const audio = linkedAudio(entries, crossfades.filter((x) => x.ok && x.from.lane === lane), track, trackIndex, lane, ctx)
    if (audio) audioLanes.push(audio)
  })

  return { clipLanes, graphicLanes, audioLanes }
}

/**
 * The item the editor links: the ORIGINAL file, never the normalized cache,
 * with paths resolved. `sourceWindow(..., 'render')` over this view picks the
 * same file the render would pick apart from the cache (the `nobg_src` cutout
 * when `remove_bg` is on and one exists) and reports in/out points in that
 * file's own coordinates, with no cache rebase.
 */
function linkView(item, projectDir) {
  const { normalizedSrc: _n, normalizedInPoint: _o, ...rest } = item
  rest.src = resolveProjectSrc(item.src, projectDir)
  if (item.nobg_src) rest.nobg_src = resolveProjectSrc(item.nobg_src, projectDir)
  return rest
}

/**
 * Pair the track's clips with `transitionPairs`, quantise each overlap, drop
 * what cannot be an editor transition, and trim the survivors to the midpoint
 * cut. Returns every candidate; `ok` marks the real transitions.
 */
function planCrossfades(entries, clipItems, trackIndex, { toFrame, warnings }) {
  const byItem = new Map(entries.map((e) => [e.item, e]))
  const candidates = []
  for (const pair of transitionPairs(clipItems)) {
    const from = byItem.get(pair.from)
    const to = byItem.get(pair.to)
    if (!from || !to) continue
    const startFrame = toFrame(pair.start)
    const endFrame = toFrame(pair.end)
    // Rounds to no frame at all: the render's deduped boundaries leave nothing to blend.
    if (endFrame <= startFrame) continue
    candidates.push({ from, to, startFrame, endFrame, cutFrame: 0, ok: true })
  }

  // Overlaps that intersect: three or more clips live at once. No honest
  // from/to (activation.js, crossfadesAt), so none of them is a transition.
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length && candidates[j].startFrame < candidates[i].endFrame; j++) {
      if (candidates[i].ok || candidates[j].ok) {
        warnings.push(`track ${trackIndex}: three or more clips are on screen at once at frame ${candidates[j].startFrame}; exported without those crossfades`)
      }
      candidates[i].ok = false
      candidates[j].ok = false
    }
  }

  for (const c of candidates) {
    if (!c.ok) continue
    const cutFrame = c.startFrame + Math.floor((c.endFrame - c.startFrame) / 2)
    if (!(c.from.startFrame < cutFrame && cutFrame < c.to.endFrame)) {
      c.ok = false
      continue
    }
    c.cutFrame = cutFrame
    c.from.endFrame = cutFrame
    c.to.startFrame = cutFrame
  }
  return candidates
}

/**
 * Assign lanes; a transition whose two sides land on different lanes cannot be
 * an editor transition, so it is undone (both clips get their spans back) and
 * the lanes recomputed, until every surviving transition sits on one lane.
 */
function layOutLanes(entries, crossfades, trackIndex, warnings) {
  for (;;) {
    assignLanes(entries)
    const broken = crossfades.filter((c) => c.ok && c.from.lane !== c.to.lane)
    if (broken.length === 0) return
    for (const c of broken) {
      c.ok = false
      c.from.endFrame = c.from.rawEndFrame
      c.to.startFrame = c.to.rawStartFrame
      warnings.push(`track ${trackIndex}: the crossfade from ${c.from.id} to ${c.to.id} overlaps another clip; exported as two layered clips`)
    }
  }
}

/** Each entry, in document order, goes one lane above every earlier entry it overlaps. */
function assignLanes(entries) {
  const placed = []
  for (const e of entries) {
    let lane = 0
    for (const p of placed) {
      if (p.startFrame < e.endFrame && e.startFrame < p.endFrame) lane = Math.max(lane, p.lane + 1)
    }
    e.lane = lane
    placed.push(e)
  }
}

/** Entries grouped by lane (dense from 0), each lane by `startFrame`. */
function lanesOf(entries) {
  const lanes = []
  for (const e of entries) (lanes[e.lane] ??= []).push(e)
  return lanes.map((l) => [...l].sort((a, b) => a.startFrame - b.startFrame))
}

function transitionOf(c, trackIndex, lane, ids = { from: c.from.id, to: c.to.id }) {
  return {
    trackIndex,
    lane,
    fromClipId: ids.from,
    toClipId: ids.to,
    startFrame: c.startFrame,
    cutFrame: c.cutFrame,
    endFrame: c.endFrame,
    durationFrames: c.endFrame - c.startFrame,
  }
}

/** Where the render seeks a video entry at `startFrame`, and the matching out point. */
function videoWindow(entry, startFrame, endFrame, fps) {
  const speed = entry.item.speed ?? 1
  const sourceIn = seekTime(entry.link, startFrame / fps, 'render')
  return { sourceIn, sourceOut: sourceIn + (speed * (endFrame - startFrame)) / fps }
}

/** @returns {NleClip} */
function toClip(entry, track, trackIndex, ctx) {
  const { item, kind } = entry
  const { fps, motionBlur, noteSource } = ctx
  const geoKind = kind === 'graphic' ? 'overlay' : kind
  const g = geometryFor(item, geoKind)
  const fit = kind === 'image' ? imageFitFor(item) : (g.fit ?? null)

  let sourceIn = null
  let sourceOut = null
  let volume = null
  let muted = null
  let speed = 1
  if (kind === 'video') {
    ;({ sourceIn, sourceOut } = videoWindow(entry, entry.startFrame, entry.endFrame, fps))
    ;({ volume, muted } = effectiveItemAudio(track, item))
    speed = item.speed ?? 1
  } else if (kind === 'graphic') {
    // The overlay's own clock, as the render runs it: its capture starts at
    // its quantised start (render.js collectPuppeteerSegments, not floored at
    // 0), so a graphic starting before the timeline is already partway in.
    sourceIn = (entry.startFrame - Math.round(item.start * fps)) / fps
    sourceOut = sourceIn + (entry.endFrame - entry.startFrame) / fps
  }

  if (kind !== 'graphic') noteSource(entry.src, entry.id, kind)

  return {
    id: entry.id,
    kind,
    trackIndex,
    itemIndex: entry.itemIndex,
    src: entry.src,
    startFrame: entry.startFrame,
    endFrame: entry.endFrame,
    sourceIn,
    sourceOut,
    speed,
    volume,
    muted,
    opacity: g.opacity,
    transform: {
      scale: g.scale,
      scaleX: g.scaleX,
      scaleY: g.scaleY,
      offsetX: g.offsetX,
      offsetY: g.offsetY,
      rotation: g.rotation,
      fit,
    },
    crop: cropOf(item, kind),
    sourceSize: kind === 'video' && item.sourceWidth > 0 && item.sourceHeight > 0
      ? { width: item.sourceWidth, height: item.sourceHeight }
      : null,
    opaque: kind === 'graphic' ? opaqueReplacesPicture(item) : false,
    unsupported: unsupportedOf(entry, motionBlur),
  }
}

/**
 * The static source crop. A video crops only with its display size
 * (encode-segment.js gates the crop filter on `sourceWidth && sourceHeight`),
 * so without one the render shows it uncropped and so does the editor.
 */
function cropOf(item, kind) {
  const sc = item.sourceCrop
  if (kind === 'graphic' || !sc || isFullFrameCrop(sc)) return null
  if (kind === 'video' && !(item.sourceWidth && item.sourceHeight)) return null
  return { x: sc.x, y: sc.y, w: sc.w, h: sc.h }
}

/** See LEFT OUT in the module header. */
function unsupportedOf(entry, motionBlur) {
  const { item, kind } = entry
  const out = []
  // A mask that is turned off draws nothing, so its tracks are not left out.
  const maskOff = kind !== 'graphic' && !maskAt(item, 0)
  for (const track of Array.isArray(item.keyframes) ? item.keyframes : []) {
    if (!track || !Array.isArray(track.points) || track.points.length === 0) continue
    if (maskOff && (MASK_KEYFRAME_PROPS.includes(track.prop) || track.prop === MASK_POINTS_PROP)) continue
    const mark = `keyframes:${track.prop}`
    if (!out.includes(mark)) out.push(mark)
  }
  if (kind !== 'graphic') {
    if (maskAt(item, 0)) out.push('mask')
    const blend = blendModeOf(item)
    if (blend !== 'normal') out.push(`blendMode:${blend}`)
  }
  if (kind === 'video' && item.loop) out.push('loop')
  if (kind === 'video' && item.remove_bg) {
    out.push(entry.link.nobg_src ? 'remove_bg:nobg_src' : 'remove_bg')
  }
  if (kind === 'graphic' && motionBlur > 1) out.push('motionBlur')
  return out
}

// ---------------------------------------------------------------------------
// Linked video sound
// ---------------------------------------------------------------------------

/**
 * The sound of one video lane: an `AudioClip` per audible video clip, with the
 * crossfades mirrored. Null when the lane has no audible video.
 */
function linkedAudio(entries, crossfades, track, trackIndex, lane, ctx) {
  const { fps } = ctx
  const byEntry = new Map()
  for (const e of entries) {
    if (e.kind !== 'video') continue
    const { volume, muted } = effectiveItemAudio(track, e.item)
    byEntry.set(e, {
      entry: e,
      id: ctx.uniqueId(`${e.id}:audio`, `${e.id}:audio`),
      startFrame: e.startFrame,
      endFrame: e.endFrame,
      volume,
      muted: Boolean(muted),
      fadeInFrames: 0,
      fadeOutFrames: 0,
      fadeInCurve: null,
      fadeOutCurve: null,
    })
  }
  if (byEntry.size === 0) return null

  const transitions = []
  for (const c of crossfades) {
    const from = byEntry.get(c.from)
    const to = byEntry.get(c.to)
    if (from && to) {
      transitions.push(transitionOf(c, trackIndex, lane, { from: from.id, to: to.id }))
    } else if (from) {
      // Only the outgoing side has sound: it plays on through the overlap,
      // fading out linearly (the render's per-item crossfade ramp).
      from.endFrame = c.endFrame
      from.fadeOutFrames = c.endFrame - c.startFrame
      from.fadeOutCurve = 'linear'
    } else if (to) {
      to.startFrame = c.startFrame
      to.fadeInFrames = c.endFrame - c.startFrame
      to.fadeInCurve = 'linear'
    }
  }

  const clips = [...byEntry.values()]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((a) => {
      const { sourceIn, sourceOut } = videoWindow(a.entry, a.startFrame, a.endFrame, fps)
      return {
        id: a.id,
        src: a.entry.src,
        startFrame: a.startFrame,
        endFrame: a.endFrame,
        sourceIn,
        sourceOut,
        speed: a.entry.item.speed ?? 1,
        volume: a.volume,
        muted: a.muted,
        fadeInFrames: a.fadeInFrames,
        fadeOutFrames: a.fadeOutFrames,
        fadeInCurve: a.fadeInCurve,
        fadeOutCurve: a.fadeOutCurve,
        linkedClipId: a.entry.id,
        unsupported: [],
      }
    })

  return { source: 'video', trackIndex, lane, audioIndex: null, clips, transitions }
}

// ---------------------------------------------------------------------------
// audio.tracks
// ---------------------------------------------------------------------------

/** One editor audio track per `audio.tracks` entry, placed by `audioSourceWindow`. */
function buildAudioTracks(audioTracks, ctx) {
  const { fps, toFrame, projectDir, warnings, uniqueId, noteSource } = ctx
  const out = []
  ;(Array.isArray(audioTracks) ? audioTracks : []).forEach((track, audioIndex) => {
    if (!track?.src) {
      warnings.push(`audio track ${track?.id ?? audioIndex}: no src; skipped`)
      return
    }
    const w = audioSourceWindow(track)
    const startFrame = toFrame(w.start)
    // As for video, the source runs on from where the track's own clock is at
    // `startFrame`; this only moves anything for a start before the timeline.
    const sourceIn = w.inPoint + Math.max(0, startFrame / fps - w.start)
    let endFrame = null
    let sourceOut = null
    if (w.outPoint !== null) {
      endFrame = toFrame(w.start + (w.outPoint - w.inPoint))
      if (endFrame <= startFrame) return  // no frame of it is ever heard
      sourceOut = sourceIn + (endFrame - startFrame) / fps
    }
    const length = endFrame === null ? Infinity : endFrame - startFrame
    const fadeFrames = (seconds) => (finite(seconds) && seconds > 0 ? Math.min(length, Math.round(seconds * fps)) : 0)
    let fadeInFrames = fadeFrames(track.fadeIn)
    // The render fades out only to a declared `end` (mix-audio.js buildFadeFilters).
    let fadeOutFrames = w.end !== null ? fadeFrames(track.fadeOut) : 0
    // Two fades longer than the clip together: both shrink in proportion to fit.
    if (fadeInFrames + fadeOutFrames > length) {
      const scale = length / (fadeInFrames + fadeOutFrames)
      fadeInFrames = Math.floor(fadeInFrames * scale)
      fadeOutFrames = Math.floor(fadeOutFrames * scale)
    }

    const src = resolveProjectSrc(track.src, projectDir)
    const id = uniqueId(track.id, `audio-${audioIndex}`)
    noteSource(src, id, 'audio')
    out.push({
      source: 'audio.tracks',
      trackIndex: null,
      lane: null,
      audioIndex,
      clips: [{
        id,
        src,
        startFrame,
        endFrame,
        sourceIn,
        sourceOut,
        speed: 1,
        volume: track.volume ?? 1,
        muted: Boolean(track.muted),
        fadeInFrames,
        fadeOutFrames,
        fadeInCurve: fadeInFrames > 0 ? (track.fadeInCurve ?? DEFAULT_FADE_CURVE) : null,
        fadeOutCurve: fadeOutFrames > 0 ? (track.fadeOutCurve ?? DEFAULT_FADE_CURVE) : null,
        linkedClipId: null,
        unsupported: track.ducking?.enabled ? ['ducking'] : [],
      }],
      transitions: [],
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/**
 * One placeholder spanning the first caption's start to the last one's end,
 * clipped to the picture (the render's caption layer spans the picture and no
 * more). The graphics renderer draws the caption layer into it.
 *
 * @returns {NleCaptionsTrack | null}
 */
function buildCaptions(captions, durationFrames, { fps, toFrame, motionBlur, warnings, uniqueId }) {
  const segments = (Array.isArray(captions?.segments) ? captions.segments : [])
    .filter((s) => finite(s?.start) && finite(s?.end))
  if (segments.length === 0) return null
  const startFrame = toFrame(Math.min(...segments.map((s) => s.start)))
  const endFrame = Math.min(toFrame(Math.max(...segments.map((s) => s.end))), durationFrames)
  if (endFrame <= startFrame) {
    warnings.push('captions fall outside the picture; not exported')
    return null
  }
  return {
    clips: [{
      id: uniqueId('captions', 'captions'),
      kind: 'captions',
      startFrame,
      endFrame,
      sourceIn: startFrame / fps,
      sourceOut: endFrame / fps,
      segmentCount: segments.length,
      style: captions.style ?? null,
      unsupported: motionBlur > 1 ? ['motionBlur'] : [],
    }],
  }
}

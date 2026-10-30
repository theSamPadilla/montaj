// render/nle/xmeml.js
/**
 * The editor timeline (`nle/timeline.js`) as a Final Cut Pro 7 XML file
 * (`xmeml` version 5), the interchange both Premiere Pro and DaVinci Resolve
 * import. `writeXmeml(timeline, probes, options)` is pure: the media facts come
 * in as `probes` (`nle/probe.js`), and it returns `{ xml, warnings }`.
 *
 * Where FCP7's own documentation leaves a choice open, this writer copies what
 * Premiere Pro writes when it exports "Final Cut Pro XML", because that is the
 * file both editors are known to read: Premiere reads its own, and Premiere to
 * Resolve is the most common XML workflow there is. The references were real
 * exports (OpenTimelineIO's `premiere_example.xml` and published Premiere and
 * Resolve exports), read element by element, and Apple's "Final Cut Pro XML
 * Interchange Format" reference.
 *
 * ── TIME ────────────────────────────────────────────────────────────────────
 *
 * Every clipitem carries the SEQUENCE rate (`fps`, `ntsc FALSE`), and all of
 * its frame numbers are counted at that rate: `start`/`end` on the timeline,
 * and `in`/`out`/`duration` in the source, as `seconds * fps`. The `<file>`
 * keeps the media's own rate and its length in its own frames.
 *
 * That is the classic trap with mixed rates. A 29.97 source in a 30 sequence
 * has `in = round(sourceIn * 30)`, NOT its own frame number
 * `round(sourceIn * 30000/1001)`: 600 s into the clip is in 18000, where the
 * source's frame count (17982) would land 0.6 s early. Apple: "In points are
 * stored in the frame rate of a sequence" (`mixedratesoffset`). Premiere does
 * the same: a 60 fps clip in a 50 fps sequence and a 29.97 clip in a 23.976 one
 * both carry the sequence's rate with `in` at `seconds * sequence fps`, their
 * `pproTicksIn` agreeing to the frame. `pproTicksIn`/`pproTicksOut` (Premiere's
 * exact source position, 254016000000 per second) are written too, so Premiere
 * lands on the exact source time even between frames.
 *
 * `out` and `end` are exclusive (FCP7 counts them from frame 1), so a clip
 * covering Montaj's half-open `[startFrame, endFrame)` has `end = endFrame` and
 * `out - in = end - start`.
 *
 * ── SPEED ───────────────────────────────────────────────────────────────────
 *
 * A clip at speed S gets a constant "Time Remap" filter (`speed` = S * 100),
 * the form Premiere writes and Resolve imports as a linear speed change. Its
 * `in`/`out`/`duration` are then in the RETIMED clip's frames: source seconds
 * divided by S, times fps, so `out - in` is still the clip's length on the
 * timeline. The `graphdict` keyframes map those frames (`when`) to source
 * frames at the sequence rate (`value`), with the four `speedkf*` flags and no
 * last-frame +1, all as Premiere writes it (a 200% clip: in 170 ↔ value 340).
 *
 * ── TRANSITIONS ─────────────────────────────────────────────────────────────
 *
 * Task 1 already cut each crossfade into two abutting clips at `cutFrame`. In
 * the XML a `<transitionitem>` (Cross Dissolve, or Cross Fade (0dB) on sound,
 * Montaj's linear crossfade) sits between them with `alignment center` and
 * Premiere's `cutPointTicks`, and the two clips follow FCP7's own encoding:
 * the outgoing clip's `end` and the incoming clip's `start` are `-1` ("computed
 * from the transition"), and their `out`/`in` reach to the transition's end and
 * start, the handles the dissolve blends (Apple's listing 3-17, and Premiere).
 *
 * ── PICTURE ─────────────────────────────────────────────────────────────────
 *
 * Basic Motion's `scale` is a percentage of the media's own pixel size, and its
 * `center` is the offset of the media's centre from the frame's centre in
 * pixels DIVIDED BY THE MEDIA'S OWN WIDTH AND HEIGHT, y down (Premiere: an
 * over/under 4096x2048 clip at 140.7% sits at vert ±0.703125, which is ±1440 px
 * of the source, a quarter of the 5760 frame). Montaj fits the (cropped) media
 * into its box (`scaleX * width` by `scaleY * height`, centred at the offsets):
 * a video always contains, an image covers, contains or fills. So:
 *
 *   scale  = 100 * min (contain) or max (cover) of box / cropped media, per axis
 *   center = (box centre - R(rotation) * scale * crop centre) / media size
 *
 * where the crop centre is the visible region's centre measured from the
 * media's centre (rotation and scale turn about the media's centre, so it is
 * pulled back to land on the box). A cover crops what spills out of the box
 * with the Crop filter, as the render does. A non-uniform box needs no
 * non-uniform scale (contain and cover scale both axes alike); only an image
 * with `fit: 'fill'` whose box has another shape really stretches, and FCP7's
 * Basic Motion cannot, so it is written as a cover with a "non-uniform scale"
 * marker. Crop and Opacity filters are written when not at their defaults.
 *
 * Graphics and captions are rendered by the graphics step (Task 3) into
 * full-canvas ProRes 4444 movies with their motion already in the pixels, whose
 * frame 0 is the clip's first frame. They are placed untransformed over their
 * own window, and the keyframe and motion-blur notes are dropped: the movie
 * carries them.
 *
 * ── SOUND ───────────────────────────────────────────────────────────────────
 *
 * A stereo source is two FCP tracks (channel 1 and channel 2, `sourcetrack`),
 * exploded the way Premiere writes a stereo track; a mono one is one. The
 * linked clips of one video clip all carry the same `<link>` list (the video
 * clip, then every audio channel, `groupindex 1`), as Premiere writes it. A
 * linked clip whose file has no audio stream is dropped, and if it was half of
 * a crossfade the other half plays on through the overlap with a linear fade,
 * as the render does. Audio Levels carries the linear gain (FCP7's `Level`), and
 * fades are linear Level keyframes, with a marker when Montaj's curve is not
 * linear. A muted `audio.tracks` entry is written disabled.
 *
 * ── LEFT OUT ────────────────────────────────────────────────────────────────
 *
 * Each remaining `unsupported` entry becomes a `<marker>` on its clip: a plain
 * label for the editor ("Stays in Montaj: moving zoom") and the raw key in its
 * comment. Entries with the same label share one marker.
 *
 * Ids are deterministic (`clipitem-<n>` in document order, `file-<n>` in order
 * of first use), so the same timeline always gives the same bytes.
 */

import { cleanFileName } from './file-name.js'

/** Premiere's time unit: ticks per second. */
export const PPRO_TICKS_PER_SECOND = 254016000000

/** How long a still's media is said to be: an hour, so it can be extended. */
const STILL_SECONDS = 3600

/** FCP7's Audio Levels maximum, +12 dB. */
const MAX_LEVEL = 3.981072

/** The sound format Montaj renders and the sequence declares. */
const SAMPLE_RATE = 48000

/** Labels for the `unsupported` keys, in plain words (UI copy: no em dashes). */
const KEYFRAME_LABELS = {
  offsetX: 'moving position',
  offsetY: 'moving position',
  scale: 'moving zoom',
  scaleX: 'moving zoom',
  scaleY: 'moving zoom',
  rotation: 'moving rotation',
  opacity: 'fade',
  cropX: 'moving crop',
  cropY: 'moving crop',
  cropW: 'moving crop',
  cropH: 'moving crop',
  maskX: 'moving mask',
  maskY: 'moving mask',
  maskW: 'moving mask',
  maskH: 'moving mask',
  maskRotation: 'moving mask',
  maskFeather: 'moving mask',
  maskPoints: 'moving mask',
}

const LABELS = {
  loop: 'Stays in Montaj: loop',
  mask: 'Stays in Montaj: mask',
  blendMode: 'Stays in Montaj: blend mode',
  blur: 'Stays in Montaj: blur',
  remove_bg: 'Stays in Montaj: background removal',
  'remove_bg:nobg_src': 'Cutout linked, background removed',
  motionBlur: 'Stays in Montaj: motion blur',
  ducking: 'Stays in Montaj: ducking',
  nonUniformScale: 'Stays in Montaj: non-uniform scale',
  fadeInCurve: 'Stays in Montaj: fade in shape',
  fadeOutCurve: 'Stays in Montaj: fade out shape',
}

/**
 * The editor-facing name of an `unsupported` key.
 *
 * @param {string} key
 * @returns {string}
 */
export function markerLabel(key) {
  if (key.startsWith('keyframes:')) {
    const prop = key.slice('keyframes:'.length)
    return `Stays in Montaj: ${KEYFRAME_LABELS[prop] ?? `${prop} animation`}`
  }
  const head = key.split(':')[0]
  return LABELS[key] ?? LABELS[head] ?? `Stays in Montaj: ${key}`
}

/**
 * Write the timeline as FCP7 XML.
 *
 * @param {import('./timeline.js').NleTimeline} timeline
 * @param {Object<string, import('./probe.js').NleProbe>} probes  Keyed by absolute path.
 * @param {{ name?: string, graphics?: Object<string, string>, captions?: string | null, xmlDir?: string | null, mediaPaths?: Object<string, string> }} [options]
 *   `name`: the sequence name. `graphics`: clip id → rendered movie (absolute).
 *   `captions`: the rendered captions movie (absolute). `xmlDir`: the folder the
 *   XML is written to; the captions without a movie are linked at
 *   `<xmlDir>/captions.mov`, where the graphics step puts it. A graphic without
 *   a movie in the map is left out of the XML, with a warning.
 * @returns {{ xml: string, warnings: string[], leftOut: { clip: string, label: string }[] }}
 *   `leftOut`: the markers the XML carries, each (clip key, label) once; `clip` is
 *   the timeline clip's id (the media file name is not unique: two clips can share a file).
 */
export function writeXmeml(timeline, probes, options = {}) {
  const { name = 'Montaj', graphics = {}, captions = null, xmlDir = null, mediaPaths = {} } = options
  const ctx = {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    probes: probes ?? {},
    graphics: graphics ?? {},
    captions,
    xmlDir,
    mediaPaths,
    warnings: [],
    media: new Map(),
  }

  const video = timeline.videoTracks.map((t) => planVideoTrack(t, ctx))
  if (timeline.captionsTrack) video.push(planCaptionsTrack(timeline.captionsTrack, ctx))
  const audio = timeline.audioTracks.flatMap((t) => planAudioTrack(t, ctx))

  finishDurations([...video, ...audio], ctx)
  assignIds(video, audio)
  linkGroups(video, audio)

  const clipEnds = [...video, ...audio].flatMap((t) => t.items.filter((i) => i.type === 'clip').map((c) => c.recordEnd))
  const duration = Math.max(timeline.durationFrames, ...clipEnds)
  const xml = serialize(sequenceNode(name, duration, video, audio, ctx))
  return { xml, warnings: ctx.warnings, leftOut: leftOutOf(video, audio) }
}

/** The markers written, per timeline clip id; a clip's audio channels repeat none (markers are on the first). */
function leftOutOf(video, audio) {
  const seen = new Set()
  const left = []
  for (const track of [...video, ...audio]) {
    for (const item of track.items) {
      if (item.type !== 'clip') continue
      for (const m of item.markers) {
        const key = `${item.key}\u0000${m.name}`
        if (m.name && !seen.has(key)) {
          seen.add(key)
          left.push({ clip: item.key, label: m.name })
        }
      }
    }
  }
  return left
}

// ---------------------------------------------------------------------------
// Media facts
// ---------------------------------------------------------------------------

/**
 * What one file looks like to the XML, from its probe or, without one, from
 * what the timeline implies. Cached per path; the first use decides its role.
 */
function mediaFor(path, role, ctx, hint = {}) {
  const cached = ctx.media.get(path)
  if (cached) return cached
  const { fps } = ctx
  const p = ctx.probes[path]
  const seqRate = { timebase: fps, ntsc: false }
  const m = {
    path,
    // Where the file the editor links lives: a copy beside the timeline (`options.mediaPaths`, original to copy), else the original.
    linkPath: ctx.mediaPaths[path] ?? path,
    role,
    name: baseName(path),
    rate: seqRate,
    fpsExact: fps,
    durationSeconds: null,
    width: ctx.width,
    height: ctx.height,
    sized: false,
    hasVideo: role !== 'audio',
    hasAudio: role === 'video' || role === 'audio',
    audioKnown: false,
    channels: 2,
    sampleRate: SAMPLE_RATE,
    timecode: null,
    alpha: role === 'graphic',
    needSeconds: 0,
    fileFrames: null,
  }

  if (role === 'graphic') {
    // Rendered by the graphics step; probed only when the caller has it.
    if (p?.exists && p.hasVideo) applyPicture(m, p)
    m.hasAudio = false
  } else if (!p) {
    ctx.warnings.push(`no probe result for ${path}; written with the timeline's own numbers`)
  } else if (!p.exists) {
    ctx.warnings.push(`media not found: ${path}; linked offline`)
  } else {
    m.audioKnown = true
    m.hasAudio = p.hasAudio
    if (p.audioChannels) m.channels = p.audioChannels
    if (p.audioSampleRate) m.sampleRate = p.audioSampleRate
    m.timecode = p.timecode
    if (role === 'audio') {
      m.durationSeconds = p.durationSeconds
    } else if (p.hasVideo) {
      applyPicture(m, p)
      if (role === 'still' || p.isStill) m.rate = seqRate
    } else {
      ctx.warnings.push(`${path} has no picture; linked as ${role === 'still' ? 'an image' : 'a video'} anyway`)
    }
  }

  if (!m.sized && role !== 'graphic' && role !== 'audio') {
    // A rendered graphic is frame-sized by contract; anything else unprobed
    // takes the size the project stored, else the frame's, with a warning.
    if (hint.size) {
      m.width = hint.size.width
      m.height = hint.size.height
    } else {
      ctx.warnings.push(`the picture size of ${path} is unknown; placed as if it were ${ctx.width}x${ctx.height}`)
    }
  }
  if (role === 'audio') m.hasVideo = false
  if (role === 'still') m.hasAudio = false
  ctx.media.set(path, m)
  return m
}

function applyPicture(m, p) {
  if (p.width && p.height) {
    m.width = p.width
    m.height = p.height
    m.sized = true
  }
  if (!p.isStill && p.timebase) {
    m.rate = { timebase: p.timebase, ntsc: p.ntsc }
    m.fpsExact = p.fpsExact
    m.durationSeconds = p.durationSeconds
    m.fileFrames = p.durationFrames
  }
}

/** The media lengths, once every clip has said how much of its file it uses. */
function finishDurations(tracks, ctx) {
  const { fps } = ctx
  for (const m of ctx.media.values()) {
    if (m.role === 'still') {
      m.fileFrames = Math.max(Math.ceil(m.needSeconds * fps), STILL_SECONDS * fps)
      m.durationSeconds = m.fileFrames / fps
    } else if (m.durationSeconds === null) {
      // Unknown length (offline, unprobed, or a graphics movie not rendered
      // yet): exactly what the clips use.
      m.durationSeconds = m.needSeconds
      m.fileFrames = Math.ceil(m.needSeconds * (m.fpsExact ?? fps) - 1e-6)
    } else {
      if (m.fileFrames === null) m.fileFrames = Math.round(m.durationSeconds * fps)
      if (m.needSeconds > m.durationSeconds + 0.5 / fps) {
        ctx.warnings.push(`${m.path} is ${fmt(m.durationSeconds)} s long but the edit uses it to ${fmt(m.needSeconds)} s`)
      }
    }
  }
  for (const t of tracks) {
    for (const item of t.items) {
      if (item.type !== 'clip') continue
      const m = item.media
      const length = Math.round((m.durationSeconds * fps) / item.speed)
      item.duration = Math.max(length, item.out)
    }
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function planVideoTrack(track, ctx) {
  const heads = new Map(track.transitions.map((t) => [t.toClipId, t]))
  const tails = new Map(track.transitions.map((t) => [t.fromClipId, t]))
  const items = []
  for (const clip of track.clips) {
    const plan = planVisualClip(clip, heads.get(clip.id) ?? null, tails.get(clip.id) ?? null, ctx)
    if (!plan) continue
    items.push(plan)
    const tail = tails.get(clip.id)
    if (tail) items.push(transitionPlan(tail, 'video', ctx))
  }
  return { mediatype: 'video', items, attrs: {}, extra: [] }
}

function planCaptionsTrack(captionsTrack, ctx) {
  const items = captionsTrack.clips.map((clip) => {
    const path = ctx.captions ?? expectedGraphicPath(clip.id, 'captions', ctx)
    return graphicPlan(clip, path, ctx)
  })
  return { mediatype: 'video', items, attrs: {}, extra: [] }
}

function expectedGraphicPath(id, what, ctx) {
  if (!ctx.xmlDir) {
    throw new TypeError(`writeXmeml: ${what} ${id} has no rendered movie and options.xmlDir is not set`)
  }
  const dir = ctx.xmlDir.replace(/[\\/]+$/, '')
  // The graphics step writes the captions to `captions.mov` and a graphic to `graphics/<name>.mov`.
  const path = what === 'captions' ? `${dir}/captions.mov` : `${dir}/graphics/${cleanFileName(id)}.mov`
  ctx.warnings.push(`${what} ${id} is not rendered yet; linked at ${path}`)
  return path
}

function planVisualClip(clip, head, tail, ctx) {
  if (clip.kind === 'graphic') {
    const path = ctx.graphics[clip.id]
    if (!path) {
      // The renderer made no movie for it: linking a guessed `graphics/<id>.mov`
      // could name another clip's movie, so the clip stays out of the XML.
      ctx.warnings.push(`graphic ${clip.id} has no rendered movie; left out of the XML`)
      return null
    }
    return graphicPlan(clip, path, ctx)
  }
  const still = clip.kind === 'image'
  const media = mediaFor(clip.src, still ? 'still' : 'video', ctx, { size: clip.sourceSize })
  const plan = still
    ? stillTiming(clip, head, tail, media, ctx)
    : sourceTiming(clip, head, tail, media, ctx)
  const motion = motionOf(clip, media, ctx)
  plan.filters = [
    ...(motion.basic ? [basicMotionFilter(motion)] : []),
    ...(motion.crop ? [cropFilter(motion.crop)] : []),
    ...(Math.abs(clip.opacity - 1) > 1e-9 ? [opacityFilter(clip.opacity)] : []),
    ...plan.filters,
  ]
  plan.markers = markersFor([...clip.unsupported, ...motion.marks], plan)
  return plan
}

/** A rendered graphic or the captions: full frame, untransformed, its own window. */
function graphicPlan(clip, path, ctx) {
  const media = mediaFor(path, 'graphic', ctx)
  const length = clip.endFrame - clip.startFrame
  media.needSeconds = Math.max(media.needSeconds, length / ctx.fps)
  const plan = basePlan({
    media,
    mediatype: 'video',
    key: clip.id,
    start: clip.startFrame,
    end: clip.endFrame,
    recordStart: clip.startFrame,
    recordEnd: clip.endFrame,
    inFrame: 0,
    span: length,
    speed: 1,
    srcStart: 0,
  }, ctx)
  plan.alphatype = 'straight'
  // Keyframes and motion blur are in the movie's pixels.
  const kept = clip.unsupported.filter((k) => !k.startsWith('keyframes:') && k !== 'motionBlur')
  plan.markers = markersFor(kept, plan)
  return plan
}

/**
 * A video or linked-audio clip's frames in its source (see TIME and SPEED).
 * `head`/`tail` are the transitions it is the incoming/outgoing side of.
 */
function sourceTiming(clip, head, tail, media, ctx, mediatype = 'video') {
  const { fps } = ctx
  const speed = clip.speed > 0 ? clip.speed : 1
  const headFrames = head ? clip.startFrame - head.startFrame : 0
  const tailFrames = tail ? tail.endFrame - clip.endFrame : 0
  const span = headFrames + (clip.endFrame - clip.startFrame) + tailFrames
  // An incoming crossfade clip that starts before its source does (off the
  // frame grid, inPoint 0) has no earlier footage to show: never a negative time.
  const srcStart = Math.max(0, clip.sourceIn - (speed * headFrames) / fps)
  const inFrame = Math.max(0, Math.round((srcStart * fps) / speed))
  return basePlan({
    media,
    mediatype,
    key: clip.id,
    start: head ? -1 : clip.startFrame,
    end: tail ? -1 : clip.endFrame,
    recordStart: clip.startFrame,
    recordEnd: clip.endFrame,
    headFrames,
    inFrame,
    span,
    speed,
    srcStart,
  }, ctx)
}

/** A still: its media starts at frame 0, wherever the clip is. */
function stillTiming(clip, head, tail, media, ctx) {
  const headFrames = head ? clip.startFrame - head.startFrame : 0
  const tailFrames = tail ? tail.endFrame - clip.endFrame : 0
  const span = headFrames + (clip.endFrame - clip.startFrame) + tailFrames
  return basePlan({
    media,
    mediatype: 'video',
    key: clip.id,
    start: head ? -1 : clip.startFrame,
    end: tail ? -1 : clip.endFrame,
    recordStart: clip.startFrame,
    recordEnd: clip.endFrame,
    headFrames,
    inFrame: 0,
    span,
    speed: 1,
    srcStart: 0,
  }, ctx)
}

function basePlan(t, ctx) {
  const { fps } = ctx
  const srcEnd = t.srcStart + (t.speed * t.span) / fps
  t.media.needSeconds = Math.max(t.media.needSeconds, srcEnd)
  const plan = {
    type: 'clip',
    key: t.key,
    mediatype: t.mediatype,
    media: t.media,
    enabled: true,
    start: t.start,
    end: t.end,
    recordStart: t.recordStart,
    recordEnd: t.recordEnd,
    headFrames: t.headFrames ?? 0,
    in: t.inFrame,
    out: t.inFrame + t.span,
    speed: t.speed,
    srcStart: t.srcStart,
    srcEnd,
    ticksIn: Math.round(t.srcStart * PPRO_TICKS_PER_SECOND),
    ticksOut: Math.round(srcEnd * PPRO_TICKS_PER_SECOND),
    duration: null,
    alphatype: null,
    sourcetrack: null,
    channelType: null,
    filters: [],
    markers: [],
    links: [],
    id: null,
    trackindex: null,
    clipindex: null,
  }
  if (t.speed !== 1) plan.filters.push({ timeRemap: true })
  return plan
}

// ---------------------------------------------------------------------------
// Geometry (see PICTURE)
// ---------------------------------------------------------------------------

export function motionOf(clip, media, ctx) {
  const W = ctx.width
  const H = ctx.height
  const nw = media.width
  const nh = media.height
  const { scaleX: sx, scaleY: sy, offsetX: ox, offsetY: oy, rotation, fit } = clip.transform
  const c = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const vw = c.w * nw
  const vh = c.h * nh
  const kx = (sx * W) / vw
  const ky = (sy * H) / vh
  const marks = []
  let s
  let cover = false
  if (clip.kind === 'video' || fit === 'contain') {
    s = Math.min(kx, ky)
  } else if (fit === 'fill' && Math.abs(kx - ky) <= 1e-9 * Math.max(kx, ky)) {
    s = kx
  } else {
    if (fit === 'fill') marks.push('nonUniformScale')
    s = Math.max(kx, ky)
    cover = true
  }
  if (!(s > 0)) s = 0

  let left = c.x
  let right = 1 - c.x - c.w
  let top = c.y
  let bottom = 1 - c.y - c.h
  if (cover && s > 0) {
    // What spills out of the box, cut evenly from both sides, in the media's own fractions.
    const ex = Math.max(0, vw - (sx * W) / s) / 2 / nw
    const ey = Math.max(0, vh - (sy * H) / s) / 2 / nh
    left += ex
    right += ex
    top += ey
    bottom += ey
  }
  const crop = [left, right, top, bottom].some((v) => v > 1e-9)
    ? { left: left * 100, right: right * 100, top: top * 100, bottom: bottom * 100 }
    : null

  const cx = (c.x + c.w / 2 - 0.5) * nw
  const cy = (c.y + c.h / 2 - 0.5) * nh
  const th = (rotation * Math.PI) / 180
  const px = (ox / 100) * W - s * (cx * Math.cos(th) - cy * Math.sin(th))
  const py = (oy / 100) * H - s * (cx * Math.sin(th) + cy * Math.cos(th))
  const motion = { scale: s * 100, centerH: px / nw, centerV: py / nh, rotation, crop, marks }
  motion.basic = Math.abs(motion.scale - 100) > 1e-9 || Math.abs(motion.centerH) > 1e-9
    || Math.abs(motion.centerV) > 1e-9 || Math.abs(rotation) > 1e-9
  return motion
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/** One Montaj audio track → one FCP track per channel (1 or 2), or none. */
function planAudioTrack(track, ctx) {
  const clips = track.clips.map((a) => ({ ...a }))
  const byId = new Map(clips.map((a) => [a.id, a]))
  const media = new Map(clips.map((a) => [a.id, mediaFor(a.src, track.source === 'video' ? 'video' : 'audio', ctx)]))

  // A linked clip whose file has no sound is not written; its crossfade
  // partner plays on through the overlap with a linear fade (see SOUND).
  const silent = new Set(clips.filter((a) => a.linkedClipId && media.get(a.id).audioKnown && !media.get(a.id).hasAudio).map((a) => a.id))
  // A muted clip is written disabled, but makes no sound either, so a crossfade
  // partner fades alone across the overlap exactly as for a file without sound.
  const quiet = (id) => silent.has(id) || Boolean(byId.get(id)?.muted && byId.get(id).linkedClipId)
  const transitions = []
  for (const t of track.transitions) {
    const fromSilent = quiet(t.fromClipId)
    const toSilent = quiet(t.toClipId)
    if (!fromSilent && !toSilent) {
      transitions.push(t)
    } else if (!fromSilent) {
      const a = byId.get(t.fromClipId)
      a.sourceOut += (a.speed * (t.endFrame - a.endFrame)) / ctx.fps
      a.endFrame = t.endFrame
      a.fadeOutFrames = t.durationFrames
      a.fadeOutCurve = 'linear'
    } else if (!toSilent) {
      const a = byId.get(t.toClipId)
      a.sourceIn -= (a.speed * (a.startFrame - t.startFrame)) / ctx.fps
      a.startFrame = t.startFrame
      a.fadeInFrames = t.durationFrames
      a.fadeInCurve = 'linear'
    }
  }
  const kept = clips.filter((a) => !silent.has(a.id))
  if (kept.length === 0) return []

  // Plays to the end of its file: the file says where that is.
  for (const a of kept) {
    if (a.endFrame !== null) continue
    const m = media.get(a.id)
    const left = m.durationSeconds !== null ? m.durationSeconds - a.sourceIn : null
    if (left !== null && left > 0) {
      a.endFrame = a.startFrame + Math.max(1, Math.round(left * ctx.fps))
    } else {
      a.endFrame = a.startFrame + ctx.fps
      ctx.warnings.push(`audio ${a.id}: the length of ${a.src} is unknown; written one second long`)
    }
    a.sourceOut = a.sourceIn + (a.endFrame - a.startFrame) / ctx.fps
  }

  const stereo = kept.some((a) => media.get(a.id).channels >= 2)
  const channels = stereo ? [1, 2] : [1]
  const heads = new Map(transitions.map((t) => [t.toClipId, t]))
  const tails = new Map(transitions.map((t) => [t.fromClipId, t]))

  return channels.map((channel, i) => {
    const items = []
    for (const a of kept) {
      const m = media.get(a.id)
      const plan = sourceTiming(a, heads.get(a.id) ?? null, tails.get(a.id) ?? null, m, ctx, 'audio')
      plan.key = a.id
      plan.linkedClipId = a.linkedClipId
      plan.enabled = !a.muted
      plan.sourcetrack = Math.min(channel, m.channels >= 2 ? 2 : 1)
      plan.channelType = stereo ? 'stereo' : 'mono'
      plan.filters.push(levelsFilter(a, plan))
      // Markers and warnings once per clip, on the first channel.
      if (i === 0) {
        plan.markers = markersFor([...a.unsupported, ...curveMarks(a)], plan)
        if (a.volume > MAX_LEVEL) ctx.warnings.push(`audio ${a.id}: volume ${a.volume} is above the editor's +12 dB; written at +12 dB`)
      }
      items.push(plan)
      const tail = tails.get(a.id)
      if (tail) items.push(transitionPlan(tail, 'audio', ctx))
    }
    return {
      mediatype: 'audio',
      items,
      attrs: {
        premiereTrackType: stereo ? 'Stereo' : 'Mono',
        currentExplodedTrackIndex: String(i),
        totalExplodedTrackCount: String(channels.length),
      },
      // A stereo pair routes each channel to its own output; a mono track is left to the editor's centre pan.
      extra: stereo ? [el('outputchannelindex', String(channel))] : [],
    }
  })
}

function curveMarks(a) {
  const out = []
  if (a.fadeInFrames > 0 && a.fadeInCurve && a.fadeInCurve !== 'linear') out.push(`fadeInCurve:${a.fadeInCurve}`)
  if (a.fadeOutFrames > 0 && a.fadeOutCurve && a.fadeOutCurve !== 'linear') out.push(`fadeOutCurve:${a.fadeOutCurve}`)
  return out
}

/** Audio Levels: the gain, and fades as linear keyframes in the clip's own frames. */
function levelsFilter(a, plan) {
  const level = Math.min(Math.max(a.volume, 0), MAX_LEVEL)
  const first = plan.in + plan.headFrames
  const last = first + (a.endFrame - a.startFrame)
  const keyframes = []
  const fadeIn = a.fadeInFrames > 0
  const fadeOut = a.fadeOutFrames > 0
  if (fadeIn && fadeOut && first + a.fadeInFrames >= last - a.fadeOutFrames) {
    // The fades meet: one peak where they cross, never keyframes out of order.
    const total = a.fadeInFrames + a.fadeOutFrames
    const length = last - first
    const peakFrame = first + Math.round((length * a.fadeInFrames) / total)
    const peak = level * Math.min(1, length / total)
    keyframes.push([first, 0], [peakFrame, peak], [last, 0])
  } else {
    if (fadeIn) keyframes.push([first, 0], [first + a.fadeInFrames, level])
    if (fadeOut) keyframes.push([last - a.fadeOutFrames, level], [last, 0])
  }
  return { levels: { level, keyframes } }
}

// ---------------------------------------------------------------------------
// Transitions, markers, ids, links
// ---------------------------------------------------------------------------

function transitionPlan(t, mediatype, ctx) {
  return {
    type: 'transition',
    mediatype,
    start: t.startFrame,
    end: t.endFrame,
    cutPointTicks: Math.round(((t.cutFrame - t.startFrame) / ctx.fps) * PPRO_TICKS_PER_SECOND),
  }
}

/** One marker per label, at the clip's first visible frame. */
function markersFor(keys, plan) {
  const byLabel = new Map()
  for (const key of keys) {
    const label = markerLabel(key)
    if (!byLabel.has(label)) byLabel.set(label, [])
    if (!byLabel.get(label).includes(key)) byLabel.get(label).push(key)
  }
  return [...byLabel].map(([label, rawKeys]) => ({ name: label, comment: rawKeys.join(', '), in: plan.in + plan.headFrames }))
}

function assignIds(video, audio) {
  let n = 0
  for (const tracks of [video, audio]) {
    tracks.forEach((track, t) => {
      track.items.forEach((item, i) => {
        if (item.type !== 'clip') return
        item.id = `clipitem-${++n}`
        item.trackindex = t + 1
        item.clipindex = i + 1
      })
    })
  }
}

/** A video clip and its sound, linked both ways: every member lists the whole group. */
function linkGroups(video, audio) {
  const groups = new Map()
  for (const track of video) {
    for (const item of track.items) if (item.type === 'clip') groups.set(item.key, [item])
  }
  for (const track of audio) {
    for (const item of track.items) {
      if (item.type === 'clip' && item.linkedClipId && groups.has(item.linkedClipId)) groups.get(item.linkedClipId).push(item)
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const links = members.map((m) => ({
      ref: m.id,
      mediatype: m.mediatype,
      trackindex: m.trackindex,
      clipindex: m.clipindex,
      groupindex: m.mediatype === 'audio' ? 1 : null,
    }))
    for (const m of members) m.links = links
  }
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function sequenceNode(name, duration, video, audio, ctx) {
  const files = new Set()
  return el('sequence', { id: 'sequence-1', explodedTracks: 'true' }, [
    el('name', name),
    el('duration', String(duration)),
    rateNode(ctx.fps, false),
    el('timecode', [
      rateNode(ctx.fps, false),
      el('string', '00:00:00:00'),
      el('frame', '0'),
      el('displayformat', 'NDF'),
    ]),
    el('media', [
      el('video', [
        el('format', [
          el('samplecharacteristics', [
            rateNode(ctx.fps, false),
            el('width', String(ctx.width)),
            el('height', String(ctx.height)),
            el('anamorphic', 'FALSE'),
            el('pixelaspectratio', 'square'),
            el('fielddominance', 'none'),
          ]),
        ]),
        ...video.map((t) => trackNode(t, files, ctx)),
      ]),
      el('audio', [
        el('numOutputChannels', '2'),
        el('format', [
          el('samplecharacteristics', [el('depth', '16'), el('samplerate', String(SAMPLE_RATE))]),
        ]),
        el('outputs', [1, 2].map((i) => el('group', [
          el('index', String(i)),
          el('numchannels', '1'),
          el('downmix', '0'),
          el('channel', [el('index', String(i))]),
        ]))),
        ...audio.map((t) => trackNode(t, files, ctx)),
      ]),
    ]),
  ])
}

function trackNode(track, files, ctx) {
  return el('track', track.attrs, [
    ...track.items.map((item) => (item.type === 'clip' ? clipNode(item, files, ctx) : transitionNode(item, ctx))),
    el('enabled', 'TRUE'),
    el('locked', 'FALSE'),
    ...track.extra,
  ])
}

function clipNode(c, files, ctx) {
  const attrs = { id: c.id }
  if (c.channelType) attrs.premiereChannelType = c.channelType
  return el('clipitem', attrs, [
    el('name', c.media.name),
    el('enabled', c.enabled ? 'TRUE' : 'FALSE'),
    el('duration', String(c.duration)),
    rateNode(ctx.fps, false),
    el('start', String(c.start)),
    el('end', String(c.end)),
    el('in', String(c.in)),
    el('out', String(c.out)),
    el('pproTicksIn', String(c.ticksIn)),
    el('pproTicksOut', String(c.ticksOut)),
    ...(c.alphatype ? [el('alphatype', c.alphatype)] : []),
    fileNode(c.media, files),
    ...(c.sourcetrack ? [el('sourcetrack', [el('mediatype', 'audio'), el('trackindex', String(c.sourcetrack))])] : []),
    ...c.filters.map((f) => filterNode(f, c, ctx)),
    ...c.markers.map((m) => el('marker', [
      el('comment', m.comment),
      el('name', m.name),
      el('in', String(m.in)),
      el('out', '-1'),
    ])),
    ...c.links.map((l) => el('link', [
      el('linkclipref', l.ref),
      el('mediatype', l.mediatype),
      el('trackindex', String(l.trackindex)),
      el('clipindex', String(l.clipindex)),
      ...(l.groupindex ? [el('groupindex', String(l.groupindex))] : []),
    ])),
  ])
}

/** A file is written in full the first time and by id after that. */
function fileNode(m, files) {
  if (files.has(m.path)) return el('file', { id: m.id })
  files.add(m.path)
  m.id = `file-${files.size}`
  const media = []
  if (m.hasVideo) {
    media.push(el('video', [
      el('samplecharacteristics', [
        rateNode(m.rate.timebase, m.rate.ntsc),
        el('width', String(m.width)),
        el('height', String(m.height)),
        el('anamorphic', 'FALSE'),
        el('pixelaspectratio', 'square'),
        el('fielddominance', 'none'),
      ]),
    ]))
  }
  if (m.hasAudio) {
    media.push(el('audio', [
      el('samplecharacteristics', [el('depth', '16'), el('samplerate', String(m.sampleRate))]),
      el('channelcount', String(m.channels)),
    ]))
  }
  return el('file', { id: m.id }, [
    el('name', m.name),
    el('pathurl', pathUrl(m.linkPath ?? m.path)),
    rateNode(m.rate.timebase, m.rate.ntsc),
    el('duration', String(m.fileFrames)),
    ...(m.timecode ? [timecodeNode(m.timecode, m.rate)] : []),
    el('media', media),
  ])
}

function timecodeNode(tc, rate) {
  const dropFrame = tc.includes(';')
  return el('timecode', [
    rateNode(rate.timebase, rate.ntsc),
    el('string', tc),
    el('frame', String(timecodeFrames(tc, rate.timebase, dropFrame && rate.ntsc))),
    el('displayformat', dropFrame ? 'DF' : 'NDF'),
  ])
}

/** A timecode string as a frame count at its timebase (SMPTE drop-frame when `df`). */
export function timecodeFrames(tc, timebase, df) {
  const [h, m, s, f] = tc.split(/[:;.]/).map(Number)
  const nominal = ((h * 60 + m) * 60 + s) * timebase + f
  if (!df) return nominal
  const drop = Math.round(timebase / 15)
  const minutes = h * 60 + m
  return nominal - drop * (minutes - Math.floor(minutes / 10))
}

function transitionNode(t, ctx) {
  const effect = t.mediatype === 'video'
    ? [
        el('name', 'Cross Dissolve'),
        el('effectid', 'Cross Dissolve'),
        el('effectcategory', 'Dissolve'),
        el('effecttype', 'transition'),
        el('mediatype', 'video'),
        el('wipecode', '0'),
        el('wipeaccuracy', '100'),
        el('startratio', '0'),
        el('endratio', '1'),
        el('reverse', 'FALSE'),
      ]
    : [
        el('name', 'Cross Fade (0dB)'),
        el('effectid', 'KGAudioTransCrossFade0dB'),
        el('effecttype', 'transition'),
        el('mediatype', 'audio'),
        el('wipecode', '0'),
        el('wipeaccuracy', '100'),
        el('startratio', '0'),
        el('endratio', '1'),
        el('reverse', 'FALSE'),
      ]
  return el('transitionitem', [
    el('start', String(t.start)),
    el('end', String(t.end)),
    el('alignment', 'center'),
    el('cutPointTicks', String(t.cutPointTicks)),
    rateNode(ctx.fps, false),
    el('effect', effect),
  ])
}

function filterNode(f, c, ctx) {
  if (f.basic) return f.basic
  if (f.crop) return f.crop
  if (f.opacity) return f.opacity
  if (f.timeRemap) return timeRemapNode(c, ctx)
  if (f.levels) return levelsNode(f.levels)
  throw new Error('unknown filter')
}

function effect(name, id, category, type, mediatype, params) {
  return el('filter', [
    el('effect', [
      el('name', name),
      el('effectid', id),
      el('effectcategory', category),
      el('effecttype', type),
      el('mediatype', mediatype),
      ...params,
    ]),
  ])
}

function param(id, name, value, min, max) {
  return el('parameter', { authoringApp: 'PremierePro' }, [
    el('parameterid', id),
    el('name', name),
    ...(min !== undefined ? [el('valuemin', String(min)), el('valuemax', String(max))] : []),
    typeof value === 'object' ? el('value', [el('horiz', num(value.horiz)), el('vert', num(value.vert))]) : el('value', value),
  ])
}

function basicMotionFilter(m) {
  return {
    basic: effect('Basic Motion', 'basic', 'motion', 'motion', 'video', [
      param('scale', 'Scale', num(m.scale), 0, 1000),
      param('rotation', 'Rotation', num(m.rotation), -8640, 8640),
      param('center', 'Center', { horiz: m.centerH, vert: m.centerV }),
      param('centerOffset', 'Anchor Point', { horiz: 0, vert: 0 }),
    ]),
  }
}

function cropFilter(crop) {
  return {
    crop: effect('Crop', 'crop', 'motion', 'motion', 'video', [
      param('left', 'left', num(crop.left), 0, 100),
      param('right', 'right', num(crop.right), 0, 100),
      param('top', 'top', num(crop.top), 0, 100),
      param('bottom', 'bottom', num(crop.bottom), 0, 100),
    ]),
  }
}

function opacityFilter(opacity) {
  return {
    opacity: effect('Opacity', 'opacity', 'motion', 'motion', 'video', [
      param('opacity', 'opacity', num(opacity * 100), 0, 100),
    ]),
  }
}

/** Constant speed (see SPEED). */
function timeRemapNode(c, ctx) {
  const { fps } = ctx
  const mediaFrames = Math.round(c.media.durationSeconds * fps)
  const keyframes = []
  if (c.in > 0) keyframes.push([0, 0, 'speedkfstart'])
  keyframes.push([c.in, Math.round(c.srcStart * fps), 'speedkfin'])
  keyframes.push([c.out, Math.round(c.srcEnd * fps), 'speedkfout'])
  if (c.out < c.duration) keyframes.push([c.duration, mediaFrames, 'speedkfend'])
  return effect('Time Remap', 'timeremap', 'motion', 'motion', c.mediatype, [
    param('variablespeed', 'variablespeed', '0', 0, 1),
    param('speed', 'speed', num(c.speed * 100), -100000, 100000),
    param('reverse', 'reverse', 'FALSE'),
    param('frameblending', 'frameblending', 'FALSE'),
    el('parameter', { authoringApp: 'PremierePro' }, [
      el('parameterid', 'graphdict'),
      el('name', 'graphdict'),
      el('valuemin', '0'),
      el('valuemax', String(mediaFrames)),
      el('value', '0'),
      ...keyframes.map(([when, value, flag]) => el('keyframe', [
        el('when', String(when)),
        el('value', String(value)),
        el('speedvirtualkf', 'TRUE'),
        el(flag, 'TRUE'),
      ])),
      el('interpolation', [el('name', 'FCPCurve')]),
    ]),
  ])
}

function levelsNode({ level, keyframes }) {
  return effect('Audio Levels', 'audiolevels', 'audiolevels', 'audiolevels', 'audio', [
    el('parameter', { authoringApp: 'PremierePro' }, [
      el('parameterid', 'level'),
      el('name', 'Level'),
      el('valuemin', '0'),
      el('valuemax', String(MAX_LEVEL)),
      el('value', num(level)),
      ...keyframes.map(([when, value]) => el('keyframe', [el('when', String(when)), el('value', num(value))])),
    ]),
  ])
}

function rateNode(timebase, ntsc) {
  return el('rate', [el('timebase', String(timebase)), el('ntsc', ntsc ? 'TRUE' : 'FALSE')])
}

/**
 * `file://localhost/` and the absolute path, every segment percent-encoded
 * (RFC 2396, as Apple's `pathurl` requires: spaces, `&`, `#`, non-ASCII...). A
 * Windows drive path keeps its drive as `C%3a`, the way Premiere writes it.
 *
 * @param {string} path
 * @returns {string}
 */
export function pathUrl(path) {
  const drive = /^([A-Za-z]):[\\/]/.exec(path)
  const rest = drive ? path.slice(2) : path
  const segments = rest.replace(/\\/g, '/').split('/').filter((s, i) => i > 0 || s !== '')
  const encoded = segments.map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`))
  return `file://localhost/${drive ? `${drive[1]}%3a/` : ''}${encoded.join('/')}`
}

/** Numbers to at most six decimals, no float dust, no "-0". */
function num(v) {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? '0' : String(r)
}

function fmt(v) {
  return String(Math.round(v * 1000) / 1000)
}

function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

// A minimal XML tree: el(tag, [attrs], children | text).
function el(tag, a, b) {
  let attrs = {}
  let body = a
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    attrs = a
    body = b
  }
  return { tag, attrs, body: body ?? [] }
}

function serialize(root) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="5">']
  write(root, 1, lines)
  lines.push('</xmeml>', '')
  return lines.join('\n')
}

function write(node, depth, lines) {
  const pad = '  '.repeat(depth)
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
  if (typeof node.body === 'string') {
    lines.push(`${pad}<${node.tag}${attrs}>${escapeText(node.body)}</${node.tag}>`)
  } else if (node.body.length === 0) {
    lines.push(`${pad}<${node.tag}${attrs}/>`)
  } else {
    lines.push(`${pad}<${node.tag}${attrs}>`)
    for (const child of node.body) write(child, depth + 1, lines)
    lines.push(`${pad}</${node.tag}>`)
  }
}

/** XML 1.0 has no place for most control characters, U+FFFE/U+FFFF or a lone surrogate: dropped. */
function stripForbidden(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

function escapeText(s) {
  return stripForbidden(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** An attribute value: XML-forbidden characters dropped, then `& < > " '` escaped. FCPXML's writer uses it too. */
export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

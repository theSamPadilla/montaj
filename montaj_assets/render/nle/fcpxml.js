// render/nle/fcpxml.js
/**
 * The editor timeline as FCPXML 1.9 for Final Cut Pro (`writeFcpxml`). The same neutral timeline (`nle/timeline.js`)
 * the FCP7 XML and the After Effects writers read.
 *
 * Shape: one event, one project, one sequence. The spine is a single gap as long as the edit, and every clip hangs
 * off it on a lane (connected clips): video tracks bottom to top are lanes 1, 3, 5, ... (a second lane up when two
 * clips of one track overlap, which is what a crossfade is), `audio.tracks` are lanes -1, -2, ... Clips are
 * `asset-clip`s of assets that link the media by file URL (the copies in the package).
 *
 * What lands: cut, source window, speed (`timeMap`), placement (`adjust-transform` with conform off, so scale is
 * the media's own size), crop (`adjust-crop`), opacity (`adjust-blend`), clip volume (`adjust-volume`), a crossfade as
 * opacity keyframes on the overlap, `audio.tracks` with fades as volume keyframes, overlays and captions as
 * transparent movies, and a marker on a clip for what stays in Montaj. A crossfade is not a Final Cut transition (those
 * need the clips on the primary storyline); an editor can replace it.
 */
import { markerLabel, motionOf, pathUrl } from './xmeml.js'

const FALLBACK_FRAMES = 150

/** `1001/30000s` style frame duration for a fps. */
function frameDurationOf(fps) {
  const ntsc = [[24000, 1001, 23.976], [30000, 1001, 29.97], [60000, 1001, 59.94], [120000, 1001, 119.88]]
  for (const [n, d, v] of ntsc) if (Math.abs(fps - v) < 0.01) return [d, n]
  const r = Math.round(fps)
  return [1, r]
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (v) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r) }
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const db = (v) => (v <= 0.00001 ? -96 : 20 * Math.log10(v))

/**
 * @param {import('./timeline.js').NleTimeline} timeline
 * @param {Object<string, object>} probes
 * @param {{
 *   name?: string,
 *   mediaPaths?: Object<string, string>,   original path to its copy in the package
 *   graphics?: Object<string, string>,     overlay clip id to its rendered movie
 *   captions?: string | null,
 * }} options
 * @returns {{ xml: string, warnings: string[], leftOut: { clip: string, label: string }[] }}
 */
export function writeFcpxml(timeline, probes, options = {}) {
  const { name = 'Montaj', mediaPaths = {}, graphics = {}, captions = null } = options
  const warnings = []
  const leftOut = []
  const [fn, fd] = frameDurationOf(timeline.fps)
  const frameDuration = `${fn}/${fd}s`
  const t = (frames) => (frames === 0 ? '0s' : `${frames * fn}/${fd}s`)
  const sec = (s) => t(Math.round((s * fd) / fn))
  const totalFrames = timeline.durationFrames > 0 ? timeline.durationFrames : FALLBACK_FRAMES
  const H = timeline.height
  const noteLeft = (clip, key) => {
    const label = markerLabel(key)
    if (!leftOut.some((l) => l.clip === clip && l.label === label)) leftOut.push({ clip, label })
    return label
  }

  // Resources: formats and assets, each once.
  const formats = []
  const formatId = (w, h, still) => {
    const key = `${w}x${h}${still ? 's' : ''}`
    let f = formats.find((x) => x.key === key)
    if (!f) { f = { key, id: `r${formats.length + 2}`, w, h, still }; formats.push(f) }
    return f.id
  }
  const assets = new Map()
  const assetFor = (path, kind) => {
    if (assets.has(path)) return assets.get(path)
    const p = probes[path] ?? {}
    const id = `a${assets.size + 1}`
    const a = {
      id, kind, name: baseName(path), src: pathUrl(path).replace('file://localhost', 'file://'),
      hasVideo: kind !== 'audio', hasAudio: kind === 'audio' || (kind === 'video' && p.hasAudio !== false),
      duration: kind === 'image' ? '0s' : (p.durationSeconds ? sec(p.durationSeconds) : t(totalFrames)),
      format: kind === 'audio' ? null : formatId(p.width ?? timeline.width, p.height ?? timeline.height, kind === 'image'),
      channels: p.audioChannels ?? 2, rate: p.audioSampleRate ?? 48000,
    }
    assets.set(path, a)
    return a
  }

  const lanesUsed = []
  const clips = []
  let lane = 1
  for (const track of timeline.videoTracks) {
    const placedEnds = [[], []]
    for (const clip of track.clips) {
      // A clip that starts before the previous one on its track ends (a crossfade) goes a lane up.
      const slot = placedEnds[0].some((e) => e > clip.startFrame) ? 1 : 0
      placedEnds[slot].push(clip.endFrame)
      const myLane = lane + slot
      lanesUsed.push(myLane)
      const marks = []
      for (const key of clip.unsupported) {
        if (key.startsWith('keyframes:') || key === 'motionBlur') continue
        marks.push(noteLeft(clip.id, key))
      }
      if (clip.kind === 'graphic') {
        const movie = graphics[clip.id]
        if (!movie) { warnings.push(`overlay ${clip.id} has no rendered movie, so it is not in the project`); continue }
        clips.push({ clip, lane: myLane, asset: assetFor(movie, 'video'), marks, graphic: true })
        continue
      }
      const src = mediaPaths[clip.src] ?? clip.src
      const kind = clip.kind === 'image' ? 'image' : 'video'
      const p = probes[clip.src] ?? {}
      const media = { width: p.width ?? timeline.width, height: p.height ?? timeline.height }
      const motion = motionOf(clip, media, { width: timeline.width, height: timeline.height })
      for (const m of motion.marks) marks.push(noteLeft(clip.id, m))
      clips.push({ clip, lane: myLane, asset: assetFor(src, kind), marks, motion, media })
    }
    lane += 2
  }
  // Crossfades: opacity keys on the overlap, by clip id.
  const fades = new Map()
  for (const track of timeline.videoTracks) {
    for (const tr of track.transitions) {
      fades.set(tr.fromClipId, { out: [tr.startFrame, tr.endFrame] })
      fades.set(tr.toClipId, { in: [tr.startFrame, tr.endFrame] })
    }
  }

  const body = []
  for (const c of clips) {
    const { clip, asset, motion, media } = c
    const speed = clip.speed ?? 1
    const dur = clip.endFrame - clip.startFrame
    const inner = []
    if (!c.graphic && speed !== 1 && clip.kind === 'video') {
      const srcDur = (speed * dur * fn) / fd
      inner.push(`<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${t(dur)}" value="${sec(srcDur)}" interp="linear"/></timeMap>`)
    }
    if (motion) {
      inner.push('<adjust-conform type="none"/>')
      if (motion.crop) {
        const px = (v, total) => num((v / 100) * total)
        inner.push(`<adjust-crop mode="trim"><trim-rect left="${px(motion.crop.left, media.width)}" right="${px(motion.crop.right, media.width)}" top="${px(motion.crop.top, media.height)}" bottom="${px(motion.crop.bottom, media.height)}"/></adjust-crop>`)
      }
      // Position is in units where the frame is 100 high; y is up. Rotation is counter-clockwise.
      const k = 100 / H
      const px = motion.centerH * media.width * k
      const py = -motion.centerV * media.height * k
      const s = motion.scale / 100
      if (motion.basic) inner.push(`<adjust-transform position="${num(px)} ${num(py)}" rotation="${num(-motion.rotation)}" scale="${num(s)} ${num(s)}"/>`)
    }
    const op = clip.opacity ?? 1
    const fade = fades.get(clip.id)
    if (fade || op !== 1) {
      if (fade) {
        const keys = []
        const rel = (f) => t(f - clip.startFrame)
        if (fade.in) keys.push([rel(fade.in[0]), 0], [rel(fade.in[1]), op])
        if (fade.out) keys.push([rel(fade.out[0]), op], [rel(fade.out[1]), 0])
        inner.push(`<adjust-blend amount="${num(op)}"><param name="amount"><keyframeAnimation>${keys.map(([tt, v]) => `<keyframe time="${tt}" value="${num(v)}"/>`).join('')}</keyframeAnimation></param></adjust-blend>`)
      } else {
        inner.push(`<adjust-blend amount="${num(op)}"/>`)
      }
    }
    if (clip.kind === 'video') {
      const vol = clip.muted ? 0 : (clip.volume ?? 1)
      if (vol !== 1) inner.push(`<adjust-volume amount="${num(db(vol))}dB"/>`)
    }
    const start = clip.kind === 'image' || c.graphic ? '0s' : sec(clip.sourceIn ?? 0)
    for (const m of c.marks) inner.push(`<marker start="${start}" duration="${frameDuration}" value="${esc(m)}"/>`)
    body.push(`<asset-clip ref="${asset.id}" lane="${c.lane}" offset="${t(clip.startFrame)}" name="${esc(c.graphic ? `Overlay ${clip.id}` : clip.id)}" start="${start}" duration="${t(dur)}"${clip.muted ? ' audioRole="dialogue"' : ''}>${inner.join('')}</asset-clip>`)
  }

  if (captions) {
    const a = assetFor(captions, 'video')
    body.push(`<asset-clip ref="${a.id}" lane="${(lanesUsed.length ? Math.max(...lanesUsed) : 1) + 2}" offset="0s" name="Captions" start="0s" duration="${t(totalFrames)}"/>`)
  }

  let audioLane = -1
  for (const track of timeline.audioTracks) {
    if (track.source !== 'audio.tracks') continue
    for (const c of track.clips) {
      if (c.muted) continue
      for (const key of c.unsupported ?? []) noteLeft(c.id, key)
      const asset = assetFor(mediaPaths[c.src] ?? c.src, 'audio')
      const sp = c.speed ?? 1
      const startFr = c.startFrame
      const endFr = c.endFrame ?? totalFrames
      const dur = endFr - startFr
      const vol = c.volume ?? 1
      const keys = []
      if (c.fadeInFrames > 0) keys.push([0, -96], [c.fadeInFrames, db(vol)])
      if (c.fadeOutFrames > 0) { if (!keys.length) keys.push([0, db(vol)]); keys.push([dur - c.fadeOutFrames, db(vol)], [dur, -96]) }
      const vx = keys.length
        ? `<adjust-volume amount="${num(db(vol))}dB"><param name="amount"><keyframeAnimation>${keys.map(([f, v]) => `<keyframe time="${t(f)}" value="${num(v)}dB"/>`).join('')}</keyframeAnimation></param></adjust-volume>`
        : vol !== 1 ? `<adjust-volume amount="${num(db(vol))}dB"/>` : ''
      const tm = sp !== 1 ? `<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="${t(dur)}" value="${sec((sp * dur * fn) / fd)}" interp="linear"/></timeMap>` : ''
      body.push(`<asset-clip ref="${asset.id}" lane="${audioLane--}" offset="${t(startFr)}" name="${esc(c.id)}" start="${sec(c.sourceIn ?? 0)}" duration="${t(dur)}">${tm}${vx}</asset-clip>`)
    }
  }

  const seqFormat = 'r1'
  const res = [`<format id="${seqFormat}" name="Montaj ${timeline.width}x${timeline.height}" frameDuration="${frameDuration}" width="${timeline.width}" height="${timeline.height}"/>`]
  for (const f of formats) res.push(`<format id="${f.id}" name="Media ${f.key}" ${f.still ? '' : `frameDuration="${frameDuration}" `}width="${f.w}" height="${f.h}"/>`)
  for (const a of assets.values()) {
    res.push(`<asset id="${a.id}" name="${esc(a.name)}" src="${esc(a.src)}" start="0s" duration="${a.duration}" hasVideo="${a.hasVideo ? 1 : 0}" hasAudio="${a.hasAudio ? 1 : 0}"${a.format ? ` format="${a.format}"` : ''}${a.hasAudio ? ` audioSources="1" audioChannels="${a.channels}" audioRate="${a.rate}"` : ''}/>`)
  }

  if (timeline.captionsTrack?.segmentCount && !captions) warnings.push('captions were not rendered, so they are not in the project')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
<resources>
${res.join('\n')}
</resources>
<library>
<event name="${esc(name)}">
<project name="${esc(name)}">
<sequence format="${seqFormat}" duration="${t(totalFrames)}" tcStart="0s" tcFormat="NDF">
<spine>
<gap name="Montaj" offset="0s" start="0s" duration="${t(totalFrames)}">
${body.join('\n')}
</gap>
</spine>
</sequence>
</project>
</event>
</library>
</fcpxml>
`
  return { xml, warnings, leftOut }
}

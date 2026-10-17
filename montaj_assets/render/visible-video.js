// render/visible-video.js
/**
 * Which video is actually on screen, and so which colour space the picture needs
 * (§378). A project's HDR is stored once, at intake, from the clips it was given,
 * so a clip used only for its voice (a voiceover, a talking clip a 3D scene covers)
 * could make the whole project HDR when nothing HDR is ever shown. The export, the
 * disk estimate and the render window all ask this one question instead.
 *
 * Pure: no files, no ffprobe. What needs a file (does a full-canvas image have an
 * alpha channel) is passed in as `coversPicture`.
 *
 * A video item is VISIBLE when it sits on an enabled track, starts before the
 * export ends, and some part of its span (clipped to the export) is not hidden by
 * a cover: an overlay that is opaque over the whole canvas at full opacity
 * (timeline-core's isOpaqueCover and fullOpacitySpans, the rule the planner
 * uses), or whatever `coversPicture` says covers the whole canvas (a full-canvas
 * image with no alpha, an opaque full-canvas video).
 */
import { isOpaqueCover, isFullCanvasPlacement, fullOpacitySpans } from '@bycrux/timeline-core'

const finite = (v, d) => (Number.isFinite(v) ? v : d)

/** `[from, to)` pieces of the item's own span in which `cover` is at full opacity (item-relative spans moved to project time). */
function coverSpans(cover) {
  const start = finite(cover.start, 0)
  const end = finite(cover.end, Infinity)
  const out = []
  for (const [a, b] of fullOpacitySpans(cover)) {
    const from = Math.max(start, a === -Infinity ? start : start + a)
    const to = Math.min(end, b === Infinity ? end : start + b)
    if (to > from) out.push([from, to])
  }
  return out
}

/** Merge `[from, to)` spans. */
function union(spans) {
  const sorted = [...spans].sort((x, y) => x[0] - y[0])
  const out = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/** Whether `[from, to)` lies wholly inside the merged spans. */
function insideAll(from, to, merged) {
  return merged.some(([a, b]) => a <= from && b >= to)
}

/**
 * The video items that show.
 *
 * @param {object[][]} tracksItems  the ENABLED tracks' items, track by track
 * @param {object} [opts]
 * @param {number} [opts.end]       the export's end in seconds (default: the last item's end)
 * @param {(item: object) => boolean} [opts.coversPicture]  an image or video covering the whole canvas opaquely (the caller reads the file)
 * @returns {object[]}
 */
export function visibleVideoItems(tracksItems, { end, coversPicture = () => false } = {}) {
  const tagged = []
  tracksItems.forEach((track, trackIdx) => {
    for (const item of track ?? []) if (item && typeof item === 'object') tagged.push({ item, trackIdx })
  })
  const last = end ?? Math.max(0, ...tagged.map(({ item }) => finite(item.end, 0)))
  // Each cover with the track it sits on: an image or overlay covers every video (they draw above video
  // tracks); a video covers only the videos on a track before its own.
  const covers = []
  for (const { item: it, trackIdx } of tagged) {
    if (it.type === 'overlay' && isOpaqueCover(it)) {
      for (const span of coverSpans(it)) covers.push({ span, trackIdx: Infinity })
    } else if ((it.type === 'image' || it.type === 'video') && isFullCanvasPlacement(it) && (it.opacity ?? 1) === 1 && !it.remove_bg && coversPicture(it)) {
      covers.push({ span: [finite(it.start, 0), finite(it.end, last)], trackIdx: it.type === 'image' ? Infinity : trackIdx })
    }
  }
  return tagged
    .filter(({ item: it, trackIdx }) => {
      if (it.type !== 'video' || !it.src) return false
      const from = finite(it.start, 0)
      const to = Math.min(finite(it.end, last), last)
      if (!(to > from)) return false
      const above = union(covers.filter((c) => c.trackIdx > trackIdx).map((c) => c.span))
      return !insideAll(from, to, above)
    })
    .map(({ item }) => item)
}

/**
 * The colour space the picture needs. A stored HDR choice the user made
 * (`settings.colorSpaceSource === 'explicit'`) always stands. An auto-picked HDR
 * (the marker 'auto', or none: every project from before the marker) falls back
 * to SDR when no visible video item is HDR. SDR stays SDR.
 *
 * @param {{ stored: string, source?: string|null, visible: object[], isHdrItem: (item: object) => boolean, isHdrKey: (key: string) => boolean }} a
 * @returns {{ colorSpace: string, hdrVisible: boolean, downgraded: boolean }}
 */
export function effectiveColorSpace({ stored, source = null, visible, isHdrItem, isHdrKey }) {
  const hdrVisible = visible.some((i) => isHdrItem(i))
  if (!isHdrKey(stored)) return { colorSpace: stored, hdrVisible, downgraded: false }
  if (source === 'explicit' || hdrVisible) return { colorSpace: stored, hdrVisible, downgraded: false }
  return { colorSpace: 'sdr_bt709', hdrVisible, downgraded: true }
}

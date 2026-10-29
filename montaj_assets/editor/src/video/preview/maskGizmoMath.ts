// The on-canvas mask gizmo's geometry (§616 U2), pure: no React, no DOM.
//
// Everything here works in BOX PIXELS: the clip's own box before rotation, in
// preview pixels, y down. It is the space timeline-core's `maskPolygon` draws
// in and the space the gizmo's SVG viewBox spans (`0 0 boxW boxH`), so the
// outline, the rings and every handle land where the export's mask is.
//
// Only one conversion touches the screen: `clientToBox`, which undoes the
// clip's offset, rotation and scale. Every gesture then reads two box points
// (where the press began, where the pointer is) and returns the mask props it
// sets, which the host commits through `applyOverlayChanges` -> writeProp.

import { MASK_FEATHER_MAX, maskPolygon, maskSigmaPx } from '@bycrux/timeline-core'
import type { MaskKeyframeProp } from '../../schema'

/** A mask with every field resolved, as timeline-core's `maskAt` returns it. */
export type ResolvedMask = NonNullable<ReturnType<typeof import('@bycrux/timeline-core').maskAt>>

/** What one mask gesture sets: some of the six mask props. */
export type MaskChanges = Partial<Record<MaskKeyframeProp, number>>

export type MaskHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type MaskGesture = 'move' | `resize-${MaskHandle}` | 'rotate' | 'feather'

export interface Pt { x: number; y: number }

/** Where the clip sits on the frame, as its wrapper's CSS draws it. */
export interface ClipPlacement {
  /** % of the frame. */
  offsetX: number
  offsetY: number
  /** Degrees clockwise. */
  rotation: number
  scaleX: number
  scaleY: number
}

/** The frame's rect on screen (a `DOMRect` will do). */
export interface FrameRect { left: number; top: number; width: number; height: number }

/** How far above the top edge the rotate handle sits, in box (= screen) pixels. */
export const ROTATE_OFFSET_PX = 24
/** A wipe's rotate handle: how far along its edge line from (x, y). */
export const WIPE_ROTATE_OFFSET_PX = 40
/** The feather ring (the grab) never sits closer than this outside the edge, box px. */
export const OUTER_RING_MIN_PX = 8
/** The smallest mask side a resize leaves, as a fraction of the box. */
const MIN_SIDE = 0.01

const RAD = Math.PI / 180

/**
 * A client point in box pixels. The clip's wrapper is the frame-sized box
 * `translate(offset%) rotate(θ) scale(sx, sy)` about the frame centre, so:
 * take the point relative to the clip's centre on screen, turn it back by -θ,
 * then scale it by box pixels per screen pixel on each axis (the box is
 * `boxW` preview pixels wide and `frame.width · sx` client pixels on screen).
 */
export function clientToBox(client: Pt, frame: FrameRect, clip: ClipPlacement, boxW: number, boxH: number): Pt {
  const cx = frame.left + frame.width * (0.5 + clip.offsetX / 100)
  const cy = frame.top + frame.height * (0.5 + clip.offsetY / 100)
  const dx = client.x - cx
  const dy = client.y - cy
  const t = clip.rotation * RAD
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const ux = dx * cos + dy * sin
  const uy = -dx * sin + dy * cos
  const kx = frame.width * clip.scaleX ? boxW / (frame.width * clip.scaleX) : 1
  const ky = frame.height * clip.scaleY ? boxH / (frame.height * clip.scaleY) : 1
  return { x: boxW / 2 + ux * kx, y: boxH / 2 + uy * ky }
}

/** The mask's centre (x, y) in box pixels. */
export function maskCentre(m: ResolvedMask, boxW: number, boxH: number): Pt {
  return { x: m.x * boxW, y: m.y * boxH }
}

/** A point `(lx, ly)` in the mask's own frame (turned by its rotation about its centre), in box pixels. */
function fromMaskFrame(m: ResolvedMask, boxW: number, boxH: number, lx: number, ly: number): [number, number] {
  const c = maskCentre(m, boxW, boxH)
  const t = m.rotation * RAD
  return [c.x + lx * Math.cos(t) - ly * Math.sin(t), c.y + lx * Math.sin(t) + ly * Math.cos(t)]
}

/** The angle in (-180, 180]. */
function wrapDeg(d: number): number {
  const r = ((d % 360) + 360) % 360
  return r > 180 ? r - 360 : r
}

function distToSegment(p: Pt, a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const len2 = vx * vx + vy * vy
  const k = len2 ? Math.min(1, Math.max(0, ((p.x - a[0]) * vx + (p.y - a[1]) * vy) / len2)) : 0
  return Math.hypot(p.x - (a[0] + vx * k), p.y - (a[1] + vy * k))
}

/**
 * How far `p` is in from the mask's edge, in box pixels: positive inside the
 * shape, negative outside. The edge is the outline (`maskPolygon`, convex) for
 * an ellipse or rect, and the edge line for a wipe, whose inside is the side
 * that shows (`(p - c)·n <= 0`). The hard shape, so `invert` does not turn it.
 */
export function insideDistance(m: ResolvedMask, p: Pt, boxW: number, boxH: number): number {
  if (m.shape === 'wipe') {
    const c = maskCentre(m, boxW, boxH)
    const t = m.rotation * RAD
    return -((p.x - c.x) * Math.cos(t) + (p.y - c.y) * Math.sin(t))
  }
  const pts = maskPolygon(m, boxW, boxH)
  let best = Infinity
  let pos = false
  let neg = false
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const d = distToSegment(p, a, b)
    if (d < best) best = d
    const cross = (b[0] - a[0]) * (p.y - a[1]) - (b[1] - a[1]) * (p.x - a[0])
    if (cross > 0) pos = true
    else if (cross < 0) neg = true
  }
  // Convex: inside is on the same side of every edge.
  return pos && neg ? -best : best
}

/**
 * The mask props a gesture sets, from the mask at the press (`m`), the press
 * point and the pointer now, both in box pixels.
 *
 *   - move: the delta over the box size, on x and y. A wipe moves the same
 *     way: (x, y) is a point on its edge.
 *   - resize: the delta turned into the mask's own frame (undoing its
 *     rotation); each side moves by it and the opposite side mirrors it, so
 *     the size changes by twice the drag about the centre. A corner sets w
 *     and h, an edge one of them.
 *   - rotate: the pointer's turn about the mask centre since the press, added
 *     to the rotation.
 *   - feather: the band's width (feather x the box's shorter side) follows the
 *     outer ring, which is band / 2 outside the edge: dragging it out by d
 *     widens the band by 2 d, in by d narrows it. Measured as a change from
 *     the press (outward distance, `-insideDistance`), so a press on the ring
 *     parked at its 8 px minimum (feather 0) does not jump. Clamped to
 *     0..MASK_FEATHER_MAX.
 */
export function maskGestureChanges(gesture: MaskGesture, m: ResolvedMask, from: Pt, to: Pt, boxW: number, boxH: number): MaskChanges {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (gesture === 'move') {
    return { maskX: m.x + dx / boxW, maskY: m.y + dy / boxH }
  }
  if (gesture === 'rotate') {
    const c = maskCentre(m, boxW, boxH)
    const a0 = Math.atan2(from.y - c.y, from.x - c.x)
    const a1 = Math.atan2(to.y - c.y, to.x - c.x)
    return { maskRotation: m.rotation + wrapDeg((a1 - a0) / RAD) }
  }
  if (gesture === 'feather') {
    const short = Math.min(boxW, boxH)
    if (!(short > 0)) return { maskFeather: 0 }
    const d0 = -insideDistance(m, from, boxW, boxH)
    const d1 = -insideDistance(m, to, boxW, boxH)
    const band = Math.max(0, m.feather * short + 2 * (d1 - d0))
    return { maskFeather: Math.min(MASK_FEATHER_MAX, Math.max(0, band / short)) }
  }
  const handle = gesture.slice(7) as MaskHandle
  const t = m.rotation * RAD
  const lx = dx * Math.cos(t) + dy * Math.sin(t)
  const ly = -dx * Math.sin(t) + dy * Math.cos(t)
  const dirX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const dirY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  const out: MaskChanges = {}
  if (dirX) out.maskW = Math.max(MIN_SIDE, m.w + (2 * dirX * lx) / boxW)
  if (dirY) out.maskH = Math.max(MIN_SIDE, m.h + (2 * dirY * ly) / boxH)
  return out
}

/**
 * The rotate gesture, one step: the pointer's turn about the mask centre from
 * `prev` to `to`, wrapped to -180..180 and added to `rotation` (the rotation so
 * far). Called per move with the previous move's point, so a drag past 180
 * degrees in one gesture keeps turning instead of jumping by 360.
 */
export function rotateStep(m: ResolvedMask, rotation: number, prev: Pt, to: Pt, boxW: number, boxH: number): number {
  const c = maskCentre(m, boxW, boxH)
  const a0 = Math.atan2(prev.y - c.y, prev.x - c.x)
  const a1 = Math.atan2(to.y - c.y, to.x - c.x)
  return rotation + wrapDeg((a1 - a0) / RAD)
}

/**
 * A wipe's edge line clipped to the box, as its two end points, or null when
 * the line misses the box. The line runs through (x, y) along
 * (-sin θ, cos θ).
 */
export function wipeLine(m: ResolvedMask, boxW: number, boxH: number, offsetPx = 0): Array<[number, number]> | null {
  const t = m.rotation * RAD
  const nx = Math.cos(t)
  const ny = Math.sin(t)
  const c = maskCentre(m, boxW, boxH)
  const px = c.x + nx * offsetPx
  const py = c.y + ny * offsetPx
  const ux = -ny
  const uy = nx
  // Liang-Barsky: the span of s for which p + s·u stays in the box.
  let lo = -Infinity
  let hi = Infinity
  for (const [p, u, max] of [[px, ux, boxW], [py, uy, boxH]] as const) {
    if (Math.abs(u) < 1e-12) {
      if (p < 0 || p > max) return null
      continue
    }
    const a = (0 - p) / u
    const b = (max - p) / u
    lo = Math.max(lo, Math.min(a, b))
    hi = Math.min(hi, Math.max(a, b))
  }
  if (!(hi > lo)) return null
  return [[px + ux * lo, py + uy * lo], [px + ux * hi, py + uy * hi]]
}

/**
 * The feather band's two dashed rings: `outer` (band / 2 outside the edge,
 * never closer than OUTER_RING_MIN_PX, so there is always something to grab,
 * even at feather 0) and `inner` (band / 2 inside), null when not feathered
 * or when it would collapse. For an ellipse or rect, `maskPolygon` with w and
 * h grown / shrunk by 4 sigma over the box on each axis (2 sigma off the edge
 * each way). For a wipe, the edge line moved to each side; outer is the HIDDEN
 * side (+normal), and either is null when it misses the box.
 */
export interface FeatherRings {
  outer: Array<[number, number]> | null
  inner: Array<[number, number]> | null
}

export function featherRings(m: ResolvedMask, boxW: number, boxH: number): FeatherRings {
  const sigma = maskSigmaPx(m, boxW, boxH)
  const feathered = sigma > 0
  const out = Math.max(2 * sigma, OUTER_RING_MIN_PX)
  if (m.shape === 'wipe') {
    return {
      outer: wipeLine(m, boxW, boxH, out),
      inner: feathered ? wipeLine(m, boxW, boxH, -2 * sigma) : null,
    }
  }
  // Grow by `out` px each side: the polygon's w/h are fractions of the box.
  const outer = maskPolygon({ ...m, w: m.w + (2 * out) / boxW, h: m.h + (2 * out) / boxH }, boxW, boxH)
  const gw = (4 * sigma) / boxW
  const gh = (4 * sigma) / boxH
  const inner = feathered && m.w - gw > 0 && m.h - gh > 0 ? maskPolygon({ ...m, w: m.w - gw, h: m.h - gh }, boxW, boxH) : null
  return { outer, inner }
}

/** The eight squares around the mask's box, in its own frame: [x, y] in half-sizes. */
const RESIZE_ANCHORS: Array<[MaskHandle, number, number]> = [
  ['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1],
  ['w', -1, 0], ['e', 1, 0],
  ['sw', -1, 1], ['s', 0, 1], ['se', 1, 1],
]

export interface MaskHandles {
  /** The squares at the mask box's corners and edge midpoints; none for a wipe. */
  resize: Array<{ handle: MaskHandle; at: [number, number] }>
  /** The rotate handle, and where its stalk starts (the top edge's midpoint), or null for a wipe. */
  rotate: { at: [number, number]; stalkFrom: [number, number] | null }
}

/** Where every handle sits, in box pixels. All of them turn with the mask. */
export function maskHandles(m: ResolvedMask, boxW: number, boxH: number): MaskHandles {
  if (m.shape === 'wipe') {
    return {
      resize: [],
      // Up the edge line (its direction is (-sin θ, cos θ), so up is minus that).
      rotate: { at: fromMaskFrame(m, boxW, boxH, 0, -WIPE_ROTATE_OFFSET_PX), stalkFrom: null },
    }
  }
  const rx = (m.w * boxW) / 2
  const ry = (m.h * boxH) / 2
  return {
    resize: RESIZE_ANCHORS.map(([handle, ax, ay]) => ({ handle, at: fromMaskFrame(m, boxW, boxH, ax * rx, ay * ry) })),
    rotate: {
      at: fromMaskFrame(m, boxW, boxH, 0, -ry - ROTATE_OFFSET_PX),
      stalkFrom: fromMaskFrame(m, boxW, boxH, 0, -ry),
    },
  }
}

/** How far inside the clip's edge a handle that left the box is pinned, px. */
export const PIN_INSET_PX = 18
/** The step along an edge that keeps two pinned handles apart, px. */
const PIN_STEP_PX = 22

export interface PinnedHandles {
  resize: Array<{ handle: MaskHandle; at: [number, number]; pinned: boolean }>
  rotate: { at: [number, number]; stalkFrom: [number, number] | null; pinned: boolean }
}

/**
 * The handles, each one outside the clip's box pinned just inside its edge.
 * The preview frame clips to the canvas, so a mask grown past a full-frame
 * clip (a reveal's end) would otherwise show none of its handles, and the
 * only handles left on screen would be the clip's own. Every gesture works
 * from the pointer's change, never its position, so a pinned handle drags as
 * its real place would. A pinned handle slides along its edge, clear of the
 * handles placed before it; a pinned rotate handle has no stalk.
 */
export function pinHandles(h: MaskHandles, boxW: number, boxH: number): PinnedHandles {
  const taken: Array<[number, number]> = []
  const clamp = (n: number, max: number) => Math.min(Math.max(n, PIN_INSET_PX), Math.max(PIN_INSET_PX, max - PIN_INSET_PX))
  const pin = (at: [number, number]): { at: [number, number]; pinned: boolean } => {
    if (at[0] >= 0 && at[0] <= boxW && at[1] >= 0 && at[1] <= boxH) {
      taken.push(at)
      return { at, pinned: false }
    }
    // Off the top or bottom: slide along x; off a side: along y.
    const alongX = at[1] < 0 || at[1] > boxH
    const base: [number, number] = [clamp(at[0], boxW), clamp(at[1], boxH)]
    const free = (q: [number, number]) => !taken.some(t => Math.hypot(t[0] - q[0], t[1] - q[1]) < PIN_STEP_PX - 1)
    let p = base
    // Steps of +1, -1, +2, -2... along the edge, staying inside the box.
    for (let k = 1; k <= 16 && !free(p); k++) {
      const s = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * PIN_STEP_PX
      const q: [number, number] = alongX ? [base[0] + s, base[1]] : [base[0], base[1] + s]
      if (alongX ? clamp(q[0], boxW) === q[0] : clamp(q[1], boxH) === q[1]) p = q
    }
    taken.push(p)
    return { at: p, pinned: true }
  }
  const resize = h.resize.map(({ handle, at }) => ({ handle, ...pin(at) }))
  const rotate = pin(h.rotate.at)
  return {
    resize,
    rotate: { ...rotate, stalkFrom: rotate.pinned ? null : h.rotate.stalkFrom },
  }
}

/** An SVG `points` attribute. */
export function pointsAttr(pts: ReadonlyArray<readonly [number, number]>): string {
  return pts.map(([x, y]) => `${x},${y}`).join(' ')
}

/**
 * Whether a rect or ellipse mask takes in the whole box, give or take `slackPx`
 * at the corners (a rounded rect's corners sit a little inside the box's). Then
 * its fill is no move area: the centre belongs to the clip.
 */
export function coversBox(m: ResolvedMask, boxW: number, boxH: number, slackPx = 16): boolean {
  if (m.shape === 'wipe') return false
  return ([[0, 0], [boxW, 0], [boxW, boxH], [0, boxH]] as const).every(
    ([x, y]) => insideDistance(m, { x, y }, boxW, boxH) >= -slackPx,
  )
}

/**
 * A 3D item (render/scene3d.js): an overlay whose `src` is the reserved
 * `engine:scene3d`, and whose `props.inPoint` is how many seconds into its 3D
 * it starts. The frame it shows at item-local time `t` is the 3D's frame at
 * `inPoint + t`, so an edit that moves the item's head while its content stays
 * where it was on the timeline (a head trim, the right half of a split) moves
 * `inPoint` by the same amount, or the picture jumps. After a cut inside the
 * item, `props.timeMap` ([[item time, scene second, length]] pieces) says which
 * scene seconds it plays; `inPoint` is then the scene second at item time 0,
 * and a head edit moves the pieces with the head.
 *
 * The user never meets the concept: these items read as plain "3D" in the
 * editor, and the editor keeps their in point consistent on its own.
 */

/** The reserved overlay `src` of a 3D item. */
export const SCENE3D_SRC = 'engine:scene3d'

/**
 * A 3D item's own props, which the editor never shows as fields: which 3D it
 * draws (`scene`), where in it it starts (`inPoint`), and the two a stage
 * derives from them (`sceneFile`, `sceneJson`). The AI sets them; edits keep
 * `inPoint` consistent on their own.
 */
export const SCENE3D_PROPS: ReadonlySet<string> = new Set(['scene', 'inPoint', 'timeMap', 'sceneFile', 'sceneJson'])

interface Scene3dFields {
  type?: string
  src?: string
  props?: Record<string, unknown>
}

export function isScene3dItem(item: Scene3dFields | null | undefined): boolean {
  return !!item && item.type === 'overlay' && item.src === SCENE3D_SRC
}

/** Seconds into its 3D the item starts at: `props.inPoint`, 0 when absent. */
export function scene3dInPoint(item: Scene3dFields): number {
  const v = item.props?.inPoint
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * `item` with its in point moved by `delta` (timeline seconds its head moved
 * while its content stayed in place). Anything that is not a 3D item comes
 * back as the same object. Never below 0, which render refuses: the edits that
 * can move a head earlier stop there themselves.
 */
export function shiftScene3dInPoint<T extends Scene3dFields>(item: T, delta: number): T {
  if (!isScene3dItem(item) || delta === 0) return item
  const pieces = timeMapOf(item)
  if (!pieces) return { ...item, props: { ...item.props, inPoint: Math.max(0, scene3dInPoint(item) + delta) } }
  // The head moved by delta: every piece starts delta earlier on the item's own clock. What falls before 0 is
  // trimmed away; a head moved earlier runs the first piece back (the edits stop where the 3D begins).
  const moved: Array<[number, number, number]> = []
  for (const [t, s, n] of pieces) {
    const t0 = t - delta
    const t1 = t0 + n
    if (t1 <= 1e-9) continue
    moved.push(t0 < 0 ? [0, s - t0, t1] : [t0, s, n])
  }
  if (moved.length === 0) return item
  if (moved[0][0] > 1e-9) {
    const lead = moved[0][0]
    moved[0] = [0, Math.max(0, moved[0][1] - lead), moved[0][2] + lead]
  }
  const timeMap = moved.map(([t, s, n]) => [round6(t), round6(s), round6(n)])
  return { ...item, props: { ...item.props, inPoint: timeMap[0][1], timeMap } }
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** The pieces of a well-formed `props.timeMap`, else null (the item then runs on `inPoint` alone). */
function timeMapOf(item: Scene3dFields): Array<[number, number, number]> | null {
  const raw = item.props?.timeMap
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: Array<[number, number, number]> = []
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
    if (p[2] <= 0 || p[0] < 0 || p[1] < 0) return null
    out.push([p[0], p[1], p[2]])
  }
  return out
}

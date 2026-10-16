/**
 * A 3D item (render/scene3d.js): an overlay whose `src` is the reserved
 * `engine:scene3d`, and whose `props.inPoint` is how many seconds into its 3D
 * it starts. The frame it shows at item-local time `t` is the 3D's frame at
 * `inPoint + t`, so an edit that moves the item's head while its content stays
 * where it was on the timeline (a head trim, the right half of a split) moves
 * `inPoint` by the same amount, or the picture jumps.
 *
 * The user never meets the concept: these items read as plain "3D" in the
 * editor, and the editor keeps their in point consistent on its own.
 */

/** The reserved overlay `src` of a 3D item. */
export const SCENE3D_SRC = 'engine:scene3d'

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
  return { ...item, props: { ...item.props, inPoint: Math.max(0, scene3dInPoint(item) + delta) } }
}

import { snapToSlide, type SnapGuide } from '../gestures'
import { coveredUnion, type Box } from './AlignControls'

// Moving several selected elements at once (§156). Every member moves by the
// same delta, so the group keeps its shape. Snapping follows the single drag
// (`useOverlayDrag`): the same dead zone and snap distance, applied to the box
// the whole group covers, so no member snaps on its own.

// Same values as useOverlayDrag's DEAD_ZONE_PX and SNAP_PX.
const DEAD_ZONE_PX = 12
const SNAP_PX = 6

export type GroupMember = Box & { id: string }

export interface GroupDragResult {
  /** Each member's new top-left, in the members' order. */
  positions: Array<{ id: string; x: number; y: number }>
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * Where the members land when the cursor has moved `cursor` screen pixels
 * from where the drag started, on a canvas drawn at `scale`.
 */
export function groupDragMove(
  members: readonly GroupMember[],
  cursor: { dx: number; dy: number },
  scale: number,
  slide: { w: number; h: number },
): GroupDragResult {
  let dx = cursor.dx / scale
  let dy = cursor.dy / scale
  let guides: SnapGuide[] = []
  const inDeadZone = cursor.dx * cursor.dx + cursor.dy * cursor.dy < DEAD_ZONE_PX * DEAD_ZONE_PX
  if (!inDeadZone && members.length > 0) {
    const u = coveredUnion(members)
    const proposed = { x: u.left + dx, y: u.top + dy, w: u.right - u.left, h: u.bottom - u.top }
    const snap = snapToSlide(proposed, slide, Math.max(SNAP_PX / scale, 1))
    dx = snap.position.x - u.left
    dy = snap.position.y - u.top
    guides = snap.guides
  }
  return {
    positions: members.map((m) => ({ id: m.id, x: m.x + dx, y: m.y + dy })),
    dx,
    dy,
    guides,
  }
}

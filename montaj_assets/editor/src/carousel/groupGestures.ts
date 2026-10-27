import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { CarouselElement, Slide } from '../types'
import { buildElementTransform, nextResizeBox, nextRotation, startResize, startRotate, type ResizeHandle, type ResizeState, type RotateState } from '../gestures'
import { isLocked } from './lock'
import { groupBox, groupOf, groupPivot, rotateMembers, roundedMemberBoxes, scaleMembers, wholeGroup, type MemberBox } from './groups'
import { scaleFontSize, scalesTextWithBox } from './textScale'
import type { LiveBoxes } from './liveBox'

// A selected group's resize and turn on the canvas (§587). The preview writes
// each member's box straight to its wrapper and chrome, as one element's
// gesture does, and an overlay renders at its live box (liveBox.ts); the
// release writes every member in ONE `editElements`, so one undo step. A
// corner keeps the ratio (Shift frees it) and scales a text member's font, as
// a corner drag of one text box does; a side stretches. A turn goes round the
// mean of the members' centres, which a turn does not move, so a turn and its
// opposite put the group back. The box covers the members shown: a hidden one
// stays in the group and moves with it. Moving a group is the multi-selection
// drag (groupDrag.ts).

type Box = { x: number; y: number; w: number; h: number }

interface GroupGestureArgs {
  slide: Slide
  slideId: string
  scale: number
  selectedIds: string[]
  editElements?: (slideId: string, edit: (elements: CarouselElement[]) => CarouselElement[]) => Promise<void>
  applyPreviewBox: (id: string, box: Box, rotation: number) => void
  applyPreviewOverlayBox: (id: string, box: { w: number; h: number }, ratio: number) => void
  liveBoxes: LiveBoxes
  /** Members hidden on this canvas: still moved, not in the box. */
  hidden?: ReadonlySet<string> | null
}

type Gesture =
  | { kind: 'resize'; state: ResizeState; members: CarouselElement[]; from: Box; latest: MemberBox[] | null; kept: boolean }
  | { kind: 'rotate'; state: RotateState; members: CarouselElement[]; from: Box; center: { x: number; y: number }; latest: MemberBox[] | null; deg: number }

export function useGroupGestures({ slide, slideId, scale, selectedIds, editElements, applyPreviewBox, applyPreviewOverlayBox, liveBoxes, hidden }: GroupGestureArgs) {
  /** The group the selection is, whole; null otherwise. */
  const group = wholeGroup(slide.elements, selectedIds)
  const members = group ? slide.elements.filter((el) => groupOf(el) === group) : []
  const shown = members.filter((el) => !hidden?.has(el.id))
  const box = shown.length ? groupBox(shown) : null
  const locked = members.some(isLocked)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)

  /** The group box's place, written straight to its div; a turn goes round `pivot` (slide px). */
  const place = (b: Box, rotation = 0, pivot?: { x: number; y: number }) => {
    const el = boxRef.current
    if (!el) return
    el.style.transformOrigin = pivot ? `${(pivot.x - b.x) * scale}px ${(pivot.y - b.y) * scale}px` : 'center center'
    el.style.transform = buildElementTransform(b.x, b.y, scale, rotation)
    el.style.width = `${b.w * scale}px`
    el.style.height = `${b.h * scale}px`
  }
  const preview = (boxes: MemberBox[], scaleText: boolean) => {
    for (const b of boxes) {
      applyPreviewBox(b.id, b, b.rotation)
      const el = slide.elements.find((e) => e.id === b.id)
      applyPreviewOverlayBox(b.id, b, scaleText && el && scalesTextWithBox(el) ? b.ratio : 1)
    }
  }

  const beginResize = (handle: ResizeHandle, e: ReactPointerEvent) => {
    if (!box || locked) return false
    gestureRef.current = { kind: 'resize', state: startResize('group', handle, { x: e.clientX, y: e.clientY }, box), members, from: box, latest: null, kept: false }
    return true
  }

  const beginRotate = (e: ReactPointerEvent) => {
    const div = boxRef.current
    if (!box || locked || !div) return false
    // The box is unturned at rest: the pivot is its offset into the box on screen.
    const center = groupPivot(shown)
    const r = div.getBoundingClientRect()
    const client = { x: r.left + (center.x - box.x) * scale, y: r.top + (center.y - box.y) * scale }
    gestureRef.current = {
      kind: 'rotate', state: startRotate('group', client, { x: e.clientX, y: e.clientY }, 0), members, from: box,
      center, latest: null, deg: 0,
    }
    return true
  }

  const move = (cursor: { x: number; y: number }, shiftKey: boolean) => {
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'resize') {
      const keepRatio = !shiftKey
      const next = nextResizeBox(g.state, cursor, scale, { keepRatio })
      g.kept = keepRatio && g.state.handle.length === 2
      g.latest = scaleMembers(g.members, g.from, next)
      preview(g.latest, g.kept)
      place(next)
    } else {
      g.deg = nextRotation(g.state, cursor)
      g.latest = rotateMembers(g.members, g.center, g.deg)
      preview(g.latest, false)
      place(g.from, g.deg, g.center)
    }
  }

  /** Ends the gesture, writing what it previewed. True when it wrote. */
  const end = (): boolean => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g) return false
    liveBoxes.clear()
    const restore = () => {
      for (const m of g.members) applyPreviewBox(m.id, m, m.rotation ?? 0)
      place(g.from)
    }
    if (!g.latest) { restore(); return false }
    let boxes: MemberBox[]
    if (g.kind === 'resize') boxes = roundedMemberBoxes(g.latest)
    else {
      const deg = Math.round(g.deg)
      if (deg % 360 === 0) { restore(); return false }
      boxes = roundedMemberBoxes(rotateMembers(g.members, g.center, deg))
    }
    const byId = new Map(boxes.map((b) => [b.id, b]))
    const changed = g.members.some((m) => {
      const b = byId.get(m.id)!
      return m.x !== b.x || m.y !== b.y || m.w !== b.w || m.h !== b.h || (m.rotation ?? 0) !== b.rotation
    })
    if (!changed || !editElements) { restore(); return false }
    // Drawn where they land, in this tick with the write, so nothing jumps.
    for (const b of boxes) applyPreviewBox(b.id, b, b.rotation)
    const landed = boxes.filter((b) => !hidden?.has(b.id))
    place(groupBox(landed.length ? landed : boxes))
    const kept = g.kind === 'resize' && g.kept
    void editElements(slideId, (els) => els.map((el) => {
      const b = byId.get(el.id)
      if (!b || isLocked(el)) return el
      const next = { ...el, x: b.x, y: b.y, w: b.w, h: b.h, rotation: b.rotation }
      if (kept && scalesTextWithBox(el)) {
        const source = el.overlay.props.fontSize
        const fontSize = scaleFontSize(source, b.ratio)
        if (fontSize !== null && fontSize !== scaleFontSize(source, 1)) {
          return { ...next, overlay: { ...el.overlay, props: { ...el.overlay.props, fontSize } } } as CarouselElement
        }
      }
      return next as CarouselElement
    })).catch(() => {})
    return true
  }

  /** A multi-selection drag of the group: its box follows by `d` (slide px); null puts it back. */
  const dragTo = (d: { dx: number; dy: number } | null) => {
    if (!box) return
    place(d ? { ...box, x: box.x + d.dx, y: box.y + d.dy } : box)
  }

  return { group, box, locked, boxRef, handles: !!editElements, beginResize, beginRotate, move, end, dragTo }
}

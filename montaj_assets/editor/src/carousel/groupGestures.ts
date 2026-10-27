import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { CarouselElement, Slide } from '../types'
import { buildElementTransform, nextResizeBox, nextRotation, startResize, startRotate, type ResizeHandle, type ResizeState, type RotateState } from '../gestures'
import { isLocked } from './lock'
import { groupBox, groupOf, rotateMembers, roundedMemberBoxes, scaleMembers, wholeGroup, type MemberBox } from './groups'
import { scaleFontSize, scalesTextWithBox } from './textScale'
import type { LiveBoxes } from './liveBox'

// A selected group's resize and turn on the canvas (§587). The preview writes
// each member's box straight to its wrapper and chrome, as one element's
// gesture does, and an overlay renders at its live box (liveBox.ts); the
// release writes every member in ONE `editElements`, so one undo step. A
// corner keeps the ratio (Shift frees it) and scales a text member's font, as
// a corner drag of one text box does; a side stretches. A turn goes round the
// group box's centre. Moving a group is the multi-selection drag (groupDrag.ts).

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
}

type Gesture =
  | { kind: 'resize'; state: ResizeState; members: CarouselElement[]; from: Box; latest: MemberBox[] | null; kept: boolean }
  | { kind: 'rotate'; state: RotateState; members: CarouselElement[]; from: Box; center: { x: number; y: number }; latest: MemberBox[] | null; deg: number }

export function useGroupGestures({ slide, slideId, scale, selectedIds, editElements, applyPreviewBox, applyPreviewOverlayBox, liveBoxes }: GroupGestureArgs) {
  /** The group the selection is, whole; null otherwise. */
  const group = wholeGroup(slide.elements, selectedIds)
  const members = group ? slide.elements.filter((el) => groupOf(el) === group) : []
  const box = members.length ? groupBox(members) : null
  const locked = members.some(isLocked)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)

  /** The group box's place, written straight to its div. */
  const place = (b: Box, rotation = 0) => {
    const el = boxRef.current
    if (!el) return
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
    const r = div.getBoundingClientRect()
    const client = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    gestureRef.current = {
      kind: 'rotate', state: startRotate('group', client, { x: e.clientX, y: e.clientY }, 0), members, from: box,
      center: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, latest: null, deg: 0,
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
      place(g.from, g.deg)
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
    place(groupBox(boxes))
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

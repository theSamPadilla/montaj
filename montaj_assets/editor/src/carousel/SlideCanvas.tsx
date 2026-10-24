import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import type { Slide, OverlayElement, ImageElement, OverlayFactory } from '../types'
import OverlayErrorBoundary from './OverlayErrorBoundary'
import {
  useOverlayDrag,
  useOverlayResize,
  useOverlayRotate,
  buildElementTransform,
  roundResizedBox,
  type ResizeHandle as ResizeHandleId,
  type SnapGuide,
} from '../gestures'
import { OverlayPreview } from '../preview/OverlayPreview'
import { CanvasCropOverlay } from '../crop/CanvasCropOverlay'
import { InlineTextEditor } from '../text/InlineTextEditor'
import { ensureGoogleFontsLoaded } from '../lib/google-fonts'
import { groupDragMove, type GroupDragResult, type GroupMember } from './groupDrag'

// Neutral fallback used only when no host `resolveImageSrc` is injected. The
// package must not synthesize a host-shaped URL (e.g. Montaj's `/api/files`):
// it returns the `src` unchanged so a host without a resolver gets a passthrough
// rather than a URL it can't serve. Hosts that need resolution always inject
// `resolveImageSrc` (Montaj's adapter does).
function resolveAssetDefault(src: string): string {
  return src
}

// ── Resize / Rotate handle geometry ────────────────────────────────────────────

const HANDLE_SIZE = 8
const ROTATE_OFFSET = 20

const HANDLES: { id: ResizeHandleId; cursor: string; xPct: number; yPct: number }[] = [
  { id: 'nw', cursor: 'nwse-resize', xPct: 0,   yPct: 0   },
  { id: 'n',  cursor: 'ns-resize',   xPct: 0.5, yPct: 0   },
  { id: 'ne', cursor: 'nesw-resize', xPct: 1,   yPct: 0   },
  { id: 'e',  cursor: 'ew-resize',   xPct: 1,   yPct: 0.5 },
  { id: 'se', cursor: 'nwse-resize', xPct: 1,   yPct: 1   },
  { id: 's',  cursor: 'ns-resize',   xPct: 0.5, yPct: 1   },
  { id: 'sw', cursor: 'nesw-resize', xPct: 0,   yPct: 1   },
  { id: 'w',  cursor: 'ew-resize',   xPct: 0,   yPct: 0.5 },
]

// ── OverlayElementView — shared OverlayPreview wrapper ─────────────────────────

// Fallback compiler used when no compiler is injected (e.g. thumbnail previews
// that don't need live overlay rendering). Always rejects so OverlayPreview
// shows its errorState rather than a spinner that never resolves.
const noopCompiler = (): Promise<OverlayFactory> =>
  Promise.reject(new Error('No overlay compiler provided'))

function OverlayElementView({
  element,
  compileOverlay,
}: {
  element: OverlayElement
  compileOverlay?: (template: string) => Promise<OverlayFactory>
}) {
  const duration = (element.overlay.props.duration as number | undefined) ?? 60
  const mergedProps = { ...element.overlay.props, offsetX: 0, offsetY: 0, scale: 1 }
  // Inject any Google Fonts the overlay declares so the carousel preview renders
  // with the same glyphs/metrics as the renderer. Resilient: the helper only
  // appends a <link>; a font-fetch failure never breaks the overlay render.
  useEffect(() => {
    ensureGoogleFontsLoaded(element.googleFonts)
  }, [element.googleFonts])
  return (
    <OverlayPreview
      compileOverlay={compileOverlay ?? noopCompiler}
      template={element.overlay.template}
      props={mergedProps}
      frame={element.frame}
      fps={30}
      duration={duration}
    />
  )
}

// ── SlideCanvas ───────────────────────────────────────────────────────────────

type Crop = { x: number; y: number; w: number; h: number }

/** The whole source: what an image with no crop shows. */
const FULL_FRAME: Crop = { x: 0, y: 0, w: 1, h: 1 }

/** Crops this close on every side are the same crop: a window dragged back to
 *  where it was comes back through float math. */
const SAME_CROP_EPSILON = 1e-6

function sameCrop(a: Crop, b: Crop): boolean {
  return (
    Math.abs(a.x - b.x) < SAME_CROP_EPSILON &&
    Math.abs(a.y - b.y) < SAME_CROP_EPSILON &&
    Math.abs(a.w - b.w) < SAME_CROP_EPSILON &&
    Math.abs(a.h - b.h) < SAME_CROP_EPSILON
  )
}

/** A crop in progress (§556 M4): the image, the slide it is on, the file it was
 *  started on, and the window picked so far (source fractions). */
type CropSession = { slideId: string; elementId: string; src: string; localCrop: Crop }

/** The window starts as the crop the image has: the whole source when none. */
function startCrop(slideId: string, el: ImageElement): CropSession {
  return { slideId, elementId: el.id, src: el.src, localCrop: el.crop ?? FULL_FRAME }
}

/** How crop mode ends: `apply` writes the window picked, as one undo step, and
 *  nothing when it is the crop the image has; `discard` writes nothing. */
export type CropExit = 'apply' | 'discard'

/** The host's hold on crop mode (§556 M4): every way out of it but Esc, which
 *  this canvas handles itself, goes through `leave`. */
export interface SlideCanvasCropControl {
  /** Ends crop mode, if it is on. Resolves once what it wrote is saved. */
  leave: (how: CropExit) => Promise<void>
}

interface Props {
  slide: Slide
  slideId?: string
  width: number
  height: number
  interactive?: boolean
  /** The one selected element: it gets the resize, rotate and crop handles. */
  selectedElementId?: string | null
  onSelect?: (id: string | null) => void
  /**
   * Every selected element, in click order (§156). Each draws the selection
   * outline; dragging one of them when there are two or more moves them all.
   * Absent → just `selectedElementId`.
   */
  selectedElementIds?: string[]
  /** Shift-click on an element: add it to the selection or take it out. Absent → shift-click selects as a plain click. */
  onToggleSelect?: (id: string) => void
  scale?: number
  resolveImageSrc?: (element: ImageElement) => string
  /**
   * Host-supplied overlay compiler. Injected from the adapter so SlideCanvas
   * (and OverlayPreview inside it) never import '@/lib/overlay-eval' directly.
   * When absent, overlay elements render nothing (thumbnail / read-only paths).
   */
  compileOverlay?: (template: string) => Promise<OverlayFactory>

  /**
   * Host-supplied file watcher. Threaded into OverlayErrorBoundary so editing an
   * overlay's source on disk auto-recovers its preview. When absent, no watch is
   * opened — the package never reaches for a host transport directly.
   */
  watchFile?: (path: string, onChange: () => void) => () => void

  // Project-state mutators (editor-core). Required for the interactive path.
  moveElement?: (slideId: string, elementId: string, x: number, y: number) => Promise<void>
  resizeElement?: (slideId: string, elementId: string, box: { x: number; y: number; w: number; h: number }) => Promise<void>
  rotateElement?: (slideId: string, elementId: string, rotation: number) => Promise<void>
  commit?: () => Promise<void>
  updateOverlayProp?: (slideId: string, elementId: string, key: string, value: string) => Promise<void>
  updateImageCrop?: (slideId: string, elementId: string, crop: { x: number; y: number; w: number; h: number } | undefined) => Promise<void>

  // Crop mode is owned here; the host enters it (the panel's Crop button, or a
  // double-click on an image) and is told when it ends.
  cropElementId?: string | null
  onExitCrop?: () => void
  /** Double-click on an unrotated image asks the host to crop it. Absent → double-click on an image does nothing. */
  onEnterCrop?: (elementId: string) => void
  /** Set to the control that ends crop mode from the host (§556 M4). */
  cropControlRef?: Ref<SlideCanvasCropControl>

  /**
   * Editor-only element ids to omit from this canvas (non-persisted). Used by
   * the host's visibility toggle to hide a scrim/background while positioning
   * overlays beneath it. Absent → all elements render.
   */
  hiddenElementIds?: string[]

  /**
   * Drag-and-drop on the canvas root (§556 M7), for the editor to take images
   * dropped on the slide. Forwarded to an interactive canvas only (a thumbnail
   * takes no drops); the editor turns a drop's client point into slide units
   * with the root's rect and `scale`. Absent → the canvas takes no drags.
   */
  onDragEnter?: React.DragEventHandler<HTMLDivElement>
  onDragOver?: React.DragEventHandler<HTMLDivElement>
  onDrop?: React.DragEventHandler<HTMLDivElement>

  /**
   * Layers drawn over the slide (the editor's note pins and armed-note layer,
   * PL70): rendered last inside the outer box, above the elements, so they
   * can position themselves in percentages of the slide. Absent → nothing.
   */
  children?: ReactNode
}

// Plain default for the inline editor when we can't read the rendered text's
// real style (e.g. no matching node found).
const FALLBACK_EDIT_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#ffffff',
  fontSize: '18px',
  fontFamily: 'system-ui, sans-serif',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

// Find the innermost element under `root` whose full text equals `text` — the
// overlay's text container. Used to copy its computed style onto the editor.
function findTextNode(root: HTMLElement, text: string): HTMLElement | null {
  const want = text.trim()
  if (!want) return null
  const matches: HTMLElement[] = []
  const walk = (el: HTMLElement) => {
    if ((el.textContent ?? '').trim() === want) matches.push(el)
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement) walk(child)
    }
  }
  walk(root)
  if (matches.length === 0) return null
  // Innermost match = the one with the fewest descendant elements.
  return matches.reduce((best, el) =>
    el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best,
  )
}

// Snapshot the rendered overlay text's computed style so the inline editor
// matches it instead of a generic stub. Overlays are authored at native slide
// pixels then CSS-scaled by `scale`; the editor is positioned in already-scaled
// display coords with no transform, so px metrics must be multiplied by `scale`.
// Returns null when no text node is found (caller falls back).
function captureTextStyle(
  wrapper: HTMLElement | undefined,
  text: string,
  scale: number,
): Partial<CSSStyleDeclaration> | null {
  if (!wrapper || typeof window === 'undefined') return null
  const target = findTextNode(wrapper, text)
  if (!target) return null
  const cs = window.getComputedStyle(target)
  const scalePx = (v: string) => {
    const n = parseFloat(v)
    return Number.isFinite(n) ? `${n * scale}px` : v
  }
  return {
    color: cs.color,
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    textAlign: cs.textAlign,
    textTransform: cs.textTransform,
    fontSize: scalePx(cs.fontSize),
    lineHeight: cs.lineHeight === 'normal' ? 'normal' : scalePx(cs.lineHeight),
    letterSpacing: cs.letterSpacing === 'normal' ? 'normal' : scalePx(cs.letterSpacing),
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Partial<CSSStyleDeclaration>
}

export default function SlideCanvas({
  slide,
  slideId,
  width,
  height,
  interactive = false,
  selectedElementId,
  onSelect,
  selectedElementIds,
  onToggleSelect,
  scale = 1,
  resolveImageSrc,
  compileOverlay,
  watchFile,
  moveElement,
  resizeElement,
  rotateElement,
  commit,
  updateOverlayProp,
  updateImageCrop,
  cropElementId,
  onExitCrop,
  onEnterCrop,
  cropControlRef,
  hiddenElementIds,
  onDragEnter,
  onDragOver,
  onDrop,
  children,
}: Props) {
  const sid = slideId ?? slide.id
  const resolveSrc = resolveImageSrc ?? ((el: ImageElement) => resolveAssetDefault(el.src))
  const hiddenSet = hiddenElementIds && hiddenElementIds.length ? new Set(hiddenElementIds) : null
  const selectedIds = selectedElementIds ?? (selectedElementId ? [selectedElementId] : [])

  // Refs to each element wrapper so gesture previews can mutate DOM directly.
  const wrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const setWrapperRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) wrapperRefs.current.set(id, el)
    else wrapperRefs.current.delete(id)
  }

  // Inline text edit state.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRect, setEditRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [editStyle, setEditStyle] = useState<Partial<CSSStyleDeclaration> | null>(null)

  // Crop mode (§556 M4): the crop in progress. The ref is what handlers read,
  // current within one tick; the state draws it.
  const cropRef = useRef<CropSession | null>(null)
  const [cropSession, setCropSessionState] = useState<CropSession | null>(null)
  const setCropSession = (next: CropSession | null) => {
    cropRef.current = next
    setCropSessionState(next)
  }
  const changeCropSession = (change: (open: CropSession) => CropSession) => {
    if (cropRef.current) setCropSession(change(cropRef.current))
  }
  // The natural size of the file the crop preview last loaded. It belongs to
  // that file alone, so it outlives slide changes and goes stale only when the
  // image gets another file.
  const [cropSrcDims, setCropSrcDims] = useState<{ src: string; width: number; height: number } | null>(null)
  const dimsOf = (open: CropSession | null) =>
    open && cropSrcDims?.src === open.src ? { width: cropSrcDims.width, height: cropSrcDims.height } : undefined

  // ── Gesture preview helper: write transform/size directly to the wrapper ──
  const applyPreviewTransform = (id: string, x: number, y: number, rotation: number) => {
    const el = wrapperRefs.current.get(id)
    if (el) el.style.transform = buildElementTransform(x, y, scale, rotation)
  }
  const applyPreviewBox = (
    id: string,
    box: { x: number; y: number; w: number; h: number },
    rotation: number,
  ) => {
    const el = wrapperRefs.current.get(id)
    if (!el) return
    el.style.transform = buildElementTransform(box.x, box.y, scale, rotation)
    el.style.width = `${box.w * scale}px`
    el.style.height = `${box.h * scale}px`
  }

  // ── Gesture hooks ──
  // Each commit rounds to whole pixels and draws exactly that, since the
  // preview drew the unrounded value. A gesture that rounds back to where the
  // element already is, or whose element is gone, records nothing: no edit,
  // no commit, no undo step.
  const elementById = (id: string) => slide.elements.find((e) => e.id === id)

  const drag = useOverlayDrag({
    scale,
    slide: { w: width, h: height },
    onPreview: applyPreviewTransform,
    onCommit: async (id, x, y) => {
      const el = elementById(id)
      if (!el) return
      const nx = Math.round(x)
      const ny = Math.round(y)
      applyPreviewTransform(id, nx, ny, el.rotation)
      if (nx === el.x && ny === el.y) return
      await moveElement?.(sid, id, nx, ny)
      await commit?.()
    },
  })

  const resize = useOverlayResize({
    scale,
    onPreview: applyPreviewBox,
    onCommit: async (id, box, gesture) => {
      const el = elementById(id)
      if (!el) return
      const rotation = gesture.startBox.rotation ?? 0
      // w and h first, then x and y from the point the handle pins.
      const next = roundResizedBox(box, gesture.handle, rotation)
      applyPreviewBox(id, next, rotation)
      if (next.x === el.x && next.y === el.y && next.w === el.w && next.h === el.h) return
      await resizeElement?.(sid, id, next)
      await commit?.()
    },
  })

  const rotate = useOverlayRotate({
    onPreview: (id, rotation, x, y) => applyPreviewTransform(id, x, y, rotation),
    onCommit: async (id, rotation) => {
      const el = elementById(id)
      if (!el) return
      const next = Math.round(rotation)
      // A whole turn away is the same angle: put back the element's own.
      const same = ((next - (el.rotation ?? 0)) % 360 + 360) % 360 === 0
      applyPreviewTransform(id, el.x, el.y, same ? el.rotation : next)
      if (same) return
      await rotateElement?.(sid, id, next)
      await commit?.()
    },
  })

  // ── Crop mode (§556 M4) ──
  // Writes the window picked onto the image it was picked on: the box takes
  // the window's shape at its width, then the crop, which `updateImageCrop`
  // folds into one undo step with the box, then a commit. Every call is made
  // in this tick, so nothing the caller does next lands between them. Writes
  // nothing when the image is not on this slide, its size is not known yet,
  // or the window is the crop the image already has.
  function writeCrop(open: CropSession): Promise<void> {
    const el = open.slideId === sid ? slide.elements.find((e) => e.id === open.elementId) : undefined
    const dims = dimsOf(open)
    if (el?.type !== 'image' || !dims) return Promise.resolve()
    if (sameCrop(open.localCrop, el.crop ?? FULL_FRAME)) return Promise.resolve()
    const writes: Array<Promise<void> | undefined> = []
    // The window's pixel aspect, as a box height for the box's width.
    const aspect = (open.localCrop.w * dims.width) / (open.localCrop.h * dims.height)
    if (Number.isFinite(aspect) && aspect > 0) {
      const h = Math.round(el.w / aspect)
      if (h !== el.h) writes.push(resizeElement?.(open.slideId, el.id, { x: el.x, y: el.y, w: el.w, h }))
    }
    writes.push(updateImageCrop?.(open.slideId, el.id, open.localCrop))
    writes.push(commit?.())
    return Promise.all(writes).then(() => undefined)
  }

  // The one way crop mode ends: Esc here, the host's control for every other
  // way out, and the image going away. Resolves once the write is saved.
  function leaveCrop(how: CropExit): Promise<void> {
    const open = cropRef.current
    if (!open) return Promise.resolve()
    setCropSession(null)
    const written = how === 'apply' ? writeCrop(open) : Promise.resolve()
    onExitCrop?.()
    return written
  }
  // The latest render's, for the handle, Esc and the effects below.
  const leaveCropRef = useRef(leaveCrop)
  leaveCropRef.current = leaveCrop
  useImperativeHandle(cropControlRef, () => ({ leave: (how) => leaveCropRef.current(how) }), [])

  // The host enters crop mode, moves it to another image, or ends it without
  // the control (the image deleted): the window starts as the image's own
  // crop, or what was picked is dropped, writing nothing.
  useEffect(() => {
    const open = cropRef.current
    if (open?.elementId === cropElementId) return
    if (open) setCropSession(null)
    if (!cropElementId) return
    const el = slide.elements.find((e) => e.id === cropElementId)
    if (el?.type !== 'image') {
      onExitCrop?.()
      return
    }
    setCropSession(startCrop(sid, el))
  }, [cropElementId])

  // Any other change to the slide keeps the window picked. A new file for the
  // image (a Replace landing) starts it again from that file's crop; the image
  // going away ends crop mode, writing nothing.
  useEffect(() => {
    const open = cropRef.current
    if (!open) return
    const el = open.slideId === sid ? slide.elements.find((e) => e.id === open.elementId) : undefined
    if (el?.type !== 'image') void leaveCropRef.current('discard')
    else if (el.src !== open.src) setCropSession(startCrop(sid, el))
  }, [slide, sid])

  // Esc applies the crop. The editor's own keys leave Esc alone in crop mode.
  const cropOpen = cropSession !== null
  useEffect(() => {
    if (!cropOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // A save that fails is rolled back and shown by the host.
      leaveCropRef.current('apply').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cropOpen])

  // ── Inline text edit ──
  function beginTextEdit(element: OverlayElement) {
    if (!interactive || typeof element.overlay.props.text !== 'string') return
    // Snapshot the live text's style BEFORE we hide it / re-render.
    setEditStyle(
      captureTextStyle(wrapperRefs.current.get(element.id), element.overlay.props.text, scale),
    )
    setEditRect({
      left: element.x * scale,
      top: element.y * scale,
      width: element.w * scale,
      height: element.h * scale,
    })
    setEditingId(element.id)
  }

  function endTextEdit() {
    setEditingId(null)
    setEditRect(null)
    setEditStyle(null)
  }

  function commitTextEdit(element: OverlayElement, value: string) {
    void updateOverlayProp?.(sid, element.id, 'text', value)
    endTextEdit()
  }

  // ── Pointer wiring shared by drag/resize/rotate ──
  // We attach window-level move/up listeners while a gesture is active so the
  // gesture keeps tracking outside the element bounds.
  const activeGesture = useRef<'drag' | 'resize' | 'rotate' | 'group' | null>(null)

  // Set when a gesture ends (a resize, a rotate, a drag, or a group drag that
  // moved), so the click the browser sends after its release changes nothing:
  // not a deselect when the pointer was let go off the element (that click
  // lands on the canvas), not a collapse of the selection to the element under
  // the pointer. The next press on the canvas clears it, so a release off the
  // canvas, whose click never comes here, cannot swallow a later click.
  const swallowClickRef = useRef(false)

  // ── Group drag (§156): every selected element moves by one delta, one undo step ──
  const groupRef = useRef<{ start: { x: number; y: number }; members: GroupMember[]; latest: GroupDragResult | null } | null>(null)
  const [groupGuides, setGroupGuides] = useState<SnapGuide[]>([])
  const groupHandlers = useRef({ move: (_c: { x: number; y: number }) => {}, up: () => {} })
  groupHandlers.current = {
    move: (cursor) => {
      const g = groupRef.current
      if (!g) return
      const result = groupDragMove(g.members, { dx: cursor.x - g.start.x, dy: cursor.y - g.start.y }, scale, { w: width, h: height })
      g.latest = result
      setGroupGuides(result.guides)
      for (const p of result.positions) {
        const m = g.members.find((mm) => mm.id === p.id)
        applyPreviewTransform(p.id, p.x, p.y, m?.rotation ?? 0)
      }
    },
    up: () => {
      const g = groupRef.current
      groupRef.current = null
      setGroupGuides([])
      const result = g?.latest
      if (!g || !result || (result.dx === 0 && result.dy === 0)) return
      swallowClickRef.current = true
      const moves = result.positions.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) }))
      const moved = moves.some((p) => {
        const m = g.members.find((mm) => mm.id === p.id)
        return !m || m.x !== p.x || m.y !== p.y
      })
      if (!moved) {
        // Rounded back to where they are: draw them there, record nothing.
        for (const m of g.members) applyPreviewTransform(m.id, m.x, m.y, m.rotation ?? 0)
        return
      }
      void (async () => {
        for (const p of moves) await moveElement?.(sid, p.id, p.x, p.y)
        await commit?.()
      })()
    },
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cursor = { x: e.clientX, y: e.clientY }
      if (activeGesture.current === 'drag') drag.onPointerMove(cursor)
      else if (activeGesture.current === 'resize') resize.onPointerMove(cursor, { shiftKey: e.shiftKey })
      else if (activeGesture.current === 'rotate') rotate.onPointerMove(cursor)
      else if (activeGesture.current === 'group') groupHandlers.current.move(cursor)
    }
    const onUp = () => {
      const gesture = activeGesture.current
      activeGesture.current = null
      if (gesture === 'drag') drag.onPointerUp()
      else if (gesture === 'resize') resize.onPointerUp()
      else if (gesture === 'rotate') rotate.onPointerUp()
      else if (gesture === 'group') groupHandlers.current.up()
      // A group drag decides for itself: a press on a member that did not move
      // is a click, and collapses the selection to that member.
      if (gesture === 'drag' || gesture === 'resize' || gesture === 'rotate') swallowClickRef.current = true
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, resize, rotate])

  const displayW = width * scale
  const displayH = height * scale

  return (
    <div
      data-interactive={interactive ? 'true' : undefined}
      role={interactive ? 'group' : 'presentation'}
      aria-label={interactive ? 'Slide canvas' : undefined}
      style={{
        width: displayW,
        height: displayH,
        overflow: 'hidden',
        position: 'relative',
        flexShrink: 0,
      }}
      onPointerDownCapture={interactive ? () => { swallowClickRef.current = false } : undefined}
      onClick={interactive ? () => {
        if (swallowClickRef.current) { swallowClickRef.current = false; return }
        onSelect?.(null)
      } : undefined}
      onDragEnter={interactive ? onDragEnter : undefined}
      onDragOver={interactive ? onDragOver : undefined}
      onDrop={interactive ? onDrop : undefined}
    >
      {/* Inner native-resolution layer. Elements are positioned at native coords
          and the wrapper transform applies translate(...*scale) so gesture
          previews can mutate the same transform string. */}
      <div
        style={{
          width: displayW,
          height: displayH,
          position: 'absolute',
          top: 0,
          left: 0,
          backgroundColor: slide.base_color || '#ffffff',
        }}
      >
        {/* Snap guides — drawn at the drag hook's reported guide axes. */}
        {interactive && (groupGuides.length > 0 ? groupGuides : drag.guides).map((g: SnapGuide, i) =>
          g.axis === 'x' ? (
            <div
              key={`gx-${i}`}
              data-testid="snap-guide-x"
              style={{
                position: 'absolute',
                left: g.at * scale - 1,
                top: 0,
                width: 2,
                height: displayH,
                background: '#ff2d88',
                boxShadow: '0 0 6px 1px rgba(255,45,136,0.9)',
                pointerEvents: 'none',
                zIndex: 999,
              }}
            />
          ) : (
            <div
              key={`gy-${i}`}
              data-testid="snap-guide-y"
              style={{
                position: 'absolute',
                left: 0,
                top: g.at * scale - 1,
                width: displayW,
                height: 2,
                background: '#ff2d88',
                boxShadow: '0 0 6px 1px rgba(255,45,136,0.9)',
                pointerEvents: 'none',
                zIndex: 999,
              }}
            />
          ),
        )}

        {slide.elements.map((element) => {
          // Editor-only visibility: omit hidden elements from this canvas.
          if (hiddenSet?.has(element.id)) return null
          // Outlined when selected at all; handles only for the one selected element.
          const isOutlined = selectedIds.includes(element.id)
          const isSelected = selectedElementId === element.id
          const inCrop = cropSession?.elementId === element.id
          const isRotated = (element.rotation ?? 0) !== 0

          const wrapperStyle: React.CSSProperties = {
            position: 'absolute',
            left: 0,
            top: 0,
            width: element.w * scale,
            height: element.h * scale,
            transform: buildElementTransform(element.x, element.y, scale, element.rotation),
            transformOrigin: 'center center',
            pointerEvents: interactive ? 'auto' : 'none',
            userSelect: 'none',
            outline: isSelected || isOutlined ? '1px solid var(--editor-selection)' : 'none',
            cursor: interactive ? 'grab' : 'default',
          }

          const handlePointerDownDrag = (e: React.PointerEvent) => {
            if (!interactive || inCrop || editingId === element.id) return
            e.preventDefault()
            e.stopPropagation()
            // Shift toggles membership and drags nothing. Crop mode ignores shift.
            if (e.shiftKey && onToggleSelect && !cropSession) {
              onToggleSelect(element.id)
              return
            }
            // A press on a member of a multi-selection drags the whole group.
            if (selectedIds.length > 1 && selectedIds.includes(element.id)) {
              const members: GroupMember[] = []
              for (const id of selectedIds) {
                const m = slide.elements.find((el) => el.id === id)
                if (m) members.push({ id: m.id, x: m.x, y: m.y, w: m.w, h: m.h, rotation: m.rotation })
              }
              groupRef.current = { start: { x: e.clientX, y: e.clientY }, members, latest: null }
              activeGesture.current = 'group'
              return
            }
            onSelect?.(element.id)
            activeGesture.current = 'drag'
            drag.onPointerDown(
              element.id,
              { x: e.clientX, y: e.clientY },
              { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
            )
          }

          const innerContent =
            element.type === 'image' ? (
              // While actively cropping this element, the CanvasCropOverlay draws
              // the full source with a draggable window on top — so show the plain
              // (uncropped) base beneath it. Otherwise honor the committed crop.
              element.crop && !inCrop ? (
                // Cropped display: render the crop sub-rect [cx,cx+cw]×[cy,cy+ch]
                // (fractions of the source) scaled to cover the element box. This
                // mirrors Montaj's renderer (render/templates/slide.jsx): an
                // overflow-hidden wrapper + an oversized cover image moved by
                // the crop rect. It is moved by a translate, whose percentages
                // are of the image's own size, so the box shows the crop rect
                // on a box of any shape (§562); a percentage margin-top would be
                // a share of the box's width. `maxWidth/maxHeight: 'none'`
                // defeats Tailwind preflight's `img { max-width: 100% }`, which
                // would otherwise clamp the oversized image.
                <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
                  <img
                    src={resolveSrc(element)}
                    draggable={false}
                    style={{
                      display: 'block',
                      width: `${100 / element.crop.w}%`,
                      height: `${100 / element.crop.h}%`,
                      maxWidth: 'none',
                      maxHeight: 'none',
                      transform: `translate(${-element.crop.x * 100}%, ${-element.crop.y * 100}%)`,
                      objectFit: 'cover',
                    }}
                    alt=""
                  />
                </div>
              ) : (
                <img
                  src={resolveSrc(element)}
                  draggable={false}
                  // Uncropped images use `contain` to mirror the renderer
                  // (render/templates/slide.jsx: no-crop branch → objectFit
                  // 'contain'). Logos/escudos placed in a fixed box must keep
                  // their aspect (letterboxed) in BOTH paths; `cover` here would
                  // crop them in the preview and diverge from the final PNG.
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  alt=""
                />
              )
            ) : (
              // Overlays are authored in NATIVE slide pixels (fixed font sizes sized
              // for element.w×element.h at full resolution). The wrapper is already
              // shrunk to element.w*scale, so render the overlay at native size and
              // CSS-scale it to fit — mirroring the renderer. Without this the
              // native-size text overflows the shrunk box and overlaps (the box
              // sizing only auto-fits resolution-independent content like <img>).
              <div
                style={{
                  width: element.w,
                  height: element.h,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  // Hide the live text while it's being edited in place so the
                  // InlineTextEditor isn't doubled over it.
                  visibility: editingId === element.id ? 'hidden' : undefined,
                }}
              >
                <OverlayErrorBoundary
                  label={element.overlay.template.split('/').pop() ?? element.overlay.template}
                  watchPath={element.overlay.template}
                  watchFile={watchFile}
                >
                  <OverlayElementView element={element} compileOverlay={compileOverlay} />
                </OverlayErrorBoundary>
              </div>
            )

          return (
            <div
              key={element.id}
              ref={setWrapperRef(element.id)}
              data-element-wrapper
              data-element-id={element.id}
              role={interactive ? 'group' : 'presentation'}
              aria-label={interactive ? `${element.type} element` : undefined}
              style={wrapperStyle}
              onClick={interactive ? (e) => {
                e.stopPropagation()
                // The press already toggled it.
                if (e.shiftKey && onToggleSelect && !cropSession) return
                // A gesture just ended here: keep the selection.
                if (swallowClickRef.current) { swallowClickRef.current = false; return }
                onSelect?.(element.id)
              } : undefined}
              onPointerDown={handlePointerDownDrag}
              onDoubleClick={
                !interactive
                  ? undefined
                  : element.type === 'overlay'
                    ? (e) => { e.stopPropagation(); beginTextEdit(element) }
                    : onEnterCrop
                      // An image crops, as its Crop button does: not while turned
                      // (the crop math is for an upright box), nor again in crop.
                      ? (e) => { e.stopPropagation(); if (!inCrop && (element.rotation ?? 0) === 0) onEnterCrop(element.id) }
                      : undefined
              }
            >
              {innerContent}

              {/* In-canvas crop overlay for the image being cropped. */}
              {inCrop && element.type === 'image' && cropSession && (
                <CanvasCropOverlay
                  element={element}
                  resolveImageSrc={resolveSrc}
                  scale={scale}
                  localCrop={cropSession.localCrop}
                  onLocalCropChange={(next) => changeCropSession((open) => ({ ...open, localCrop: next }))}
                  onSrcDimsLoaded={(dims) => setCropSrcDims({ src: element.src, ...dims })}
                  srcDims={dimsOf(cropSession)}
                  // The click the browser sends after a window or handle drag
                  // changes nothing, even when let go off the image.
                  onDragEnd={() => { swallowClickRef.current = true }}
                />
              )}

              {/* Selection handles (hidden while cropping or rotated-crop guard).
                  Placed in percentages of the box, so they follow the size a
                  resize preview writes straight to the wrapper. */}
              {isSelected && !inCrop && editingId !== element.id && interactive && (
                <>
                  {HANDLES.map((h) => (
                    <div
                      key={h.id}
                      data-testid={`resize-handle-${h.id}`}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        activeGesture.current = 'resize'
                        resize.onPointerDown(
                          element.id,
                          h.id,
                          { x: e.clientX, y: e.clientY },
                          { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
                        )
                      }}
                      style={{
                        position: 'absolute',
                        left: `${h.xPct * 100}%`,
                        top: `${h.yPct * 100}%`,
                        marginLeft: -HANDLE_SIZE / 2,
                        marginTop: -HANDLE_SIZE / 2,
                        width: HANDLE_SIZE,
                        height: HANDLE_SIZE,
                        background: 'var(--editor-selection)',
                        border: '1px solid #fff',
                        borderRadius: 1,
                        cursor: h.cursor,
                        zIndex: 10,
                        boxSizing: 'border-box',
                        touchAction: 'none',
                      }}
                    />
                  ))}
                  {/* Rotate handle */}
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      marginLeft: -0.5,
                      top: -ROTATE_OFFSET,
                      width: 1,
                      height: ROTATE_OFFSET,
                      background: 'var(--editor-selection)',
                      pointerEvents: 'none',
                      zIndex: 9,
                    }}
                  />
                  <div
                    data-testid="rotate-handle"
                    title="Drag to rotate"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = (e.currentTarget as HTMLElement)
                        .closest('[data-element-wrapper]')!
                        .getBoundingClientRect()
                      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                      activeGesture.current = 'rotate'
                      rotate.onPointerDown(
                        element.id,
                        center,
                        { x: e.clientX, y: e.clientY },
                        element.rotation ?? 0,
                        { x: element.x, y: element.y },
                      )
                    }}
                    style={{
                      position: 'absolute',
                      left: '50%',
                      marginLeft: -7,
                      top: -ROTATE_OFFSET - 14,
                      width: 14,
                      height: 14,
                      background: 'var(--editor-selection)',
                      border: '2px solid #fff',
                      borderRadius: '50%',
                      cursor: 'crosshair',
                      zIndex: 10,
                      boxSizing: 'border-box',
                      touchAction: 'none',
                    }}
                  />
                  {element.type === 'overlay' && typeof element.overlay.props.text === 'string' && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: -20,
                        left: 0,
                        fontSize: 10,
                        color: 'var(--editor-selection)',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      double-click to edit text
                    </div>
                  )}
                  {/* Guard hint: crop disabled while rotated (enforced in panel). */}
                  {element.type === 'image' && isRotated && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: -20,
                        left: 0,
                        fontSize: 10,
                        color: '#fca5a5',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      reset rotation to crop
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}

        {/* Inline text editor (positioned in display coords over the element). */}
        {interactive && editingId && editRect && (() => {
          const el = slide.elements.find((e) => e.id === editingId)
          if (!el || el.type !== 'overlay') return null
          const initial = typeof el.overlay.props.text === 'string' ? el.overlay.props.text : ''
          return (
            <InlineTextEditor
              key={editingId}
              initialValue={initial}
              rect={editRect}
              styleSnapshot={editStyle ?? FALLBACK_EDIT_STYLE}
              onChange={() => {}}
              onCommit={(value) => commitTextEdit(el, value)}
              onCancel={endTextEdit}
            />
          )
        })()}
      </div>
      {children}
    </div>
  )
}

// Re-export the default asset resolver so other modules can reuse it.
export { resolveAssetDefault as resolveAsset }

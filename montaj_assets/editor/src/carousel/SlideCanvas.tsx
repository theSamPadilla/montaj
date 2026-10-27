import { Check, Image as ImageIcon, Type as TypeIcon, Shapes } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import type { Slide, CarouselElement, OverlayElement, ImageElement, OverlayFactory } from '../types'
import OverlayErrorBoundary from './OverlayErrorBoundary'
import {
  useOverlayDrag,
  useOverlayResize,
  useOverlayRotate,
  buildElementTransform,
  roundResizedBox,
  type ResizeHandle as ResizeHandleId,
  type ResizeGesture,
  type GapSegment,
  type SnapBox,
  type SnapGuide,
} from '../gestures'
import { OverlayPreview } from '../preview/OverlayPreview'
import { CanvasCropOverlay } from '../crop/CanvasCropOverlay'
import { croppedBox, shownCrop } from '../crop/crop-math'
import { InlineTextEditor } from '../text/InlineTextEditor'
import { ensureGoogleFontsLoaded } from '../lib/google-fonts'
import { isLocked } from './lock'
import { bandRect, bandTouches, type BandRect } from './bandSelect'
import { groupDragMove, type GroupDragResult, type GroupMember } from './groupDrag'
import { elementsAt, isLayerPress, nextLayerDown, pointInElement } from './hitTest'
import { isApplePlatform } from '../ui/modifierKeys'
import { scaleFontSize, scalesTextWithBox } from './textScale'

// Neutral fallback used only when no host `resolveImageSrc` is injected. The
// package must not synthesize a host-shaped URL (e.g. Montaj's `/api/files`):
// it returns the `src` unchanged so a host without a resolver gets a passthrough
// rather than a URL it can't serve. Hosts that need resolution always inject
// `resolveImageSrc` (Montaj's adapter does).
function resolveAssetDefault(src: string): string {
  return src
}

// A group drag that snapped nothing shows no guide or gap.
const NO_SNAP: { guides: SnapGuide[]; gaps: GapSegment[] } = { guides: [], gaps: [] }

// The snap guide's look, shared by the slide-long guides and the equal-gap segments.
const GUIDE_STYLE: React.CSSProperties = {
  position: 'absolute',
  background: '#ff2d88',
  boxShadow: '0 0 6px 1px rgba(255,45,136,0.9)',
  pointerEvents: 'none',
  zIndex: 999,
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

/** One row of the pick list: what the element is called. Text: its text; image: its file; overlay: its template. */
function pickName(el: CarouselElement): { name: string; Icon: typeof TypeIcon } {
  if (el.type === 'image') return { name: el.src.split(/[\\/]/).pop() || el.src, Icon: ImageIcon }
  const t = el.overlay.props.text
  if (typeof t === 'string' && t.trim()) return { name: t.trim(), Icon: TypeIcon }
  const base = el.overlay.template.split(/[\\/]/).pop() ?? el.overlay.template
  return { name: base.replace(/\.[jt]sx?$/, ''), Icon: Shapes }
}

/** The lock badge's diameter, in display pixels. */
const LOCK_BADGE_SIZE = 24

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
 *  started on, and the window picked so far (source fractions); null until the
 *  window is moved, while it is the part the box shows (M3b). */
type CropSession = { slideId: string; elementId: string; src: string; localCrop: Crop | null }

/** The window starts on the box: the part of the source the image shows. */
function startCrop(slideId: string, el: ImageElement): CropSession {
  return { slideId, elementId: el.id, src: el.src, localCrop: null }
}

/** The window of `open` on `el`: the part the box shows until it is moved (M3b). */
function windowOf(open: CropSession, el: ImageElement, dims: { width: number; height: number } | undefined): Crop {
  if (open.localCrop) return open.localCrop
  return dims ? shownCrop(el, el.crop, dims) : el.crop ?? FULL_FRAME
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
  /**
   * Drag-select (§586 M6): the new selection, in order, so the last is the
   * primary. The band's elements back-to-front, behind the prior selection's
   * when shift was held at the press. Absent → no band is drawn.
   */
  onSelectMany?: (ids: string[]) => void
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
  /** A number is written as a number: a text box's corner resize keeps a numeric font size numeric (§586 M8). */
  updateOverlayProp?: (slideId: string, elementId: string, key: string, value: string | number) => Promise<void>
  updateImageCrop?: (slideId: string, elementId: string, crop: { x: number; y: number; w: number; h: number } | undefined) => Promise<void>

  // Crop mode is owned here; the host enters it (the panel's Crop button, or a
  // double-click on an image) and is told when it ends.
  cropElementId?: string | null
  onExitCrop?: () => void
  /** Double-click on an unrotated image asks the host to crop it. Absent → double-click on an image does nothing. */
  onEnterCrop?: (elementId: string) => void
  /** Set to the control that ends crop mode from the host (§556 M4). */
  cropControlRef?: Ref<SlideCanvasCropControl>
  /** A click on the lock badge of the selected locked element (§586 M5b). Absent → no badge. */
  onUnlock?: (elementId: string) => void

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
   * PL70): rendered last inside the slide box, above the elements and clipped
   * with them, so they can position themselves in percentages of the slide.
   * Absent → nothing.
   */
  children?: ReactNode

  /**
   * Room the host keeps around an interactive slide, in display pixels (§586
   * M4). The selection outlines and handles draw out to it past the slide
   * edge, and a press in it is a press on the empty canvas. 0 (the default)
   * → they clip at the slide edge.
   */
  margin?: number

  /**
   * The Cmd-click pick list (§587 M8, rail layout): a Cmd-press (Ctrl off a
   * Mac) also lists every element under the pointer. Absent → no list.
   */
  pickList?: boolean
  /**
   * A right-click (rail layout, §587 M7): the element under the pointer (or
   * null on the empty slide or its margin) and the point in slide units. The
   * native menu is suppressed only when this is passed.
   */
  onContextMenu?: (info: { clientX: number; clientY: number; elementId: string | null; point: { x: number; y: number } }) => void
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
  onSelectMany,
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
  onUnlock,
  cropControlRef,
  hiddenElementIds,
  onDragEnter,
  onDragOver,
  onDrop,
  children,
  margin = 0,
  pickList = false,
  onContextMenu,
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

  // Each outlined element's box in the chrome layer (§586 M4): its outline
  // and handles, drawn past the slide edge on the wrapper's transform and size.
  const chromeRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const setChromeRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) chromeRefs.current.set(id, el)
    else chromeRefs.current.delete(id)
  }
  const boxesOf = (id: string) =>
    [wrapperRefs.current.get(id), chromeRefs.current.get(id)].filter((el): el is HTMLDivElement => !!el)

  // Each overlay's inner layer, drawn at native size and scaled to the canvas.
  const innerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const setInnerRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) innerRefs.current.set(id, el)
    else innerRefs.current.delete(id)
  }

  // ── Gesture preview helper: write transform/size directly to the wrapper ──
  // and to its chrome box in the same call, so the handles never lag the element.
  const applyPreviewTransform = (id: string, x: number, y: number, rotation: number) => {
    for (const el of boxesOf(id)) el.style.transform = buildElementTransform(x, y, scale, rotation)
  }
  const applyPreviewBox = (
    id: string,
    box: { x: number; y: number; w: number; h: number },
    rotation: number,
  ) => {
    for (const el of boxesOf(id)) {
      el.style.transform = buildElementTransform(box.x, box.y, scale, rotation)
      el.style.width = `${box.w * scale}px`
      el.style.height = `${box.h * scale}px`
    }
  }
  // A text box's corner resize (§586 M8) scales its content by `ratio` while
  // the drag lasts, so the text does not jump when the real font size lands.
  // 1 takes the preview off.
  const applyPreviewTextScale = (id: string, ratio: number) => {
    const inner = innerRefs.current.get(id)
    if (inner) inner.style.transform = `scale(${scale * ratio})`
  }

  // ── Gesture hooks ──
  // Each commit rounds to whole pixels and draws exactly that, since the
  // preview drew the unrounded value. A gesture that rounds back to where the
  // element already is, or whose element is gone, records nothing: no edit,
  // no commit, no undo step.
  const elementById = (id: string) => slide.elements.find((e) => e.id === id)

  // What a drag snaps to besides the slide (§586 M7): every element shown on
  // this canvas that is not being dragged.
  const snapTargets = (dragged: readonly string[]): SnapBox[] =>
    slide.elements
      .filter((e) => !dragged.includes(e.id) && !hiddenSet?.has(e.id))
      .map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h, rotation: e.rotation }))

  const drag = useOverlayDrag({
    scale,
    slide: { w: width, h: height },
    onPreview: applyPreviewTransform,
    onCommit: async (id, x, y) => {
      const el = elementById(id)
      if (!el) return
      // Locked while held: back to where it is, nothing written or committed.
      if (isLocked(el)) { applyPreviewTransform(id, el.x, el.y, el.rotation); return }
      const nx = Math.round(x)
      const ny = Math.round(y)
      applyPreviewTransform(id, nx, ny, el.rotation)
      if (nx === el.x && ny === el.y) return
      await moveElement?.(sid, id, nx, ny)
      await commit?.()
    },
  })

  // A corner resize that keeps the ratio scales a text box's font size by the
  // height ratio (§586 M8); side handles, Shift and Fit to box change the box
  // only.
  const scalesText = (el: CarouselElement | undefined, gesture: ResizeGesture): el is OverlayElement =>
    !!el && gesture.keptRatio && gesture.startBox.h > 0 && scalesTextWithBox(el)

  const resize = useOverlayResize({
    scale,
    onPreview: (id, box, rotation, gesture) => {
      applyPreviewBox(id, box, rotation)
      if (scalesText(elementById(id), gesture)) applyPreviewTextScale(id, box.h / gesture.startBox.h)
      else applyPreviewTextScale(id, 1)
    },
    onCommit: async (id, box, gesture) => {
      // Off first, so an element gone mid-drag leaves no scaled layer.
      applyPreviewTextScale(id, 1)
      const el = elementById(id)
      if (!el) return
      const rotation = gesture.startBox.rotation ?? 0
      if (isLocked(el)) { applyPreviewBox(id, el, el.rotation); return }
      // w and h first, then x and y from the point the handle pins.
      const next = roundResizedBox(box, gesture.handle, rotation)
      applyPreviewBox(id, next, rotation)
      if (next.x === el.x && next.y === el.y && next.w === el.w && next.h === el.h) return
      // A size that rounds back to the one it has is not written.
      const source = scalesText(el, gesture) ? el.overlay.props.fontSize : undefined
      const fontSize = scaleFontSize(source, next.h / gesture.startBox.h)
      if (fontSize !== null && fontSize !== scaleFontSize(source, 1) && updateOverlayProp) {
        // Both in this tick, so the box and the size draw together. The prop
        // write folds the transient resize into its undo step and its save.
        await Promise.all([resizeElement?.(sid, id, next), updateOverlayProp(sid, id, 'fontSize', fontSize)])
        return
      }
      await resizeElement?.(sid, id, next)
      await commit?.()
    },
  })

  const rotate = useOverlayRotate({
    onPreview: (id, rotation, x, y) => applyPreviewTransform(id, x, y, rotation),
    onCommit: async (id, rotation) => {
      const el = elementById(id)
      if (!el) return
      if (isLocked(el)) { applyPreviewTransform(id, el.x, el.y, el.rotation); return }
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
  // the kept region's place at the picture's scale, then the crop, which `updateImageCrop`
  // folds into one undo step with the box, then a commit. Every call is made
  // in this tick, so nothing the caller does next lands between them. Writes
  // nothing when the image is not on this slide, its size is not known yet,
  // or the window is the crop the image already has or the part its box shows.
  function writeCrop(open: CropSession): Promise<void> {
    const el = open.slideId === sid ? slide.elements.find((e) => e.id === open.elementId) : undefined
    const dims = dimsOf(open)
    if (el?.type !== 'image' || !dims || !open.localCrop) return Promise.resolve()
    if (sameCrop(open.localCrop, el.crop ?? FULL_FRAME)) return Promise.resolve()
    if (sameCrop(open.localCrop, shownCrop(el, el.crop, dims))) return Promise.resolve()
    const writes: Array<Promise<void> | undefined> = []
    // The box takes the kept region's place at the picture's current scale.
    const next = croppedBox(el, el.crop, open.localCrop, dims)
    const box = { x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.w), h: Math.round(next.h) }
    const valid = [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0
    if (valid && (box.x !== el.x || box.y !== el.y || box.w !== el.w || box.h !== el.h)) {
      writes.push(resizeElement?.(open.slideId, el.id, box))
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
    if (el?.type !== 'image' || isLocked(el)) void leaveCropRef.current('discard')
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
    // A locked text is not edited (§586 M5).
    if (!interactive || isLocked(element) || typeof element.overlay.props.text !== 'string') return
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

  // The text being edited became locked: close without writing what was typed.
  const editingLocked = isLocked(slide.elements.find((e) => e.id === editingId))
  useEffect(() => {
    if (editingLocked) endTextEdit()
  }, [editingLocked])

  function commitTextEdit(element: OverlayElement, value: string) {
    void updateOverlayProp?.(sid, element.id, 'text', value)
    endTextEdit()
  }

  // The slide-space point under a mouse event: the root sits at the slide's
  // corner, and its drawn size says how far the display is zoomed past `scale`.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const slidePoint = (e: { clientX: number; clientY: number }) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: e.clientX / scale, y: e.clientY / scale }
    const zoom = rect.width > 0 ? (width * scale) / rect.width : 1
    return { x: ((e.clientX - rect.left) * zoom) / scale, y: ((e.clientY - rect.top) * zoom) / scale }
  }

  // Cmd-press (Ctrl off a Mac): the next element down under the pointer is
  // selected and nothing starts; a crop in progress is applied. Its click,
  // which would select the top one, changes nothing.
  const startLayerPress = (e: { clientX: number; clientY: number }) => {
    swallowClickRef.current = true
    const next = nextLayerDown(elementsAt(slidePoint(e), slide.elements, hiddenSet), selectedIds)
    if (cropRef.current) leaveCrop('apply').catch(() => {})
    if (next) onSelect?.(next)
    if (pickList) {
      const ids = elementsAt(slidePoint(e), slide.elements, hiddenSet)
      const at = slidePoint(e)
      setPick(ids.length ? { ids, x: at.x, y: at.y } : null)
    }
  }

  // The pick list (§587 M8): the ids under the last Cmd-press, front to back,
  // and the press in slide units. Selection only; nothing here is saved.
  const [pick, setPick] = useState<{ ids: string[]; x: number; y: number } | null>(null)
  const pickIds = pick ? pick.ids.filter((id) => slide.elements.some((el) => el.id === id)) : []
  const pickOpen = pick !== null && pickIds.length > 0
  const pickIdsRef = useRef(pickIds)
  pickIdsRef.current = pickIds
  const pickSelectedRef = useRef<string[]>(selectedIds)
  pickSelectedRef.current = selectedIds
  const pickSelect = (id: string) => {
    if (cropRef.current) leaveCrop('apply').catch(() => {})
    onSelect?.(id)
  }
  const pickSelectRef = useRef(pickSelect)
  pickSelectRef.current = pickSelect
  // Esc, Enter close it; Up and Down move the tick. A press elsewhere, a
  // scroll or a zoom closes it.
  useEffect(() => {
    if (!pickOpen) return
    const onKey = (e: KeyboardEvent) => {
      // Keys typed into a field stay the field's.
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, select, [contenteditable="true"]'))) return
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        setPick(null)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const ids = pickIdsRef.current
        const at = ids.findIndex((id) => pickSelectedRef.current.includes(id))
        const to = Math.max(0, Math.min(ids.length - 1, (at < 0 ? 0 : at) + (e.key === 'ArrowDown' ? 1 : -1)))
        pickSelectRef.current(ids[to])
      }
    }
    const close = () => setPick(null)
    const onDown = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('[data-pick-list]')) return
      setPick(null)
    }
    // Capture: a Cmd-press that follows on the canvas opens it again after.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close, { capture: true, passive: true })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close, true)
    }
  }, [pickOpen])
  useEffect(() => { setPick(null) }, [scale])

  // The selected element a press at `e` is inside (frontmost first), when it is
  // not in crop: pressing inside it acts on it, whatever lies on top (§586 M1).
  const selectedUnder = (e: { clientX: number; clientY: number }) => {
    const id = elementsAt(slidePoint(e), slide.elements, hiddenSet).find(
      (hit) => selectedIds.includes(hit) && cropSession?.elementId !== hit,
    )
    return id ? elementById(id) : undefined
  }

  // The selected element a click released inside, when another lay on top and
  // took the selection: a double-click's first click moves the selection off
  // the element the double-click is for, so it is remembered a moment.
  const clickBaseRef = useRef<{ id: string; at: number } | null>(null)
  const DOUBLE_CLICK_MS = 600

  // The element a double-click on `element` is for: the one the clicks before
  // it began on, else the selected one under the pointer, else `element`.
  const doubleClickTarget = (e: React.MouseEvent, element: Slide['elements'][number]) => {
    const base = clickBaseRef.current
    clickBaseRef.current = null
    if (base && Date.now() - base.at < DOUBLE_CLICK_MS) {
      const el = elementById(base.id)
      if (el && pointInElement(slidePoint(e), el)) return el
    }
    return selectedUnder(e) ?? element
  }

  // Double-click on an element, or on its handles: an overlay edits its text;
  // an image crops, as its Crop button does: not while turned (the crop math
  // is for an upright box), nor again in crop. Absent `onEnterCrop` → an
  // image takes no double-click.
  const handleDoubleClick = (element: Slide['elements'][number], e: React.MouseEvent) => {
    const target = doubleClickTarget(e, element)
    const reselect = () => { if (selectedElementId !== target.id) onSelect?.(target.id) }
    if (target.type === 'overlay') {
      e.stopPropagation()
      reselect()
      beginTextEdit(target)
    } else if (onEnterCrop) {
      e.stopPropagation()
      reselect()
      // A locked image is not cropped (§586 M5).
      if (!isLocked(target) && cropSession?.elementId !== target.id && (target.rotation ?? 0) === 0) onEnterCrop(target.id)
    }
  }

  // ── Pointer wiring shared by drag/resize/rotate ──
  // We attach window-level move/up listeners while a gesture is active so the
  // gesture keeps tracking outside the element bounds.
  const activeGesture = useRef<'drag' | 'resize' | 'rotate' | 'group' | 'band' | null>(null)

  // Set when a gesture ends (a resize, a rotate, a drag, or a group drag that
  // moved), so the click the browser sends after its release changes nothing:
  // not a deselect when the pointer was let go off the element (that click
  // lands on the canvas), not a collapse of the selection to the element under
  // the pointer. The next press on the canvas clears it, so a release off the
  // canvas, whose click never comes here, cannot swallow a later click.
  const swallowClickRef = useRef(false)

  // A drag of the selected element under another (§586 M1) selects the topmost
  // on release when it never moved, so its click must not be swallowed.
  const heldPressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  // ── Group drag (§156): every selected element moves by one delta, one undo step ──
  const groupRef = useRef<{
    start: { x: number; y: number }
    members: GroupMember[]
    others: SnapBox[]
    latest: GroupDragResult | null
  } | null>(null)
  const [groupSnap, setGroupSnap] = useState<{ guides: SnapGuide[]; gaps: GapSegment[] }>(NO_SNAP)
  const groupHandlers = useRef({ move: (_c: { x: number; y: number }, _skipSnap: boolean) => {}, up: () => {} })
  groupHandlers.current = {
    move: (cursor, skipSnap) => {
      const g = groupRef.current
      if (!g) return
      const result = groupDragMove(
        g.members,
        { dx: cursor.x - g.start.x, dy: cursor.y - g.start.y },
        scale,
        { w: width, h: height },
        g.others,
        { skip: skipSnap },
      )
      g.latest = result
      setGroupSnap(result.guides.length || result.gaps.length ? { guides: result.guides, gaps: result.gaps } : NO_SNAP)
      for (const p of result.positions) {
        const m = g.members.find((mm) => mm.id === p.id)
        applyPreviewTransform(p.id, p.x, p.y, m?.rotation ?? 0)
      }
    },
    up: () => {
      const g = groupRef.current
      groupRef.current = null
      setGroupSnap(NO_SNAP)
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

  // ── Drag-select (§586 M6): a press and move from the empty canvas, the margin
  // or a locked element draws a band, in slide units. A press that never moves
  // is a click and draws nothing.
  const bandRef = useRef<{
    start: { x: number; y: number }
    /** The press in slide units, so the band follows zoom and scroll as the hit test does. */
    startSlide: { x: number; y: number }
    add: boolean
    /** A shift-press on a locked element: toggled on release when the pointer never moved. */
    toggleId?: string
    rect: BandRect | null
  } | null>(null)
  // The band's rect changes on every move: it is written straight to the div's
  // style, and only whether it shows is state, so a move re-renders nothing.
  const [bandShown, setBandShown] = useState(false)
  const bandElRef = useRef<HTMLDivElement | null>(null)
  const writeBand = (rect: BandRect) => {
    const el = bandElRef.current
    if (!el) return
    el.style.left = `${rect.x * scale}px`
    el.style.top = `${rect.y * scale}px`
    el.style.width = `${rect.w * scale}px`
    el.style.height = `${rect.h * scale}px`
  }
  const BAND_THRESHOLD = 3
  const CLICK_SLOP = 3
  const startBand = (e: React.PointerEvent, toggleId?: string) => {
    if (!interactive || !onSelectMany || e.button !== 0) return
    bandRef.current = {
      start: { x: e.clientX, y: e.clientY },
      startSlide: slidePoint(e),
      add: e.shiftKey,
      toggleId,
      rect: null,
    }
    activeGesture.current = 'band'
  }
  const bandHandlers = useRef({ move: (_c: { x: number; y: number }) => {}, up: (_commit: boolean) => {} })
  bandHandlers.current = {
    move: (cursor) => {
      const b = bandRef.current
      if (!b) return
      if (!b.rect && Math.hypot(cursor.x - b.start.x, cursor.y - b.start.y) < BAND_THRESHOLD) return
      // A crop in progress is applied as the band starts, as any other press away does.
      if (!b.rect && cropRef.current) leaveCropRef.current('apply').catch(() => {})
      const first = !b.rect
      b.rect = bandRect(b.startSlide, slidePoint({ clientX: cursor.x, clientY: cursor.y }))
      if (first) setBandShown(true)
      else writeBand(b.rect)
    },
    up: (commitBand) => {
      const b = bandRef.current
      bandRef.current = null
      setBandShown(false)
      if (b && !b.rect && commitBand && b.toggleId) onToggleSelect?.(b.toggleId)
      if (!b?.rect || !commitBand) return
      swallowClickRef.current = true
      const rect = b.rect
      const ids = slide.elements
        .filter((el) => !hiddenSet?.has(el.id) && bandTouches(el, rect))
        .map((el) => el.id)
      onSelectMany?.(b.add ? [...selectedIds.filter((id) => !ids.includes(id)), ...ids] : ids)
    },
  }

  useEffect(() => {
    // Ends the gesture in progress where it is, committing what it previewed.
    // A release is followed by a click, which `swallowClick` keeps from
    // changing the selection; a gesture ended any other way has no click coming.
    const end = (swallowClick: boolean) => {
      const gesture = activeGesture.current
      activeGesture.current = null
      if (gesture === 'drag') drag.onPointerUp()
      else if (gesture === 'resize') resize.onPointerUp()
      else if (gesture === 'rotate') rotate.onPointerUp()
      else if (gesture === 'group') groupHandlers.current.up()
      else if (gesture === 'band') bandHandlers.current.up(swallowClick)
      // A group drag decides for itself: a press on a member that did not move
      // is a click, and collapses the selection to that member.
      const unmoved = heldPressRef.current?.moved === false
      heldPressRef.current = null
      if (swallowClick && !(gesture === 'drag' && unmoved) && (gesture === 'drag' || gesture === 'resize' || gesture === 'rotate')) swallowClickRef.current = true
    }
    const onMove = (e: PointerEvent) => {
      // A mouse that moves with no button held has lost its release (the window
      // lost the mouse mid-gesture, as when the person switches apps). The
      // gesture ends where it is, as a release would end it, and no click
      // follows, so nothing is swallowed.
      if (activeGesture.current && e.pointerType === 'mouse' && e.buttons === 0) {
        end(false)
        return
      }
      const cursor = { x: e.clientX, y: e.clientY }
      const held = heldPressRef.current
      // A press over a selected lower element is a click until it travels
      // CLICK_SLOP; a jitter moves nothing and the click selects the top one.
      if (held && !held.moved && Math.hypot(cursor.x - held.x, cursor.y - held.y) >= CLICK_SLOP) held.moved = true
      const pending = !!held && !held.moved
      // Cmd (Ctrl on Windows) held during a drag snaps nothing while it is held.
      const skipSnap = e.metaKey || e.ctrlKey
      if (pending && (activeGesture.current === 'drag' || activeGesture.current === 'group')) return
      if (activeGesture.current === 'drag') drag.onPointerMove(cursor, { skipSnap })
      else if (activeGesture.current === 'resize') resize.onPointerMove(cursor, { shiftKey: e.shiftKey })
      else if (activeGesture.current === 'rotate') rotate.onPointerMove(cursor)
      else if (activeGesture.current === 'group') groupHandlers.current.move(cursor, skipSnap)
      else if (activeGesture.current === 'band') bandHandlers.current.move(cursor)
    }
    const onUp = () => end(true)
    const onCancel = () => end(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [drag, resize, rotate])

  const displayW = width * scale
  const displayH = height * scale

  // The chrome layer and the margin box share this frame: the slide plus the
  // host's margin on every side.
  const marginBox: React.CSSProperties = {
    position: 'absolute',
    left: -margin,
    top: -margin,
    width: displayW + 2 * margin,
    height: displayH + 2 * margin,
  }
  // A right-press (or Ctrl-click on a Mac) opens the host's menu when it has
  // one; it starts no gesture, on the element or on its handles.
  const isMenuPress = (e: React.PointerEvent) =>
    !!onContextMenu && (e.button === 2 || (e.button === 0 && e.ctrlKey && isApplePlatform()))
  // The pick list opens toward the room left in the chrome box: past the
  // right or bottom edge it flips to the press's other side (rows ~28px).
  const pickFlip = {
    x: pick !== null && pick.x * scale + 8 + 220 > displayW + margin,
    y: pick !== null && pick.y * scale + 8 + pickIds.length * 28 + 8 > displayH + margin,
  }

  return (
    <div
      ref={rootRef}
      data-interactive={interactive ? 'true' : undefined}
      role={interactive ? 'group' : 'presentation'}
      aria-label={interactive ? 'Slide canvas' : undefined}
      style={{
        width: displayW,
        height: displayH,
        // An interactive slide clips its elements in the layer below, so the
        // chrome layer can draw past its edge (§586 M4).
        overflow: interactive ? undefined : 'hidden',
        position: 'relative',
        flexShrink: 0,
      }}
      onPointerDownCapture={interactive ? () => { swallowClickRef.current = false } : undefined}
      onPointerDown={interactive ? (e) => {
        // Only a press on the empty canvas starts a band: elements, handles
        // and the host's layers take their own presses.
        const t = e.target as HTMLElement
        if (t === e.currentTarget || t.hasAttribute('data-canvas-margin') || t.hasAttribute('data-slide-base')) startBand(e)
      } : undefined}
      // The empty canvas is the slide's background and the margin around it:
      // a click there deselects, and the host applies a crop in progress. A
      // drag-select starts from a press on either.
      onClick={interactive ? () => {
        if (swallowClickRef.current) { swallowClickRef.current = false; return }
        onSelect?.(null)
      } : undefined}
      onDragEnter={interactive ? onDragEnter : undefined}
      onDragOver={interactive ? onDragOver : undefined}
      onDrop={interactive ? onDrop : undefined}
      onContextMenu={interactive && onContextMenu ? (e) => {
        e.preventDefault()
        const t = e.target as HTMLElement
        const hit = t.closest?.('[data-element-id], [data-chrome-for]') as HTMLElement | null
        const elementId = hit?.getAttribute('data-element-id') ?? hit?.getAttribute('data-chrome-for') ?? null
        onContextMenu({ clientX: e.clientX, clientY: e.clientY, elementId, point: slidePoint(e) })
      } : undefined}
    >
      {/* The margin around the page (§586 M4): a press here is a press on the
          empty canvas, and its click reaches the root. Under the slide. */}
      {interactive && margin > 0 && <div data-canvas-margin="" style={marginBox} />}

      {/* Inner native-resolution layer. Elements are positioned at native coords
          and the wrapper transform applies translate(...*scale) so gesture
          previews can mutate the same transform string. It clips at the slide
          edge, as the export does. */}
      <div
        data-slide-base={interactive ? '' : undefined}
        style={{
          width: displayW,
          height: displayH,
          position: 'absolute',
          top: 0,
          left: 0,
          backgroundColor: slide.base_color || '#ffffff',
          ...(interactive ? { overflow: 'hidden' } : null),
        }}
      >
        {slide.elements.map((element) => {
          // Editor-only visibility: omit hidden elements from this canvas.
          if (hiddenSet?.has(element.id)) return null
          const inCrop = cropSession?.elementId === element.id
          // The crop overlay draws the picture once its size is known (M3b):
          // the element's own is hidden under it, so it is not drawn twice.
          const ownHidden = inCrop && dimsOf(cropSession) !== undefined

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
            // The selection outline is drawn in the chrome layer.
            outline: 'none',
            cursor: interactive && !isLocked(element) ? 'grab' : 'default',
          }

          // Every selected, unlocked element, as one drag moves them (§156).
          const startGroupDrag = (e: React.PointerEvent) => {
            const members: GroupMember[] = []
            for (const id of selectedIds) {
              const m = slide.elements.find((el) => el.id === id)
              if (m && !isLocked(m)) members.push({ id: m.id, x: m.x, y: m.y, w: m.w, h: m.h, rotation: m.rotation })
            }
            groupRef.current = { start: { x: e.clientX, y: e.clientY }, members, others: snapTargets(members.map((m) => m.id)), latest: null }
            activeGesture.current = 'group'
          }
          const startDrag = (e: React.PointerEvent, el: Slide['elements'][number]) => {
            activeGesture.current = 'drag'
            drag.onPointerDown(
              el.id,
              { x: e.clientX, y: e.clientY },
              { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation },
              snapTargets([el.id]),
            )
          }

          const handlePointerDownDrag = (e: React.PointerEvent) => {
            if (!interactive || editingId === element.id) return
            if (isMenuPress(e)) return
            const layerPress = isLayerPress(e)
            if (inCrop && !layerPress) return
            e.preventDefault()
            e.stopPropagation()
            // Cmd-press (Ctrl off a Mac) selects the next element down under
            // the pointer and starts nothing; a crop in progress is applied.
            // Its click, which would select the top one, changes nothing.
            if (layerPress) {
              startLayerPress(e)
              return
            }
            // Shift toggles membership and drags nothing. Crop mode ignores shift.
            // On a locked element it toggles on release, and a move bands and adds.
            if (e.shiftKey && onToggleSelect && !cropSession) {
              if (isLocked(element) && onSelectMany) startBand(e, element.id)
              else onToggleSelect(element.id)
              return
            }
            // A press inside a selected element's box acts on it though another
            // lies on top (§586 M1): a move drags it, or the whole selection.
            // Without a move the click selects the topmost. A locked one waits.
            const held = selectedUnder(e)
            if (held && held.id !== element.id && held.id !== editingId) {
              // A locked selection is never dragged: a move there draws a band,
              // and the selection stays until the click picks the top element.
              const allLocked = selectedIds.every((id) => isLocked(slide.elements.find((el) => el.id === id)))
              if (allLocked) startBand(e)
              else if (selectedIds.length > 1) {
                heldPressRef.current = { x: e.clientX, y: e.clientY, moved: false }
                startGroupDrag(e)
              } else if (!isLocked(held)) {
                heldPressRef.current = { x: e.clientX, y: e.clientY, moved: false }
                startDrag(e, held)
              }
              return
            }
            // A press on a locked element starts nothing (§586 M5): it is only
            // selected, as a click does; a press-and-move on it draws a band.
            if (isLocked(element)) {
              if (!(selectedIds.length > 1 && selectedIds.includes(element.id))) onSelect?.(element.id)
              startBand(e)
              return
            }
            // A press on a member of a multi-selection drags the whole group;
            // its locked members stay where they are.
            if (selectedIds.length > 1 && selectedIds.includes(element.id)) {
              startGroupDrag(e)
              return
            }
            onSelect?.(element.id)
            startDrag(e, element)
          }

          const innerContent =
            element.type === 'image' ? (
              element.crop ? (
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
                <div style={{ width: '100%', height: '100%', overflow: 'hidden', visibility: ownHidden ? 'hidden' : undefined }}>
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
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', visibility: ownHidden ? 'hidden' : undefined }}
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
                ref={setInnerRef(element.id)}
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
                if (swallowClickRef.current) {
                  swallowClickRef.current = false
                  if (e.detail < 2) clickBaseRef.current = null
                  return
                }
                // Released inside the selected element with another on top: the
                // top one is selected, and a double-click may still be for the first.
                const held = selectedUnder(e)
                // The second click of a double-click lands on the top element
                // too, and leaves the first click's base standing; any other
                // click that is not under the selection ends it.
                if (held && held.id !== element.id) clickBaseRef.current = { id: held.id, at: Date.now() }
                else if (e.detail < 2) clickBaseRef.current = null
                onSelect?.(element.id)
              } : undefined}
              onPointerDown={handlePointerDownDrag}
              onDoubleClick={interactive ? (e) => handleDoubleClick(element, e) : undefined}
            >
              {innerContent}
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
        {children}
      </div>

      {/* Chrome layer (§586 M4): selection outlines, handles, snap guides and
          the crop window's handles, over the slide and out into the margin.
          Only the handles take the pointer. A click on one ends here: its
          press already did what it does. */}
      {interactive && (
        <div
          data-slide-chrome=""
          style={{ ...marginBox, overflow: 'hidden', pointerEvents: 'none' }}
          onClick={(e) => { e.stopPropagation(); swallowClickRef.current = false }}
        >
          <div style={{ position: 'absolute', left: margin, top: margin, width: displayW, height: displayH }}>
            {/* Snap guides — drawn at the drag hook's reported guide axes. A
                drag and a group drag never run at once. */}
            {(groupSnap !== NO_SNAP ? groupSnap : drag).guides.map((g: SnapGuide, i) =>
              g.axis === 'x' ? (
                <div
                  key={`gx-${i}`}
                  data-testid="snap-guide-x"
                  style={{ ...GUIDE_STYLE, left: g.at * scale - 1, top: 0, width: 2, height: displayH }}
                />
              ) : (
                <div
                  key={`gy-${i}`}
                  data-testid="snap-guide-y"
                  style={{ ...GUIDE_STYLE, left: 0, top: g.at * scale - 1, width: displayW, height: 2 }}
                />
              ),
            )}
            {/* The drag-select band (§586 M6), in the guides' thin look. */}
            {bandShown && (
              <div
                ref={bandElRef}
                data-testid="selection-band"
                style={{
                  position: 'absolute',
                  left: (bandRef.current?.rect?.x ?? 0) * scale,
                  top: (bandRef.current?.rect?.y ?? 0) * scale,
                  width: (bandRef.current?.rect?.w ?? 0) * scale,
                  height: (bandRef.current?.rect?.h ?? 0) * scale,
                  border: '1px solid var(--editor-selection)',
                  background: 'color-mix(in srgb, var(--editor-selection) 12%, transparent)',
                  pointerEvents: 'none',
                  zIndex: 999,
                }}
              />
            )}
            {/* Equal gaps (§586 M7): each gap a short segment in the guide's look. */}
            {(groupSnap !== NO_SNAP ? groupSnap : drag).gaps.map((g: GapSegment, i) => (
              <div
                key={`gap-${i}`}
                data-testid="snap-gap"
                style={
                  g.axis === 'x'
                    ? { ...GUIDE_STYLE, left: g.from * scale, top: g.at * scale - 1, width: (g.to - g.from) * scale, height: 2 }
                    : { ...GUIDE_STYLE, left: g.at * scale - 1, top: g.from * scale, width: 2, height: (g.to - g.from) * scale }
                }
              />
            ))}

            {/* The pick list (§587 M8), anchored at the Cmd-press. */}
            {pickOpen && pick && (
              <div
                data-pick-list=""
                role="listbox"
                aria-label="Layers here"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  left: pick.x * scale + (pickFlip.x ? -8 : 8),
                  top: pick.y * scale + (pickFlip.y ? -8 : 8),
                  transform: `translate(${pickFlip.x ? '-100%' : '0'}, ${pickFlip.y ? '-100%' : '0'})`,
                  minWidth: 140,
                  maxWidth: 220,
                  padding: 4,
                  background: 'var(--editor-surface)',
                  color: 'var(--editor-text)',
                  border: '1px solid color-mix(in srgb, var(--editor-text) 15%, transparent)',
                  borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                  fontSize: 12,
                  zIndex: 1000,
                  pointerEvents: 'auto',
                }}
              >
                {pickIds.map((id) => {
                  const el = slide.elements.find((x) => x.id === id)
                  if (!el) return null
                  const { name, Icon } = pickName(el)
                  const on = selectedIds.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      role="option"
                      data-pick-row={id}
                      aria-selected={on}
                      onClick={(e) => { e.stopPropagation(); swallowClickRef.current = false; pickSelect(id); setPick(null) }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        padding: '4px 6px',
                        border: 0,
                        borderRadius: 4,
                        background: on ? 'color-mix(in srgb, var(--editor-selection) 15%, transparent)' : 'transparent',
                        color: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      <Icon size={13} aria-hidden="true" style={{ flex: 'none', opacity: 0.7 }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                      {on && <Check size={13} aria-hidden="true" style={{ flex: 'none', color: 'var(--editor-selection)' }} />}
                    </button>
                  )
                })}
              </div>
            )}

            {slide.elements.map((element) => {
              if (hiddenSet?.has(element.id)) return null
              // Outlined when selected at all; handles only for the one selected element.
              const isOutlined = selectedIds.includes(element.id)
              const isSelected = selectedElementId === element.id
              const locked = isLocked(element)
              const inCrop = cropSession?.elementId === element.id
              const picked = pickOpen && !isOutlined && pickIds.includes(element.id)
              if (!isOutlined && !isSelected && !inCrop && !picked) return null
              const isRotated = (element.rotation ?? 0) !== 0

              return (
                <div
                  key={element.id}
                  ref={setChromeRef(element.id)}
                  data-chrome-for={element.id}
                  onDoubleClick={(e) => handleDoubleClick(element, e)}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: element.w * scale,
                    height: element.h * scale,
                    transform: buildElementTransform(element.x, element.y, scale, element.rotation),
                    transformOrigin: 'center center',
                    outline: `1px ${picked ? 'dashed' : 'solid'} var(--editor-selection)`,
                    pointerEvents: 'none',
                  }}
                >
                  {/* The crop overlay for the image being cropped (M3b): the whole
                      picture at its scale on the slide, past the box and the slide
                      edge, its window on the box and its handles whole at the
                      image's edge. */}
                  {inCrop && element.type === 'image' && cropSession && (
                    <CanvasCropOverlay
                      element={element}
                      resolveImageSrc={resolveSrc}
                      scale={scale}
                      fit="current"
                      localCrop={windowOf(cropSession, element, dimsOf(cropSession))}
                      onLocalCropChange={(next) => changeCropSession((open) => ({ ...open, localCrop: next }))}
                      onSrcDimsLoaded={(dims) => setCropSrcDims({ src: element.src, ...dims })}
                      srcDims={dimsOf(cropSession)}
                      // The click the browser sends after a window or handle drag
                      // changes nothing, even when let go off the image.
                      onDragEnd={() => { swallowClickRef.current = true }}
                      // Cmd-press on the picture reaches the layer under it.
                      onLayerPress={startLayerPress}
                    />
                  )}

                  {/* Lock badge (§586 M5b): the selected locked element's way back
                      to unlocked. Only the badge takes the pointer. */}
                  {isSelected && locked && onUnlock && (
                    <button
                      type="button"
                      data-testid="lock-badge"
                      aria-label="Unlock"
                      title="Unlock"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); swallowClickRef.current = false; onUnlock(element.id) }}
                      style={{
                        position: 'absolute',
                        top: -LOCK_BADGE_SIZE / 2 - 2,
                        right: -LOCK_BADGE_SIZE / 2 - 2,
                        width: LOCK_BADGE_SIZE,
                        height: LOCK_BADGE_SIZE,
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxSizing: 'border-box',
                        background: 'var(--editor-surface)',
                        border: '1.5px solid var(--editor-selection)',
                        borderRadius: '50%',
                        color: 'var(--editor-selection)',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                        cursor: 'pointer',
                        zIndex: 10,
                        pointerEvents: 'auto',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                    </button>
                  )}

                  {/* Selection handles (hidden while cropping or rotated-crop guard).
                      Placed in percentages of the box, so they follow the size a
                      resize preview writes straight to this box. */}
                  {isSelected && !locked && !inCrop && editingId !== element.id && (
                    <>
                      {HANDLES.map((h) => (
                        <div
                          key={h.id}
                          data-testid={`resize-handle-${h.id}`}
                          onPointerDown={(e) => {
                            if (isMenuPress(e)) return
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
                            pointerEvents: 'auto',
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
                          if (isMenuPress(e)) return
                          e.preventDefault()
                          e.stopPropagation()
                          // The element turns about the middle of its wrapper.
                          const wrapper = wrapperRefs.current.get(element.id)
                          if (!wrapper) return
                          const rect = wrapper.getBoundingClientRect()
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
                          pointerEvents: 'auto',
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
          </div>
        </div>
      )}
    </div>
  )
}

// Re-export the default asset resolver so other modules can reuse it.
export { resolveAssetDefault as resolveAsset }

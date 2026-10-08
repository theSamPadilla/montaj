import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, AlertCircle, Download, Info, Undo2, Redo2 } from 'lucide-react'
import type { Project, Slide, CarouselElement, ImageElement, CarouselEditorProps, OverlayFactory, SlideNotesApi } from '../types'
import type { SlideNote } from '../schema'
import { applyTheme, defaultMontajTheme, isLightTheme } from '../theme'
import { useProjectState } from '../state/use-project-state'
import SlideCanvas from './SlideCanvas'
import SlidePropertyPanel from './SlidePropertyPanel'
import AddElementMenu from './AddElementMenu'
import CarouselRenderModal from './CarouselRenderModal'
import ControlsInfoModal, { CAROUSEL_CONTROLS, platformSections } from '../ControlsInfoModal'
import { DARK_TEXT, NoteArmLayer, NotePinLayer, badgeColor, hasPoint } from './NoteLayers'
import { addSlideNote, setSlideNoteText, setSlideNoteDone, setSlideNotePoint, removeSlideNotes } from './notes'
import { noteId } from '../video/timeline/notes'
import { Button } from '../ui'
import { shortcutText } from '../ui/modifierKeys'

// Generic over the host's concrete project type `P` (default = the package's
// own `Project`). Montaj passes its richer Project; the index signature on
// EditorProject absorbs the host-only pipeline fields, so a full host Project
// round-trips through load→edit→save (and `onProjectChange`) without casts.
type Props<P extends Project = Project> = CarouselEditorProps<P>

// ── SlideGrid (inline sub-component) ─────────────────────────────────────────

interface SlideGridProps {
  project: Project
  slides: Slide[]
  selectedSlideId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (fromIdx: number, toIdx: number) => void
  resolveImageSrc?: (element: ImageElement) => string
  compileOverlay?: (template: string) => Promise<OverlayFactory>
  /** Each slide's pin ids by tone, in the host's order (§149). */
  noteTones?: Map<string, NoteTones>
  onPinClick?: (id: string) => void
}

/** A slide's pin ids by tone: `'review'`, and every other tone as yours. */
interface NoteTones {
  self: string[]
  review: string[]
}

const BUBBLE_TONES = [
  { tone: 'self', one: 'note', many: 'notes' },
  { tone: 'review', one: 'review', many: 'reviews' },
] as const

const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation()

/**
 * A tone's notes on a slide thumbnail (§149): a small speech bubble in the
 * tone's colour, numbered past one note. It takes its own press, so the
 * thumbnail neither selects twice nor starts a drag from it.
 */
function NoteBubble({ slideId, tone, count, label, onOpen }: { slideId: string; tone: string; count: number; label: string; onOpen: () => void }) {
  const color = badgeColor(tone)
  return (
    <button
      type="button"
      data-slide-note-bubble={slideId}
      data-tone={tone}
      aria-label={label}
      title={label}
      // Draggable so the drag starts here, where it is cancelled, and not on the thumbnail.
      draggable
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      onPointerDown={stopEvent}
      onMouseDown={stopEvent}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      style={{
        position: 'relative',
        height: 13,
        minWidth: 16,
        padding: count > 1 ? '0 4px' : 0,
        border: 'none',
        borderRadius: 6.5,
        backgroundColor: color,
        boxShadow: '0 0 0 1.5px #fff',
        filter: 'drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.4))',
        color: DARK_TEXT,
        fontFamily: 'inherit',
        fontSize: 9,
        fontWeight: 700,
        lineHeight: '13px',
        textAlign: 'center',
        cursor: 'pointer',
        pointerEvents: 'auto',
      }}
    >
      {count > 1 ? count : null}
      {/* The tail: its fill covers the ring where it meets the body. */}
      <svg aria-hidden="true" width="6" height="5" viewBox="0 0 6 5" style={{ position: 'absolute', left: 3, top: 12, overflow: 'visible' }}>
        <path d="M0 0 L1 4 L5 0 Z" style={{ fill: color }} />
        <path d="M0 0.75 L1 4 L5 0.75" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function SlideGrid({
  project,
  slides,
  selectedSlideId,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onReorder,
  resolveImageSrc,
  compileOverlay,
  noteTones,
  onPinClick,
}: SlideGridProps) {
  const [w, h] = project.settings.resolution
  const THUMB_W = 200
  const scale = THUMB_W / w
  const thumbH = Math.round(h * scale)

  const dragIdx = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  function handleDragStart(idx: number) {
    dragIdx.current = idx
  }
  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    setDragOverIdx(idx)
  }
  function handleDrop(toIdx: number) {
    if (dragIdx.current !== null && dragIdx.current !== toIdx) {
      onReorder(dragIdx.current, toIdx)
    }
    dragIdx.current = null
    setDragOverIdx(null)
  }
  function handleDragEnd() {
    dragIdx.current = null
    setDragOverIdx(null)
  }

  return (
    <div className="w-56 flex-shrink-0 flex flex-col border-r border-[var(--editor-border)] bg-[var(--editor-bg)] overflow-y-auto min-h-0 h-full">
      <div className="px-3 py-2 border-b border-[var(--editor-border)]">
        <span className="text-xs font-semibold text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] uppercase tracking-wider">Slides</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2 flex flex-col gap-2 px-2">
        {slides.map((slide, idx) => {
          const tones = noteTones?.get(slide.id)
          return (
            <div
              key={slide.id}
              data-slide-thumb={slide.id}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDrop={() => handleDrop(idx)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelect(slide.id)}
              className={`group relative flex-shrink-0 cursor-pointer rounded overflow-hidden border transition-colors ${
                selectedSlideId === slide.id
                  ? 'border-[var(--editor-accent)]'
                  : dragOverIdx === idx
                  ? 'border-[var(--editor-accent)] opacity-70'
                  : 'border-[var(--editor-border)] hover:border-[var(--editor-accent)]'
              }`}
              style={{ width: THUMB_W, height: thumbH }}
            >
              <SlideCanvas slide={slide} width={w} height={h} interactive={false} scale={scale} resolveImageSrc={resolveImageSrc} compileOverlay={compileOverlay} />
              <div className="absolute bottom-1 left-1 text-xs text-white bg-black/50 px-1 rounded">
                {idx + 1}
              </div>
              {tones ? (
                <div style={{ position: 'absolute', right: 5, bottom: 7, display: 'flex', gap: 5, pointerEvents: 'none' }}>
                  {BUBBLE_TONES.map(({ tone, one, many }) => {
                    const ids = tones[tone]
                    if (ids.length === 0) return null
                    return (
                      <NoteBubble
                        key={tone}
                        slideId={slide.id}
                        tone={tone}
                        count={ids.length}
                        label={`${ids.length} ${ids.length === 1 ? one : many}`}
                        onOpen={() => { onSelect(slide.id); onPinClick?.(ids[0]) }}
                      />
                    )
                  })}
                </div>
              ) : null}
              <div className="absolute top-1 right-1 hidden group-hover:flex gap-1">
                <button
                  onClick={e => { e.stopPropagation(); onDuplicate(slide.id) }}
                  className="text-xs bg-black/60 text-white px-1 py-0.5 rounded hover:bg-black/80"
                  title="Duplicate slide"
                >
                  ⧉
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onDelete(slide.id) }}
                  className="text-xs bg-black/60 text-red-400 px-1 py-0.5 rounded hover:bg-black/80"
                  title="Delete slide"
                >
                  ×
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="p-2 border-t border-[var(--editor-border)]">
        <Button size="sm" variant="outline" onClick={onAdd} className="w-full text-xs">
          + Add Slide
        </Button>
      </div>
    </div>
  )
}

// ── helpers ──

function deepCloneElement(el: CarouselElement): CarouselElement {
  if (el.type === 'overlay') {
    return {
      ...el,
      id: crypto.randomUUID(),
      overlay: { template: el.overlay.template, props: { ...el.overlay.props } },
    }
  }
  return { ...el, id: crypto.randomUUID() }
}

function makeSlide(): Slide {
  return { id: crypto.randomUUID(), base_color: '#ffffff', elements: [] }
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

// ── CarouselEditor ────────────────────────────────────────────────────────────

export default function CarouselEditor<P extends Project = Project>({ project: initialProject, adapter, onProjectChange, theme, slots, hiddenElementIds, onToggleElementVisibility, onSelectionChange, renderModal, renderControls, notes, onProvideNotesApi, pins, pinDisplay = 'badge', onPinClick, onSelectedSlideChange, pendingSurface = 'default' }: Props<P>) {
  const state = useProjectState(adapter, initialProject.id, initialProject)
  const project = state.project
  const slides = project.slides ?? []

  // Keep the host's project state in sync with the hook's authoritative state.
  useEffect(() => {
    onProjectChange?.(project)
  }, [project, onProjectChange])

  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(slides[0]?.id ?? null)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [cropElementId, setCropElementId] = useState<string | null>(null)

  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showControls, setShowControls] = useState(false)
  // What a host's `renderControls` is handed: the modal's content, resolved
  // for the platform once (it does not change while the editor is up).
  const controlSections = useMemo(() => platformSections(CAROUSEL_CONTROLS), [])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshState, setRefreshState] = useState<'idle' | 'err'>('idle')
  const [rendering, setRendering] = useState(false)
  const [renderOpen, setRenderOpen] = useState(false)

  // ── Theme: apply tokens onto the editor container. ──
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (containerRef.current) applyTheme(containerRef.current, theme ?? defaultMontajTheme)
  }, [theme])

  // Classified once here, off the same theme object VideoEditor's
  // `timelineMode` uses — see that file's comment for why (three independent
  // consumers resolving light/dark separately is three chances to disagree).
  const mode = useMemo<'light' | 'dark'>(
    () => (isLightTheme(theme ?? defaultMontajTheme) ? 'light' : 'dark'),
    [theme],
  )

  // ── Keyboard shortcuts: undo / redo. Guarded against text inputs. ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        state.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        state.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  // ── Keyboard shortcut: Delete / Backspace removes the selected element. ──
  // Guarded against text inputs (so editing an overlay's text or a panel field
  // never deletes the element) and against crop mode (Backspace there belongs to
  // the crop UI). Deleting mutates project state, so the canvas + thumbnails
  // re-render without the element immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!selectedSlideId || !selectedElementId || cropElementId) return
      e.preventDefault()
      void state.removeElement(selectedSlideId, selectedElementId)
      setSelectedElementId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, selectedSlideId, selectedElementId, cropElementId])

  // ── Project notes (PL70) ───────────────────────────────────────────────
  // The editor is the ONLY writer of `project.notes`. The N flow and the
  // host's notes api both land in `state.editNotes`: one save and one undo
  // step per write, never gated by status (see use-project-state).
  const { editNotes } = state
  const notesRef = useRef(notes)
  notesRef.current = notes
  const slidesRef = useRef(slides)
  slidesRef.current = slides

  /** Adds an empty note on `slideId` (at `point`, or about the whole slide)
   *  and returns it as stored: the core of the N flow and `api.add`. */
  const addNoteOn = useCallback((slideId: string, point?: { x: number; y: number }): SlideNote => {
    const id = noteId()
    let added: SlideNote | undefined
    void editNotes((n) => {
      const next = addSlideNote(n, { slideId, x: point?.x, y: point?.y, id }).notes
      added = next[next.length - 1] as SlideNote
      return next
    })
    return added!
  }, [editNotes])

  /** Every other note write. One that changes nothing writes nothing. */
  const editNote = useCallback((edit: (n: Project['notes']) => Project['notes']) => {
    void editNotes(edit)
  }, [editNotes])

  const selectSlide = useCallback((slideId: string) => {
    if (!slidesRef.current.some((s) => s.id === slideId)) return
    setSelectedSlideId(slideId)
    setSelectedElementId(null)
    setCropElementId(null)
  }, [])

  // Host notes api: handed up once (it is stable) and withdrawn with null on
  // unmount, so the host never writes through an editor that is gone.
  const notesApi = useMemo<SlideNotesApi>(() => ({
    add: (slideId, point) => addNoteOn(slideId, point).id,
    setText: (id, text) => editNote((n) => setSlideNoteText(n, id, text)),
    setDone: (id, done) => editNote((n) => setSlideNoteDone(n, id, done)),
    setPoint: (id, point) => editNote((n) => setSlideNotePoint(n, id, point)),
    remove: (id) => editNote((n) => removeSlideNotes(n, new Set([id]))),
    selectSlide,
  }), [addNoteOn, editNote, selectSlide])
  useEffect(() => {
    if (!onProvideNotesApi) return
    onProvideNotesApi(notesApi)
    return () => onProvideNotesApi(null)
  }, [onProvideNotesApi, notesApi])

  // N arms a pin on the selected slide. The ref mirrors the state so a second
  // key in the same tick sees the arm before React re-renders.
  const [armedSlideId, setArmedSlideId] = useState<string | null>(null)
  const armedRef = useRef<string | null>(null)
  const setArmed = useCallback((slideId: string | null) => {
    armedRef.current = slideId
    setArmedSlideId(slideId)
  }, [])

  /** Adds the armed note (at `point`, or about the whole slide) and disarms. */
  const placeArmedNote = useCallback((point?: { x: number; y: number }) => {
    const slideId = armedRef.current
    if (!slideId) return
    setArmed(null)
    const note = addNoteOn(slideId, point)
    notesRef.current?.onNoteAdded?.(note)
  }, [addNoteOn, setArmed])

  // Disarm when arming no longer makes sense: notes switched off, crop mode,
  // another slide selected (or the armed one deleted), the canvas hidden.
  const notesEnabled = !!notes?.enabled
  useEffect(() => {
    if (armedSlideId === null) return
    if (!notesEnabled || cropElementId || armedSlideId !== selectedSlideId || project.status === 'pending') setArmed(null)
  }, [armedSlideId, notesEnabled, cropElementId, selectedSlideId, project.status, setArmed])

  // A press anywhere but the armed slide disarms without adding. Capture
  // phase, so a handler that stops propagation cannot keep a stale arm.
  const armLayerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (armedSlideId === null) return
    const onDown = (e: PointerEvent) => {
      const layer = armLayerRef.current
      if (layer && e.target instanceof Node && layer.contains(e.target)) return
      setArmed(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [armedSlideId, setArmed])

  // The key handler is read through a ref so the listener, bound only while
  // the host passes `notes`, always sees this render's state. Without
  // `notes`, N and Esc are not claimed at all.
  const noteKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  noteKeyRef.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return
    if (e.key === 'Escape') {
      if (!armedRef.current) return
      e.preventDefault()
      placeArmedNote()
      return
    }
    // Cmd, Ctrl and Alt leave N alone; Shift does not, as on video
    // (`matchesPlainKey`).
    if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return
    // Repeats are dropped: a held N must not arm and place in turn.
    if (e.repeat || cropElementId) return
    const opts = notesRef.current
    if (!opts) return
    e.preventDefault()
    if (!opts.enabled) {
      opts.onLocked?.()
      return
    }
    if (armedRef.current) {
      placeArmedNote()
      return
    }
    if (!selectedSlideId || project.status === 'pending') return
    setArmed(selectedSlideId)
  }
  const hasNotes = !!notes
  useEffect(() => {
    if (!hasNotes) return
    const onKey = (e: KeyboardEvent) => noteKeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasNotes])

  // Host pins: the selected slide's pins with a point go on the canvas; every
  // slide's pins, with a point or without, are bubbles on its thumbnail.
  const canvasPins = useMemo(
    () => (pins ?? []).filter((p) => p.slideId === selectedSlideId).filter(hasPoint),
    [pins, selectedSlideId],
  )
  const noteTones = useMemo(() => {
    const bySlide = new Map<string, NoteTones>()
    for (const p of pins ?? []) {
      let tones = bySlide.get(p.slideId)
      if (!tones) bySlide.set(p.slideId, (tones = { self: [], review: [] }))
      tones[p.tone === 'review' ? 'review' : 'self'].push(p.id)
    }
    return bySlide
  }, [pins])

  // `pendingSurface="host"`: the host draws the pending UI, so a pending
  // project shows the slides as they arrive. Render and note arming stay off.
  const showPendingSurface = project.status === 'pending' && pendingSurface !== 'host'

  async function handleRender() {
    setRendering(true)
    try {
      await state.setStatus('final')
      setRenderOpen(true)
    } catch (e) {
      alert(`Failed to start render: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRendering(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setRefreshState('idle')
    const [result] = await Promise.allSettled([
      state.refetch(),
      new Promise(r => setTimeout(r, 1000)),
    ])
    setRefreshing(false)
    if (result.status === 'rejected') {
      console.error(result.reason)
      setRefreshState('err')
      setTimeout(() => setRefreshState('idle'), 2500)
    }
  }

  useEffect(() => {
    if (pendingSurface === 'host') return
    adapter.getInfo?.().then(info => setSkillPath(info.root_skill_path ?? null)).catch(() => {})
  }, [adapter, pendingSurface])

  // Auto-select first slide, or re-select when the current one disappears.
  useEffect(() => {
    if (slides.length === 0) return
    const stillExists = selectedSlideId && slides.some(s => s.id === selectedSlideId)
    if (!stillExists) {
      setSelectedSlideId(slides[0].id)
      setSelectedElementId(null)
      setCropElementId(null)
    }
  }, [slides, selectedSlideId])

  // Tell the host when the selected slide changes, however it changed. The
  // slide selected at mount is not reported; picking the same slide again is
  // not a change.
  const onSelectedSlideChangeRef = useRef(onSelectedSlideChange)
  onSelectedSlideChangeRef.current = onSelectedSlideChange
  const reportedSlideIdRef = useRef(selectedSlideId)
  useEffect(() => {
    if (reportedSlideIdRef.current === selectedSlideId) return
    reportedSlideIdRef.current = selectedSlideId
    onSelectedSlideChangeRef.current?.(selectedSlideId)
  }, [selectedSlideId])

  // Auto-create a starter slide for a non-pending project that ended up empty.
  const initialSlideCreatedRef = useRef(false)
  useEffect(() => {
    if (initialSlideCreatedRef.current) return
    if (project.status === 'pending') return
    if (slides.length === 0) {
      initialSlideCreatedRef.current = true
      const slide = makeSlide()
      void state.addSlide(slide)
      setSelectedSlideId(slide.id)
    }
  }, [project.status, slides.length])

  // ── Slide handlers (via project-state mutators) ──
  function handleAddSlide() {
    const slide = makeSlide()
    void state.addSlide(slide, selectedSlideId ?? undefined)
    setSelectedSlideId(slide.id)
    setSelectedElementId(null)
  }
  function handleDuplicateSlide(id: string) {
    const src = slides.find(s => s.id === id)
    if (!src) return
    const clone: Slide = { ...src, id: crypto.randomUUID(), elements: src.elements.map(deepCloneElement) }
    void state.duplicateSlide(id, clone)
    setSelectedSlideId(clone.id)
    setSelectedElementId(null)
  }
  function handleDeleteSlide(id: string) {
    void state.removeSlide(id)
    if (selectedSlideId === id) {
      setSelectedElementId(null)
      setCropElementId(null)
    }
  }
  function handleReorderSlides(fromIdx: number, toIdx: number) {
    void state.reorderSlides(fromIdx, toIdx)
  }

  // ── Element handlers ──
  function handleAddElement(slideId: string, element: CarouselElement) {
    void state.addElement(slideId, element)
    setSelectedElementId(element.id)
  }
  function handleDeleteElement(slideId: string, elementId: string) {
    void state.removeElement(slideId, elementId)
    setSelectedElementId(null)
    if (cropElementId === elementId) setCropElementId(null)
  }
  function handleDuplicateElement(slideId: string, elementId: string) {
    const slide = slides.find(s => s.id === slideId)
    const src = slide?.elements.find(el => el.id === elementId)
    if (!src) return
    const clone = { ...deepCloneElement(src), x: src.x + 20, y: src.y + 20 }
    void state.duplicateElement(slideId, elementId, clone)
    setSelectedElementId(clone.id)
  }
  function handleReorderElement(slideId: string, elementId: string, direction: 'forward' | 'backward') {
    void state.reorderElement(slideId, elementId, direction)
  }

  // Property-panel transform/frame edits → committed mutators.
  function handlePanelElementChange(patch: Partial<CarouselElement>) {
    if (!selectedSlideId || !selectedElementId) return
    const slide = slides.find(s => s.id === selectedSlideId)
    const el = slide?.elements.find(e => e.id === selectedElementId)
    if (!el) return
    if ('x' in patch || 'y' in patch || 'w' in patch || 'h' in patch) {
      const box = {
        x: patch.x ?? el.x,
        y: patch.y ?? el.y,
        w: patch.w ?? el.w,
        h: patch.h ?? el.h,
      }
      void state.resizeElement(selectedSlideId, selectedElementId, box).then(() => state.commit())
    }
    if ('rotation' in patch && typeof patch.rotation === 'number') {
      void state.rotateElement(selectedSlideId, selectedElementId, patch.rotation).then(() => state.commit())
    }
    if (el.type === 'overlay' && 'overlay' in patch && patch.overlay) {
      // Prop edits from the generic PropEditor — diff and write per key.
      const nextProps = (patch.overlay as { props: Record<string, unknown> }).props
      for (const [k, v] of Object.entries(nextProps)) {
        if (el.overlay.props[k] !== v) {
          void state.updateOverlayProp(selectedSlideId, selectedElementId, k, String(v))
        }
      }
    }
    if (el.type === 'overlay' && 'frame' in patch && typeof patch.frame === 'number') {
      void state.setOverlayFrame(selectedSlideId, selectedElementId, patch.frame)
    }
  }

  function handleSlideChange(patch: Partial<Slide>) {
    if (selectedSlideId) void state.updateSlide(selectedSlideId, patch)
  }

  const selectedSlide = slides.find(s => s.id === selectedSlideId)
  const selectedElement = selectedSlide?.elements.find(el => el.id === selectedElementId)

  // Notify the host of selection changes so it can drive selection-aware chrome
  // (e.g. a regen action in a toolbar slot). Fires with the element or null.
  useEffect(() => {
    onSelectionChange?.(selectedElement ?? null)
  }, [selectedElement, onSelectionChange])

  const [w, h] = project.settings.resolution
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const [canvasContainerSize, setCanvasContainerSize] = useState<{ w: number; h: number }>({ w: 600, h: 700 })
  useEffect(() => {
    const el = canvasContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setCanvasContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  const PADDING = 32
  const HINT_RESERVE = 28
  const availW = Math.max(0, canvasContainerSize.w - PADDING)
  const availH = Math.max(0, canvasContainerSize.h - PADDING - HINT_RESERVE)
  const canvasScale = Math.min(availW / w, availH / h, 1)

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto bg-[var(--editor-bg)] text-[var(--editor-text)]">
      {/* TOP: slide rail | canvas | editing panel (right). Fixed viewport-relative
          height with min-h-0 so each of the three columns establishes its own
          independent scroll context; the project-media region flows beneath and
          the whole editor scrolls vertically. */}
      <div className="flex flex-shrink-0 h-[78vh] min-h-0 overflow-hidden">
      <SlideGrid
        project={project}
        slides={slides}
        selectedSlideId={selectedSlideId}
        onSelect={id => { setSelectedSlideId(id); setSelectedElementId(null); setCropElementId(null) }}
        onAdd={handleAddSlide}
        onDuplicate={handleDuplicateSlide}
        onDelete={handleDeleteSlide}
        onReorder={handleReorderSlides}
        resolveImageSrc={adapter.resolveImageSrc}
        compileOverlay={(t) => adapter.compileOverlay(t)}
        noteTones={noteTones}
        onPinClick={onPinClick}
      />

      {/* CANVAS COLUMN: a pinned toolbar row on top, then the independently
          scrolling slide-rendering area below it. */}
      <div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* TOOLBAR ROW: Refresh on the left; host toolbar actions + Render on the
            right. Pinned (shrink-0) above the scrolling canvas area. */}
        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors ${
                refreshState === 'err'
                  ? (mode === 'light' ? 'text-red-700 border-red-300 bg-red-50 hover:bg-red-100' : 'text-red-300 border-red-500/40 bg-red-950/60 hover:bg-red-900/70')
                  : 'text-[var(--editor-text)] border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--editor-surface)_80%,transparent)] hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)] hover:bg-[var(--editor-surface)]'
              }`}
              title={refreshState === 'err' ? 'Refresh failed — check connection' : 'Refresh project'}
            >
              {refreshState === 'err' ? <AlertCircle size={18} /> : <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />}
              <span className="text-xs font-medium">Refresh</span>
            </button>
            <button
              onClick={() => state.undo()}
              disabled={!state.canUndo}
              className="flex items-center justify-center p-2 rounded-md border border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--editor-surface)_80%,transparent)] text-[var(--editor-text)] transition-colors hover:border-[var(--editor-accent)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Undo (${shortcutText(['⌘', 'Z'])})`}
              aria-label="Undo"
            >
              <Undo2 size={18} />
            </button>
            <button
              onClick={() => state.redo()}
              disabled={!state.canRedo}
              className="flex items-center justify-center p-2 rounded-md border border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--editor-surface)_80%,transparent)] text-[var(--editor-text)] transition-colors hover:border-[var(--editor-accent)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Redo (${shortcutText(['⌘', '⇧', 'Z'])})`}
              aria-label="Redo"
            >
              <Redo2 size={18} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {slots?.toolbarActions}
            <button
              onClick={handleRender}
              disabled={rendering || project.status === 'pending' || slides.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--editor-accent)] bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                project.status === 'pending'
                  ? 'Wait for the agent to finish before rendering'
                  : slides.length === 0
                  ? 'Add slides before rendering'
                  : 'Render all slides as PNGs'
              }
            >
              <Download size={18} />
              <span className="text-xs font-medium">{rendering ? 'Starting…' : 'Render'}</span>
            </button>
          </div>
        </div>

        {/* SCROLL AREA: the slide viewport. ResizeObserver lives here so
            canvasScale measures the slide-rendering area, not the toolbar. */}
        <div ref={canvasContainerRef} className="relative flex-1 flex flex-col items-center justify-center gap-4 overflow-y-auto min-h-0 p-4">
        {showPendingSurface ? (
          <div className="flex flex-col items-center gap-6 text-center max-w-lg w-full">
            {slots?.pendingStatus ?? (
              <div className="flex flex-col items-center gap-2">
                <p className="text-[var(--editor-text)] text-lg font-semibold">Message your agent to start</p>
                <p className="text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
              </div>
            )}
            {!slots?.pendingStatus && skillPath && (
              <div className="w-full rounded-xl border-2 border-[var(--editor-accent)] bg-[var(--editor-surface)] p-5 flex flex-col gap-3 text-left shadow-lg shadow-[color-mix(in_srgb,var(--editor-accent)_10%,transparent)]">
                {/* indigo-600 in light mode: the accent (indigo-500) is ~4.06:1 on
                    `--editor-surface`, and 12px bold is still NORMAL text under WCAG
                    (large starts at 18.66px bold), so it needs the 4.5:1 floor. The
                    border/shadow around it stay accent - this is small-TEXT only. */}
                <p className={`text-xs font-bold uppercase tracking-widest ${mode === 'light' ? 'text-indigo-600' : 'text-[var(--editor-accent)]'}`}>Send this to your agent</p>
                {/* Deliberately hardcoded dark chrome, not `--editor-*` tokens: this
                    is the literal text the user copies and pastes to their coding
                    agent, styled as terminal/code chrome — same precedent as the
                    video preview's black canvas, which also stays dark regardless
                    of editor theme.

                    This was `bg-black/60`, which composited against whatever sat
                    behind it: near-black over the dark surface, but only ~#666
                    over a light one — ~3:1 for 12px copyable text, below AA.
                    It is now an OPAQUE colour so the box no longer depends on
                    its backdrop. The specific value is not arbitrary: #070a10 is
                    exactly what `rgba(0,0,0,0.6)` over the dark theme's
                    `--editor-surface` (#111827) composited to, so dark mode is
                    pixel-identical to before while light mode is fixed. Text is
                    pinned to #f3f4f6 (= the dark theme's `--editor-text`), so it
                    is likewise unchanged in dark mode and ~18:1 in both. */}
                <div className="flex items-start justify-between bg-[#070a10] border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                  <span className="text-gray-100 text-[12px] leading-relaxed break-all">
                    There is a new project pending: &quot;{project.name ?? project.id}&quot;. Please see @{skillPath} and start. Talk to me if you run into questions.
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start. Talk to me if you run into questions.`
                      )
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                      copied ? 'bg-green-700 text-green-200' : 'bg-white/10 text-gray-100 hover:bg-white/20 hover:text-gray-100'
                    }`}
                    title="Copy prompt"
                  >
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
            <p className="text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)] text-xs font-mono">project id: {project.id}</p>
          </div>
        ) : selectedSlide ? (
          <>
            {/* Edge definition for the slide canvas, which sits on `--editor-bg`.
                Was a fixed `rgba(255,255,255,0.08)`, which read as a hairline
                highlight on the dark ground but composited to under 1/255 on the
                light one — the edge silently vanished. Keyed to `--editor-text`
                instead, the same "tint with the foreground colour" idiom the rest
                of the chrome uses, so it is a light ring on dark and a dark ring
                on light at the same subtle strength. */}
            <div className="flex-shrink-0 ring-1 ring-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]">
              <SlideCanvas
                slide={selectedSlide}
                slideId={selectedSlide.id}
                width={w}
                height={h}
                interactive
                selectedElementId={selectedElementId}
                onSelect={id => { setSelectedElementId(id); if (id !== cropElementId) setCropElementId(null) }}
                scale={canvasScale}
                resolveImageSrc={adapter.resolveImageSrc}
                compileOverlay={(t) => adapter.compileOverlay(t)}
                watchFile={adapter.watchFile}
                moveElement={state.moveElement}
                resizeElement={state.resizeElement}
                rotateElement={state.rotateElement}
                commit={state.commit}
                updateOverlayProp={state.updateOverlayProp}
                updateImageCrop={state.updateImageCrop}
                cropElementId={cropElementId}
                onExitCrop={() => setCropElementId(null)}
                hiddenElementIds={hiddenElementIds}
              >
                {canvasPins.length > 0 && <NotePinLayer pins={canvasPins} pinDisplay={pinDisplay} onPinClick={onPinClick} />}
                {armedSlideId === selectedSlide.id && <NoteArmLayer layerRef={armLayerRef} onPlace={placeArmedNote} />}
              </SlideCanvas>
            </div>
            <div className="flex-shrink-0 flex items-center justify-center gap-1.5 text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] max-w-md">
              <span className="text-center">
                Drag to reposition, resize/rotate via handles, double-click text to edit. {shortcutText(['⌘', 'Z'])} to undo.
              </span>
              <button
                type="button"
                onClick={() => setShowControls(true)}
                title="Editor controls & shortcuts"
                aria-label="Editor controls & shortcuts"
                className="shrink-0 cursor-pointer opacity-60 transition-opacity hover:opacity-100"
              >
                <Info size={13} />
              </button>
            </div>
          </>
        ) : (
          <div className="text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)] text-sm">No slides yet. Add one in the left panel.</div>
        )}

        {state.lastError && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/40 bg-red-950/80 text-red-200 text-xs">
            <AlertCircle size={14} />
            <span>{state.lastError}</span>
            <button onClick={state.clearError} className="ml-2 underline">dismiss</button>
          </div>
        )}
        </div>
      </div>

        {/* RIGHT: the slide editor (add-element toolbar + property panel),
            beside the canvas with its own independent vertical scroll. */}
        <div className="w-[24rem] flex-shrink-0 border-l border-[var(--editor-border)] flex flex-col overflow-y-auto min-h-0 h-full bg-[var(--editor-bg)]">
          {selectedSlide && !showPendingSurface && (
            <div className="px-4 py-2 border-b border-[var(--editor-border)]">
              <AddElementMenu
                project={project}
                selectedSlideId={selectedSlideId}
                adapter={adapter}
                onAddElement={handleAddElement}
                mode={mode}
              />
            </div>
          )}
          <SlidePropertyPanel
            project={project}
            slide={selectedSlide}
            element={selectedElement}
            adapter={adapter}
            onSlideChange={handleSlideChange}
            onElementChange={handlePanelElementChange}
            onDeleteSlide={handleDeleteSlide}
            onDuplicateSlide={handleDuplicateSlide}
            onDeleteElement={handleDeleteElement}
            onDuplicateElement={handleDuplicateElement}
            onReorderElement={handleReorderElement}
            onEnterCrop={(_slideId, elementId) => { setSelectedElementId(elementId); setCropElementId(elementId) }}
            updateOverlayProp={state.updateOverlayProp}
            hiddenElementIds={hiddenElementIds}
            onToggleElementVisibility={onToggleElementVisibility}
            // Fills the right column (drop the default w-80 width + left border).
            className="w-full border-l-0"
            mode={mode}
          />
          {slots?.notesPanel && (
            <div className="border-t border-[var(--editor-border)]">
              {slots.notesPanel}
            </div>
          )}
        </div>
      </div>

      {/* BELOW: Project media, full width at the bottom. Flows beneath the top
          region and scrolls with the page (the root is overflow-y-auto). */}
      {slots?.assetsPanel && (
        <div className="flex-shrink-0 border-t border-[var(--editor-border)] w-full flex flex-col">
          {slots.assetsPanel}
        </div>
      )}

      {/* Controls window. A host that passes `renderControls` draws it; it is
          called on every render, `open` saying whether the window should
          show. Otherwise the package's ControlsInfoModal. */}
      {renderControls
        ? renderControls({
            open: showControls,
            title: 'Editor controls',
            kind: 'carousel',
            sections: controlSections,
            onClose: () => setShowControls(false),
          })
        : showControls && (
          <ControlsInfoModal
            title="Editor controls"
            sections={CAROUSEL_CONTROLS}
            onClose={() => setShowControls(false)}
          />
        )}

      {/* Render window. A host that passes `renderModal` owns it and the
          render itself; it is called on every render, `open` saying whether
          the window should show. Otherwise the package's CarouselRenderModal. */}
      {renderModal
        ? renderModal({
            open: renderOpen,
            projectId: project.id,
            adapter,
            slidesCount: slides.length,
            resolution: project.settings.resolution as [number, number],
            exportActions: slots?.exportActions,
            mode,
            onClose: () => setRenderOpen(false),
          })
        : renderOpen && (
          <CarouselRenderModal
            projectId={project.id}
            adapter={adapter}
            slidesCount={slides.length}
            resolution={project.settings.resolution as [number, number]}
            exportActions={slots?.exportActions}
            onClose={() => setRenderOpen(false)}
            onCancel={() => setRenderOpen(false)}
            mode={mode}
          />
        )}
    </div>
  )
}

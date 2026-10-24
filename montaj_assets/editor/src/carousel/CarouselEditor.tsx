import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RefreshCw, AlertCircle, Download, Info, Undo2, Redo2 } from 'lucide-react'
import type { Project, Slide, CarouselElement, ImageElement, CarouselEditorProps, OverlayFactory, SlideNotesApi, CarouselApi, ImageDropPayload } from '../types'
import { IMAGE_DND_MIME } from '../types'
import type { SlideNote } from '../schema'
import { applyTheme, defaultMontajTheme, isLightTheme } from '../theme'
import { useProjectState } from '../state/use-project-state'
import SlideCanvas, { type CropExit, type SlideCanvasCropControl } from './SlideCanvas'
import SlidePropertyPanel from './SlidePropertyPanel'
import AddElementMenu from './AddElementMenu'
import CarouselRenderModal from './CarouselRenderModal'
import ControlsInfoModal, { CAROUSEL_CONTROLS, platformSections } from '../ControlsInfoModal'
import { DARK_TEXT, NoteArmLayer, NotePinLayer, badgeColor, hasPoint } from './NoteLayers'
import { addSlideNote, setSlideNoteText, setSlideNoteDone, setSlideNotePoint, removeSlideNotes } from './notes'
import { coverCrop, loadImageNaturalSize, type ImageSize } from './imageGeometry'
import { newImageElement } from './newImage'
import { noteId } from '../video/timeline/notes'
import { useKeymap, matchesDelete, matchesEscape, matchesPlainKey, matchesRedo, matchesUndo, type KeyBinding } from '../video/keymap'
import type { ReorderDirection } from '../state/project-reducer'
import { COPY_OFFSET, cloneElement, copyElements, duplicateCopies, insertCopies, pasteElements, type ElementClipboard } from './clipboard'
import { reorderSelection } from './layerOrder'
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
    // Only a slide being reordered is the rail's to take. A Media card or a file
    // crossing it is left alone, and lights nothing up: no dragend would clear it.
    if (dragIdx.current === null) return
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
              onDrop={(e) => { e.preventDefault(); handleDrop(idx) }}
              onDragEnd={handleDragEnd}
              onClick={() => onSelect(slide.id)}
              role="button"
              tabIndex={0}
              aria-label={`Slide ${idx + 1}`}
              aria-pressed={selectedSlideId === slide.id}
              onKeyDown={e => {
                // Only the thumbnail itself: its duplicate/delete buttons keep their own keys.
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(slide.id) }
              }}
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

function makeSlide(): Slide {
  return { id: crypto.randomUUID(), base_color: '#ffffff', elements: [] }
}

/** N with no Cmd, Ctrl or Alt held; Shift is allowed. */
const matchesNoteKey = matchesPlainKey('n')

/** Cmd or Ctrl with the letter `key`, and no Shift or Alt: those are other
 *  shortcuts (Cmd+Shift+V pastes as plain text, Cmd+Opt+V pastes attributes). */
const matchesCmdKey = (key: string) => (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === key

/** Cmd or Ctrl with a bracket key, with Option (`alt`) or without. Matched on
 *  `code`, the physical key: Option changes what a Mac types for it. Shift is
 *  left to the browser (it switches tabs). */
const matchesLayerKey = (code: 'BracketLeft' | 'BracketRight', alt: boolean) => (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && e.altKey === alt && e.code === code

/** The arrows and the way each one nudges. */
const ARROWS = new Map<string, [dx: number, dy: number]>([
  ['ArrowLeft', [-1, 0]],
  ['ArrowRight', [1, 0]],
  ['ArrowUp', [0, -1]],
  ['ArrowDown', [0, 1]],
])
const NUDGE_PX = 1
const NUDGE_PX_SHIFT = 10
/** A nudge burst commits this long after its last arrow press, if the key was not released first. */
const NUDGE_COMMIT_MS = 500

/** The move an arrow key asks for: 1 px, or 10 with Shift. Null for any other
 *  key, and for an arrow with Cmd, Ctrl or Alt held. */
function nudgeOf(e: KeyboardEvent): { dx: number; dy: number } | null {
  const arrow = ARROWS.get(e.key)
  if (!arrow || e.metaKey || e.ctrlKey || e.altKey) return null
  const px = e.shiftKey ? NUDGE_PX_SHIFT : NUDGE_PX
  return { dx: arrow[0] * px, dy: arrow[1] * px }
}

/** A burst of arrow-key moves that is still open: the moves are on screen
 *  already (transient), and one commit saves them as one undo step. */
interface PendingNudge {
  slideId: string
  /** Where each moved element stood when the burst began. */
  start: Map<string, { x: number; y: number }>
  /** How far the burst has moved them, in px. */
  dx: number
  dy: number
  /** The 500 ms commit; set once the first press has moved something. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Whether `burst` is the one for this slide and exactly this selection: a
 *  burst belongs to the elements it began on. */
function isBurstOf(burst: PendingNudge, slideId: string, selectedIds: string[]): boolean {
  return burst.slideId === slideId && burst.start.size === selectedIds.length && selectedIds.every((id) => burst.start.has(id))
}

/** Whether a dialog of the host's is open over the editor: any element marked
 *  `aria-modal="true"` (the Library picker, the image preview). The editor's own
 *  windows are tracked by `modalOpen`; this holds the keys for the host's too. */
function hostDialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/** The host path in a drag from the host (`IMAGE_DND_MIME`), or null when the
 *  drag carries none or it is not an `ImageDropPayload`: not JSON, or no
 *  `src` that is a non-empty string. */
function hostImageSrc(data: DataTransfer): string | null {
  const raw = data.getData(IMAGE_DND_MIME)
  if (!raw) return null
  try {
    const payload = JSON.parse(raw) as Partial<ImageDropPayload> | null
    return typeof payload?.src === 'string' && payload.src.trim() !== '' ? payload.src : null
  } catch {
    return null
  }
}

/** The image types a browser can draw. PSD is an image too, but the canvas
 *  cannot show it: it would land as an empty square. */
const DRAWABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
])
/** §568: HEIC, HEIF and TIFF the canvas cannot draw either, but the upload
 *  stores them as a JPEG (a PNG when not fully opaque) with their colour
 *  profile (serve's upload-asset), and answers that. A browser that does not
 *  know the type gives an empty one, so the name decides then. */
const CONVERTED_IMAGE_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'image/tiff'])
const CONVERTED_IMAGE_NAME = /\.(heic|heif|tiff?)$/i
const isImageFile = (file: File) =>
  DRAWABLE_IMAGE_TYPES.has(file.type) || CONVERTED_IMAGE_TYPES.has(file.type) || (file.type === '' && CONVERTED_IMAGE_NAME.test(file.name))

/** How long Render waits for the save as final (`renderSaveTimeoutMs`). */
const RENDER_SAVE_TIMEOUT_MS = 30_000

/** `promise`, or a rejection once `ms` pass without it settling. The promise
 *  itself runs on: a save that lands late still lands. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The project did not save in time.')), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// ── CarouselEditor ────────────────────────────────────────────────────────────

export default function CarouselEditor<P extends Project = Project>({ project: initialProject, adapter, onProjectChange, theme, slots, hiddenElementIds, onToggleElementVisibility, onSelectionChange, renderModal, renderControls, onProvideRenderTrigger, onProvideCarouselApi, notes, onProvideNotesApi, pins, pinDisplay = 'badge', onPinClick, onSelectedSlideChange, pendingSurface = 'default', onError, renderSaveTimeoutMs = RENDER_SAVE_TIMEOUT_MS }: Props<P>) {
  const state = useProjectState(adapter, initialProject.id, initialProject)
  const project = state.project
  const slides = project.slides ?? []

  // Keep the host's project state in sync with the hook's authoritative state.
  useEffect(() => {
    onProjectChange?.(project)
  }, [project, onProjectChange])

  // ── Arrow-key nudge (§556) ──
  // A burst of arrow presses moves the selection with the transient
  // `state.moveElement` (on screen, no undo step, no save), and one
  // `state.commit()` closes it: 500 ms after the last press, on the arrow's
  // release, on the window losing focus, or before anything else acts. The
  // last one matters: `mutate` folds an open gesture into its own undo step, and
  // `undo` drops it, so every other key and every change of selection or slide
  // ends the burst first.
  const nudgeRef = useRef<PendingNudge | null>(null)
  const commitRef = useRef(state.commit)
  commitRef.current = state.commit
  const discardRef = useRef(state.discardTransient)
  discardRef.current = state.discardTransient
  const flushNudge = useCallback(() => {
    const open = nudgeRef.current
    if (!open) return
    nudgeRef.current = null
    clearTimeout(open.timer)
    // A burst that netted to zero (Right then Left) changed nothing: it is given
    // up, with no undo step and no save.
    if (open.dx === 0 && open.dy === 0) {
      discardRef.current()
      return
    }
    // A save that fails is reported through `state.lastError`.
    commitRef.current().catch(() => {})
  }, [])

  const [selectedSlideId, setSelectedSlideIdNow] = useState<string | null>(slides[0]?.id ?? null)
  const setSelectedSlideId = useCallback((id: string | null) => {
    flushNudge()
    setSelectedSlideIdNow(id)
  }, [flushNudge])
  // The selected elements, in click order (§156). `selectedElementId` is the
  // one selected element, null when none or several are: the handles, the
  // element panel and crop all key off it, so a single selection behaves as
  // it always has.
  const [selectedElementIds, setSelectedElementIdsNow] = useState<string[]>([])
  const setSelectedElementIds = useCallback((ids: React.SetStateAction<string[]>) => {
    flushNudge()
    setSelectedElementIdsNow(ids)
  }, [flushNudge])
  const setSelectedElementId = useCallback((id: string | null) => {
    setSelectedElementIds(id ? [id] : [])
  }, [setSelectedElementIds])
  const [cropElementId, setCropElementIdState] = useState<string | null>(null)
  // The ref mirrors the state, written with it, so a handler that runs before
  // the next render (an upload that lands, a second entry in the same tick)
  // sees the crop that is on now.
  const cropElementIdRef = useRef<string | null>(null)
  const setCropElementId = useCallback((id: string | null) => {
    cropElementIdRef.current = id
    setCropElementIdState(id)
  }, [])

  // ── Crop mode (§556 M4) ──
  // The canvas holds the window being picked. Every way out of crop mode but
  // Esc (the canvas's own) comes through here: `apply` writes the window as
  // one undo step, or nothing when it changes nothing; `discard` writes
  // nothing. The promise settles once the write is saved.
  const cropControlRef = useRef<SlideCanvasCropControl | null>(null)
  const leaveCrop = useCallback((how: CropExit): Promise<void> => {
    const left = cropControlRef.current?.leave(how) ?? Promise.resolve()
    setCropElementId(null)
    return left
  }, [setCropElementId])
  /** Leaves crop mode keeping what was picked. A save that fails is rolled back and shown by `state.lastError`. */
  const applyCrop = useCallback(() => {
    leaveCrop('apply').catch(() => {})
  }, [leaveCrop])
  /** Crop mode for an image: its panel button, or a double-click on it. The
   *  crop of another image in progress is applied first, so moving on does not
   *  drop what was picked. */
  const enterCrop = useCallback((elementId: string) => {
    if (cropElementIdRef.current && cropElementIdRef.current !== elementId) applyCrop()
    setSelectedElementId(elementId)
    setCropElementId(elementId)
  }, [setSelectedElementId, setCropElementId, applyCrop])

  const selectedSlide = slides.find(s => s.id === selectedSlideId)
  // Only ids still on the selected slide count: a removed element leaves the set.
  const liveSelectedIds = useMemo(
    () => selectedElementIds.filter(id => selectedSlide?.elements.some(el => el.id === id)),
    [selectedElementIds, selectedSlide],
  )
  useEffect(() => {
    if (liveSelectedIds.length !== selectedElementIds.length) setSelectedElementIds(liveSelectedIds)
  }, [liveSelectedIds, selectedElementIds])
  const selectedElementId = liveSelectedIds.length === 1 ? liveSelectedIds[0] : null
  const selectedElements = useMemo(
    () => liveSelectedIds.map(id => selectedSlide!.elements.find(el => el.id === id)!),
    [liveSelectedIds, selectedSlide],
  )

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
  // AddElementMenu owns the overlay picker and reports it open or closed.
  const [overlayPickerOpen, setOverlayPickerOpen] = useState(false)

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

  // ── Project notes (PL70) ───────────────────────────────────────────────
  // The editor is the ONLY writer of `project.notes`. The N flow and the
  // host's notes api both land in `state.editNotes`: one save and one undo
  // step per write, never gated by status (see use-project-state).
  const { editNotes } = state
  const notesRef = useRef(notes)
  notesRef.current = notes
  const slidesRef = useRef(slides)
  slidesRef.current = slides
  // False once the editor is gone, so a write that waited on an upload (Replace
  // image) does not land on a project this editor no longer owns.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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
    applyCrop()
    setSelectedSlideId(slideId)
    setSelectedElementId(null)
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

  // `pendingSurface="host"`: the host draws the pending UI, so a pending
  // project shows the slides as they arrive. Render and note arming stay off.
  const showPendingSurface = project.status === 'pending' && pendingSurface !== 'host'

  // ── Element keys (§556): copy, cut, paste, duplicate, select all, nudge,
  // layer order, deselect. Each acts on the slide on show, never in crop mode
  // (those keys belong to the crop UI), and the ones that change the project
  // only when it can be edited.
  const clipboardRef = useRef<ElementClipboard | null>(null)
  // It survives a change of slide, but not of project: the host may put another
  // project in this editor without remounting it.
  useEffect(() => {
    clipboardRef.current = null
  }, [project.id])
  const slideLive = !!selectedSlide && !showPendingSurface && !cropElementId
  const hasSelection = slideLive && liveSelectedIds.length > 0
  const canEdit = state.isEditingAllowed

  // The element writes below are built from the render on show, which the
  // project can be ahead of (a frame from another writer lands before the
  // editor draws it). Each goes through `state.editElements`, which applies it
  // to the elements the project holds when it lands, so nothing that arrived
  // meanwhile is written over.

  /** Removes the selected elements. Several go in one slide write, so one undo
   *  brings them all back. */
  function removeSelection() {
    if (!selectedSlide) return
    if (liveSelectedIds.length === 1) {
      void state.removeElement(selectedSlide.id, liveSelectedIds[0])
    } else {
      const gone = new Set(liveSelectedIds)
      void state.editElements(selectedSlide.id, (els) => {
        const kept = els.filter(el => !gone.has(el.id))
        return kept.length === els.length ? els : kept
      })
    }
    setSelectedElementId(null)
  }

  /** Copy: the selection, in slide order, replaces the clipboard. */
  function copySelection() {
    if (!selectedSlide) return
    clipboardRef.current = copyElements(selectedSlide, liveSelectedIds) ?? clipboardRef.current
  }

  /** Paste: fresh clones on top of the slide, selected; one slide write. */
  function pasteClipboard() {
    const clipboard = clipboardRef.current
    if (!clipboard || !selectedSlide) return
    const pasted = pasteElements(clipboard, selectedSlide)
    void state.editElements(selectedSlide.id, (els) => [...els, ...pasted])
    setSelectedElementIds(pasted.map(el => el.id))
  }

  /** Duplicate: a copy of each selected element directly above it, selected; one slide write. */
  function duplicateSelection() {
    if (!selectedSlide) return
    // The copies are made now, so their ids (the new selection) are known; each
    // goes above its source in the elements the project has when the write lands.
    const copies = duplicateCopies(selectedSlide.elements, liveSelectedIds)
    if (copies.size === 0) return
    void state.editElements(selectedSlide.id, (els) => insertCopies(els, copies))
    setSelectedElementIds(Array.from(copies.values(), (copy) => copy.id))
  }

  /** Select all: every element on the slide the host is not hiding. */
  function selectAll() {
    if (!selectedSlide) return
    const hidden = new Set(hiddenElementIds)
    setSelectedElementIds(selectedSlide.elements.filter(el => !hidden.has(el.id)).map(el => el.id))
  }

  /** Layer order for the whole selection, in one slide write; nothing is
   *  written when the order would not change. */
  function moveSelectionInStack(direction: ReorderDirection) {
    if (!selectedSlide) return
    // An order that would not change on show records nothing.
    if (reorderSelection(selectedSlide.elements, liveSelectedIds, direction) === selectedSlide.elements) return
    const ids = liveSelectedIds
    void state.editElements(selectedSlide.id, (els) => reorderSelection(els, ids, direction))
  }

  /** One arrow press: every selected element moves, on screen only. Positions
   *  are the burst's start plus what it has moved so far, so presses that come
   *  faster than a render still add up. */
  function nudgeSelection(dx: number, dy: number) {
    if (!selectedSlide) return
    let burst = nudgeRef.current
    if (burst && !isBurstOf(burst, selectedSlide.id, liveSelectedIds)) {
      flushNudge()
      burst = null
    }
    if (!burst) {
      const start = new Map(selectedElements.map(el => [el.id, { x: el.x, y: el.y }] as const))
      burst = { slideId: selectedSlide.id, start, dx: 0, dy: 0, timer: undefined }
    }
    clearTimeout(burst.timer)
    burst.dx += dx
    burst.dy += dy
    for (const [id, from] of burst.start) void state.moveElement(burst.slideId, id, from.x + burst.dx, from.y + burst.dy)
    burst.timer = setTimeout(flushNudge, NUDGE_COMMIT_MS)
    nudgeRef.current = burst
  }

  // An arrow's release, the window losing focus and unmounting all end an open burst.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (ARROWS.has(e.key)) flushNudge()
    }
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', flushNudge)
    return () => {
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', flushNudge)
      flushNudge()
    }
  }, [flushNudge])

  // ── Keyboard shortcuts: every one in ONE registry (the video editor's
  // `useKeymap`). One `document` listener reads this list fresh on each key,
  // so the bindings see this render's state, and the first binding that
  // matches wins: a new shortcut goes in the list where its priority belongs.
  // `useKeymap` skips typing surfaces (inputs, textareas such as the inline
  // text editor, contentEditable) and holds every key while a dialog is up.
  // Nothing here may match Esc in crop mode: that Esc falls through to
  // SlideCanvas's window listener, which applies the crop. Without `notes`,
  // N is not claimed at all; Esc only when something is selected, so a host's
  // own Esc handlers still run.
  const modalOpen = showControls || renderOpen || overlayPickerOpen

  // Undo and redo, from the keys and the toolbar. An open nudge burst is
  // committed first, so Undo takes the nudge back (it is its own step) and Redo
  // finds a new edit that has ended redo. In crop mode undo cancels the crop
  // (crop mode ends, nothing is written) and redo does nothing.
  function undo() {
    flushNudge()
    if (cropElementId) void leaveCrop('discard')
    else state.undo()
  }
  function redo() {
    flushNudge()
    if (!cropElementId) state.redo()
  }

  const bindings: KeyBinding[] = [
    {
      // Esc adds the armed note about the whole slide.
      id: 'carousel.place-note',
      description: 'Add the armed note about the whole slide',
      matches: matchesEscape,
      guard: () => !!notesRef.current && !!armedRef.current && !cropElementId,
      action: () => placeArmedNote(),
      paletteHidden: true,
    },
    {
      // After the armed note, which takes the first Esc.
      id: 'carousel.deselect',
      description: 'Clear the selection',
      keyHint: ['Esc'],
      matches: matchesEscape,
      guard: () => hasSelection,
      action: () => setSelectedElementId(null),
      paletteHidden: true,
    },
    {
      id: 'carousel.undo',
      description: 'Undo',
      keyHint: ['⌘', 'Z'],
      matches: matchesUndo,
      action: () => undo(),
    },
    {
      id: 'carousel.redo',
      description: 'Redo',
      keyHint: ['⌘', '⇧', 'Z'],
      matches: matchesRedo,
      action: () => redo(),
    },
    {
      // Removes the selected elements, never in crop mode (Backspace there
      // belongs to the crop UI), and only in a project that can be edited, as
      // the other editing keys. Shift+Delete is not this, as on video.
      id: 'carousel.delete',
      description: 'Remove the selected elements',
      keyHint: ['Delete'],
      matches: matchesDelete,
      guard: () => hasSelection && canEdit,
      action: () => removeSelection(),
    },
    {
      // N arms a pin on the selected slide; with one armed, N adds it about
      // the whole slide. Cmd, Ctrl and Alt leave N alone; Shift does not, as
      // on video. Repeats are dropped: a held N must not arm and place in turn.
      id: 'carousel.add-note',
      description: 'Add a note',
      keyHint: ['N'],
      matches: (e) => matchesNoteKey(e) && !e.repeat,
      guard: () => !!notesRef.current && !cropElementId,
      action: () => {
        const opts = notesRef.current
        if (!opts) return
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
      },
    },
    {
      // `preventDefault: false` so the browser's own text copy is untouched:
      // this only adds a copy of the elements on top, as on video.
      id: 'carousel.copy',
      description: 'Copy the selection',
      keyHint: ['⌘', 'C'],
      matches: matchesCmdKey('c'),
      guard: () => hasSelection,
      preventDefault: false,
      action: () => copySelection(),
    },
    {
      id: 'carousel.cut',
      description: 'Cut the selection',
      keyHint: ['⌘', 'X'],
      matches: matchesCmdKey('x'),
      guard: () => hasSelection && canEdit,
      action: () => {
        copySelection()
        removeSelection()
      },
    },
    {
      // Only with something to paste, so the browser's own paste is otherwise untouched.
      id: 'carousel.paste',
      description: 'Paste',
      keyHint: ['⌘', 'V'],
      matches: matchesCmdKey('v'),
      guard: () => slideLive && canEdit && !!clipboardRef.current?.elements.length,
      action: () => pasteClipboard(),
    },
    {
      id: 'carousel.duplicate',
      description: 'Duplicate the selection',
      keyHint: ['⌘', 'D'],
      matches: matchesCmdKey('d'),
      guard: () => hasSelection && canEdit,
      action: () => duplicateSelection(),
    },
    {
      // Claimed on an empty slide too: the page must not select its own text.
      id: 'carousel.select-all',
      description: 'Select all',
      keyHint: ['⌘', 'A'],
      matches: matchesCmdKey('a'),
      guard: () => slideLive,
      action: () => selectAll(),
    },
    // Layer order. Cmd+[ and Cmd+] are history navigation in a browser, so
    // they are taken even when the order would not change. The Option ones
    // come first: they also pass the plain ones' Cmd test, but not !alt.
    {
      id: 'carousel.layer-front',
      description: 'Bring to front',
      keyHint: ['⌘', '⌥', ']'],
      matches: matchesLayerKey('BracketRight', true),
      guard: () => hasSelection && canEdit,
      action: () => moveSelectionInStack('front'),
    },
    {
      id: 'carousel.layer-back',
      description: 'Send to back',
      keyHint: ['⌘', '⌥', '['],
      matches: matchesLayerKey('BracketLeft', true),
      guard: () => hasSelection && canEdit,
      action: () => moveSelectionInStack('back'),
    },
    {
      id: 'carousel.layer-forward',
      description: 'Bring forward',
      keyHint: ['⌘', ']'],
      matches: matchesLayerKey('BracketRight', false),
      guard: () => hasSelection && canEdit,
      action: () => moveSelectionInStack('forward'),
    },
    {
      id: 'carousel.layer-backward',
      description: 'Send backward',
      keyHint: ['⌘', '['],
      matches: matchesLayerKey('BracketLeft', false),
      guard: () => hasSelection && canEdit,
      action: () => moveSelectionInStack('backward'),
    },
  ]
  useKeymap([
    // Every binding but the nudge ends an open nudge burst before it acts, so
    // the burst is its own undo step and Cmd+Z right after it undoes it.
    ...bindings.map((binding): KeyBinding => ({
      ...binding,
      // A dialog of the host's holds the key as the editor's own windows do:
      // not claimed, so the page keeps it.
      guard: () => !hostDialogOpen() && (binding.guard?.() ?? true),
      action: (e) => {
        flushNudge()
        binding.action(e)
      },
    })),
    {
      // Arrows move the selection 1 px, Shift+arrow 10; a held key repeats.
      id: 'carousel.nudge',
      description: 'Nudge the selection',
      keyHint: ['←', '↑', '↓', '→'],
      matches: (e) => nudgeOf(e) !== null,
      guard: () => !hostDialogOpen() && hasSelection && canEdit,
      action: (e) => {
        const step = nudgeOf(e)
        if (step) nudgeSelection(step.dx, step.dy)
      },
      paletteHidden: true,
    },
  ], { modalOpen })

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

  /** A failure the editor does not draw itself: told to the host's `onError`,
   *  else logged. Never a system alert. */
  function reportError(title: string, e: unknown) {
    const notice = { title, detail: e instanceof Error ? e.message : String(e) }
    if (onError) onError(notice)
    else console.error(`[CarouselEditor] ${notice.title}: ${notice.detail}`)
  }

  // Render saves the project as final, then opens. A save that fails or never
  // answers ends here: the host is told (`onError`) and Render is back. A crop
  // in progress is applied first, so the render has it (§556 M4).
  async function handleRender() {
    setRendering(true)
    try {
      await withTimeout(leaveCrop('apply').then(() => state.setStatus('final')), renderSaveTimeoutMs)
      setRenderOpen(true)
    } catch (e) {
      reportError("Couldn't start the render", e)
    } finally {
      setRendering(false)
    }
  }

  // §448: a host that draws Export in its own header takes this trigger and
  // the toolbar button is not drawn. A ref keeps the trigger stable while it
  // always runs the latest handleRender (pending/empty projects are no-ops).
  const handleRenderRef = useRef(handleRender)
  handleRenderRef.current = handleRender
  const canRenderRef = useRef(false)
  canRenderRef.current = project.status !== 'pending' && slides.length > 0
  const openRender = useCallback(() => {
    if (canRenderRef.current) void handleRenderRef.current()
  }, [])
  useEffect(() => { onProvideRenderTrigger?.(openRender) }, [onProvideRenderTrigger, openRender])

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
    if (slides.length === 0) {
      // Every slide went, and a crop on one of them with its image: nothing is
      // written, and the canvas that would end it is gone too.
      if (cropElementIdRef.current) void leaveCrop('discard')
      return
    }
    const stillExists = selectedSlideId && slides.some(s => s.id === selectedSlideId)
    if (!stillExists) {
      // A crop on the slide that is gone went with its image: nothing is written.
      applyCrop()
      setSelectedSlideId(slides[0].id)
      setSelectedElementId(null)
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
  // A crop in progress is applied first (§556 M4): its own undo step, before
  // the one these add.
  function handleAddSlide() {
    applyCrop()
    const slide = makeSlide()
    void state.addSlide(slide, selectedSlideId ?? undefined)
    setSelectedSlideId(slide.id)
    setSelectedElementId(null)
  }
  function handleDuplicateSlide(id: string) {
    // The crop lands before the copy is made, so the copy has it too.
    if (cropElementId) flushSync(applyCrop)
    const src = slidesRef.current.find(s => s.id === id)
    if (!src) return
    const clone: Slide = { ...src, id: crypto.randomUUID(), elements: src.elements.map(cloneElement) }
    void state.duplicateSlide(id, clone)
    setSelectedSlideId(clone.id)
    setSelectedElementId(null)
  }
  function handleDeleteSlide(id: string) {
    void state.removeSlide(id)
    if (selectedSlideId === id) {
      setSelectedElementId(null)
      // A crop on it goes with it, unwritten.
      void leaveCrop('discard')
    }
  }
  function handleReorderSlides(fromIdx: number, toIdx: number) {
    void state.reorderSlides(fromIdx, toIdx)
  }

  // ── Element handlers ──
  // Each new element is selected, so a crop in progress is applied first, as
  // its own undo step (§556 M4). An add that took time (an upload, an AI image)
  // may land after the person has gone to another slide: it is added to its own
  // slide, and their selection and crop there are theirs.
  function handleAddElement(slideId: string, element: CarouselElement) {
    const onShow = selectedSlideIdRef.current === slideId
    if (onShow) applyCrop()
    void state.addElement(slideId, element)
    if (onShow) setSelectedElementId(element.id)
  }
  function handleDeleteElement(slideId: string, elementId: string) {
    void state.removeElement(slideId, elementId)
    setSelectedElementId(null)
    // A crop on it goes with it, unwritten.
    if (cropElementId === elementId) void leaveCrop('discard')
  }
  function handleDuplicateElement(slideId: string, elementId: string) {
    // The crop lands before the copy is made, so the copy has it too.
    if (cropElementId) flushSync(applyCrop)
    const slide = slidesRef.current.find(s => s.id === slideId)
    const src = slide?.elements.find(el => el.id === elementId)
    if (!src) return
    const clone = { ...cloneElement(src), x: src.x + COPY_OFFSET, y: src.y + COPY_OFFSET }
    void state.duplicateElement(slideId, elementId, clone)
    setSelectedElementId(clone.id)
  }
  function handleReorderElement(slideId: string, elementId: string, direction: 'forward' | 'backward') {
    void state.reorderElement(slideId, elementId, direction)
  }

  // Replace image (§556 M5): the file goes into the project, the new image's
  // size is read, and the source is swapped in ONE write (one save, one undo
  // step) that keeps the box: x, y, w, h and rotation stay, `mediaId` goes, and
  // the crop is the centred region of the new image with the box's aspect, so
  // the box stays filled. No crop when the size cannot be read or the shapes
  // already match.
  async function handleReplaceImage(slideId: string, elementId: string, file: File) {
    const imageNow = () => {
      const el = slidesRef.current.find(s => s.id === slideId)?.elements.find(e => e.id === elementId)
      return el?.type === 'image' ? el : undefined
    }
    const start = imageNow()
    if (!start) return
    let src: string
    try {
      src = await adapter.uploadFile(file, project.id, 'picker')
    } catch (e) {
      reportError("Couldn't replace the image", e)
      return
    }
    // Read through the adapter's own URL for the new source. The element built
    // here has no `mediaId`: that named the old file.
    let size: ImageSize | null = null
    try {
      size = await loadImageNaturalSize(adapter.resolveImageSrc({
        id: start.id, type: 'image', src, x: start.x, y: start.y, w: start.w, h: start.h, rotation: start.rotation,
      }))
    } catch {
      // A resolver that throws: the size cannot be read.
    }
    // The upload and the load took time. Write only if the editor is still up
    // and the image still there, cropped for the box it has now.
    const live = imageNow()
    if (!mountedRef.current || !live) return
    const crop = size ? coverCrop(live.w, live.h, size.width, size.height) : undefined
    // A save that fails is rolled back and shown by `state.lastError`.
    await state.replaceImage(slideId, elementId, { src, crop }).catch(() => {})
  }

  // ── Images onto the canvas (§556 M7) ──
  // An image dropped on the canvas (from the host's Media panel, or files from
  // the OS) and the host's `addImage` each put images on a slide, shaped like
  // themselves (`newImageElement`). Several go in ONE slide write, so one undo
  // step takes them all back. Only a slide on show, in a project that can be
  // edited, and not in crop mode: the image being cropped keeps the selection.
  const canAddImages = slideLive && canEdit
  const selectedSlideIdRef = useRef(selectedSlideId)
  selectedSlideIdRef.current = selectedSlideId

  /** Adds an image to `slideId` for each source, a function that gives the
   *  image's host path (an upload, or a path the host already named), centred
   *  on `at` (slide units) or on the slide. Each one after the first sits 20 px
   *  further down and right. The new images become the selection, unless the
   *  person has gone to another slide or into crop mode meanwhile. One that
   *  cannot be uploaded is reported once and the rest are still added. */
  async function addImages(slideId: string, sources: Array<() => Promise<string>>, at?: { x: number; y: number }) {
    const resolution = project.settings.resolution as [number, number]
    const settled = await Promise.allSettled(
      sources.map(async (source) => newImageElement(adapter, resolution, await source(), at)),
    )
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) reportError("Couldn't add the image", failed.reason)
    const added = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))

    // The uploads and size reads took time. Write only if the editor is still
    // up and the slide still there, onto the elements it has now.
    const slide = slidesRef.current.find((s) => s.id === slideId)
    if (!mountedRef.current || !slide || added.length === 0) return
    // An arrow-key nudge still open would fold into this edit's undo step.
    flushNudge()
    const placed = added.map((el, i) => ({ ...el, x: el.x + i * COPY_OFFSET, y: el.y + i * COPY_OFFSET }))
    const saved = state.editElements(slideId, (els) => [...els, ...placed])
    // Selected, unless the user has gone to another slide meanwhile, or into
    // crop mode: their selection is theirs, and moving it off the image being
    // cropped would leave the crop on one image and the selection on another.
    if (selectedSlideIdRef.current === slideId && !cropElementIdRef.current) setSelectedElementIds(placed.map((el) => el.id))
    // A save that fails is rolled back and shown by `state.lastError`.
    await saved.catch(() => {})
  }

  /** The host's `addImage`: the image goes to the slide selected now, at its centre. */
  async function addImage(src: string) {
    if (!selectedSlide || !canAddImages) return
    await addImages(selectedSlide.id, [() => Promise.resolve(src)])
  }

  // Host api: handed up once (it is stable, and always runs the latest
  // `addImage`) and withdrawn with null on unmount, like the notes api.
  const addImageRef = useRef(addImage)
  addImageRef.current = addImage
  const carouselApi = useMemo<CarouselApi>(() => ({ addImage: (src) => addImageRef.current(src) }), [])
  useEffect(() => {
    if (!onProvideCarouselApi) return
    onProvideCarouselApi(carouselApi)
    return () => onProvideCarouselApi(null)
  }, [onProvideCarouselApi, carouselApi])

  // A host image (`IMAGE_DND_MIME`) is believed only while a drag that began in
  // this document is under way. Any other page or app can put the same type on a
  // drag, and its `src` (a remote address, or any local path) would be stored in
  // the project and fetched. A dragstart in the document is put on record; a
  // dragend or a drop clears it (the drop in the bubble phase, after the canvas
  // has read it). Files from the OS are not affected.
  const pageDragRef = useRef<Event | null>(null)
  useEffect(() => {
    const begin = (e: Event) => { pageDragRef.current = e }
    const end = () => { pageDragRef.current = null }
    document.addEventListener('dragstart', begin, true)
    document.addEventListener('dragend', end, true)
    document.addEventListener('drop', end)
    return () => {
      document.removeEventListener('dragstart', begin, true)
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('drop', end)
    }
  }, [])
  /** Whether a drag that began in this document is under way. A dragstart that
   *  was cancelled (a note bubble cancels its own) starts no drag, so no dragend
   *  would ever end it: it does not count. */
  const pageDragOn = () => pageDragRef.current !== null && !pageDragRef.current.defaultPrevented

  /** Whether a drag with these `types` is of the canvas's kind: a host image
   *  from a drag that began in this page, or files, which it uploads.
   *  `getData` is unreadable until the drop, so only `types` can say. */
  function isImageDrag(types: ArrayLike<string> | undefined): boolean {
    if (!types) return false
    const list = Array.from(types)
    return (pageDragOn() && list.includes(IMAGE_DND_MIME)) || (list.includes('Files') && typeof adapter.uploadFile === 'function')
  }

  /** dragenter and dragover: an image drag the canvas can take now gets a copy
   *  cursor, and the browser a drop; any other drag is left alone. */
  function handleCanvasDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!canAddImages || !isImageDrag(e.dataTransfer?.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  /** A drop on the canvas: the host's image (`IMAGE_DND_MIME`) if it carries
   *  one, else the image files in it, centred on where it fell. */
  function handleCanvasDrop(e: React.DragEvent<HTMLDivElement>) {
    const data = e.dataTransfer
    if (!data || !isImageDrag(data.types)) return
    // Whatever happens next, the browser must not also open what was dropped.
    e.preventDefault()
    if (!selectedSlide || !canAddImages) return
    // A DataTransfer can only be read during its event. A payload from a drag
    // that did not begin in this page is not believed.
    const src = pageDragOn() ? hostImageSrc(data) : null
    const sources = src !== null
      ? [() => Promise.resolve(src)]
      : Array.from(data.files ?? []).filter(isImageFile).map((file) => () => adapter.uploadFile(file, project.id, 'drop'))
    if (sources.length === 0) return

    // Where it fell, in slide units: the canvas draws the slide at `canvasScale`.
    const rect = e.currentTarget.getBoundingClientRect()
    const at = canvasScale > 0
      ? { x: (e.clientX - rect.left) / canvasScale, y: (e.clientY - rect.top) / canvasScale }
      : undefined
    void addImages(selectedSlide.id, sources, at)
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

  const selectedElement = selectedSlide?.elements.find(el => el.id === selectedElementId)

  // Notify the host of selection changes so it can drive selection-aware chrome
  // (e.g. a regen action in a toolbar slot). Fires with one element or null:
  // with several selected, the last one clicked.
  const reportedElement = selectedElements.length > 0 ? selectedElements[selectedElements.length - 1] : null
  useEffect(() => {
    onSelectionChange?.(reportedElement)
  }, [reportedElement, onSelectionChange])

  // Shift-click (§156): add the element to the selection, or take it out.
  // An armed note pin ignores it.
  const toggleSelect = useCallback((id: string) => {
    if (armedRef.current) return
    setSelectedElementIds(ids => (ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]))
  }, [])

  // Align several selected elements to the box they cover: moves only, one save
  // and one undo step for the lot.
  function handleAlignSelection(patches: Array<{ id: string } & ({ x: number } | { y: number })>) {
    if (!selectedSlide) return
    const moves = patches.flatMap(p => {
      const el = selectedSlide.elements.find(e => e.id === p.id)
      if (!el) return []
      const x = 'x' in p ? p.x : el.x
      const y = 'y' in p ? p.y : el.y
      return x === el.x && y === el.y ? [] : [{ id: el.id, x, y }]
    })
    if (moves.length === 0) return
    const slideId = selectedSlide.id
    void (async () => {
      for (const m of moves) await state.moveElement(slideId, m.id, m.x, m.y)
      await state.commit()
    })()
  }

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
        onSelect={id => { applyCrop(); setSelectedSlideId(id); setSelectedElementId(null) }}
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
              onClick={() => undo()}
              disabled={!state.canUndo && !cropElementId}
              className="flex items-center justify-center p-2 rounded-md border border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--editor-surface)_80%,transparent)] text-[var(--editor-text)] transition-colors hover:border-[var(--editor-accent)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Undo (${shortcutText(['⌘', 'Z'])})`}
              aria-label="Undo"
            >
              <Undo2 size={18} />
            </button>
            <button
              onClick={() => redo()}
              disabled={!state.canRedo || !!cropElementId}
              className="flex items-center justify-center p-2 rounded-md border border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--editor-surface)_80%,transparent)] text-[var(--editor-text)] transition-colors hover:border-[var(--editor-accent)] hover:bg-[var(--editor-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
              title={`Redo (${shortcutText(['⌘', '⇧', 'Z'])})`}
              aria-label="Redo"
            >
              <Redo2 size={18} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {slots?.toolbarActions}
            {!onProvideRenderTrigger && <button
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
            </button>}
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
                onSelect={id => { if (cropElementId && id !== cropElementId) applyCrop(); setSelectedElementId(id) }}
                selectedElementIds={liveSelectedIds}
                onToggleSelect={toggleSelect}
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
                onEnterCrop={enterCrop}
                cropControlRef={cropControlRef}
                hiddenElementIds={hiddenElementIds}
                onDragEnter={handleCanvasDragOver}
                onDragOver={handleCanvasDragOver}
                onDrop={handleCanvasDrop}
              >
                {canvasPins.length > 0 && <NotePinLayer pins={canvasPins} pinDisplay={pinDisplay} onPinClick={onPinClick} />}
                {armedSlideId === selectedSlide.id && <NoteArmLayer layerRef={armLayerRef} onPlace={placeArmedNote} />}
              </SlideCanvas>
            </div>
            <div className="flex-shrink-0 flex items-center justify-center gap-1.5 text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] max-w-md">
              <span className="text-center">
                Drag to reposition, resize/rotate via handles, double-click text to edit or an image to crop. {shortcutText(['⌘', 'Z'])} to undo.
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
                onOverlayPickerOpenChange={setOverlayPickerOpen}
              />
            </div>
          )}
          <SlidePropertyPanel
            project={project}
            slide={selectedSlide}
            element={selectedElement}
            selection={selectedElements}
            onAlignSelection={handleAlignSelection}
            adapter={adapter}
            onSlideChange={handleSlideChange}
            onElementChange={handlePanelElementChange}
            onDeleteSlide={handleDeleteSlide}
            onDuplicateSlide={handleDuplicateSlide}
            onDeleteElement={handleDeleteElement}
            onDuplicateElement={handleDuplicateElement}
            onReorderElement={handleReorderElement}
            onEnterCrop={(_slideId, elementId) => enterCrop(elementId)}
            onReplaceImage={state.isEditingAllowed ? handleReplaceImage : undefined}
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

import { useEffect, useRef, useState } from 'react'
import { RefreshCw, AlertCircle, Download } from 'lucide-react'
import { api } from '@/lib/api'
import type { Project, Slide, CarouselElement } from '@/lib/types/schema'
import SlideCanvas from './SlideCanvas'
import SlidePropertyPanel from './SlidePropertyPanel'
import AssetsPanel from '@/components/AssetsPanel'
import CarouselRenderModal from '@/components/CarouselRenderModal'
import { Button } from '@/components/ui/button'

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
  logMessage?: string | null
}

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
    <div className="w-56 flex-shrink-0 flex flex-col border-r border-gray-800 bg-gray-950 overflow-y-auto">
      <div className="px-3 py-2 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Slides</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2 flex flex-col gap-2 px-2">
        {slides.map((slide, idx) => (
          <div
            key={slide.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={e => handleDragOver(e, idx)}
            onDrop={() => handleDrop(idx)}
            onDragEnd={handleDragEnd}
            onClick={() => onSelect(slide.id)}
            className={`group relative cursor-pointer rounded overflow-hidden border transition-colors ${
              selectedSlideId === slide.id
                ? 'border-blue-500'
                : dragOverIdx === idx
                ? 'border-blue-400 opacity-70'
                : 'border-gray-700 hover:border-gray-500'
            }`}
            style={{ width: THUMB_W, height: thumbH }}
          >
            <SlideCanvas
              slide={slide}
              width={w}
              height={h}
              interactive={false}
              scale={scale}
            />
            {/* Slide number */}
            <div className="absolute bottom-1 left-1 text-xs text-white bg-black/50 px-1 rounded">
              {idx + 1}
            </div>
            {/* Hover actions */}
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
        ))}
      </div>
      <div className="p-2 border-t border-gray-800">
        <Button size="sm" variant="outline" onClick={onAdd} className="w-full text-xs">
          + Add Slide
        </Button>
      </div>
    </div>
  )
}

// ── CarouselEditor ────────────────────────────────────────────────────────────

function deepCloneElement(el: CarouselElement): CarouselElement {
  if (el.type === 'overlay') {
    return {
      ...el,
      id: crypto.randomUUID(),
      overlay: {
        template: el.overlay.template,
        props: { ...el.overlay.props }, // shallow clone is sufficient — prop values are primitives/strings
      },
    }
  }
  return { ...el, id: crypto.randomUUID() }
}

function makeSlide(): Slide {
  return {
    id: crypto.randomUUID(),
    base_color: '#ffffff',
    elements: [],
  }
}

export default function CarouselEditor({ project, onProjectChange, logMessage }: Props) {
  const slides = project.slides ?? []

  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(
    slides[0]?.id ?? null
  )
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)

  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshState, setRefreshState] = useState<'idle' | 'err'>('idle')
  const [rendering, setRendering] = useState(false)
  const [renderOpen, setRenderOpen] = useState(false)

  async function handleRender() {
    setRendering(true)
    try {
      const final = { ...project, status: 'final' as const }
      await api.saveProject(project.id, final)
      onProjectChange(final)
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
      api.getProject(project.id),
      new Promise(r => setTimeout(r, 1000)),
    ])
    setRefreshing(false)
    if (result.status === 'fulfilled') {
      onProjectChange(result.value)
    } else {
      console.error(result.reason)
      setRefreshState('err')
      setTimeout(() => setRefreshState('idle'), 2500)
    }
  }

  useEffect(() => {
    api.getInfo().then(info => setSkillPath(info.root_skill_path)).catch(() => {})
  }, [])

  // Auto-select the first slide when:
  // - the page loaded empty (pending) and slides arrived via SSE, or
  // - the previously selected slide was deleted / no longer exists in the project.
  // The initial useState is a one-shot at mount, so we need this to react to live updates.
  useEffect(() => {
    if (slides.length === 0) return
    const stillExists = selectedSlideId && slides.some(s => s.id === selectedSlideId)
    if (!stillExists) {
      setSelectedSlideId(slides[0].id)
      setSelectedElementId(null)
    }
  }, [slides, selectedSlideId])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingProjectRef = useRef<Project | null>(null)
  const initialSlideCreatedRef = useRef(false)

  // Auto-create first slide if empty — gated by ref to survive StrictMode double-invoke.
  // Skip while pending so the agent gets to populate slides; we only want to scaffold
  // a starter slide for non-pending projects that ended up empty.
  useEffect(() => {
    if (initialSlideCreatedRef.current) return
    if (project.status === 'pending') return
    if ((project.slides ?? []).length === 0) {
      initialSlideCreatedRef.current = true
      const slide = makeSlide()
      const next: Project = { ...project, slides: [slide] }
      onProjectChange(next)
      api.saveProject(project.id, next).catch(console.error)
      setSelectedSlideId(slide.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function saveDebounced(next: Project) {
    pendingProjectRef.current = next
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      api.saveProject(next.id, next).catch(console.error)
      pendingProjectRef.current = null
      debounceRef.current = null
    }, 100)
  }

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        const pending = pendingProjectRef.current
        if (pending) {
          api.saveProject(pending.id, pending).catch(console.error)
        }
      }
    }
  }, [])

  function saveImmediate(next: Project) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    api.saveProject(next.id, next).catch(console.error)
  }

  function mutate(nextSlides: Slide[], immediate = false) {
    const next: Project = { ...project, slides: nextSlides }
    onProjectChange(next)
    if (immediate) saveImmediate(next)
    else saveDebounced(next)
  }

  // ── Slide handlers ──

  function handleAddSlide() {
    const slide = makeSlide()
    const next = [...slides, slide]
    mutate(next, true)
    setSelectedSlideId(slide.id)
    setSelectedElementId(null)
  }

  function handleDuplicateSlide(id: string) {
    const src = slides.find(s => s.id === id)
    if (!src) return
    const clone: Slide = {
      ...src,
      id: crypto.randomUUID(),
      elements: src.elements.map(deepCloneElement),
    }
    const idx = slides.findIndex(s => s.id === id)
    const next = [...slides.slice(0, idx + 1), clone, ...slides.slice(idx + 1)]
    mutate(next, true)
    setSelectedSlideId(clone.id)
    setSelectedElementId(null)
  }

  function handleDeleteSlide(id: string) {
    const next = slides.filter(s => s.id !== id)
    mutate(next, true)
    if (selectedSlideId === id) {
      setSelectedSlideId(next[0]?.id ?? null)
      setSelectedElementId(null)
    }
  }

  function handleReorderSlides(fromIdx: number, toIdx: number) {
    const next = [...slides]
    const [removed] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, removed)
    mutate(next, true)
  }

  function handleUpdateSlide(id: string, patch: Partial<Slide>) {
    const next = slides.map(s => s.id === id ? { ...s, ...patch } : s)
    mutate(next, false)
  }

  // ── Element handlers ──

  function handleUpdateElement(slideId: string, elementId: string, patch: Partial<CarouselElement>) {
    const next = slides.map(s => {
      if (s.id !== slideId) return s
      return {
        ...s,
        elements: s.elements.map(el =>
          el.id === elementId ? { ...el, ...patch } as CarouselElement : el
        ),
      }
    })
    mutate(next, false)
  }

  function handleDeleteElement(slideId: string, elementId: string) {
    const next = slides.map(s => {
      if (s.id !== slideId) return s
      return { ...s, elements: s.elements.filter(el => el.id !== elementId) }
    })
    mutate(next, true)
    setSelectedElementId(null)
  }

  function handleDuplicateElement(slideId: string, elementId: string) {
    const slide = slides.find(s => s.id === slideId)
    if (!slide) return
    const src = slide.elements.find(el => el.id === elementId)
    if (!src) return
    const baseClone = deepCloneElement(src)
    const clone: CarouselElement = { ...baseClone, x: src.x + 20, y: src.y + 20 }
    const next = slides.map(s => {
      if (s.id !== slideId) return s
      const idx = s.elements.findIndex(el => el.id === elementId)
      const elems = [...s.elements.slice(0, idx + 1), clone, ...s.elements.slice(idx + 1)]
      return { ...s, elements: elems }
    })
    mutate(next, true)
    setSelectedElementId(clone.id)
  }

  function handleReorderElement(slideId: string, elementId: string, direction: 'forward' | 'backward') {
    const next = slides.map(s => {
      if (s.id !== slideId) return s
      const elems = [...s.elements]
      const idx = elems.findIndex(el => el.id === elementId)
      if (idx < 0) return s
      const swapIdx = direction === 'forward' ? idx + 1 : idx - 1
      if (swapIdx < 0 || swapIdx >= elems.length) return s
      ;[elems[idx], elems[swapIdx]] = [elems[swapIdx], elems[idx]]
      return { ...s, elements: elems }
    })
    mutate(next, true)
  }

  const selectedSlide = slides.find(s => s.id === selectedSlideId)
  const selectedElement = selectedSlide?.elements.find(el => el.id === selectedElementId)

  const [w, h] = project.settings.resolution
  // Measure the center column so the canvas grows to fill it instead of being capped
  // at hardcoded constants. Subtract padding (p-6 = 24px each side) and a small
  // headroom for the hint text below the canvas.
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
  const PADDING = 48          // p-6 on the container
  const HINT_RESERVE = 36     // gap + hint text below canvas
  const availW = Math.max(0, canvasContainerSize.w - PADDING)
  const availH = Math.max(0, canvasContainerSize.h - PADDING - HINT_RESERVE)
  const canvasScale = Math.min(availW / w, availH / h, 1)

  const assetsPanelOnChange = async (next: import('@/lib/types/schema').Asset[]) => {
    const updated = { ...project, assets: next }
    onProjectChange(updated)
    await api.saveProject(project.id, updated)
  }

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {/* Left: Slide grid */}
      <SlideGrid
        project={project}
        slides={slides}
        selectedSlideId={selectedSlideId}
        onSelect={id => { setSelectedSlideId(id); setSelectedElementId(null) }}
        onAdd={handleAddSlide}
        onDuplicate={handleDuplicateSlide}
        onDelete={handleDeleteSlide}
        onReorder={handleReorderSlides}
      />

      {/* Center: Canvas — replaced by waiting overlay while pending */}
      <div ref={canvasContainerRef} className="relative flex-1 flex flex-col items-center justify-center gap-4 overflow-hidden p-6">
        {/* Refresh — top-left of the editing area */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className={`absolute top-3 left-3 z-30 flex items-center gap-2 px-3 py-2 rounded-md border transition-colors ${
            refreshState === 'err'
              ? 'text-red-300 border-red-500/40 bg-red-950/60 hover:bg-red-900/70'
              : 'text-gray-200 border-gray-700 bg-gray-900/80 hover:text-white hover:border-gray-500 hover:bg-gray-800'
          }`}
          title={refreshState === 'err' ? 'Refresh failed — check connection' : 'Refresh project'}
        >
          {refreshState === 'err'
            ? <AlertCircle size={18} />
            : <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />}
          <span className="text-xs font-medium">Refresh</span>
        </button>

        {/* Render — top-right of the editing area */}
        <button
          onClick={handleRender}
          disabled={rendering || project.status === 'pending' || (project.slides ?? []).length === 0}
          className="absolute top-3 right-3 z-30 flex items-center gap-2 px-3 py-2 rounded-md border border-blue-500/50 bg-blue-600/80 text-white hover:bg-blue-600 hover:border-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            project.status === 'pending'
              ? 'Wait for the agent to finish before rendering'
              : (project.slides ?? []).length === 0
              ? 'Add slides before rendering'
              : 'Render all slides as PNGs'
          }
        >
          <Download size={18} />
          <span className="text-xs font-medium">{rendering ? 'Starting…' : 'Render'}</span>
        </button>

        {project.status === 'pending' ? (
          <div className="flex flex-col items-center gap-6 text-center max-w-lg w-full">
            {!logMessage ? (
              /* Waiting for the user to kick off the agent */
              <>
                <div className="flex flex-col items-center gap-2">
                  <p className="text-white text-lg font-semibold">Message your agent to start</p>
                  <p className="text-gray-400 text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
                </div>

                {skillPath && (
                  <div className="w-full rounded-xl border-2 border-blue-400/50 bg-gray-900 p-5 flex flex-col gap-3 text-left shadow-lg shadow-blue-400/10">
                    <p className="text-blue-400 text-xs font-bold uppercase tracking-widest">Send this to your agent</p>
                    <div className="flex items-start justify-between bg-black/60 border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                      <span className="text-gray-200 text-[12px] leading-relaxed break-all">
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
                          copied
                            ? 'bg-green-700 text-green-200'
                            : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
                        }`}
                        title="Copy prompt"
                      >
                        {copied ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-gray-600 text-xs font-mono">project id: {project.id}</p>
              </>
            ) : (
              /* Agent is working — show latest log line */
              <>
                <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
                <p className="text-gray-300 text-sm">
                  {(project.assets?.length ?? 0) > 0 && (
                    <><span className="text-white font-medium">{project.assets!.length} asset{project.assets!.length > 1 ? 's' : ''}</span>{' attached. '}</>
                  )}
                  Agent is working:
                </p>
                <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
                  → {logMessage}
                </p>
                <p className="text-gray-700 text-xs font-mono">project id: {project.id}</p>
              </>
            )}
          </div>
        ) : selectedSlide ? (
          <>
            <div className="flex-shrink-0" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.08)' }}>
              <SlideCanvas
                slide={selectedSlide}
                width={w}
                height={h}
                interactive
                selectedElementId={selectedElementId}
                onSelect={setSelectedElementId}
                onElementChange={(id, patch) => {
                  if (selectedSlideId) handleUpdateElement(selectedSlideId, id, patch)
                }}
                scale={canvasScale}
              />
            </div>
            <p className="flex-shrink-0 text-xs text-gray-500 text-center max-w-md">
              Drag elements to reposition. Ask the agent for any other changes.
            </p>
          </>
        ) : (
          <div className="text-gray-600 text-sm">No slides yet. Add one in the left panel.</div>
        )}
      </div>

      {/* Right: Property panel + assets */}
      <div className="flex flex-col overflow-hidden">
        <SlidePropertyPanel
          project={project}
          slide={selectedSlide}
          element={selectedElement}
          onSlideChange={patch => { if (selectedSlideId) handleUpdateSlide(selectedSlideId, patch) }}
          onElementChange={patch => {
            if (selectedSlideId && selectedElementId) {
              handleUpdateElement(selectedSlideId, selectedElementId, patch)
            }
          }}
          onDeleteSlide={handleDeleteSlide}
          onDuplicateSlide={handleDuplicateSlide}
          onDeleteElement={handleDeleteElement}
          onDuplicateElement={handleDuplicateElement}
          onReorderElement={handleReorderElement}
        />
        <div className="border-t border-gray-800 flex flex-col overflow-hidden" style={{ minHeight: 180 }}>
          <AssetsPanel
            assets={project.assets ?? []}
            onChange={assetsPanelOnChange}
          />
        </div>
      </div>

      {renderOpen && (
        <CarouselRenderModal
          projectId={project.id}
          slidesCount={(project.slides ?? []).length}
          resolution={project.settings.resolution as [number, number]}
          onClose={() => setRenderOpen(false)}
          onCancel={() => setRenderOpen(false)}
        />
      )}
    </div>
  )
}

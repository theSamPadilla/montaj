import { useState, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import type { Project, VisualItem, RegenQueueEntry } from '@/lib/types/schema'

interface Props {
  project: Project
  clip: VisualItem
  onClose: () => void
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}

const MODELS = ['kling-v3-omni', 'kling-video-o1'] as const
const MIN_WINDOW = 3
const MAX_WINDOW = 15

export default function SubcutRegenTool({ project, clip, onClose, onProjectChange, onSave }: Props) {
  const gen = clip.generation!
  const clipInPoint = clip.inPoint ?? 0
  const clipOutPoint = clip.outPoint ?? (clip.end - clip.start)
  const clipSourceDuration = clipOutPoint - clipInPoint

  // Subrange in source-seconds
  const [rangeStart, setRangeStart] = useState(clipInPoint)
  const [rangeEnd, setRangeEnd] = useState(Math.min(clipInPoint + 5, clipOutPoint))
  const [showModal, setShowModal] = useState(false)

  // Form state
  const [prompt, setPrompt] = useState(gen.prompt ?? '')
  const [duration, setDuration] = useState(Math.min(Math.max(MIN_WINDOW, Math.round(rangeEnd - rangeStart)), MAX_WINDOW))
  const [model, setModel] = useState(gen.model ?? 'kling-v3-omni')
  const [selectedRefs, setSelectedRefs] = useState<string[]>(gen.refImages ?? [])
  const [useFirstFrame, setUseFirstFrame] = useState(false)
  const [useLastFrame, setUseLastFrame] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Range picker drag state
  const barRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<'start' | 'end' | 'body' | null>(null)
  const dragStartXRef = useRef(0)
  const dragStartValRef = useRef({ start: 0, end: 0 })

  const sourceToFraction = useCallback((s: number) => (s - clipInPoint) / clipSourceDuration, [clipInPoint, clipSourceDuration])

  function clampRange(start: number, end: number): [number, number] {
    start = Math.round(Math.max(clipInPoint, start))
    end = Math.round(Math.min(clipOutPoint, end))
    const len = end - start
    if (len < MIN_WINDOW) {
      if (end + (MIN_WINDOW - len) <= clipOutPoint) end = start + MIN_WINDOW
      else start = end - MIN_WINDOW
    }
    if (end - start > MAX_WINDOW) {
      end = start + MAX_WINDOW
    }
    return [Math.max(clipInPoint, start), Math.min(clipOutPoint, end)]
  }

  function handlePointerDown(e: React.PointerEvent, edge: 'start' | 'end' | 'body') {
    e.preventDefault()
    e.stopPropagation()
    if (!barRef.current) return
    draggingRef.current = edge
    dragStartXRef.current = e.clientX
    dragStartValRef.current = { start: rangeStart, end: rangeEnd }
    const bar = barRef.current

    function onMove(me: PointerEvent) {
      const rect = bar.getBoundingClientRect()
      const dx = (me.clientX - dragStartXRef.current) / rect.width
      const dSrc = dx * clipSourceDuration

      if (edge === 'start') {
        const [s, e] = clampRange(dragStartValRef.current.start + dSrc, dragStartValRef.current.end)
        setRangeStart(s)
        setRangeEnd(e)
      } else if (edge === 'end') {
        const [s, e] = clampRange(dragStartValRef.current.start, dragStartValRef.current.end + dSrc)
        setRangeStart(s)
        setRangeEnd(e)
      } else {
        const len = dragStartValRef.current.end - dragStartValRef.current.start
        let newStart = dragStartValRef.current.start + dSrc
        newStart = Math.round(Math.max(clipInPoint, Math.min(clipOutPoint - len, newStart)))
        setRangeStart(newStart)
        setRangeEnd(newStart + len)
      }
    }

    function onUp() {
      draggingRef.current = null
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  function openModal() {
    setDuration(Math.min(Math.max(MIN_WINDOW, Math.round(rangeEnd - rangeStart)), MAX_WINDOW))
    setShowModal(true)
  }

  const validDurations = model === 'kling-video-o1' ? [5, 10] : undefined

  function handleModelChange(m: string) {
    setModel(m)
    if (m === 'kling-video-o1' && duration !== 5 && duration !== 10) {
      setDuration(duration <= 7 ? 5 : 10)
    }
  }

  function toggleRef(refId: string) {
    setSelectedRefs(prev =>
      prev.includes(refId) ? prev.filter(r => r !== refId) : [...prev, refId]
    )
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const entry: RegenQueueEntry = {
        id: `req-${Date.now()}`,
        clipId: clip.id,
        mode: 'subcut',
        subrange: { start: rangeStart, end: rangeEnd },
        prompt: prompt.trim(),
        refImages: selectedRefs,
        duration,
        useFirstFrame,
        useLastFrame,
        model,
        requestedAt: new Date().toISOString(),
      }
      const nextProject: Project = {
        ...project,
        regenQueue: [...(project.regenQueue ?? []), entry],
      }
      await onSave(nextProject)
      onProjectChange(nextProject)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const imageRefs = project.storyboard?.imageRefs ?? []
  const windowLen = Math.round(rangeEnd - rangeStart)

  return (
    <>
      {/* Range picker overlay — rendered inline in the timeline area */}
      <div className="border border-amber-500/40 bg-amber-950/20 rounded-md px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-amber-300 font-medium">Subcut regenerate — {clip.id}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={12} /></button>
        </div>

        {/* Range bar */}
        <div ref={barRef} className="relative h-6 bg-gray-800 rounded overflow-hidden cursor-default select-none">
          {/* Selected range fill */}
          <div
            className="absolute top-0 bottom-0 bg-amber-500/30"
            style={{
              left: `${sourceToFraction(rangeStart) * 100}%`,
              width: `${(sourceToFraction(rangeEnd) - sourceToFraction(rangeStart)) * 100}%`,
            }}
            onPointerDown={e => handlePointerDown(e, 'body')}
          />
          {/* Start handle */}
          <div
            className="absolute top-0 bottom-0 w-2 cursor-ew-resize bg-amber-400/60 hover:bg-amber-400 z-10"
            style={{ left: `calc(${sourceToFraction(rangeStart) * 100}% - 4px)` }}
            onPointerDown={e => handlePointerDown(e, 'start')}
          />
          {/* End handle */}
          <div
            className="absolute top-0 bottom-0 w-2 cursor-ew-resize bg-amber-400/60 hover:bg-amber-400 z-10"
            style={{ left: `calc(${sourceToFraction(rangeEnd) * 100}% - 4px)` }}
            onPointerDown={e => handlePointerDown(e, 'end')}
          />
        </div>

        <div className="flex items-center justify-between text-[10px] font-mono text-gray-500">
          <span>{rangeStart}s – {rangeEnd}s ({windowLen}s window)</span>
          <span className={windowLen >= MIN_WINDOW && windowLen <= MAX_WINDOW ? 'text-green-400' : 'text-red-400'}>
            {MIN_WINDOW}–{MAX_WINDOW}s OK
          </span>
        </div>

        <button
          onClick={openModal}
          disabled={windowLen < MIN_WINDOW || windowLen > MAX_WINDOW}
          className="self-start px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
        >
          Confirm range
        </button>
      </div>

      {/* Confirm modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-white">
                Subcut regenerate — {rangeStart}s to {rangeEnd}s ({windowLen}s)
              </h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 flex flex-col gap-4">
              {/* Parent prompt context */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Parent clip prompt (reference)</p>
                <p className="text-xs text-gray-500 bg-gray-950 border border-gray-800 rounded-md px-3 py-2 font-mono">
                  {gen.prompt}
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 mb-1 block">Prompt for this subcut</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500 resize-y"
                />
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Duration (s)</label>
                  {validDurations ? (
                    <div className="flex gap-2">
                      {validDurations.map(d => (
                        <button
                          key={d}
                          onClick={() => setDuration(d)}
                          className={`px-3 py-1.5 rounded border text-sm transition-colors ${
                            duration === d
                              ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                              : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                          }`}
                        >{d}s</button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="number"
                      value={duration}
                      onChange={e => setDuration(Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, parseInt(e.target.value) || MIN_WINDOW)))}
                      min={MIN_WINDOW}
                      max={MAX_WINDOW}
                      className="w-24 bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  )}
                  <p className="text-[10px] text-gray-500 mt-1">May differ from the {windowLen}s window — timeline will ripple.</p>
                </div>

                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Model</label>
                  <select
                    value={model}
                    onChange={e => handleModelChange(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  >
                    {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              {imageRefs.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Reference images</label>
                  <div className="flex flex-wrap gap-2">
                    {imageRefs.map(ref => {
                      const checked = selectedRefs.includes(ref.id)
                      return (
                        <button
                          key={ref.id}
                          onClick={() => toggleRef(ref.id)}
                          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                            checked
                              ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                              : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                          }`}
                        >
                          {ref.label} ({ref.id})
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Continuity toggles */}
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useFirstFrame}
                    onChange={e => setUseFirstFrame(e.target.checked)}
                    className="rounded border-gray-600"
                  />
                  Use first frame of subrange
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useLastFrame}
                    onChange={e => setUseLastFrame(e.target.checked)}
                    className="rounded border-gray-600"
                  />
                  Use last frame of subrange
                </label>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !prompt.trim()}
                  className="px-4 py-2 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  {submitting ? 'Queuing…' : 'Queue subcut regeneration'}
                </button>
                <button
                  onClick={() => setShowModal(false)}
                  className="text-sm text-gray-400 hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

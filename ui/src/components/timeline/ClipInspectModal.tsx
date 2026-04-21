import { useState } from 'react'
import { X, RefreshCw } from 'lucide-react'
import type { Project, RegenQueueEntry } from '@/lib/types/schema'

interface Props {
  project: Project
  clipId: string
  onClose: () => void
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}

const MODELS = ['kling-v3-omni', 'kling-video-o1'] as const

export default function ClipInspectModal({ project, clipId, onClose, onProjectChange, onSave }: Props) {
  const clip = (project.tracks?.[0] ?? []).find(c => c.id === clipId)
  const gen = clip?.generation
  const scene = project.storyboard?.scenes?.find(s => s.id === gen?.sceneId)
  const isAiVideo = project.projectType === 'ai_video'
  const canRegen = isAiVideo && !!gen

  const [regenMode, setRegenMode] = useState(false)
  const [prompt, setPrompt] = useState(gen?.prompt ?? '')
  const [duration, setDuration] = useState(gen?.duration ?? 5)
  const [model, setModel] = useState(gen?.model ?? 'kling-v3-omni')
  const [selectedRefs, setSelectedRefs] = useState<string[]>(gen?.refImages ?? [])
  const [submitting, setSubmitting] = useState(false)

  if (!clip || !gen) return null

  const durationMin = 3
  const durationMax = 15
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

  async function handleSubmitRegen() {
    setSubmitting(true)
    try {
      const entry: RegenQueueEntry = {
        id: `req-${Date.now()}`,
        clipId: clip!.id,
        mode: 'full',
        subrange: null,
        prompt: prompt.trim(),
        refImages: selectedRefs,
        duration,
        useFirstFrame: false,
        useLastFrame: false,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white">
            {regenMode ? 'Regenerate' : 'Generation details'} — {gen.sceneId ?? clip.id}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          {!regenMode ? (
            <>
              {/* Inspect view (read-only) */}
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">Prompt</p>
                <p className="text-sm text-gray-200 whitespace-pre-wrap bg-gray-950 border border-gray-800 rounded-md px-3 py-2 font-mono text-xs leading-relaxed">
                  {gen.prompt}
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                {gen.provider && (
                  <div>
                    <p className="text-xs text-gray-500">Provider</p>
                    <p className="text-sm text-gray-300">{gen.provider}</p>
                  </div>
                )}
                {gen.model && (
                  <div>
                    <p className="text-xs text-gray-500">Model</p>
                    <p className="text-sm text-gray-300">{gen.model}</p>
                  </div>
                )}
                {gen.duration != null && (
                  <div>
                    <p className="text-xs text-gray-500">Duration</p>
                    <p className="text-sm text-gray-300">{gen.duration}s</p>
                  </div>
                )}
                {gen.sceneId && (
                  <div>
                    <p className="text-xs text-gray-500">Scene</p>
                    <p className="text-sm text-gray-300">{gen.sceneId}</p>
                  </div>
                )}
              </div>

              {gen.refImages && gen.refImages.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-400 mb-1">Reference images</p>
                  <div className="flex flex-wrap gap-1">
                    {gen.refImages.map((refId: string, i: number) => {
                      const ref = imageRefs.find(r => r.id === refId)
                      return (
                        <span key={i} className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300">
                          {ref ? `${ref.label} (${refId})` : refId}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {scene && (
                <div>
                  <p className="text-xs font-medium text-gray-400 mb-1">Scene prompt (pre-composition)</p>
                  <p className="text-sm text-gray-400 bg-gray-950 border border-gray-800 rounded-md px-3 py-2 text-xs">
                    {scene.prompt}
                  </p>
                </div>
              )}

              {gen.attempts && gen.attempts.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-400 mb-1">Previous attempts ({gen.attempts.length})</p>
                  <div className="flex flex-col gap-1">
                    {gen.attempts.map((a: { ts?: string; prompt?: string }, i: number) => (
                      <div key={i} className="text-xs text-gray-500 bg-gray-950 border border-gray-800 rounded px-2 py-1">
                        {a.ts && <span className="text-gray-600">{new Date(a.ts).toLocaleString()} — </span>}
                        {a.prompt && <span className="font-mono">{a.prompt.slice(0, 100)}{a.prompt.length > 100 ? '…' : ''}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {canRegen && (
                <button
                  onClick={() => setRegenMode(true)}
                  className="flex items-center gap-2 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors w-fit mt-1"
                >
                  <RefreshCw size={14} />
                  Regenerate this clip
                </button>
              )}
            </>
          ) : (
            <>
              {/* Regen form */}
              <div>
                <label className="text-xs font-medium text-gray-400 mb-1 block">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
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
                              ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                              : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                          }`}
                        >{d}s</button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="number"
                      value={duration}
                      onChange={e => setDuration(Math.max(durationMin, Math.min(durationMax, parseInt(e.target.value) || durationMin)))}
                      min={durationMin}
                      max={durationMax}
                      className="w-24 bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  )}
                </div>

                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Model</label>
                  <select
                    value={model}
                    onChange={e => handleModelChange(e.target.value)}
                    className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                              ? 'border-blue-500 bg-blue-500/20 text-blue-300'
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

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSubmitRegen}
                  disabled={submitting || !prompt.trim()}
                  className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  {submitting ? 'Queuing…' : 'Queue regeneration'}
                </button>
                <button
                  onClick={() => setRegenMode(false)}
                  className="text-sm text-gray-400 hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

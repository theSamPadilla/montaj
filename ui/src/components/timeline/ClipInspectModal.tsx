import { useState } from 'react'
import { X, RefreshCw, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import type { Project, AudioTrack, RegenQueueEntry } from '@/lib/types/schema'

export type InspectTarget =
  | { kind: 'clip'; id: string }
  | { kind: 'audio'; id: string }

interface Props {
  project: Project
  target: InspectTarget
  onClose: () => void
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}

const MODELS = ['kling-v3-omni', 'kling-video-o1'] as const

function basename(path: string) {
  return path.split('/').pop() ?? path
}

function volumeToDb(v: number): string {
  if (v === 0) return '\u2212\u221E dB'
  return `${(20 * Math.log10(v)).toFixed(1)} dB`
}

/* ── Audio inspect branch ────────────────────────────────────── */

function AudioInspect({ project, trackId, onClose, onProjectChange, onSave }: {
  project: Project
  trackId: string
  onClose: () => void
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}) {
  const tracks = project.audio?.tracks ?? []
  const track = tracks.find(t => t.id === trackId)

  const [label, setLabel] = useState(track?.label ?? (track ? basename(track.src) : ''))
  const [start, setStart] = useState(track?.start ?? 0)
  const [end, setEnd] = useState(track?.end ?? 0)
  const [inPoint, setInPoint] = useState(track?.inPoint ?? 0)
  const [outPoint, setOutPoint] = useState(track?.outPoint ?? (track?.sourceDuration ?? ((track?.end ?? 0) - (track?.start ?? 0))))
  const [volume, setVolume] = useState(track?.volume ?? 1)
  const [muted, setMuted] = useState(track?.muted ?? false)
  const [duckingOpen, setDuckingOpen] = useState(false)
  const [duckingEnabled, setDuckingEnabled] = useState(track?.ducking?.enabled ?? false)
  const [duckingDepth, setDuckingDepth] = useState(track?.ducking?.depth ?? -12)
  const [duckingAttack, setDuckingAttack] = useState(track?.ducking?.attack ?? 0.3)
  const [duckingRelease, setDuckingRelease] = useState(track?.ducking?.release ?? 0.5)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  if (!track) return null

  const srcDur = track.sourceDuration ?? Infinity

  async function handleSave() {
    setSaving(true)
    try {
      const updated: AudioTrack = {
        ...track!,
        label: label.trim() || basename(track!.src),
        start,
        end,
        inPoint,
        outPoint,
        volume,
        muted,
        ducking: {
          enabled: duckingEnabled,
          depth: duckingDepth,
          attack: duckingAttack,
          release: duckingRelease,
        },
      }
      const nextProject: Project = {
        ...project,
        audio: {
          ...project.audio,
          tracks: (project.audio?.tracks ?? []).map(t => t.id === trackId ? updated : t),
        },
      }
      onProjectChange(nextProject)
      await onSave(nextProject)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    const nextProject: Project = {
      ...project,
      audio: {
        ...project.audio,
        tracks: (project.audio?.tracks ?? []).filter(t => t.id !== trackId),
      },
    }
    onProjectChange(nextProject)
    await onSave(nextProject)
    onClose()
  }

  const inputCls = 'bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <>
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-white">
          Audio track — {label || basename(track.src)}
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>
      <div className="px-5 py-4 flex flex-col gap-4">
        {/* Label */}
        <div>
          <label className="text-xs font-medium text-gray-400 mb-1 block">Label</label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            className={`w-full ${inputCls}`}
          />
        </div>

        {/* Source (read-only) */}
        <div>
          <label className="text-xs font-medium text-gray-400 mb-1 block">Source</label>
          <p className="text-xs text-gray-400 font-mono bg-gray-950 border border-gray-800 rounded-md px-3 py-2 break-all">
            {track.src}
          </p>
          {track.sourceDuration != null && (
            <p className="text-xs text-gray-500 mt-1">Duration: {track.sourceDuration.toFixed(2)}s</p>
          )}
        </div>

        {/* Start / End */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="text-xs font-medium text-gray-400 mb-1 block">Start (s)</label>
            <input
              type="number"
              step={0.01}
              value={start}
              onChange={e => {
                const v = parseFloat(e.target.value) || 0
                setStart(v)
              }}
              className={`w-full ${inputCls}`}
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-gray-400 mb-1 block">End (s)</label>
            <input
              type="number"
              step={0.01}
              value={end}
              onChange={e => {
                const v = parseFloat(e.target.value) || 0
                setEnd(v)
              }}
              className={`w-full ${inputCls}`}
            />
            {end <= start && (
              <p className="text-xs text-red-400 mt-1">End must be greater than start</p>
            )}
          </div>
        </div>

        {/* inPoint / outPoint */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="text-xs font-medium text-gray-400 mb-1 block">In point (s)</label>
            <input
              type="number"
              step={0.01}
              min={0}
              max={srcDur === Infinity ? undefined : srcDur}
              value={inPoint}
              onChange={e => {
                let v = parseFloat(e.target.value) || 0
                v = Math.max(0, Math.min(v, outPoint))
                setInPoint(v)
              }}
              className={`w-full ${inputCls}`}
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-gray-400 mb-1 block">Out point (s)</label>
            <input
              type="number"
              step={0.01}
              min={0}
              max={srcDur === Infinity ? undefined : srcDur}
              value={outPoint}
              onChange={e => {
                let v = parseFloat(e.target.value) || 0
                v = Math.max(inPoint, srcDur === Infinity ? v : Math.min(v, srcDur))
                setOutPoint(v)
              }}
              className={`w-full ${inputCls}`}
            />
          </div>
        </div>

        {/* Volume */}
        <div>
          <label className="text-xs font-medium text-gray-400 mb-1 block">
            Volume
            <span className="ml-2 text-xs font-mono text-gray-500">
              {volume.toFixed(2)} ({volumeToDb(volume)})
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
            className="w-full h-2 rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-runnable-track]:bg-gray-700
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full"
          />
        </div>

        {/* Muted */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={muted}
            onChange={e => setMuted(e.target.checked)}
            className="rounded border-gray-600 bg-gray-950 text-blue-500 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-300">Muted</span>
        </label>

        {/* Ducking */}
        <div className="border border-gray-800 rounded-lg overflow-hidden">
          <button
            onClick={() => setDuckingOpen(!duckingOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800/50 transition-colors"
          >
            {duckingOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-medium">Ducking</span>
            {duckingEnabled && <span className="text-xs text-blue-400 ml-auto">On</span>}
          </button>
          {duckingOpen && (
            <div className="px-3 pb-3 flex flex-col gap-3 border-t border-gray-800 pt-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={duckingEnabled}
                  onChange={e => setDuckingEnabled(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-950 text-blue-500 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-300">Enabled</span>
              </label>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Depth (dB)</label>
                  <input
                    type="number"
                    step={1}
                    value={duckingDepth}
                    onChange={e => setDuckingDepth(parseFloat(e.target.value) || -12)}
                    className={`w-full ${inputCls}`}
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Attack (s)</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    value={duckingAttack}
                    onChange={e => setDuckingAttack(Math.max(0, parseFloat(e.target.value) || 0))}
                    className={`w-full ${inputCls}`}
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-gray-400 mb-1 block">Release (s)</label>
                  <input
                    type="number"
                    step={0.05}
                    min={0}
                    value={duckingRelease}
                    onChange={e => setDuckingRelease(Math.max(0, parseFloat(e.target.value) || 0))}
                    className={`w-full ${inputCls}`}
                  />
                </div>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed">
                When enabled, this track automatically lowers in volume whenever a louder track is playing. Typical use: enable on music so it ducks under voiceover.
              </p>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving || end <= start}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {saving ? 'Saving\u2026' : 'Save'}
          </button>
          <button
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>

        {/* Delete */}
        <div className="border-t border-gray-800 pt-3">
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 text-sm font-medium transition-colors"
            >
              <Trash2 size={14} />
              Delete track
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-red-400">Delete this audio track?</span>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-sm text-gray-400 hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ── Clip inspect branch (existing) ─────────────────────────── */

function ClipInspect({ project, clipId, onClose, onProjectChange, onSave }: {
  project: Project
  clipId: string
  onClose: () => void
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}) {
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
  const [clipVolume, setClipVolume] = useState(clip?.volume ?? 1)
  const [clipMuted, setClipMuted] = useState(clip?.muted ?? false)
  const [savingVolume, setSavingVolume] = useState(false)

  if (!clip) return null

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

  async function handleSaveVolume() {
    setSavingVolume(true)
    try {
      const nextProject: Project = {
        ...project,
        tracks: (project.tracks ?? []).map(track =>
          track.map(item => item.id === clipId ? { ...item, volume: clipVolume, muted: clipMuted } : item)
        ),
      }
      onProjectChange(nextProject)
      await onSave(nextProject)
    } finally {
      setSavingVolume(false)
    }
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
    <>
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-white">
          {regenMode ? 'Regenerate' : 'Clip'} — {gen?.sceneId ?? clip.id}
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>
      <div className="px-5 py-4 flex flex-col gap-4">
        {/* Audio controls — always visible */}
        {clip.type === 'video' && (
          <div className="border border-gray-800 rounded-lg px-4 py-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-400">Clip audio</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clipMuted}
                  onChange={e => setClipMuted(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-950 text-blue-500 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-400">Muted</span>
              </label>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-400 mb-1 block">
                Volume
                <span className="ml-2 text-xs font-mono text-gray-500">
                  {clipVolume.toFixed(2)} ({volumeToDb(clipVolume)})
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={clipVolume}
                onChange={e => setClipVolume(parseFloat(e.target.value))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-runnable-track]:bg-gray-700
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full"
              />
            </div>
            <button
              onClick={handleSaveVolume}
              disabled={savingVolume}
              className="self-start px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              {savingVolume ? 'Saving\u2026' : 'Save audio settings'}
            </button>
          </div>
        )}

        {gen && !regenMode && (
          <>
            {/* Generation details (read-only) */}
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
                      {a.prompt && <span className="font-mono">{a.prompt.slice(0, 100)}{a.prompt.length > 100 ? '\u2026' : ''}</span>}
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
        )}
        {regenMode && gen && (
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
                {submitting ? 'Queuing\u2026' : 'Queue regeneration'}
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
    </>
  )
}

/* ── Main modal shell ────────────────────────────────────────── */

export default function ClipInspectModal({ project, target, onClose, onProjectChange, onSave }: Props) {
  // Gate check: don't render the modal shell if the target doesn't exist.
  if (target.kind === 'clip') {
    const clip = (project.tracks?.[0] ?? []).find(c => c.id === target.id)
    if (!clip) return null
  }
  if (target.kind === 'audio') {
    const track = (project.audio?.tracks ?? []).find(t => t.id === target.id)
    if (!track) return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {target.kind === 'clip' ? (
          <ClipInspect
            project={project}
            clipId={target.id}
            onClose={onClose}
            onProjectChange={onProjectChange}
            onSave={onSave}
          />
        ) : (
          <AudioInspect
            project={project}
            trackId={target.id}
            onClose={onClose}
            onProjectChange={onProjectChange}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  )
}

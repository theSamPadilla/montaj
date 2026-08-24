import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import type { Project, RegenQueueEntry } from '@/lib/types/schema'
import { trackItems } from '@/lib/types/schema'
import { cn } from '@/lib/utils'

export interface GenerationPanelProps {
  project: Project
  clipId: string
  onProjectChange: (p: Project) => void
  onSave: (p: Project) => Promise<unknown>
}

const MODELS = ['kling-v3-omni', 'kling-video-o1'] as const

// Matches @bycrux/editor's OverlayInspector chrome (var(--editor-*) tokens,
// same collapsible-section header, row rhythm, and control sizing) so this
// reads as part of the same right-hand panel rather than a modal squeezed
// into a sidebar column. `cn`/`inspectorInputClass`-equivalents aren't part
// of the package's public API, so the handful of shared classes below are
// copied rather than imported.
const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'
const LABEL_CLASS = 'text-[11px] font-medium text-[var(--editor-text)]/55 mb-1 block'
const READONLY_CLASS =
  'text-xs text-[var(--editor-text)]/80 whitespace-pre-wrap bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded-md px-2.5 py-2 leading-relaxed'
const INPUT_CLASS =
  'w-full rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2.5 py-1.5 text-sm text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)] focus:ring-1 focus:ring-[var(--editor-accent)]'
const CHIP_BASE = 'text-xs px-2.5 py-1 rounded border transition-colors'
const CHIP_ON = 'border-[var(--editor-accent)] bg-[var(--editor-accent)]/20 text-[var(--editor-accent)]'
const CHIP_OFF = 'border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/60 hover:border-[var(--editor-text)]/30'

/**
 * `<GenerationPanel>` — Montaj's AI-regeneration surface for a video clip,
 * rendered inside the editor's right-hand properties panel (beneath the
 * editor-owned clip properties — volume/mute/speed — via
 * `renderGenerationPanel`).
 *
 * Reads/writes `project.regenQueue` and `project.storyboard`: host-only
 * fields @bycrux/editor deliberately knows nothing about, which is why this
 * surface lives here rather than in the package. Renders nothing when the
 * clip isn't an ai_video generation (not an ai_video project, or the clip
 * has no frozen `generation` provenance) — the editor just shows clip
 * properties with no generation section in that case.
 */
export default function GenerationPanel({ project, clipId, onProjectChange, onSave }: GenerationPanelProps) {
  const clip = (trackItems(project)[0] ?? []).find(c => c.id === clipId)
  const gen = clip?.generation
  const scene = project.storyboard?.scenes?.find(s => s.id === gen?.sceneId)
  const isAiVideo = project.projectType === 'ai_video'
  const canRegen = isAiVideo && !!gen

  const [collapsed, setCollapsed] = useState(false)
  const [regenMode, setRegenMode] = useState(false)
  const [prompt, setPrompt] = useState(gen?.prompt ?? '')
  const [duration, setDuration] = useState(gen?.duration ?? 5)
  const [model, setModel] = useState(gen?.model ?? 'kling-v3-omni')
  const [selectedRefs, setSelectedRefs] = useState<string[]>(gen?.refImages ?? [])
  const [submitting, setSubmitting] = useState(false)

  if (!canRegen || !gen) return null

  const durationMin = 3
  const durationMax = 15
  const validDurations = model === 'kling-video-o1' ? [5, 10] : undefined
  const imageRefs = project.storyboard?.imageRefs ?? []

  function handleModelChange(m: string) {
    setModel(m)
    if (m === 'kling-video-o1' && duration !== 5 && duration !== 10) {
      setDuration(duration <= 7 ? 5 : 10)
    }
  }

  function toggleRef(refId: string) {
    setSelectedRefs(prev => (prev.includes(refId) ? prev.filter(r => r !== refId) : [...prev, refId]))
  }

  async function handleSubmitRegen() {
    setSubmitting(true)
    try {
      const entry: RegenQueueEntry = {
        id: `req-${Date.now()}`,
        clipId,
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
      // No onClose here (this replaced a modal branch) — this is a panel, not
      // a dialog. Drop back to the provenance view showing the queued state.
      setRegenMode(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={SECTION_CLASS}>
      <div className="shrink-0 flex items-center gap-1 border-b border-[var(--editor-border)] px-2 py-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[var(--editor-text)]/60 transition-colors hover:text-[var(--editor-text)]"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="text-xs font-medium uppercase tracking-wide">Generation</span>
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-3 p-2">
          {!regenMode ? (
            <>
              {/* Frozen generation provenance — read-only */}
              <div>
                <span className={LABEL_CLASS}>Prompt</span>
                <p className={cn(READONLY_CLASS, 'font-mono text-[11px]')}>{gen.prompt}</p>
              </div>

              <div className="flex flex-wrap gap-3">
                {gen.provider && (
                  <div>
                    <p className="text-[10px] text-[var(--editor-text)]/45">Provider</p>
                    <p className="text-xs text-[var(--editor-text)]/80">{gen.provider}</p>
                  </div>
                )}
                {gen.model && (
                  <div>
                    <p className="text-[10px] text-[var(--editor-text)]/45">Model</p>
                    <p className="text-xs text-[var(--editor-text)]/80">{gen.model}</p>
                  </div>
                )}
                {gen.duration != null && (
                  <div>
                    <p className="text-[10px] text-[var(--editor-text)]/45">Duration</p>
                    <p className="text-xs text-[var(--editor-text)]/80">{gen.duration}s</p>
                  </div>
                )}
                {gen.sceneId && (
                  <div>
                    <p className="text-[10px] text-[var(--editor-text)]/45">Scene</p>
                    <p className="text-xs text-[var(--editor-text)]/80">{gen.sceneId}</p>
                  </div>
                )}
              </div>

              {gen.refImages && gen.refImages.length > 0 && (
                <div>
                  <span className={LABEL_CLASS}>Reference images</span>
                  <div className="flex flex-wrap gap-1">
                    {gen.refImages.map((refId, i) => {
                      const ref = imageRefs.find(r => r.id === refId)
                      return (
                        <span
                          key={i}
                          className="text-[10px] bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded px-1.5 py-0.5 text-[var(--editor-text)]/70"
                        >
                          {ref ? `${ref.label} (${refId})` : refId}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {scene && (
                <div>
                  <span className={LABEL_CLASS}>Scene prompt (pre-composition)</span>
                  <p className={cn(READONLY_CLASS, 'text-[11px]')}>{scene.prompt}</p>
                </div>
              )}

              {gen.attempts && gen.attempts.length > 0 && (
                <div>
                  <span className={LABEL_CLASS}>Previous attempts ({gen.attempts.length})</span>
                  <div className="flex flex-col gap-1">
                    {gen.attempts.map((a, i) => (
                      <div
                        key={i}
                        className="text-[10px] text-[var(--editor-text)]/50 bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded px-2 py-1"
                      >
                        <span className="text-[var(--editor-text)]/35">{new Date(a.ts).toLocaleString()}</span>
                        {' · '}
                        <span className="font-mono">
                          {a.prompt.slice(0, 100)}
                          {a.prompt.length > 100 ? '…' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => setRegenMode(true)}
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--editor-accent)] hover:opacity-80 transition-opacity w-fit"
              >
                <RefreshCw size={12} />
                Regenerate this clip
              </button>
            </>
          ) : (
            <>
              {/* Regen form */}
              <div>
                <label htmlFor={`regen-prompt-${clipId}`} className={LABEL_CLASS}>
                  Prompt
                </label>
                <textarea
                  id={`regen-prompt-${clipId}`}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={4}
                  className={cn(INPUT_CLASS, 'font-mono resize-y')}
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label htmlFor={`regen-duration-${clipId}`} className={LABEL_CLASS}>
                    Duration (s)
                  </label>
                  {validDurations ? (
                    <div className="flex gap-1.5">
                      {validDurations.map(d => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDuration(d)}
                          className={cn(CHIP_BASE, duration === d ? CHIP_ON : CHIP_OFF)}
                        >
                          {d}s
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      id={`regen-duration-${clipId}`}
                      type="number"
                      value={duration}
                      onChange={e =>
                        setDuration(Math.max(durationMin, Math.min(durationMax, parseInt(e.target.value) || durationMin)))
                      }
                      min={durationMin}
                      max={durationMax}
                      className={cn(INPUT_CLASS, 'w-20')}
                    />
                  )}
                </div>

                <div className="flex-1">
                  <label htmlFor={`regen-model-${clipId}`} className={LABEL_CLASS}>
                    Model
                  </label>
                  <select
                    id={`regen-model-${clipId}`}
                    value={model}
                    onChange={e => handleModelChange(e.target.value)}
                    className={INPUT_CLASS}
                  >
                    {MODELS.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {imageRefs.length > 0 && (
                <div>
                  <label className={LABEL_CLASS}>Reference images</label>
                  <div className="flex flex-wrap gap-1.5">
                    {imageRefs.map(ref => {
                      const checked = selectedRefs.includes(ref.id)
                      return (
                        <button
                          key={ref.id}
                          type="button"
                          onClick={() => toggleRef(ref.id)}
                          className={cn(CHIP_BASE, checked ? CHIP_ON : CHIP_OFF)}
                        >
                          {ref.label} ({ref.id})
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleSubmitRegen}
                  disabled={submitting || !prompt.trim()}
                  className="px-3 py-1.5 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  {submitting ? 'Queuing…' : 'Queue regeneration'}
                </button>
                <button
                  type="button"
                  onClick={() => setRegenMode(false)}
                  className="text-xs text-[var(--editor-text)]/50 hover:text-[var(--editor-text)]/80 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

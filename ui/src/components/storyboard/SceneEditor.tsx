import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Scene } from '@/lib/types/schema'

const KLING_PROMPT_LIMIT = 2500

interface Props {
  scene: Scene
  index: number
  styleAnchor?: string
  onClose: () => void
  onSave: (newPrompt: string) => Promise<void>
  onDelete?: () => Promise<void>
}

/** Known section types and their display order (matches SECTION_ORDER in lib/ai_video.py). */
const SECTION_ORDER = ['camera', 'subject', 'action', 'dialogue'] as const
type SectionType = typeof SECTION_ORDER[number]

const sectionMeta: Record<SectionType, { label: string; color: string; bg: string; border: string; placeholder: string; optional?: boolean }> = {
  camera:   { label: 'Camera',   color: 'text-purple-400', bg: 'bg-purple-400/10', border: 'border-purple-400/20', placeholder: 'Shot size + camera motion. One sentence.\ne.g. "Wide shot, camera slowly pushes in."' },
  subject:  { label: 'Subject',  color: 'text-blue-400',   bg: 'bg-blue-400/10',   border: 'border-blue-400/20',   placeholder: 'Who/what is in the scene. Anchor identity first.\ne.g. "Rennie sits at the top of the yellow slide, gripping the railings."' },
  action:   { label: 'Action',   color: 'text-cyan-400',   bg: 'bg-cyan-400/10',   border: 'border-cyan-400/20',   placeholder: 'What happens — active verbs, sequential motion.\ne.g. "She stares down frozen. Rosie looks up and wags her tail."' },
  dialogue: { label: 'Dialogue', color: 'text-green-400',  bg: 'bg-green-400/10',  border: 'border-green-400/20',  placeholder: 'Voice-tagged speech. Leave empty if no dialogue.\ne.g. (female, ~8yo, nervous) Rennie says: "It looks high."', optional: true },
}

/** Parse ## section-formatted prompt into ordered entries. */
function parseSections(prompt: string): { key: string; text: string }[] {
  const sections: { key: string; text: string }[] = []
  const lines = prompt.split('\n')
  let currentKey: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/)
    if (match) {
      if (currentKey !== null) {
        sections.push({ key: currentKey, text: currentLines.join('\n').trim() })
      }
      currentKey = match[1].trim().toLowerCase()
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  if (currentKey !== null) {
    sections.push({ key: currentKey, text: currentLines.join('\n').trim() })
  }
  return sections
}

/** Check if the prompt uses ## sections. */
function isStructured(prompt: string): boolean {
  return /^##\s+\w/m.test(prompt)
}

/** Rebuild prompt string from sections. */
function sectionsToPrompt(sections: { key: string; text: string }[]): string {
  return sections
    .filter(s => s.text.trim())
    .map(s => `## ${s.key.charAt(0).toUpperCase() + s.key.slice(1)}\n${s.text}`)
    .join('\n\n')
}

/** Create a blank structured prompt with all sections. */
function blankStructuredPrompt(): { key: string; text: string }[] {
  return SECTION_ORDER.map(key => ({ key, text: '' }))
}

export function SceneEditor({ scene, index, styleAnchor, onClose, onSave, onDelete }: Props) {
  const structured = isStructured(scene.prompt)
  const [sections, setSections] = useState<{ key: string; text: string }[]>(
    structured ? parseSections(scene.prompt) : blankStructuredPrompt()
  )
  const [rawDraft, setRawDraft] = useState(scene.prompt)
  const [viewMode, setViewMode] = useState<'structured' | 'raw'>(structured ? 'structured' : 'raw')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync between modes
  function switchToRaw() {
    if (viewMode === 'structured') {
      setRawDraft(sectionsToPrompt(sections))
    }
    setViewMode('raw')
  }
  function switchToStructured() {
    if (viewMode === 'raw' && isStructured(rawDraft)) {
      setSections(parseSections(rawDraft))
    } else if (viewMode === 'raw' && !isStructured(rawDraft)) {
      // Can't parse — keep existing sections
    }
    setViewMode('structured')
  }

  const currentPrompt = viewMode === 'structured' ? sectionsToPrompt(sections) : rawDraft
  const dirty = currentPrompt !== scene.prompt
  const styleAnchorLen = styleAnchor ? styleAnchor.length + 1 : 0
  const sceneBudget = KLING_PROMPT_LIMIT - styleAnchorLen
  const over = currentPrompt.length > sceneBudget

  function updateSection(idx: number, text: string) {
    setSections(prev => prev.map((s, i) => i === idx ? { ...s, text } : s))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    if (!dirty) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      await onSave(currentPrompt)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!onDelete) return
    if (!window.confirm(`Delete scene ${index + 1}?`)) return
    setSaving(true)
    setError(null)
    try {
      await onDelete()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <aside
        className="w-full max-w-2xl max-h-[85vh] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-label={`Scene ${index + 1} prompt`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-white">Scene {index + 1}</h2>
            {scene.shotScale && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-400/10 text-purple-400 border border-purple-400/20">
                {scene.shotScale}
              </span>
            )}
            {scene.cameraMove && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-400/10 text-purple-400 border border-purple-400/20">
                {scene.cameraMove}
              </span>
            )}
            <span className="text-[10px] text-gray-500">{scene.duration}s</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-gray-700 overflow-hidden">
              <button
                onClick={switchToStructured}
                className={`px-2 py-1 text-[10px] transition-colors ${viewMode === 'structured' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >Structured</button>
              <button
                onClick={switchToRaw}
                className={`px-2 py-1 text-[10px] transition-colors ${viewMode === 'raw' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >Raw</button>
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none ml-2">×</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 px-5 py-4 overflow-y-auto">
          {viewMode === 'raw' ? (
            <textarea
              value={rawDraft}
              onChange={(e) => setRawDraft(e.target.value)}
              rows={16}
              autoFocus
              className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono"
              placeholder="## Camera&#10;Slow zoom in&#10;&#10;## Subject&#10;A blonde girl at the slide..."
            />
          ) : (
            <div className="flex flex-col gap-2">
              {sections.map((sec, i) => {
                const meta = sectionMeta[sec.key as SectionType]
                if (!meta) return null
                return (
                  <div key={sec.key} className={`rounded-md border ${meta.border} ${meta.bg} px-3 py-2`}>
                    <label className={`text-[10px] font-bold uppercase tracking-wider ${meta.color}`}>
                      {meta.label}
                    </label>
                    <textarea
                      value={sec.text}
                      onChange={(e) => updateSection(i, e.target.value)}
                      rows={sec.text ? Math.min(Math.max(sec.text.split('\n').length, 2), 5) : 2}
                      className="mt-1 w-full bg-transparent text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none resize-none leading-relaxed"
                      placeholder={meta.placeholder}
                    />
                  </div>
                )
              })}
            </div>
          )}
          <p className={`text-xs ${over ? 'text-red-400' : 'text-gray-500'}`}>
            {currentPrompt.length} / {sceneBudget} chars
            {styleAnchor
              ? ` (Kling limit ${KLING_PROMPT_LIMIT} − ${styleAnchorLen} styleAnchor prefix)`
              : ` (Kling limit ${KLING_PROMPT_LIMIT})`}
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center px-5 py-4 border-t border-gray-800">
          {onDelete && (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              Delete scene
            </button>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  )
}

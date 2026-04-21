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

export function SceneEditor({ scene, index, styleAnchor, onClose, onSave, onDelete }: Props) {
  const [draft, setDraft] = useState(scene.prompt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = draft !== scene.prompt
  const styleAnchorLen = styleAnchor ? styleAnchor.length + 1 : 0
  const sceneBudget = KLING_PROMPT_LIMIT - styleAnchorLen
  const over = draft.length > sceneBudget

  // Close on Escape
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
      await onSave(draft)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!onDelete) return
    if (!window.confirm(`Delete scene ${index + 1}? This removes the scene and any generated clip for it.`)) return
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
        className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-label={`Scene ${index + 1} prompt`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Scene {index + 1}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 px-5 py-4">
          <label htmlFor="prompt-editor" className="text-xs font-medium text-gray-400">Prompt</label>
          <textarea
            id="prompt-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            autoFocus
            className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          <p className={`text-xs ${over ? 'text-red-400' : 'text-gray-500'}`}>
            {draft.length} / {sceneBudget} chars
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

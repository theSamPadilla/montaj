import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { ImageRef } from '@/lib/types/schema'

interface Props {
  projectId: string
  imageRef: ImageRef
  onClose: () => void
  onComplete: (newRefImagePath: string) => void
}

export function RegenerateImageRefModal({ projectId, imageRef, onClose, onComplete }: Props) {
  const [prompt, setPrompt] = useState(imageRef.anchor || imageRef.label)
  const [provider, setProvider] = useState<'gemini' | 'openai'>('gemini')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !generating) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, generating])

  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const { path: outPath } = await api.reservePath(projectId, {
        prefix: `imageref_${imageRef.id}`,
        extension: 'png',
      })
      const result = await api.runStep<{ path: string }>('generate_image', {
        prompt,
        out: outPath,
        provider,
      })
      onComplete(result.path)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !generating) onClose() }}
    >
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Regenerate: {imageRef.label}</h2>
          <button onClick={onClose} disabled={generating} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              autoFocus
              className="rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
            <p className="text-[11px] text-gray-500">Editing the prompt here does NOT change the saved anchor text.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-400">Provider</label>
            <select
              value={provider}
              onChange={e => setProvider(e.target.value as 'gemini' | 'openai')}
              className="h-9 rounded-md border border-gray-600 bg-gray-800 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={generating}>Cancel</Button>
          <Button size="sm" onClick={generate} disabled={generating || !prompt.trim()}>
            {generating ? 'Generating…' : 'Generate'}
          </Button>
        </div>
      </div>
    </div>
  )
}

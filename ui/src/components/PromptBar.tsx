import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { Project } from '@/lib/project'

interface PromptBarProps {
  clips: string[]
  assets?: string[]
  name?: string
  profile?: string
  initialPrompt?: string
  initialWorkflow?: string
}

export default function PromptBar({ clips, assets = [], name, profile, initialPrompt = '', initialWorkflow = 'basic_trim' }: PromptBarProps) {
  const [prompt, setPrompt]     = useState(initialPrompt)
  const [workflow, setWorkflow] = useState(initialWorkflow)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const navigate = useNavigate()

  async function handleRun() {
    if (!prompt.trim()) return
    setLoading(true)
    setError(null)
    try {
      const project: Project = await api.createProject({ clips, assets: assets.length ? assets : undefined, name: name?.trim() || undefined, prompt: prompt.trim(), workflow, profile: profile || undefined })
      navigate(`/projects/${project.id}`, { state: { project } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-t border-gray-800 p-3 flex flex-col gap-2">
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 items-end">
        <Textarea
          className="flex-1 min-h-[56px] max-h-32"
          placeholder="tight cuts, remove filler, 9:16 for Reels…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
        />
        <div className="flex flex-col gap-1.5">
          <select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            className="h-9 rounded-md border border-gray-700 bg-gray-800 px-2 text-xs text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="basic_trim">basic_trim</option>
          </select>
          <Button onClick={handleRun} disabled={loading || !prompt.trim()} size="sm">
            {loading ? 'Running…' : 'Run ⌘↵'}
          </Button>
        </div>
      </div>
    </div>
  )
}

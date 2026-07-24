import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MobileProjectHeader from '@/components/MobileProjectHeader'
import { PreviewPlayer, createPlaybackClock, type PlaybackClock } from '@bycrux/editor'
import { createMontajAdapter } from '@/app/editor/montajAdapter'
import MobileRenderModal from '@/components/MobileRenderModal'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
}

export default function MobileVideoPreview({ project, onProjectChange }: Props) {
  const clockRef = useRef<PlaybackClock | null>(null)
  if (!clockRef.current) clockRef.current = createPlaybackClock()
  const adapter = useMemo(() => createMontajAdapter(), [])
  const [renderOpen, setRenderOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()

  const isPending = project.status === 'pending'

  async function handleRender() {
    setSaving(true)
    try {
      const final = { ...project, status: 'final' as const }
      await api.saveProject(project.id, final)
      onProjectChange(final)
      setRenderOpen(true)
    } catch (e) {
      alert(`Failed to save project: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <MobileProjectHeader project={project} onProjectChange={onProjectChange} />

      <div className="shrink-0 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50">
        <p className="text-xs text-amber-800 dark:text-amber-300 text-center">
          Open on desktop to edit. You can render from here.
        </p>
      </div>

      <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-3">
        <PreviewPlayer
          project={project}
          clock={clockRef.current}
          fileUrl={adapter.fileUrl}
          compileOverlay={adapter.compileOverlay}
          clearOverlayCache={adapter.clearOverlayCache}
          watchFile={adapter.watchFile}
          resolveCaptionTemplate={adapter.resolveCaptionTemplate}
        />
      </div>

      <div className="shrink-0 p-3 border-t border-gray-200 dark:border-gray-800">
        <Button onClick={handleRender} disabled={saving || isPending} className="w-full h-11 text-base">
          {saving ? 'Saving…' : isPending ? 'Project still processing…' : 'Render →'}
        </Button>
      </div>

      {renderOpen && (
        <MobileRenderModal
          projectId={project.id}
          onClose={() => { setRenderOpen(false); navigate('/') }}
          onCancel={() => setRenderOpen(false)}
        />
      )}
    </div>
  )
}

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { PreviewPlayer } from '@bycrux/editor'
import { createMontajAdapter } from './montajAdapter'
import MobileProjectHeader from '@/components/MobileProjectHeader'
import MobileRenderModal from '@/components/MobileRenderModal'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  logMessage?: string | null
  onProjectChange: (p: Project) => void
}

export default function MobileLiveView({ project, logMessage, onProjectChange }: Props) {
  const [currentTime, setCurrentTime] = useState(0)
  const [renderOpen, setRenderOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()
  const adapter = useMemo(() => createMontajAdapter(), [])

  const clips = project.tracks?.[0] ?? []
  const hasTrimmedClips = clips.some(c => c.inPoint !== undefined && c.outPoint !== undefined)
  const canGoBack = !hasTrimmedClips

  useEffect(() => {
    api.getInfo().then(info => setSkillPath(info.root_skill_path)).catch(() => {})
  }, [])

  async function handleBackToSetup() {
    try { await api.deleteProject(project.id) } catch (e) { console.error(e) }
    navigate('/projects/new')
  }

  async function handleRender() {
    setSaving(true)
    try {
      const final = { ...project, status: 'final' as const }
      await api.saveProject(project.id, final)
      onProjectChange(final)
      setRenderOpen(true)
    } catch (e) {
      alert(`Failed to save: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSaving(false) }
  }

  const renderButton = hasTrimmedClips && (
    <Button size="sm" onClick={handleRender} disabled={saving || project.status === 'pending'}>
      {saving ? 'Saving…' : 'Render →'}
    </Button>
  )

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <MobileProjectHeader project={project} onProjectChange={onProjectChange} actions={renderButton} />

      <div className="flex-1 flex items-center justify-center bg-gray-950 overflow-hidden p-4">
        {hasTrimmedClips ? (
          <PreviewPlayer
            project={project}
            currentTime={currentTime}
            onTimeUpdate={setCurrentTime}
            fileUrl={adapter.fileUrl}
            compileOverlay={adapter.compileOverlay}
            clearOverlayCache={adapter.clearOverlayCache}
            watchFile={adapter.watchFile}
            resolveCaptionTemplate={adapter.resolveCaptionTemplate}
          />
        ) : (
          <div className="flex flex-col items-center gap-4 text-center max-w-sm w-full">
            {!logMessage ? (
              <>
                <p className="text-white text-base font-semibold">Message your agent to start</p>
                <p className="text-gray-400 text-xs">Nothing happens automatically. Copy this and send it to your agent.</p>
                {skillPath && (
                  <div className="w-full rounded-lg border border-blue-400/40 bg-gray-900 p-3 flex flex-col gap-2 text-left">
                    <p className="text-blue-400 text-[10px] font-bold uppercase tracking-wider">Send to agent</p>
                    <code className="text-gray-200 text-[11px] leading-relaxed break-all font-mono">
                      There is a new project pending: &quot;{project.name ?? project.id}&quot;. Please see @{skillPath} and start.
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start.`
                        )
                        setCopied(true); setTimeout(() => setCopied(false), 2000)
                      }}
                      className={`text-xs font-medium px-3 py-2 rounded-md transition-colors ${
                        copied ? 'bg-green-700 text-green-200' : 'bg-white/10 text-gray-300'
                      }`}
                    >
                      {copied ? '✓ Copied' : 'Copy prompt'}
                    </button>
                  </div>
                )}
                <p className="text-gray-600 text-[10px] font-mono">project id: {project.id}</p>
                {canGoBack && (
                  <button onClick={handleBackToSetup} className="text-xs text-gray-500 underline">
                    ← Back to setup
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
                <p className="text-gray-300 text-xs">Agent is working:</p>
                <p className="text-blue-400 text-[11px] font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left break-all">
                  → {logMessage}
                </p>
                <p className="text-gray-700 text-[10px] font-mono">project id: {project.id}</p>
              </>
            )}
          </div>
        )}
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

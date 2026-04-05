import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import PreviewPlayer from '@/components/PreviewPlayer'
import ProjectHeader from '@/components/ProjectHeader'
import Timeline from '@/components/Timeline'
import VersionPanel from '@/components/VersionPanel'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { type Project, type ProjectVersion, type RunSnapshot } from '@/lib/project'

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function SnapshotCard({ snapshot, index, onRestore }: { snapshot: RunSnapshot; index: number; onRestore: () => void }) {
  const clipCount = snapshot.tracks?.[0]?.length ?? 0
  const capCount  = snapshot.captions?.segments.length ?? 0

  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Run {index + 1}</span>
        <span className="text-[10px] text-gray-600">{formatRelativeTime(snapshot.timestamp)}</span>
      </div>
      <p className="text-[10px] text-gray-500 line-clamp-2 leading-relaxed">
        {snapshot.editingPrompt}
      </p>
      <div className="flex items-center gap-2 text-[10px] text-gray-600">
        <span>{clipCount} clip{clipCount !== 1 ? 's' : ''}</span>
        {capCount > 0 && <span>·</span>}
        {capCount > 0 && <span>{capCount} captions</span>}
      </div>
      <button
        onClick={onRestore}
        className="text-[10px] text-blue-500 hover:text-blue-400 text-left transition-colors"
      >
        Restore this run →
      </button>
    </div>
  )
}

interface LiveViewProps {
  project: Project
  logMessage?: string | null
  onProjectChange: (p: Project) => void
}


export default function LiveView({ project, logMessage, onProjectChange }: LiveViewProps) {
  const [currentTime, setCurrentTime] = useState(0)
  const [saving, setSaving]           = useState(false)
  const [versions, setVersions]   = useState<ProjectVersion[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied]       = useState(false)
  const navigate = useNavigate()

  const clips           = project.tracks?.[0] ?? []
  const hasTrimmedClips = clips.some(c => c.inPoint !== undefined && c.outPoint !== undefined)
  const history         = project.history ?? []

  useEffect(() => {
    api.getInfo().then(info => setSkillPath(info.root_skill_path)).catch(() => {})
  }, [])

  useEffect(() => {
    api.listVersions(project.id).then(setVersions).catch(() => {})
  }, [project.id, project.status])

  async function handleRender() {
    setSaving(true)
    try {
      await api.saveProject(project.id, { ...project, status: 'final' })
      navigate('/')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestore(snapshot: RunSnapshot) {
    setSaving(true)
    try {
      const restored = {
        ...project,
        status: 'draft' as const,
        tracks: snapshot.tracks,
        captions: snapshot.captions,
      }
      await api.saveProject(project.id, restored)
      onProjectChange(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  async function handleRestoreVersion(hash: string) {
    setRestoring(hash)
    try {
      const restored = await api.restoreVersion(project.id, hash)
      onProjectChange(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <ProjectHeader
        project={project}
        onProjectChange={onProjectChange}
        actions={
          <Button size="sm" onClick={handleRender} disabled={saving || project.status === 'pending'}>
            {saving ? 'Saving…' : 'Render →'}
          </Button>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Main */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-1 flex items-center justify-center bg-gray-950 overflow-hidden p-4">
            {hasTrimmedClips ? (
              <PreviewPlayer
                project={project}
                currentTime={currentTime}
                onTimeUpdate={setCurrentTime}
              />
            ) : (
              <div className="flex flex-col items-center gap-6 text-center max-w-lg w-full">
                {!logMessage ? (
                  /* ── Waiting for user to kick off the agent ── */
                  <>
                    <div className="flex flex-col items-center gap-2">
                      <p className="text-white text-lg font-semibold">Message your agent to start</p>
                      <p className="text-gray-400 text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
                    </div>

                    {skillPath && (
                      <div className="w-full rounded-xl border-2 border-gray-200 dark:border-white/20 bg-gray-50 dark:bg-gray-900 p-4 flex flex-col gap-3 text-left">
                        <p className="text-gray-900 dark:text-white text-xs font-semibold uppercase tracking-wider">Send this to your agent</p>
                        <div className="flex items-start justify-between bg-white/80 dark:bg-black/60 border border-gray-200 dark:border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                          <span className="text-gray-700 dark:text-gray-200 text-[12px] leading-relaxed break-all">
                            There is a new project pending. Please see @{skillPath} and start. Talk to me if you run into questions.
                          </span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `There is a new project pending. Please see @${skillPath} and start. Talk to me if you run into questions.`
                              )
                              setCopied(true)
                              setTimeout(() => setCopied(false), 2000)
                            }}
                            className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                              copied
                                ? 'bg-green-700 text-green-200'
                                : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
                            }`}
                            title="Copy prompt"
                          >
                            {copied ? '✓ Copied' : (
                              <>
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                                </svg>
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    <p className="text-gray-600 text-xs font-mono">project id: {project.id}</p>
                  </>
                ) : (
                  /* ── Agent is working ── */
                  <>
                    <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
                    <p className="text-gray-300 text-sm">
                      <span className="text-white font-medium">{clips.length} clip{clips.length > 1 ? 's' : ''}</span>
                      {' queued'}
                      {project.assets?.length > 0 && (
                        <>, <span className="text-white font-medium">{project.assets.length} asset{project.assets.length > 1 ? 's' : ''}</span>{' added'}</>
                      )}
                      {'. Agent is working:'}
                    </p>
                    <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
                      → {logMessage}
                    </p>
                    <p className="text-gray-700 text-xs font-mono">project id: {project.id}</p>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
            <Timeline
              project={project}
              currentTime={currentTime}
              onTimeUpdate={setCurrentTime}

            />
          </div>
        </div>

        {/* Right sidebar */}
        <div className="w-48 shrink-0 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden">

          {/* Versions */}
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />

          {/* Previous runs */}
          {history.length > 0 && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Previous runs</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                {[...history].reverse().map((snap, i) => (
                  <SnapshotCard
                    key={snap.timestamp}
                    snapshot={snap}
                    index={history.length - 1 - i}
                    onRestore={() => handleRestore(snap)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

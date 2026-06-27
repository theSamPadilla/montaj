import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { ProjectContext, type Asset, type Project, type RunSnapshot } from '@/lib/types/schema'
import { useProjectStream } from '@/lib/sse'
import { createMontajAdapter } from './montajAdapter'
import { useIsMobile } from '@/lib/useIsMobile'
import { CarouselEditor, VideoEditor, defaultMontajTheme, type EditorSlots } from '@bycrux/editor'
import AssetsPanel from '@/components/AssetsPanel'
import ProjectHeader from '@/components/ProjectHeader'
import RerunModal from '@/components/RerunModal'
import { Button } from '@/components/ui/button'
import ClipInspectModal, { type InspectTarget } from '@/components/timeline/ClipInspectModal'
import SubcutRegenTool from '@/components/timeline/SubcutRegenTool'
import { ProfileAssetsPanel } from './ProfileAssetsPanel'
import UploadView from './UploadView'
import StoryboardView from './StoryboardView'
import MobileUploadView from './MobileUploadView'
import MobileLiveView from './MobileLiveView'
import MobileVideoPreview from '@/components/preview/MobileVideoPreview'
import MobileCarouselPreview from '@/components/preview/MobileCarouselPreview'
import MobileEditNotice from '@/components/MobileEditNotice'

// ── Run-history "Previous runs" sidebar (ported verbatim from LiveView/ReviewView) ──
// RunSnapshot stays a Montaj-only type. The package never reads project.history;
// this UI is injected into VideoEditor's `runHistory` slot.

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

function RunHistorySidebar({ history, onRestore }: { history: RunSnapshot[]; onRestore: (snap: RunSnapshot) => void }) {
  if (history.length === 0) return null
  return (
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
            onRestore={() => onRestore(snap)}
          />
        ))}
      </div>
    </div>
  )
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(
    (location.state as { project?: Project } | null)?.project ?? null
  )
  const [error, setError] = useState<string | null>(null)

  // Authoritative latest project, updated synchronously alongside setProject so
  // callbacks (e.g. handleAssetsChange) read fresh project data rather than the
  // lagging `project` state they closed over. The editor hook owns the canonical
  // project; this ref captures every frame it propagates via onProjectChange.
  const projectRef = useRef<Project | null>(project)
  const handleProjectChange = useCallback((p: Project) => {
    projectRef.current = p
    setProject(p)
  }, [])

  // Always fetch on mount to get authoritative server state.
  // location.state is only used as an instant-display hint while the fetch is in flight.
  useEffect(() => {
    if (!id || id === 'new') return
    api.getProject(id)
      .then(setProject)
      .catch((e: Error) => setError(e.message))
  }, [id])

  // Subscribe to live updates. Pass id directly (not project?.id) so the
  // EventSource opens immediately without waiting for the first fetch to resolve,
  // avoiding a create/destroy cycle on the first non-null transition.
  const [logMessage, setLogMessage] = useState<string | null>(null)
  const handleUpdate = useCallback((p: Project) => setProject(p), [])
  const handleLog    = useCallback((msg: string) => setLogMessage(msg), [])
  useProjectStream(id !== 'new' ? id : undefined, handleUpdate, handleLog)

  // Fallback poll while pending — SSE can miss the draft transition if the connection
  // drops at the wrong moment. Polls every 10s and stops once no longer pending.
  useEffect(() => {
    if (!id || id === 'new' || project?.status !== 'pending') return
    const timer = setInterval(() => {
      api.getProject(id).then(p => { if (p.status !== 'pending') setProject(p) }).catch(() => {})
    }, 10000)
    return () => clearInterval(timer)
  }, [id, project?.status, project?.projectType])

  const isMobile = useIsMobile()

  // Montaj-native EditorAdapter for the package editors. Stable across renders.
  const adapter = useMemo(() => createMontajAdapter(), [])

  // ── Host shell state (video branch) ───────────────────────────────────────
  // Re-run modal lives in the host shell — VideoEditor doesn't own the host
  // pipeline re-run. Inspector/subcut state is owned by VideoEditor (render-prop
  // seams); only the Re-run modal toggle is host-local here.
  const [rerunOpen, setRerunOpen] = useState(false)
  // VideoEditor hands us a stable `openRender()` trigger (it owns the RenderModal);
  // we host the Render button in the ProjectHeader instead of the package toolbar.
  const [openRender, setOpenRender] = useState<(() => void) | null>(null)

  // Host-supplied slots for the package editors:
  //  - assetsPanel : Montaj's own assets panel (uploads into the project dir,
  //                  persists via PUT on change).
  //  - exportActions: a "Download all (.zip)" link to Montaj's render-zip route,
  //                  shown in the render modal's done state.
  //  - pendingStatus: the live agent-progress line (from the SSE log stream),
  //                  shown in the pending view in place of the empty-state copy.
  //  - runHistory  : the Montaj "Previous runs" snapshot list (video branch).
  // These hooks MUST run on every render (no early return above them) — declaring
  // them after the `if (!project)` guard makes the hook count change between the
  // initial null render and the post-fetch render, which violates the Rules of
  // Hooks and crashes the editor on every cold load. They are null-safe so they
  // can run before `project` resolves.
  const handleAssetsChange = useCallback(
    async (next: Asset[]) => {
      // Spread the authoritative latest project (projectRef) rather than the
      // lagging `project` closure, so an asset save doesn't clobber edits the
      // editor hook propagated after this callback was created.
      const base = projectRef.current ?? project
      if (!base) return
      const updated = { ...base, assets: next }
      handleProjectChange(updated)
      await api.saveProject(base.id, updated)
    },
    [project, handleProjectChange],
  )

  // Restore a prior run snapshot — mirrors LiveView.handleRestore: rebuild the
  // project from the snapshot's tracks/captions, flip back to draft, persist,
  // and propagate via onProjectChange.
  const handleRestoreRun = useCallback(
    async (snapshot: RunSnapshot) => {
      const base = projectRef.current ?? project
      if (!base) return
      const restored: Project = {
        ...base,
        status: 'draft',
        tracks: snapshot.tracks,
        captions: snapshot.captions,
      }
      handleProjectChange(restored)
      try {
        await api.saveProject(base.id, restored)
      } catch (e) {
        console.error(e)
      }
    },
    [project, handleProjectChange],
  )

  const carouselSlots: EditorSlots = useMemo(
    () => ({
      assetsPanel: (
        <AssetsPanel
          assets={project?.assets ?? []}
          projectId={project?.id ?? ''}
          onChange={handleAssetsChange}
        />
      ),
      exportActions: (
        <a
          href={`/api/projects/${project?.id ?? ''}/render-zip`}
          download
          className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          Download all (.zip)
        </a>
      ),
      pendingStatus: logMessage ? (
        <>
          <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm">
            {(project?.assets ?? []).length} asset(s) attached. Agent is working:
          </p>
          <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
            → {logMessage}
          </p>
        </>
      ) : undefined,
    }),
    [project, handleAssetsChange, logMessage],
  )

  // Video editor slots. The assets panel for video is Montaj's project AssetsPanel;
  // profile-scoped input materials are surfaced via ProfileAssetsPanel stacked
  // above it (preserving the LiveView/ReviewView arrangement). runHistory feeds
  // the package's right-sidebar slot.
  const videoSlots: EditorSlots = useMemo(
    () => ({
      assetsPanel: project ? (
        <>
          {project.profile && (
            <div className="border-b border-gray-200 dark:border-gray-800 p-2">
              <ProfileAssetsPanel project={project} onProjectChange={handleProjectChange} />
            </div>
          )}
          <AssetsPanel
            assets={project.assets ?? []}
            projectId={project.id}
            onChange={handleAssetsChange}
          />
        </>
      ) : undefined,
      exportActions: (
        <a
          href={`/api/projects/${project?.id ?? ''}/render-zip`}
          download
          className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          Download all (.zip)
        </a>
      ),
      pendingStatus: logMessage ? (
        <>
          <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm">
            <span className="text-white font-medium">
              {(project?.tracks?.[0] ?? []).length} clip(s)
            </span>
            {' queued. Agent is working:'}
          </p>
          <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
            → {logMessage}
          </p>
        </>
      ) : undefined,
      runHistory: (
        <RunHistorySidebar history={project?.history ?? []} onRestore={handleRestoreRun} />
      ),
    }),
    [project, handleAssetsChange, handleProjectChange, handleRestoreRun, logMessage],
  )

  // Back-to-setup: delete the project and navigate to the setup view, carrying a
  // prefill so the user keeps their clips/name/prompt/workflow/profile. Ported
  // verbatim from LiveView.handleBackToSetup.
  const handleBackToSetup = useCallback(() => {
    const base = projectRef.current ?? project
    if (!base) return
    api.deleteProject(base.id).catch(e => console.error(e))
    navigate('/projects/new', {
      state: {
        prefill: {
          clips:    (base.sources ?? []).map(s => s.src).filter(Boolean),
          name:     base.name,
          prompt:   base.editingPrompt,
          workflow: base.workflow,
          profile:  base.profile ?? '',
        },
      },
    })
  }, [project, navigate])

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>
  }

  if (!id || id === 'new' || !project) {
    return (
      <ProjectContext.Provider value={{ project, setProject }}>
        {isMobile ? <MobileUploadView /> : <UploadView />}
      </ProjectContext.Provider>
    )
  }

  let view
  if (project.projectType === 'carousel') {
    view = isMobile
      ? <MobileCarouselPreview project={project} onProjectChange={setProject} />
      : (
        <CarouselEditor<Project>
          project={project}
          adapter={adapter}
          onProjectChange={handleProjectChange}
          theme={defaultMontajTheme}
          slots={carouselSlots}
        />
      )
  } else if (project.projectType === 'ai_video' && (project.status === 'pending' || project.status === 'storyboard_ready')) {
    view = isMobile
      ? <MobileEditNotice
          project={project}
          onProjectChange={setProject}
          logMessage={logMessage}
          message="Storyboard editing is desktop-only. Open on a larger screen to review scenes and references."
        />
      : <StoryboardView project={project} onProjectChange={setProject} logMessage={logMessage} />
  } else if (isMobile) {
    view = project.status === 'pending'
      ? <MobileLiveView project={project} logMessage={logMessage} onProjectChange={setProject} />
      : <MobileVideoPreview project={project} onProjectChange={setProject} />
  } else {
    // Desktop video branch: host ProjectHeader above the package VideoEditor.
    // VideoEditor owns Undo (internal), auto-Save, and Render (in-editor button),
    // so the header keeps only host-pipeline/shell actions VideoEditor does NOT
    // own: ← Storyboard (ai_video), Re-run (host RerunModal). Rename/back/delete
    // are intrinsic to ProjectHeader. Undo/Save/Render were dropped to avoid
    // duplicating what VideoEditor provides.
    view = (
      <div className="flex flex-col h-full">
        <ProjectHeader
          project={project}
          onProjectChange={handleProjectChange}
          actions={
            <>
              {project.projectType === 'ai_video' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const updated = { ...project, status: 'storyboard_ready' as const }
                    await api.saveProject(project.id, updated)
                    handleProjectChange(updated)
                  }}
                >
                  ← Storyboard
                </Button>
              )}
              {project.status !== 'pending' && (
                <Button variant="outline" size="sm" onClick={() => setRerunOpen(true)}>
                  Re-run
                </Button>
              )}
              {/* Render lives in the header for the local OS editor (the package's
                  toolbar button is suppressed via onProvideRenderTrigger below).
                  Shown once the package hands us the trigger (review mode only). */}
              {openRender && (
                <Button size="sm" onClick={openRender}>
                  Render →
                </Button>
              )}
            </>
          }
        />
        <div className="flex-1 overflow-hidden">
          <VideoEditor<Project>
            project={project}
            adapter={adapter}
            onProjectChange={handleProjectChange}
            theme={defaultMontajTheme}
            slots={videoSlots}
            assetsPlacement="sidebar"
            renderProgressView="logs"
            onProvideRenderTrigger={(fn) => setOpenRender(() => fn)}
            onBackToSetup={handleBackToSetup}
            regenEnabled={project.projectType === 'ai_video'}
            isClipQueued={(itemId) => (project.regenQueue ?? []).some(e => e.clipId === itemId)}
            renderClipInspector={({ item, onClose }) => (
              <ClipInspectModal
                project={project}
                target={item as InspectTarget}
                onProjectChange={handleProjectChange}
                onSave={(p) => api.saveProject(p.id, p)}
                onClose={onClose}
              />
            )}
            renderSubcutRegen={({ clipId, onClose }) => {
              const clip = (project.tracks?.[0] ?? []).find(c => c.id === clipId)
              if (!clip) return null
              return (
                <SubcutRegenTool
                  project={project}
                  clip={clip}
                  onProjectChange={handleProjectChange}
                  onSave={(p) => api.saveProject(p.id, p)}
                  onClose={onClose}
                />
              )
            }}
          />
        </div>

        {rerunOpen && (
          <RerunModal
            project={project}
            onClose={() => setRerunOpen(false)}
            onRerun={(updated) => { handleProjectChange(updated); setRerunOpen(false) }}
          />
        )}
      </div>
    )
  }

  return (
    <ProjectContext.Provider value={{ project, setProject }}>
      {view}
    </ProjectContext.Provider>
  )
}

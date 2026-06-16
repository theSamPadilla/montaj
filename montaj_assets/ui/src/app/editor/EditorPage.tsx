import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { api } from '@/lib/api'
import { ProjectContext, type Asset, type Project } from '@/lib/types/schema'
import { useProjectStream } from '@/lib/sse'
import { createMontajAdapter } from './montajAdapter'
import { useIsMobile } from '@/lib/useIsMobile'
import { CarouselEditor, defaultMontajTheme, type EditorSlots } from '@bycrux/editor'
import AssetsPanel from '@/components/AssetsPanel'
import UploadView from './UploadView'
import LiveView from './LiveView'
import ReviewView from './ReviewView'
import StoryboardView from './StoryboardView'
import MobileUploadView from './MobileUploadView'
import MobileLiveView from './MobileLiveView'
import MobileVideoPreview from '@/components/preview/MobileVideoPreview'
import MobileCarouselPreview from '@/components/preview/MobileCarouselPreview'
import MobileEditNotice from '@/components/MobileEditNotice'

export default function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [project, setProject] = useState<Project | null>(
    (location.state as { project?: Project } | null)?.project ?? null
  )
  const [error, setError] = useState<string | null>(null)

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

  // Montaj-native EditorAdapter for the carousel editor. Stable across renders.
  const adapter = useMemo(() => createMontajAdapter(), [])

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

  // Host-supplied slots for the package CarouselEditor:
  //  - assetsPanel : Montaj's own assets panel (uploads into the project dir,
  //                  persists via PUT on change).
  //  - exportActions: a "Download all (.zip)" link to Montaj's render-zip route,
  //                  shown in the render modal's done state.
  //  - pendingStatus: the live agent-progress line (from the SSE log stream),
  //                  shown in the pending view in place of the empty-state copy.
  const carouselProject = project
  const handleAssetsChange = useCallback(
    async (next: Asset[]) => {
      const updated = { ...carouselProject, assets: next }
      setProject(updated)
      await api.saveProject(carouselProject.id, updated)
    },
    [carouselProject],
  )
  const carouselSlots: EditorSlots = useMemo(
    () => ({
      assetsPanel: (
        <AssetsPanel
          assets={carouselProject.assets ?? []}
          projectId={carouselProject.id}
          onChange={handleAssetsChange}
        />
      ),
      exportActions: (
        <a
          href={`/api/projects/${carouselProject.id}/render-zip`}
          className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          Download all (.zip)
        </a>
      ),
      pendingStatus: logMessage ? (
        <>
          <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm">Agent is working:</p>
          <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
            → {logMessage}
          </p>
        </>
      ) : undefined,
    }),
    [carouselProject, handleAssetsChange, logMessage],
  )

  let view
  if (project.projectType === 'carousel') {
    view = isMobile
      ? <MobileCarouselPreview project={project} onProjectChange={setProject} />
      : (
        <CarouselEditor<Project>
          project={project}
          adapter={adapter}
          onProjectChange={setProject}
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
  } else if (project.status === 'pending') {
    view = isMobile
      ? <MobileLiveView project={project} logMessage={logMessage} onProjectChange={setProject} />
      : <LiveView project={project} logMessage={logMessage} onProjectChange={setProject} />
  } else {
    view = isMobile
      ? <MobileVideoPreview project={project} onProjectChange={setProject} />
      : <ReviewView project={project} onProjectChange={setProject} />
  }

  return (
    <ProjectContext.Provider value={{ project, setProject }}>
      {view}
    </ProjectContext.Provider>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { api } from '@/lib/api'
import { ProjectContext, type Project } from '@/lib/project'
import { useProjectStream } from '@/lib/sse'
import UploadView from './UploadView'
import LiveView from './LiveView'
import ReviewView from './ReviewView'

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
  // drops at the wrong moment. Polls every 5s and stops once no longer pending.
  useEffect(() => {
    if (!id || id === 'new' || project?.status !== 'pending') return
    const timer = setInterval(() => {
      api.getProject(id).then(p => { if (p.status !== 'pending') setProject(p) }).catch(() => {})
    }, 10000)
    return () => clearInterval(timer)
  }, [id, project?.status])

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>
  }

  if (!id || id === 'new' || !project) {
    return (
      <ProjectContext.Provider value={{ project, setProject }}>
        <UploadView />
      </ProjectContext.Provider>
    )
  }

  return (
    <ProjectContext.Provider value={{ project, setProject }}>
      {project.status === 'pending' ? (
        <LiveView project={project} logMessage={logMessage} onProjectChange={setProject} />
      ) : (
        <ReviewView project={project} onProjectChange={setProject} />
      )}
    </ProjectContext.Provider>
  )
}

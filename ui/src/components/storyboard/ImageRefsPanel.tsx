import { useState } from 'react'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'
import { ImageRefCard } from './ImageRefCard'
import { RegenerateImageRefModal } from './RegenerateImageRefModal'

interface Props {
  project: Project
  onProjectChange: (project: Project) => void
}

export function ImageRefsPanel({ project, onProjectChange }: Props) {
  const refs = project.storyboard?.imageRefs ?? []
  const [regenRefId, setRegenRefId] = useState<string | null>(null)
  const regenRef = regenRefId ? refs.find(r => r.id === regenRefId) : null

  if (refs.length === 0) return null

  async function handleDelete(refId: string) {
    if (!window.confirm('Remove this image reference? Scenes using it will lose this ref.')) return
    const imageRefs = (project.storyboard?.imageRefs ?? []).filter(r => r.id !== refId)
    const nextProject: Project = {
      ...project,
      storyboard: {
        ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
        imageRefs,
      },
    }
    await api.saveProject(project.id, nextProject)
    onProjectChange(nextProject)
  }

  async function handleRegenComplete(refId: string, newPath: string) {
    const imageRefs = (project.storyboard?.imageRefs ?? []).map(r => {
      if (r.id !== refId) return r
      return { ...r, refImages: [newPath, ...r.refImages] }
    })
    const nextProject: Project = {
      ...project,
      storyboard: {
        ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
        imageRefs,
      },
    }
    await api.saveProject(project.id, nextProject)
    onProjectChange(nextProject)
  }

  return (
    <section className="flex-1 min-w-0">
      <h2 className="text-sm font-medium text-gray-300 mb-3">Image references ({refs.length})</h2>
      <div className="flex flex-col gap-2">
        {refs.map(ref => (
          <ImageRefCard
            key={ref.id}
            imageRef={ref}
            onRegenerate={() => setRegenRefId(ref.id)}
            onDelete={() => handleDelete(ref.id)}
          />
        ))}
      </div>
      {regenRef && (
        <RegenerateImageRefModal
          projectId={project.id}
          imageRef={regenRef}
          onClose={() => setRegenRefId(null)}
          onComplete={(newPath) => handleRegenComplete(regenRef.id, newPath)}
        />
      )}
    </section>
  )
}

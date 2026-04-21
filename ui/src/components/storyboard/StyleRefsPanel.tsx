import { Film, Music, Image, Trash2 } from 'lucide-react'
import { fileUrl, api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange?: (project: Project) => void
}

const kindIcon = {
  video: Film,
  audio: Music,
  image: Image,
} as const

export function StyleRefsPanel({ project, onProjectChange }: Props) {
  const refs = project.storyboard?.styleRefs ?? []
  if (refs.length === 0) return null

  async function handleDelete(refId: string) {
    if (!onProjectChange) return
    if (!window.confirm('Remove this style reference?')) return
    const styleRefs = (project.storyboard?.styleRefs ?? []).filter(r => r.id !== refId)
    const nextProject: Project = {
      ...project,
      storyboard: {
        ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
        styleRefs,
      },
    }
    await api.saveProject(project.id, nextProject)
    onProjectChange(nextProject)
  }

  return (
    <section className="flex-1 min-w-0">
      <h2 className="text-sm font-medium text-gray-300 mb-1">Style references</h2>
      <p className="text-xs text-gray-500 mb-3">Analyzed by the agent; influenced the style anchor above. Not used in the final video.</p>
      <div className="flex flex-col gap-2">
        {refs.map(ref => {
          const Icon = kindIcon[ref.kind] ?? Image
          return (
            <div key={ref.id} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3">
              {ref.kind === 'image' ? (
                <img src={fileUrl(ref.path)} alt={ref.label} className="w-10 h-10 rounded object-cover border border-gray-700" />
              ) : (
                <div className="w-10 h-10 rounded border border-gray-700 bg-gray-800 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-gray-500" />
                </div>
              )}
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm text-gray-300 truncate">{ref.label || ref.path.split('/').pop()}</span>
                <span className="text-xs text-gray-500">{ref.kind}</span>
              </div>
              {onProjectChange && (
                <button
                  type="button"
                  onClick={() => handleDelete(ref.id)}
                  className="p-1 rounded text-red-400/40 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                  title="Remove style reference"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

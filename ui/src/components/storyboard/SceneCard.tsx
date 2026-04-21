import { Pencil, Trash2 } from 'lucide-react'
import { fileUrl } from '@/lib/api'
import type { Scene, Storyboard } from '@/lib/types/schema'

interface Props {
  index: number
  scene: Scene
  storyboard: Storyboard | undefined
  onEditPrompt: () => void
  onDelete?: () => void
}

export function SceneCard({ index, scene, storyboard, onEditPrompt, onDelete }: Props) {
  const resolvedRefs = (scene.refImages ?? [])
    .map(id => storyboard?.imageRefs?.find(r => r.id === id))
    .filter((ref): ref is NonNullable<typeof ref> => !!ref)

  return (
    <article className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-400">Scene {index + 1}</span>
        <span className="text-xs text-gray-500">{scene.duration}s</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onEditPrompt}
          className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
          aria-label={`Edit scene ${index + 1} prompt`}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete scene ${index + 1}?`)) onDelete()
            }}
            className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-red-400 transition-colors"
            aria-label={`Delete scene ${index + 1}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </header>

      {resolvedRefs.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {resolvedRefs.map(ref => {
            const thumb = ref.refImages?.[0]
            return thumb ? (
              <img
                key={ref.id}
                src={fileUrl(thumb)}
                alt={ref.anchor || ref.label}
                title={ref.anchor || ref.label}
                className="w-12 h-12 rounded object-cover border border-gray-700"
              />
            ) : null
          })}
        </div>
      )}

      <p className="text-sm text-gray-300 whitespace-pre-wrap">{scene.prompt}</p>

      {scene.lastError && (
        <p className="text-xs text-red-400">
          Failed: {scene.lastError.message}
        </p>
      )}
    </article>
  )
}

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange: (project: Project) => void
}

export function ApproveAndGenerate({ project, onProjectChange }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const storyboardScenes = project.storyboard?.scenes ?? []
  const generatedClips = (project.tracks?.[0] ?? []).filter(item => item.generation)
  const approved = !!project.storyboard?.approval
  const approvedAt = project.storyboard?.approval?.approvedAt

  // Derive per-scene progress from project.json state.
  //
  // A scene is "done" when a matching clip exists in tracks[0]. The agent
  // may use either dispatch mode:
  //   - Independent / chained: one clip per scene, matched by generation.sceneId.
  //   - Batched (multi-shot): one clip per batch of up to 6 scenes; per-scene
  //     mapping lives in generation.batchShots[]. Match by any entry's sceneId.
  // A scene produced by a single-shot regen of a previously batched scene
  // shows up as a standalone clip in tracks[0], so the single-shot lookup
  // still wins (checked first).
  const progress = storyboardScenes.map(s => {
    const done = generatedClips.some(c =>
      c.generation?.sceneId === s.id ||
      c.generation?.batchShots?.some(shot => shot.sceneId === s.id)
    )
    return {
      id: s.id,
      status: done
        ? 'done' as const
        : s.lastError ? 'failed' as const : 'pending' as const,
    }
  })
  const doneCount = progress.filter(p => p.status === 'done').length

  async function onApprove() {
    const message =
      `Approve & generate ${storyboardScenes.length} scene${storyboardScenes.length === 1 ? '' : 's'} via Kling?\n\n` +
      `Estimated time: ~${storyboardScenes.length * 2} min serial, less if the agent parallelizes. ` +
      `Credits will be charged to your Kling account.\n\n` +
      `After clicking OK, tell your agent to continue. The agent will generate the scenes.`
    if (!window.confirm(message)) return

    setSubmitting(true)
    setError(null)
    try {
      const nextProject: Project = {
        ...project,
        storyboard: {
          ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
          approval: {
            approvedAt: new Date().toISOString(),
          },
        },
      }
      await api.saveProject(project.id, nextProject)
      onProjectChange(nextProject)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (approved) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex flex-col gap-2">
        <p className="text-sm text-gray-300">
          <span className="font-medium text-green-400">Approved</span>{' '}
          <span className="text-gray-500">{new Date(approvedAt!).toLocaleString()}</span>
          {' — '}agent generating {doneCount}/{storyboardScenes.length} scenes.
        </p>
        {storyboardScenes.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {progress.map((p, i) => (
              <li
                key={p.id}
                className={`text-xs px-2 py-1 rounded border ${
                  p.status === 'done'
                    ? 'border-green-800 bg-green-900/30 text-green-400'
                    : p.status === 'failed'
                    ? 'border-red-800 bg-red-900/30 text-red-400'
                    : 'border-gray-700 bg-gray-800 text-gray-400'
                }`}
              >
                Scene {i + 1}: {p.status}
              </li>
            ))}
          </ul>
        )}
        {doneCount > 0 && doneCount < storyboardScenes.length && (
          <p className="text-xs text-gray-500">If the agent stalls, ask it in chat to continue generating scenes.</p>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={onApprove}
        disabled={submitting || storyboardScenes.length === 0}
        size="lg"
      >
        {submitting
          ? 'Submitting…'
          : `Approve & Generate ${storyboardScenes.length} scene${storyboardScenes.length === 1 ? '' : 's'}`}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-xs text-gray-500">
        Approving will ask your agent to generate scenes via Kling. The agent handles
        retries and orchestration; watch progress below as scenes complete.
      </p>
    </div>
  )
}

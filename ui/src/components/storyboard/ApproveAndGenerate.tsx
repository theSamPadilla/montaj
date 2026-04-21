import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange: (project: Project) => void
}

// Compose the chat message the user pastes to their agent to trigger Phase 6.
// Kept in sync with the CLI's cli/commands/approve.py::_agent_message.
function agentMessageFor(project: Project, sceneCount: number, failedCount?: number): string {
  const label = project.name || project.id
  const id = project.id ? ` (id: ${project.id})` : ''
  const scenes = `${sceneCount} scene${sceneCount === 1 ? '' : 's'}`
  if (failedCount && failedCount > 0) {
    return (
      `${failedCount} scene${failedCount === 1 ? '' : 's'} failed for project "${label}"${id}. ` +
      `I've cleared the errors. Please retry the failed scenes ` +
      `per the ai-video skill Phase 6 contract.`
    )
  }
  return (
    `I approved the storyboard for project "${label}"${id}. ` +
    `Please proceed with scene generation (${scenes}) ` +
    `per the ai-video skill Phase 6 contract.`
  )
}

export function ApproveAndGenerate({ project, onProjectChange }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [retryMessage, setRetryMessage] = useState<string | null>(null)

  const storyboardScenes = project.storyboard?.scenes ?? []
  const generatedClips = (project.tracks?.[0] ?? []).filter(item => item.generation)
  const approved = !!project.storyboard?.approval
  const approvedAt = project.storyboard?.approval?.approvedAt
  const agentMessage = retryMessage ?? agentMessageFor(project, storyboardScenes.length)

  async function copyAgentMessage() {
    try {
      await navigator.clipboard.writeText(agentMessage)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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
  const failedCount = progress.filter(p => p.status === 'failed').length

  async function retryFailed() {
    setError(null)
    setSubmitting(true)
    try {
      // Clear lastError on all failed scenes so the agent retries them
      const clearedScenes = storyboardScenes.map(s =>
        s.lastError ? { ...s, lastError: undefined } : s
      )
      const nextProject: Project = {
        ...project,
        storyboard: {
          ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
          scenes: clearedScenes,
        },
      }
      await api.saveProject(project.id, nextProject)
      onProjectChange(nextProject)
      const msg = agentMessageFor(project, storyboardScenes.length, failedCount)
      setRetryMessage(msg)
      await navigator.clipboard.writeText(msg)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

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
    const allDone = doneCount === storyboardScenes.length && storyboardScenes.length > 0
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex flex-col gap-3">
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
        {/* Retry button for failed scenes */}
        {failedCount > 0 && (
          <button
            onClick={retryFailed}
            disabled={submitting}
            className="flex items-center gap-2 text-sm font-medium text-amber-400 hover:text-amber-300 transition-colors w-fit"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 16h5v5"/>
            </svg>
            {submitting ? 'Clearing errors…' : `Retry ${failedCount} failed scene${failedCount === 1 ? '' : 's'}`}
            {copied && <span className="text-xs text-green-400">(copied to clipboard)</span>}
          </button>
        )}
        {/* Tell-your-agent panel. Hidden once generation is complete. */}
        {!allDone && (
          <div className="rounded-md border border-gray-700 bg-gray-900 p-3 flex flex-col gap-2">
            <p className="text-xs text-gray-400">
              Your agent doesn't auto-detect approval. Paste this in your chat to start (or resume) generation:
            </p>
            <div className="flex items-start gap-2">
              <code className="flex-1 text-xs text-gray-300 bg-gray-950 border border-gray-800 rounded px-2 py-1.5 whitespace-pre-wrap break-words font-mono">
                {agentMessage}
              </code>
              <button
                onClick={copyAgentMessage}
                className={`shrink-0 text-xs px-2 py-1.5 rounded border transition-colors ${
                  copied
                    ? 'border-green-700 bg-green-900/40 text-green-300'
                    : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white'
                }`}
                title="Copy to clipboard"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {doneCount > 0 && doneCount < storyboardScenes.length && (
              <p className="text-xs text-gray-500">
                If the agent stalls mid-run, paste the same message again — it's idempotent (already-generated scenes are skipped).
              </p>
            )}
          </div>
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
        Approving records the approval on the project. A message will appear here
        afterward — paste it in your agent's chat to start scene generation.
      </p>
    </div>
  )
}

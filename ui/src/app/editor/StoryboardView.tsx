import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'
import { SceneCard } from '@/components/storyboard/SceneCard'
import { SceneEditor } from '@/components/storyboard/SceneEditor'
import { ImageRefsPanel } from '@/components/storyboard/ImageRefsPanel'
import { StyleRefsPanel } from '@/components/storyboard/StyleRefsPanel'
import { ApproveAndGenerate } from '@/components/storyboard/ApproveAndGenerate'

interface Props {
  project: Project
  onProjectChange: (project: Project) => void
  logMessage?: string | null
}

function updateScenePrompt(project: Project, sceneId: string, newPrompt: string): Project {
  const scenes = project.storyboard?.scenes ?? []
  return {
    ...project,
    storyboard: {
      ...(project.storyboard ?? { imageRefs: [], styleRefs: [], scenes: [] }),
      scenes: scenes.map(s => s.id === sceneId ? { ...s, prompt: newPrompt } : s),
    },
  }
}

export default function StoryboardView({ project, onProjectChange, logMessage }: Props) {
  const scenes = project.storyboard?.scenes ?? []
  const styleAnchor = project.storyboard?.styleAnchor
  const aspectRatio = project.storyboard?.aspectRatio
  const targetDuration = project.storyboard?.targetDurationSeconds
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null)
  const editingScene = editingSceneId ? scenes.find(s => s.id === editingSceneId) : null
  const editingIndex = editingScene ? scenes.indexOf(editingScene) : -1
  const isPending = project.status === 'pending'

  // For the agent prompt in pending state
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (isPending) {
      api.getInfo().then(info => setSkillPath(info.root_skill_path)).catch(() => {})
    }
  }, [isPending])

  async function saveScenePrompt(sceneId: string, newPrompt: string) {
    const nextProject = updateScenePrompt(project, sceneId, newPrompt)
    await api.saveProject(project.id, nextProject)
    onProjectChange(nextProject)
  }

  async function handleBackToSetup() {
    // Reconstruct draft data from storyboard so refs survive the round-trip
    const sb = project.storyboard
    const imageRefDrafts = (sb?.imageRefs ?? []).map(r => ({
      id: r.id,
      label: r.label,
      mode: (r.source === 'upload' ? 'upload' : 'describe') as 'upload' | 'describe',
      path: r.refImages?.[0],
      text: r.anchor,
    }))
    const styleRefDrafts = (sb?.styleRefs ?? []).map(r => ({
      id: r.id,
      label: r.label ?? '',
      path: r.path ?? '',
    }))

    try { await api.deleteProject(project.id) } catch (e) { console.error(e) }
    navigate('/projects/new', {
      state: {
        prefill: {
          name:     project.name,
          prompt:   project.editingPrompt,
          workflow: project.workflow,
          profile:  project.profile ?? '',
          aiVideoData: { imageRefs: imageRefDrafts, styleRefs: styleRefDrafts },
          aspectRatio: sb?.aspectRatio,
          targetDuration: sb?.targetDurationSeconds,
        },
      },
    })
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto h-full overflow-y-auto">
      {/* Header */}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white">{project.name || 'Untitled'}</h1>
          {isPending && (
            <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/30">
              pending
            </span>
          )}
        </div>
        <p className="text-sm text-gray-400 line-clamp-3">{project.editingPrompt}</p>
        <div className="flex items-center gap-2">
          {aspectRatio && (
            <span className="inline-flex items-center rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 border border-gray-700">
              {aspectRatio}
            </span>
          )}
          {targetDuration && (
            <span className="inline-flex items-center rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 border border-gray-700">
              ~{targetDuration}s total
            </span>
          )}
          {(project.storyboard?.imageRefs?.length ?? 0) > 0 && (
            <span className="inline-flex items-center rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 border border-gray-700">
              {project.storyboard!.imageRefs.length} image ref{project.storyboard!.imageRefs.length !== 1 ? 's' : ''}
            </span>
          )}
          {(project.storyboard?.styleRefs?.length ?? 0) > 0 && (
            <span className="inline-flex items-center rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 border border-gray-700">
              {project.storyboard!.styleRefs.length} style ref{project.storyboard!.styleRefs.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </header>

      {/* Pending state — agent prompt */}
      {isPending && (
        <section className="flex flex-col items-center gap-5 py-8">
          {!logMessage ? (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <p className="text-white text-lg font-semibold">Message your agent to start</p>
                <p className="text-gray-400 text-sm">The agent will build your storyboard — scenes, characters, and style. Copy this and send it.</p>
              </div>

              {skillPath && (
                <div className="w-full max-w-lg rounded-xl border-2 border-blue-400/50 bg-gray-900 p-5 flex flex-col gap-3 text-left shadow-lg shadow-blue-400/10">
                  <p className="text-blue-400 text-xs font-bold uppercase tracking-widest">Send this to your agent</p>
                  <div className="flex items-start justify-between bg-black/60 border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                    <span className="text-gray-200 text-[12px] leading-relaxed break-all">
                      There is a new project pending: "{project.name ?? project.id}". Please see @{skillPath} and start. Talk to me if you run into questions.
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(
                          `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start. Talk to me if you run into questions.`
                        )
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      }}
                      className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                        copied
                          ? 'bg-green-700 text-green-200'
                          : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
                      }`}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <p className="text-gray-600 text-xs font-mono">project id: {project.id}</p>
              <button
                onClick={handleBackToSetup}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors underline underline-offset-2"
              >
                &larr; Back to setup
              </button>
            </>
          ) : (
            <>
              <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
              <p className="text-gray-300 text-sm">Agent is building your storyboard…</p>
              <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full max-w-lg text-left truncate">
                &rarr; {logMessage}
              </p>
            </>
          )}
        </section>
      )}

      {/* Storyboard content — only shown once we have data */}
      {!isPending && (
        <>
          <ApproveAndGenerate project={project} onProjectChange={onProjectChange} />
          <p className="text-xs text-gray-500">
            Scene prompts are editable (pencil icon). For anything else — scene count,
            ordering, durations, characters, style — ask the agent in chat.
            Image references can be regenerated below.
          </p>

          {/* Style anchor */}
          {styleAnchor && (
            <section className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
              <h2 className="text-sm font-medium text-gray-300 mb-2">Style</h2>
              <p className="text-sm text-gray-400">{styleAnchor}</p>
            </section>
          )}

          {/* Refs panels */}
          <section className="flex flex-col gap-4 sm:flex-row">
            <ImageRefsPanel project={project} onProjectChange={onProjectChange} />
            <StyleRefsPanel project={project} />
          </section>

          {/* Scene list */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-gray-300">Scenes ({scenes.length})</h2>
            {scenes.map((scene, i) => (
              <SceneCard
                key={scene.id}
                index={i}
                scene={scene}
                storyboard={project.storyboard}
                onEditPrompt={() => setEditingSceneId(scene.id)}
              />
            ))}
            {scenes.length === 0 && (
              <p className="text-sm text-gray-500 italic">No scenes yet — the agent is still building the storyboard.</p>
            )}
          </section>

          {/* Scene editor side panel */}
          {editingScene && (
            <SceneEditor
              scene={editingScene}
              index={editingIndex}
              styleAnchor={styleAnchor}
              onClose={() => setEditingSceneId(null)}
              onSave={(newPrompt) => saveScenePrompt(editingScene.id, newPrompt)}
            />
          )}
        </>
      )}
    </div>
  )
}

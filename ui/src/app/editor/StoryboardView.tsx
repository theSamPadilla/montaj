import { useState } from 'react'
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

export default function StoryboardView({ project, onProjectChange }: Props) {
  const scenes = project.storyboard?.scenes ?? []
  const styleAnchor = project.storyboard?.styleAnchor
  const aspectRatio = project.storyboard?.aspectRatio
  const targetDuration = project.storyboard?.targetDurationSeconds
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null)
  const editingScene = editingSceneId ? scenes.find(s => s.id === editingSceneId) : null
  const editingIndex = editingScene ? scenes.indexOf(editingScene) : -1

  async function saveScenePrompt(sceneId: string, newPrompt: string) {
    const nextProject = updateScenePrompt(project, sceneId, newPrompt)
    await api.saveProject(project.id, nextProject)
    onProjectChange(nextProject)
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      {/* Header */}
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-white">{project.name || 'Untitled'}</h1>
        <p className="text-sm text-gray-400">{project.editingPrompt}</p>
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
        </div>
        <ApproveAndGenerate project={project} onProjectChange={onProjectChange} />
        <p className="text-xs text-gray-500">
          Scene prompts are editable (pencil icon). For anything else — scene count,
          ordering, durations, characters, style — ask the agent in chat.
          Image references can be regenerated below.
        </p>
      </header>

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
    </div>
  )
}

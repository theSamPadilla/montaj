import { describe, it, expect } from 'vitest'
import type { EditorProject } from '@devbycrux/editor'
import type { Project } from '../schema'

// A full Montaj Project — including pipeline/agent-only fields — must remain
// assignable to the package's EditorProject. This proves `Project extends
// EditorProject` and that the index signature lets host/pipeline fields pass.
describe('Project ↔ EditorProject assignability', () => {
  it('a full Project value is assignable to EditorProject', () => {
    const fullProject: Project = {
      version: '1',
      id: 'p1',
      status: 'final',
      projectType: 'carousel',
      name: 'Full project',
      workflow: 'default',
      editingPrompt: 'edit',
      settings: { resolution: [1080, 1080], fps: 30 },
      assets: [],
      storyboard: {
        imageRefs: [],
        styleRefs: [],
        scenes: [],
      },
      regenQueue: [],
      slides: [],
      carousel: { aspect: 'square' },
    }

    const asEditor: EditorProject = fullProject
    expect(asEditor.id).toBe('p1')
    expect(asEditor.status).toBe('final')
  })
})

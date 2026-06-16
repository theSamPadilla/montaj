import { describe, it, expect } from 'vitest'
import type {
  EditorAdapter,
  RenderEvent,
  RenderOptions,
  MediaItem,
  MediaScope,
  GlobalOverlay,
} from '../types'
import type { EditorProject, ImageElement } from '../schema'

// ── Full adapter contract ─────────────────────────────────────────────────────
// A fake object implementing the FULL EditorAdapter<EditorProject> — every
// required method, including the ones T4 adds — must type-check. This file
// fails to compile if a required method is missing or mistyped.

const project: EditorProject = {
  version: '1',
  id: 'p1',
  status: 'draft' as EditorProject['status'],
  name: 'Fake',
  workflow: 'carousel',
  editingPrompt: '',
  settings: { resolution: [1080, 1080] },
  assets: [],
  slides: [],
}

const overlay: GlobalOverlay = {
  name: 'caption',
  description: 'A caption overlay',
  props: [
    { name: 'text', type: 'string', default: '', description: 'caption text' },
    { name: 'color', type: 'color', default: '#fff' },
  ],
  jsxPath: '/overlays/caption.jsx',
}

// (a) FULL adapter: every required method present, optional ones present too.
function makeFullAdapter(): EditorAdapter<EditorProject> {
  return {
    loadProject: async (_id: string): Promise<EditorProject> => project,
    saveProject: async (_id: string, _p: EditorProject): Promise<void> => {},
    subscribe: (_id: string, _onFrame: (p: EditorProject) => void): (() => void) =>
      () => {},
    render: async function* (
      _id: string,
      _opts?: RenderOptions,
    ): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out/p1.mp4' }
    },
    resolveImageSrc: (el: ImageElement): string => el.src,
    compileOverlay: async (_template: string) => () => null,
    // New REQUIRED methods (T4).
    listGlobalOverlays: async (): Promise<GlobalOverlay[]> => [overlay],
    listSystemOverlays: async (): Promise<GlobalOverlay[]> => [],
    uploadFile: async (_file: File, _projectId?: string): Promise<string> => '/path',
    fileUrl: (path: string): string => `/api/files?path=${encodeURIComponent(path)}`,
    // Optional methods present.
    listMedia: async (_scope: MediaScope): Promise<MediaItem[]> => [],
    listProfileOverlays: async (_profileName: string): Promise<GlobalOverlay[]> => [],
    getInfo: async (): Promise<{ root_skill_path?: string }> => ({}),
    generateImage: async (_prompt: string, _projectId: string): Promise<{ path: string }> => ({
      path: '/gen.png',
    }),
  }
}

// (b) Minimal adapter: only required methods; optional ones omitted. Must still
// type-check.
function makeMinimalAdapter(): EditorAdapter<EditorProject> {
  return {
    loadProject: async (_id: string): Promise<EditorProject> => project,
    saveProject: async (_id: string, _p: EditorProject): Promise<void> => {},
    subscribe: (_id: string, _onFrame: (p: EditorProject) => void): (() => void) =>
      () => {},
    render: async function* (
      _id: string,
      _opts?: RenderOptions,
    ): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out/p1.mp4' }
    },
    resolveImageSrc: (el: ImageElement): string => el.src,
    compileOverlay: async (_template: string) => () => null,
    listGlobalOverlays: async (): Promise<GlobalOverlay[]> => [],
    listSystemOverlays: async (): Promise<GlobalOverlay[]> => [],
    uploadFile: async (_file: File): Promise<string> => '/path',
    fileUrl: (path: string): string => path,
  }
}

describe('EditorAdapter full contract', () => {
  it('a full adapter implements every required + optional method', () => {
    const a = makeFullAdapter()
    expect(typeof a.listGlobalOverlays).toBe('function')
    expect(typeof a.listSystemOverlays).toBe('function')
    expect(typeof a.uploadFile).toBe('function')
    expect(typeof a.fileUrl).toBe('function')
    expect(typeof a.listProfileOverlays).toBe('function')
    expect(typeof a.getInfo).toBe('function')
    expect(typeof a.generateImage).toBe('function')
  })

  it('a minimal adapter omits the optional methods and still type-checks', () => {
    const a = makeMinimalAdapter()
    expect(a.listProfileOverlays).toBeUndefined()
    expect(a.getInfo).toBeUndefined()
    expect(a.generateImage).toBeUndefined()
    expect(typeof a.listGlobalOverlays).toBe('function')
  })

  it('listGlobalOverlays resolves to GlobalOverlay[]', async () => {
    const a = makeFullAdapter()
    const overlays = await a.listGlobalOverlays()
    expect(overlays[0].name).toBe('caption')
    expect(overlays[0].props[0].type).toBe('string')
  })

  it('fileUrl maps a path to a string url', () => {
    const a = makeFullAdapter()
    expect(a.fileUrl('/ws/p1/x.png')).toContain('/api/files?path=')
  })
})

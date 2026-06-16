import { describe, it, expect } from 'vitest'
import type {
  EditorAdapter,
  RenderEvent,
  RenderOptions,
  VersionEntry,
  WaveformChunk,
} from '../types'
import type { EditorProject, ImageElement } from '../schema'

// ── Video adapter contract ────────────────────────────────────────────────────
// The video editor adds four OPTIONAL adapter methods: listVersionHistory,
// restoreVersion, getWaveformChunks, clearOverlayCache. This file fails to
// compile if those methods are mistyped, and verifies that (a) an adapter
// implementing them type-checks and (b) one omitting them still type-checks.

const project: EditorProject = {
  version: '1',
  id: 'p1',
  status: 'draft' as EditorProject['status'],
  name: 'Fake',
  workflow: 'video',
  editingPrompt: '',
  settings: { resolution: [1080, 1920] },
  assets: [],
  tracks: [[]],
}

const baseRequired = {
  loadProject: async (_id: string): Promise<EditorProject> => project,
  saveProject: async (_id: string, _p: EditorProject): Promise<void> => {},
  subscribe: (_id: string, _onFrame: (p: EditorProject) => void): (() => void) => () => {},
  render: async function* (_id: string, _opts?: RenderOptions): AsyncIterable<RenderEvent> {
    yield { type: 'done', outputPath: '/out/p1.mp4' }
  },
  resolveImageSrc: (el: ImageElement): string => el.src,
  compileOverlay: async (_template: string) => () => null,
  listGlobalOverlays: async () => [],
  listSystemOverlays: async () => [],
  uploadFile: async (_file: File): Promise<string> => '/path',
  fileUrl: (path: string): string => path,
}

// (a) Adapter implementing all four new optional methods.
function makeVideoAdapter(): EditorAdapter<EditorProject> {
  return {
    ...baseRequired,
    listVersionHistory: async (_id: string): Promise<VersionEntry[]> => [
      { hash: 'abc', message: 'init', timestamp: '2026-01-01T00:00:00Z' },
    ],
    restoreVersion: async (_id: string, _hash: string): Promise<EditorProject> => project,
    getWaveformChunks: async (
      _projectId: string,
      _trackId: string,
      _trackSrc: string,
      _chunkDurationS?: number,
    ): Promise<WaveformChunk[]> => [{ path: '/wf/0.png', start: 0, end: 15 }],
    clearOverlayCache: (_src?: string): void => {},
  }
}

// (b) Adapter omitting the new optional methods. Must still type-check.
function makeMinimalAdapter(): EditorAdapter<EditorProject> {
  return { ...baseRequired }
}

describe('EditorAdapter video methods', () => {
  it('an adapter implementing the new optional methods type-checks', async () => {
    const a = makeVideoAdapter()
    expect(typeof a.listVersionHistory).toBe('function')
    expect(typeof a.restoreVersion).toBe('function')
    expect(typeof a.getWaveformChunks).toBe('function')
    expect(typeof a.clearOverlayCache).toBe('function')

    const versions = await a.listVersionHistory!('p1')
    expect(versions[0]).toMatchObject({ hash: 'abc', message: 'init' })

    const chunks = await a.getWaveformChunks!('p1', 't1', 'a.mp3', 15)
    expect(chunks[0]).toMatchObject({ path: '/wf/0.png', start: 0, end: 15 })
  })

  it('an adapter omitting the new optional methods still type-checks', () => {
    const a = makeMinimalAdapter()
    expect(a.listVersionHistory).toBeUndefined()
    expect(a.restoreVersion).toBeUndefined()
    expect(a.getWaveformChunks).toBeUndefined()
    expect(a.clearOverlayCache).toBeUndefined()
  })
})

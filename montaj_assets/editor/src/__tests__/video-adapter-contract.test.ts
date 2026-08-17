import { describe, it, expect } from 'vitest'
import type {
  EditorAdapter,
  RenderEvent,
  RenderExport,
  RenderOptions,
  SampleFrameOptions,
  VersionEntry,
  WaveformChunk,
  PeaksData,
  FilmstripIndex,
} from '../types'
import type { EditorProject, ImageElement } from '../schema'

// ── Video adapter contract ────────────────────────────────────────────────────
// The video editor adds seven OPTIONAL adapter methods: listVersionHistory,
// restoreVersion, getWaveformChunks, clearOverlayCache, getWaveformPeaks,
// getFilmstrip, getSampleFrame. This file fails to compile if those methods are
// mistyped, and verifies that (a) an adapter implementing them type-checks and
// (b) one omitting them still type-checks. It also pins the `RenderOptions`
// shape both `render` and `renderAsync` accept.

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

// (a) Adapter implementing all six new optional methods.
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
    getWaveformPeaks: async ({ samplesPerSecond }): Promise<PeaksData> => ({
      samplesPerSecond,
      start: 0,
      duration: 15,
      peaks: [0, 0],
    }),
    getFilmstrip: async (_args): Promise<FilmstripIndex> => ({
      sheets: [{ path: '/fs/sheet_01.jpg', cols: 10, rows: 1, tiles: [{ t: 0, row: 0, col: 0 }] }],
      interval: 1,
      tileWidth: 160,
    }),
    getSampleFrame: async (
      _projectId: string,
      at: number,
      opts?: SampleFrameOptions,
    ): Promise<{ url: string }> => ({ url: `/files?at=${at}&curve=${opts?.sdrCurve ?? ''}` }),
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
    expect(typeof a.getWaveformPeaks).toBe('function')
    expect(typeof a.getFilmstrip).toBe('function')

    const versions = await a.listVersionHistory!('p1')
    expect(versions[0]).toMatchObject({ hash: 'abc', message: 'init' })

    const chunks = await a.getWaveformChunks!('p1', 't1', 'a.mp3', 15)
    expect(chunks[0]).toMatchObject({ path: '/wf/0.png', start: 0, end: 15 })

    const peaks = await a.getWaveformPeaks!({
      projectId: 'p1',
      src: 'a.mp4',
      samplesPerSecond: 200,
      start: 0,
      duration: 15,
    })
    expect(peaks).toMatchObject({ samplesPerSecond: 200, start: 0, duration: 15 })

    const filmstrip = await a.getFilmstrip!({ projectId: 'p1', src: 'a.mp4' })
    expect(filmstrip.sheets[0]).toMatchObject({ path: '/fs/sheet_01.jpg', cols: 10, rows: 1 })
    expect(filmstrip.sheets[0].tiles[0]).toMatchObject({ t: 0, row: 0, col: 0 })

    // A directly displayable URL: the modal puts it straight into an <img>.
    const sample = await a.getSampleFrame!('p1', 4.5, { sdrCurve: 'vivid1-neutral' })
    expect(sample.url).toBe('/files?at=4.5&curve=vivid1-neutral')
    // Options are optional; the host falls back to its default curve.
    expect((await a.getSampleFrame!('p1', 4.5)).url).toBe('/files?at=4.5&curve=')
  })

  it('an adapter omitting the new optional methods still type-checks', () => {
    const a = makeMinimalAdapter()
    expect(a.listVersionHistory).toBeUndefined()
    expect(a.restoreVersion).toBeUndefined()
    expect(a.getWaveformChunks).toBeUndefined()
    expect(a.clearOverlayCache).toBeUndefined()
    expect(a.getWaveformPeaks).toBeUndefined()
    expect(a.getFilmstrip).toBeUndefined()
    expect(a.getSampleFrame).toBeUndefined()
  })
})

// ── Render options shape ──────────────────────────────────────────────────────
// `export` selects the deliverables for an HDR project; `sdrCurve` names the
// HDR→SDR tone curve (ids live in montaj_assets/luts/looks.json). Both optional,
// so an empty object and an omitted argument stay valid calls.

describe('RenderOptions', () => {
  it('accepts every export mode plus a curve id, and stays fully optional', async () => {
    const modes: RenderExport[] = ['auto', 'sdr', 'both']
    const opts: RenderOptions[] = [
      {},
      { scale: 2 },
      ...modes.map(m => ({ export: m, sdrCurve: 'vivid1' })),
    ]
    expect(opts.map(o => o.export)).toEqual([undefined, undefined, 'auto', 'sdr', 'both'])

    // Both render entry points take the same options object.
    const a = makeVideoAdapter()
    for await (const ev of a.render('p1', { export: 'both', sdrCurve: 'vivid1-neutral' })) {
      expect(ev.type).toBe('done')
    }

    const sampleOpts: SampleFrameOptions = { sdrCurve: 'vivid1' }
    expect(sampleOpts.sdrCurve).toBe('vivid1')
  })
})

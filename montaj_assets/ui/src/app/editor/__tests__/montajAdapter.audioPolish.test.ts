import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── montajAdapter.analyzeAudioPolish ──────────────────────────────────────────
// Maps each `piece` to one of Montaj's audio-polish step CLIs. Arg-shape
// assertions here are the contract between this file and T1's server-side
// `--window-in`/`--window-out`/`--measure-only`/`cuts` work — pin them exactly.

// Hoisted so the vi.mock factory (which runs before module-level consts are
// initialized) can close over the same spy these tests assert on.
const { runStepAsync } = vi.hoisted(() => ({
  runStepAsync: vi.fn(async (_name: string, _params: Record<string, unknown>) => ({})),
}))

vi.mock('@/lib/api', () => ({
  api: { runStepAsync },
  fileUrl: (p: string) => `/api/files?path=${encodeURIComponent(p)}`,
}))

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
  clearOverlayCache: vi.fn(),
}))

vi.mock('@/lib/file-watch', () => ({ watchWorkspaceFile: vi.fn(() => () => {}) }))
vi.mock('@/lib/sse', () => ({ subscribeProjectStream: vi.fn(() => () => {}) }))

import { createMontajAdapter } from '../montajAdapter'

beforeEach(() => { runStepAsync.mockReset() })

describe('montajAdapter.analyzeAudioPolish — silence', () => {
  it('sends rm_nonspeech with the window and every silence option', async () => {
    runStepAsync.mockResolvedValueOnce({ cuts: [{ start: 1, end: 2 }] })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'silence',
      src: '/ws/p1/clip.mp4',
      window: { in: 5, out: 9 },
      options: { language: 'es', model: 'large-v3', maxWordGap: 0.3, sentenceEdge: 0.2 },
    })

    expect(runStepAsync).toHaveBeenCalledWith('rm_nonspeech', {
      input: '/ws/p1/clip.mp4',
      'window-in': 5,
      'window-out': 9,
      language: 'es',
      model: 'large-v3',
      'max-word-gap': 0.3,
      'sentence-edge': 0.2,
    })
    expect(result).toEqual({ piece: 'silence', removals: [{ start: 1, end: 2 }] })
  })

  it('omits window and every option key when the caller passed none', async () => {
    runStepAsync.mockResolvedValueOnce({ cuts: [] })
    const adapter = createMontajAdapter()
    await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'silence', src: '/ws/p1/a.mp4' })

    expect(runStepAsync).toHaveBeenCalledWith('rm_nonspeech', { input: '/ws/p1/a.mp4' })
  })

  it('derives removals from cuts, defaulting to empty when the step omits cuts', async () => {
    runStepAsync.mockResolvedValueOnce({})
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'silence', src: '/ws/p1/a.mp4' })

    expect(result).toEqual({ piece: 'silence', removals: [] })
  })
})

describe('montajAdapter.analyzeAudioPolish — fillers', () => {
  it('sends rm_fillers with the window and language/model, passing text through cuts', async () => {
    runStepAsync.mockResolvedValueOnce({ cuts: [{ start: 1, end: 1.4, text: 'um' }] })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'fillers',
      src: '/ws/p1/a.mp4',
      window: { in: 0, out: 10 },
      options: { language: 'en', model: 'base.en' },
    })

    expect(runStepAsync).toHaveBeenCalledWith('rm_fillers', {
      input: '/ws/p1/a.mp4',
      'window-in': 0,
      'window-out': 10,
      language: 'en',
      model: 'base.en',
    })
    expect(result).toEqual({ piece: 'fillers', removals: [{ start: 1, end: 1.4, text: 'um' }] })
  })

  it('does not send silence-only options (max-word-gap, sentence-edge)', async () => {
    runStepAsync.mockResolvedValueOnce({ cuts: [] })
    const adapter = createMontajAdapter()
    await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'fillers',
      src: '/ws/p1/a.mp4',
      options: { maxWordGap: 0.5, sentenceEdge: 0.1 },
    })

    expect(runStepAsync).toHaveBeenCalledWith('rm_fillers', { input: '/ws/p1/a.mp4' })
  })
})

describe('montajAdapter.analyzeAudioPolish — loudness', () => {
  it('sends normalize in measure-only mode with the window and a custom target', async () => {
    // Plenty of true-peak headroom (-10 dBTP) so the level-difference term
    // wins the gainDb clamp — see the dedicated peak-guard tests below for
    // the branch where the true-peak term wins instead.
    //
    // Fixture uses STRINGS, exactly as normalize.py really emits them:
    // ffmpeg's loudnorm print_format=json prints all five loudnorm-derived
    // fields as JSON strings, not numbers. This is the regression guard for
    // the SP8c crash (AudioPolishModal.tsx calling .toFixed() on a string) —
    // a numeric-only fixture here is what let that bug ship undetected.
    runStepAsync.mockResolvedValueOnce({
      input_i: '-18', input_tp: '-10', input_lra: '5', input_thresh: '-30', target_offset: '0.5', target_i: -14,
    })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'loudness',
      src: '/ws/p1/a.mp4',
      window: { in: 2, out: 8 },
      options: { targetLufs: -14 },
    })

    expect(runStepAsync).toHaveBeenCalledWith('normalize', {
      input: '/ws/p1/a.mp4',
      'measure-only': true,
      'window-in': 2,
      'window-out': 8,
      target: 'custom',
      lufs: -14,
    })
    // Level-difference branch: min(-14 - -18, -1.5 - -10) = min(4, 8.5) = 4.
    expect(result).toEqual({
      piece: 'loudness', measuredI: -18, measuredTP: -10, measuredLRA: 5, targetI: -14, gainDb: 4,
    })
  })

  it('omits target/lufs when the caller gave no targetLufs, keeping the step default preset', async () => {
    // Numeric fixture kept deliberately (alongside the string fixtures used
    // elsewhere in this describe block) so both shapes are covered — this
    // call only asserts what got sent to runStepAsync, not the result.
    runStepAsync.mockResolvedValueOnce({ input_i: -16, input_tp: -10, input_lra: 4, target_i: -14 })
    const adapter = createMontajAdapter()
    await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'loudness', src: '/ws/p1/a.mp4' })

    expect(runStepAsync).toHaveBeenCalledWith('normalize', { input: '/ws/p1/a.mp4', 'measure-only': true })
  })

  it('clamps gainDb to the true-peak guard when a hot peak would otherwise clip (worked example)', async () => {
    // A clip measuring -20 LUFS with a true peak of -0.5 dBTP, targeting -14
    // LUFS — the ordinary shape of headroom-recorded speech. The naive
    // level-difference gain (+6 dB) would push true peak to +5.5 dBTP (hard
    // clipping); the true-peak guard backs it off to -1 dB instead:
    // min(-14 - -20, -1.5 - -0.5) = min(6, -1) = -1.
    // String fixture, matching real normalize.py output.
    runStepAsync.mockResolvedValueOnce({ input_i: '-20', input_tp: '-0.5', input_lra: '6', target_i: -14 })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1', piece: 'loudness', src: '/ws/p1/hot-peak.mp4', options: { targetLufs: -14 },
    })

    expect(result).toEqual({
      piece: 'loudness', measuredI: -20, measuredTP: -0.5, measuredLRA: 6, targetI: -14, gainDb: -1,
    })
  })

  it('the true-peak guard branch can legitimately drive gainDb negative even below-target', async () => {
    // measuredI (-22) is well below targetI (-14) — the clip is quieter than
    // target, so a naive reading would expect a positive boost. But a true
    // peak of -1 dBTP already sits inside the -1.5 dBTP ceiling, so the peak
    // guard (-1.5 - -1 = -0.5) still wins over the level term (+8) and the
    // clip is asked to get QUIETER, not louder. This is correct, not a bug.
    // String fixture, matching real normalize.py output.
    runStepAsync.mockResolvedValueOnce({ input_i: '-22', input_tp: '-1', input_lra: '5', target_i: -14 })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1', piece: 'loudness', src: '/ws/p1/loud-peak.mp4', options: { targetLufs: -14 },
    })

    expect(result).toMatchObject({ gainDb: -0.5 })
  })
})

describe('montajAdapter.analyzeAudioPolish — silence-check', () => {
  it('sends waveform_trim for the whole source: no window, no options exposed', async () => {
    runStepAsync.mockResolvedValueOnce({ input: '/ws/p1/sc1.mp4', keeps: [[0, 5], [6, 10]] })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'silence-check',
      src: '/ws/p1/sc1.mp4',
      // Window and options are passed deliberately, to prove they're dropped.
      window: { in: 1, out: 2 },
      options: { maxWordGap: 0.5, sentenceEdge: 0.1 },
    })

    expect(runStepAsync).toHaveBeenCalledWith('waveform_trim', { input: '/ws/p1/sc1.mp4' })
    expect(result).toEqual({ piece: 'silence-check', keeps: [[0, 5], [6, 10]] })
  })

  it('caches the promise per source: a second call for the same source hits the cache', async () => {
    runStepAsync.mockResolvedValueOnce({ input: '/ws/p1/sc-cache.mp4', keeps: [[0, 5]] })
    const adapter = createMontajAdapter()
    const args = { projectId: 'p1', piece: 'silence-check' as const, src: '/ws/p1/sc-cache.mp4' }

    await adapter.analyzeAudioPolish!(args)
    await adapter.analyzeAudioPolish!(args)

    expect(runStepAsync).toHaveBeenCalledTimes(1)
  })
})

describe('montajAdapter.analyzeAudioPolish — errors', () => {
  it('surfaces a windowed-piece step failure as a rejected promise carrying the server message', async () => {
    runStepAsync.mockRejectedValueOnce(new Error('ffmpeg exploded'))
    const adapter = createMontajAdapter()

    await expect(
      adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'silence', src: '/ws/p1/err.mp4' }),
    ).rejects.toThrow('ffmpeg exploded')
  })
})

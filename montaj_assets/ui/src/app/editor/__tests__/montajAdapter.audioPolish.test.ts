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

describe('montajAdapter.analyzeAudioPolish — voice', () => {
  it('sends stem_separation for the whole source (no window), vocals stem only', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/ws/p1/.cache/stems/p1/xyz/a_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({
      projectId: 'p1',
      piece: 'voice',
      src: '/ws/p1/voice1.mp4',
      // A window is passed deliberately, to prove voice ignores it.
      window: { in: 1, out: 2 },
    })

    // No --out-dir: a vocals stem is a persisted project asset the renderer
    // later reads, not a disposable preview like a filmstrip sheet — so the
    // step's own absolute default (next to the source) is used instead.
    expect(runStepAsync).toHaveBeenCalledWith('stem_separation', {
      input: '/ws/p1/voice1.mp4',
      stems: 'vocals',
    })

    expect(result.piece).toBe('voice')
    if (result.piece === 'voice') {
      expect(result.vocalsPath).toBe('/ws/p1/voice1_stems/vocals.wav')
      expect(result.url).toBe(`/api/files?path=${encodeURIComponent(result.vocalsPath)}`)
    }
  })

  // `vocalsPath` is derived by a private `stripExtension` helper that has to
  // match Python's `os.path.splitext` bit-for-bit — that's a COMPATIBILITY
  // requirement, not defensive coding: `steps/audio/stem_separation.py`
  // computes its own output dir with `os.path.splitext(args.input)[0]`, and
  // any divergence means the client-derived `vocalsPath` (persisted into
  // `project.audio.tracks[].src`, read by the renderer at export) points at
  // a file the step never wrote. Works fine in preview either way — the step
  // still runs — so a wrong path here fails silently until export. Exercised
  // through `voice`'s result rather than exporting the helper just to test it.
  it('derives vocalsPath ignoring a dot in a DIRECTORY name, not just the basename', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/a.b/c/file_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'voice', src: '/a.b/c/file.mp4' })

    expect(result.piece).toBe('voice')
    if (result.piece === 'voice') expect(result.vocalsPath).toBe('/a.b/c/file_stems/vocals.wav')
  })

  it('derives vocalsPath for an extensionless source, unchanged', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/a/b/file_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'voice', src: '/a/b/file' })

    expect(result.piece).toBe('voice')
    if (result.piece === 'voice') expect(result.vocalsPath).toBe('/a/b/file_stems/vocals.wav')
  })

  it('derives vocalsPath for a dotfile with no extension, matching os.path.splitext', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/a/b/.bashrc_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'voice', src: '/a/b/.bashrc' })

    expect(result.piece).toBe('voice')
    if (result.piece === 'voice') expect(result.vocalsPath).toBe('/a/b/.bashrc_stems/vocals.wav')
  })

  it('derives vocalsPath for a dotfile WITH an extension, matching os.path.splitext', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/a/b/.bashrc_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const result = await adapter.analyzeAudioPolish!({ projectId: 'p1', piece: 'voice', src: '/a/b/.bashrc.bak' })

    expect(result.piece).toBe('voice')
    if (result.piece === 'voice') expect(result.vocalsPath).toBe('/a/b/.bashrc_stems/vocals.wav')
  })

  it('caches the promise per source: a second call for the same source hits the cache', async () => {
    runStepAsync.mockResolvedValueOnce({ path: '/ws/p1/voice-cache_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const args = { projectId: 'p1', piece: 'voice' as const, src: '/ws/p1/voice-cache.mp4' }

    await adapter.analyzeAudioPolish!(args)
    await adapter.analyzeAudioPolish!(args)

    expect(runStepAsync).toHaveBeenCalledTimes(1)
  })

  it('rejects with the server message on failure, and does not cache the broken promise', async () => {
    runStepAsync
      .mockRejectedValueOnce(new Error('demucs missing'))
      .mockResolvedValueOnce({ path: '/ws/p1/voice-retry_stems.json', type: 'json' })
    const adapter = createMontajAdapter()
    const args = { projectId: 'p1', piece: 'voice' as const, src: '/ws/p1/voice-retry.mp4' }

    await expect(adapter.analyzeAudioPolish!(args)).rejects.toThrow('demucs missing')
    const result = await adapter.analyzeAudioPolish!(args)

    expect(result.piece).toBe('voice')
    expect(runStepAsync).toHaveBeenCalledTimes(2)
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

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── montajAdapter.generateCaptions ───────────────────────────────────────────
// End-to-end over the real `api.generateCaptions`: only `fetch` is stubbed, so
// these cover both the SSE parse in lib/api.ts and the callback→AsyncIterable
// bridge in the adapter. What matters is that every path terminates the
// iterable — a stream that never ends leaves the CaptionRegenModal hanging.

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
  clearOverlayCache: vi.fn(),
}))
vi.mock('@/lib/file-watch', () => ({ watchWorkspaceFile: vi.fn(() => () => {}) }))
vi.mock('@/lib/sse', () => ({ subscribeProjectStream: vi.fn(() => () => {}) }))

import { createMontajAdapter } from '../montajAdapter'
import type { CaptionEvent } from '@bycrux/editor'

const TRACK = {
  style: 'pop',
  segments: [{ start: 0, end: 1.2, text: 'hello there', words: [] }],
}

/** An SSE response whose body streams `frames` verbatim, then closes. */
function sseResponse(frames: string[]) {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    }),
  }
}

/** A non-streaming JSON error response (what the 409 guard returns). */
function jsonErrorResponse(status: number, detail: unknown) {
  return {
    ok: false,
    status,
    statusText: 'Conflict',
    json: () => Promise.resolve({ detail }),
  }
}

async function drain(iterable: AsyncIterable<CaptionEvent>) {
  const events: CaptionEvent[] = []
  for await (const ev of iterable) events.push(ev)
  return events
}

beforeEach(() => vi.unstubAllGlobals())

describe('montajAdapter.generateCaptions', () => {
  it('streams log frames then a done frame carrying the parsed track, and completes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'event: log\ndata: [build_cut_spec] deriving cut spec\n\n',
      'event: log\ndata: [transcribe] 12%\n\n',
      `event: done\ndata: ${JSON.stringify(TRACK)}\n\n`,
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createMontajAdapter()
    const events = await drain(adapter.generateCaptions!('proj-1'))

    expect(events).toEqual([
      { type: 'log', message: '[build_cut_spec] deriving cut spec' },
      { type: 'log', message: '[transcribe] 12%' },
      { type: 'done', captions: TRACK },
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/proj-1/captions')
  })

  it('POSTs the model / language / style options as a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      `event: done\ndata: ${JSON.stringify(TRACK)}\n\n`,
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createMontajAdapter()
    await drain(adapter.generateCaptions!('proj-1', { model: 'large', language: 'es', style: 'word-by-word' }))

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'large', language: 'es', style: 'word-by-word',
    })
  })

  it('sends no body when the caller passed no options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      `event: done\ndata: ${JSON.stringify(TRACK)}\n\n`,
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createMontajAdapter()
    await drain(adapter.generateCaptions!('proj-1'))
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' })
  })

  it('yields a terminal error event for an error frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: log\ndata: [build_cut_spec] deriving cut spec\n\n',
      'event: error\ndata: multi_source\n\n',
    ])))

    const adapter = createMontajAdapter()
    const events = await drain(adapter.generateCaptions!('proj-1'))

    expect(events).toEqual([
      { type: 'log', message: '[build_cut_spec] deriving cut spec' },
      { type: 'error', message: 'multi_source' },
    ])
  })

  it('surfaces a 409 concurrent_caption_job as one error event without rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonErrorResponse(409, {
      error: 'concurrent_caption_job',
      message: 'A caption job for project proj-1 is already in progress.',
    })))

    const adapter = createMontajAdapter()
    const events = await drain(adapter.generateCaptions!('proj-1'))

    expect(events).toEqual([
      { type: 'error', message: 'A caption job for project proj-1 is already in progress.' },
    ])
  })

  it('turns a malformed done payload into an error event rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: done\ndata: {"style": "pop", oops\n\n',
    ])))

    const adapter = createMontajAdapter()
    const events = await drain(adapter.generateCaptions!('proj-1'))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
    expect((events[0] as { message: string }).message).toMatch(/^Malformed caption payload: /)
  })

  // A server that aborts mid-stream without ever emitting a `done`/`error`
  // frame (e.g. an exception the route doesn't convert to its own SSE error
  // frame) used to leave this iterable hanging forever — no terminal event,
  // `finish()` never called, CaptionRegenModal parked on its progress state
  // with no way out. Without the `sawTerminal` guard in lib/api.ts, `drain`
  // below never resolves and this test fails via timeout rather than a
  // normal assertion failure.
  it('yields a terminal error event and completes when the stream closes with no done/error frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: log\ndata: [transcribe] 12%\n\n',
    ])))

    const adapter = createMontajAdapter()
    const events = await drain(adapter.generateCaptions!('proj-1'))

    expect(events).toEqual([
      { type: 'log', message: '[transcribe] 12%' },
      { type: 'error', message: 'Caption stream ended without a result' },
    ])
  })

  it('still throws for a non-409 failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({ detail: { message: 'project.json for proj-1 not found' } }),
    }))

    const adapter = createMontajAdapter()
    // The rejected fetch promise is caught by the bridge and re-emitted as a
    // terminal error, so the iterable still completes rather than hanging.
    const events = await drain(adapter.generateCaptions!('proj-1'))
    expect(events).toEqual([
      { type: 'error', message: 'project.json for proj-1 not found' },
    ])
  })
})

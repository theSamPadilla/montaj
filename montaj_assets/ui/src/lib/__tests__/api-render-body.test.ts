import { describe, it, expect, beforeEach, vi } from 'vitest'
import { api } from '../api'

// ── api.renderProject request body ────────────────────────────────────────────
// The render route is SSE: the options the RenderModal collected ride on the
// POST that opens the stream. With no options the POST must stay bodyless,
// which is what every pre-existing caller (and an older sidecar) expects.

/** A minimal SSE response that closes immediately. */
function sseResponse() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => Promise.resolve({ done: true, value: undefined }),
        cancel: () => {},
      }),
    },
  }
}

beforeEach(() => vi.unstubAllGlobals())

describe('api.renderProject', () => {
  it('POSTs the export choice and SDR curve as a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await api.renderProject('proj-1', () => {}, () => {}, () => {}, {
      export: 'both',
      sdrCurve: 'vivid1-neutral',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/render')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      export: 'both',
      sdrCurve: 'vivid1-neutral',
    })
  })

  it('sends no body at all when no options were chosen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await api.renderProject('proj-1', () => {}, () => {}, () => {})
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'POST' })

    // An options object with nothing set is the same as no options.
    await api.renderProject('proj-1', () => {}, () => {}, () => {}, {})
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'POST' })
  })

  it('sends only the fields that were set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await api.renderProject('proj-1', () => {}, () => {}, () => {}, { export: 'sdr' })
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ export: 'sdr' })
  })
})

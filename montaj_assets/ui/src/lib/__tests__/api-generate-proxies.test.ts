import { describe, it, expect, beforeEach, vi } from 'vitest'
import { api } from '../api'

// ── api.generateProxies ────────────────────────────────────────────────────
// POSTs to the manual proxy-migration endpoint with no body; the server
// schedules proxy jobs and pushes progress over SSE (not polled here).

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  }
}

beforeEach(() => vi.unstubAllGlobals())

describe('api.generateProxies', () => {
  it('POSTs to /api/projects/:id/proxies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ scheduled: 3, alreadyFresh: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.generateProxies('proj-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/proxies')
    expect((init as RequestInit).method).toBe('POST')
    expect(result).toEqual({ scheduled: 3, alreadyFresh: 1 })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createMontajAdapter } from '../montajAdapter'

describe('montajAdapter.reportContext', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(
      new Response(null, { status: 204, headers: { 'content-length': '0' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('is implemented', () => {
    expect(typeof createMontajAdapter().reportContext).toBe('function')
  })

  it('POSTs the context to the project route', async () => {
    await createMontajAdapter().reportContext!('p1', {
      playheadSec: 12.4, selectedIds: ['c3'], selectedCaptionId: null,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/p1/context')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      playheadSec: 12.4, selectedIds: ['c3'], selectedCaptionId: null,
    })
  })

  it('resolves rather than rejecting when serve errors', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'nope' }), { status: 500 }))
    await expect(
      createMontajAdapter().reportContext!('p1', {
        playheadSec: 1, selectedIds: [], selectedCaptionId: null,
      }),
    ).resolves.toBeUndefined()
  })
})

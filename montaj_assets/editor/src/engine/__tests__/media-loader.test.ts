/**
 * SP4 T2 — `loadBytes`: the injected-`fileUrl` contract.
 *
 * The one thing worth pinning here is that the editor never invents a URL of
 * its own. It is a library; a host path like `/Users/…/orig_proxy_x.mp4` is
 * meaningless to `fetch`, and only the host knows the mapping. These tests
 * assert `fileUrl` is applied to the raw `src` unconditionally — the same
 * handling the legacy `<video>` path already uses in `useVideoPlayback.ts` —
 * so T6 can pass `adapter.fileUrl` straight through with nothing else to
 * reconcile.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadBytes } from '../media-loader'

function okResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadBytes', () => {
  it('resolves the src through fileUrl and fetches that URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetchMock)
    const fileUrl = vi.fn((p: string) => `/api/files?path=${encodeURIComponent(p)}`)

    const bytes = await loadBytes('/Users/sam/proj/orig_proxy_hable1.mp4', fileUrl)

    expect(fileUrl).toHaveBeenCalledWith('/Users/sam/proj/orig_proxy_hable1.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/files?path=%2FUsers%2Fsam%2Fproj%2Forig_proxy_hable1.mp4',
    )
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('applies fileUrl unconditionally — the host owns the mapping, not the editor', async () => {
    // A Hub-shaped adapter returns a presigned absolute URL; the editor must
    // not pre-filter on `src.startsWith('/')` or similar.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse(new Uint8Array([9])))
    vi.stubGlobal('fetch', fetchMock)
    const fileUrl = vi.fn(() => 'https://r2.example/presigned?sig=abc')

    await loadBytes('media/abc123', fileUrl)

    expect(fileUrl).toHaveBeenCalledWith('media/abc123')
    expect(fetchMock.mock.calls[0][0]).toBe('https://r2.example/presigned?sig=abc')
  })

  it('throws with the src and status on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response),
    )

    await expect(loadBytes('/a/missing_proxy.mp4', (p) => p)).rejects.toThrow(
      /\/a\/missing_proxy\.mp4 → 404 Not Found/,
    )
  })

  it('rejects an empty src before touching fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadBytes('', (p) => p)).rejects.toThrow('loadBytes: empty src')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards an AbortSignal so T5 can cancel a load on a clip-boundary swap', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse(new Uint8Array([0])))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await loadBytes('/a/p.mp4', (p) => p, { signal: controller.signal })

    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: controller.signal })
  })

  it('propagates an abort rejection rather than resolving a partial buffer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }),
    )
    const controller = new AbortController()
    controller.abort()

    await expect(loadBytes('/a/p.mp4', (p) => p, { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    )
  })
})

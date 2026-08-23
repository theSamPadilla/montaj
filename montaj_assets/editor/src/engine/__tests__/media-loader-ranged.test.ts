/**
 * `openByteSource`: the ranged half of the byte loader.
 *
 * The acceptance criterion for this whole change is that time-to-first-frame
 * stops tracking FILE SIZE, and the only way that can be true is if the loader
 * never reads bytes nobody asked for. So the assertions here are mostly about
 * what is NOT fetched: how many requests went out, what `Range` headers they
 * carried, and that a second read of the same region issues none at all.
 *
 * The fake host below honours `Range` the way `serve/routes/files.py`'s
 * `FileResponse` does (206 + `Content-Range`), with switches for the two hosts
 * that would not: one that ignores the header and returns 200 + the whole body,
 * and one that returns 206 with an unknown total (`/*`). Both must degrade to
 * the pre-ranged whole-file behavior rather than failing, because a host that
 * cannot serve ranges is a slow preview, not a broken one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  BLOCK_BYTES,
  MAX_CACHED_BYTES,
  PROBE_BYTES,
  openByteSource,
  totalFromContentRange,
} from '../media-loader'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A file whose byte at index i is `i % 251`, so any slice self-identifies. */
function syntheticFile(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

interface HostOptions {
  /** Ignore `Range` entirely and answer 200 with the whole body — the fallback host. */
  ignoreRange?: boolean
  /** Answer 206 but report the total length as `*`. */
  unknownTotal?: boolean
}

interface FakeHost {
  fetch: ReturnType<typeof vi.fn>
  /** Every `Range` header seen, in order. `null` for a request that sent none. */
  ranges: (string | null)[]
  /** Total bytes actually put on the wire — the number this change exists to shrink. */
  served: number
}

function rangeHost(file: Uint8Array, options: HostOptions = {}): FakeHost {
  const host: FakeHost = { fetch: vi.fn(), ranges: [], served: 0 }
  host.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range ?? null
    host.ranges.push(header)
    const m = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null
    if (!m || options.ignoreRange) {
      host.served += file.length
      return response(200, file, null)
    }
    const start = Number(m[1])
    const end = Math.min(Number(m[2]) + 1, file.length)
    const body = file.subarray(start, end)
    host.served += body.length
    const total = options.unknownTotal ? '*' : String(file.length)
    return response(206, body, `bytes ${start}-${end - 1}/${total}`)
  })
  vi.stubGlobal('fetch', host.fetch)
  return host
}

function response(status: number, body: Uint8Array, contentRange: string | null): Response {
  const copy = new ArrayBuffer(body.length)
  new Uint8Array(copy).set(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 206 ? 'Partial Content' : 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-range' ? contentRange : null) },
    arrayBuffer: async () => copy,
  } as unknown as Response
}

describe('totalFromContentRange', () => {
  it('reads the total out of a well-formed header', () => {
    expect(totalFromContentRange('bytes 0-1048575/402653184')).toBe(402653184)
  })

  it('is null for an unknown total, a missing header, or garbage', () => {
    // `*` means the host will not say how long the file is — there is no box
    // walk to do without a length, so the caller falls back rather than guesses.
    expect(totalFromContentRange('bytes 0-99/*')).toBeNull()
    expect(totalFromContentRange(null)).toBeNull()
    expect(totalFromContentRange('')).toBeNull()
    expect(totalFromContentRange('items 0-99/100')).toBeNull()
  })
})

describe('openByteSource — the ranged path', () => {
  it('opens a large file with ONE probe request and knows its full length', async () => {
    const file = syntheticFile(PROBE_BYTES * 6)
    const host = rangeHost(file)

    const source = await openByteSource('/proxies/big_proxy.mp4', (p) => `/api/files?path=${p}`)

    expect(source.ranged).toBe(true)
    expect(source.size).toBe(file.length)
    expect(source.whole).toBeNull()
    expect(host.fetch).toHaveBeenCalledTimes(1)
    expect(host.ranges).toEqual([`bytes=0-${PROBE_BYTES - 1}`])
    // The headline number: opening a 6 MB file moved 1 MB, and opening a 600 MB
    // one would move the same 1 MB.
    expect(host.served).toBe(PROBE_BYTES)
  })

  it('resolves the src through fileUrl, exactly like loadBytes', async () => {
    const host = rangeHost(syntheticFile(PROBE_BYTES * 3))
    const fileUrl = vi.fn(() => 'https://r2.example/presigned?sig=abc')

    await openByteSource('media/abc123', fileUrl)

    expect(fileUrl).toHaveBeenCalledWith('media/abc123')
    expect(host.fetch.mock.calls[0][0]).toBe('https://r2.example/presigned?sig=abc')
  })

  it('serves reads inside the probe window without touching the network', async () => {
    const file = syntheticFile(PROBE_BYTES * 4)
    const host = rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    const head = await source.read(0, 4096)
    const later = await source.read(200_000, 200_064)

    expect(host.fetch).toHaveBeenCalledTimes(1)
    expect(head).toEqual(file.subarray(0, 4096))
    expect(later).toEqual(file.subarray(200_000, 200_064))
  })

  it('range-fetches a read past the probe, block-aligned, and returns the exact slice', async () => {
    const file = syntheticFile(BLOCK_BYTES * 5)
    const host = rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    const start = BLOCK_BYTES * 3 + 17
    const bytes = await source.read(start, start + 100)

    expect(bytes).toEqual(file.subarray(start, start + 100))
    expect(host.fetch).toHaveBeenCalledTimes(2)
    // Rounded out to the enclosing block, not the file: 100 bytes wanted, one
    // block moved, four blocks never touched.
    expect(host.ranges[1]).toBe(`bytes=${BLOCK_BYTES * 3}-${BLOCK_BYTES * 4 - 1}`)
    expect(host.served).toBe(PROBE_BYTES + BLOCK_BYTES)
  })

  it('shares one fetched block between two reads of the same region', async () => {
    // The interleaving case: the frame server pulls a video span and the audio
    // clock then pulls packets that live between those same frames. Block
    // alignment is what stops the second read re-fetching the first read's bytes.
    const file = syntheticFile(BLOCK_BYTES * 4)
    const host = rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    const video = await source.read(BLOCK_BYTES * 2, BLOCK_BYTES * 2 + 500_000)
    const audio = await source.read(BLOCK_BYTES * 2 + 600_000, BLOCK_BYTES * 2 + 600_400)

    expect(host.fetch).toHaveBeenCalledTimes(2)
    expect(video.length).toBe(500_000)
    expect(audio).toEqual(file.subarray(BLOCK_BYTES * 2 + 600_000, BLOCK_BYTES * 2 + 600_400))
  })

  it('coalesces two concurrent reads of the same span into one request', async () => {
    const file = syntheticFile(BLOCK_BYTES * 4)
    const host = rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    const [a, b] = await Promise.all([
      source.read(BLOCK_BYTES * 3, BLOCK_BYTES * 3 + 10),
      source.read(BLOCK_BYTES * 3, BLOCK_BYTES * 3 + 10),
    ])

    expect(host.fetch).toHaveBeenCalledTimes(2)
    expect(a).toEqual(b)
  })

  it('clamps reads to the file and returns empty for a zero-width range', async () => {
    const file = syntheticFile(BLOCK_BYTES * 2 + 10)
    rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    expect(await source.read(file.length - 4, file.length + 9999)).toEqual(file.subarray(-4))
    expect(await source.read(500, 500)).toEqual(new Uint8Array(0))
  })

  it('caps cached bytes so a full scrub costs a bounded amount, not the file size', async () => {
    const blocks = Math.floor(MAX_CACHED_BYTES / BLOCK_BYTES) + 4
    const file = syntheticFile(BLOCK_BYTES * blocks)
    const host = rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    // Walk the file end to end, one block at a time...
    for (let b = 0; b < blocks; b++) await source.read(b * BLOCK_BYTES, b * BLOCK_BYTES + 16)
    const fetchesAfterWalk = host.fetch.mock.calls.length
    // ...then come back to the very first block. If nothing had been evicted
    // this would be a cache hit; the point is that it is NOT, because holding
    // the whole file is exactly the behavior being removed.
    await source.read(0, 16)

    expect(host.fetch.mock.calls.length).toBe(fetchesAfterWalk + 1)
  })

  it('close() drops the cache and refuses further reads', async () => {
    const file = syntheticFile(BLOCK_BYTES * 3)
    rangeHost(file)
    const source = await openByteSource('/p.mp4', (p) => p)

    source.close()

    await expect(source.read(0, 16)).rejects.toThrow(/byte source closed/)
  })

  it('forwards the open signal so a dropped session does not keep a connection', async () => {
    const host = rangeHost(syntheticFile(BLOCK_BYTES * 3))
    const controller = new AbortController()

    await openByteSource('/p.mp4', (p) => p, { signal: controller.signal })

    expect(host.fetch.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
  })

  it('throws with the src and status on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response),
    )

    await expect(openByteSource('/a/missing_proxy.mp4', (p) => p)).rejects.toThrow(
      /\/a\/missing_proxy\.mp4 → 404 Not Found/,
    )
  })

  it('rejects an empty src before touching fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(openByteSource('', (p) => p)).rejects.toThrow('openByteSource: empty src')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('openByteSource — the whole-file fallback', () => {
  it('falls back when the host ignores Range and answers 200', async () => {
    const file = syntheticFile(BLOCK_BYTES * 3)
    const host = rangeHost(file, { ignoreRange: true })

    const source = await openByteSource('/p.mp4', (p) => p)

    expect(source.ranged).toBe(false)
    expect(source.whole).not.toBeNull()
    expect(source.size).toBe(file.length)
    // Everything is already here, so reads are free and no second request ever
    // goes out — the pre-ranged behavior, unchanged.
    expect(await source.read(BLOCK_BYTES * 2, BLOCK_BYTES * 2 + 8)).toEqual(
      file.subarray(BLOCK_BYTES * 2, BLOCK_BYTES * 2 + 8),
    )
    expect(host.fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back when the host answers 206 without a usable total length', async () => {
    const file = syntheticFile(BLOCK_BYTES * 3)
    rangeHost(file, { unknownTotal: true })

    const source = await openByteSource('/p.mp4', (p) => p)

    expect(source.ranged).toBe(false)
    expect(source.size).toBe(PROBE_BYTES)
  })

  it('treats a proxy small enough to arrive whole in the probe as whole-file', async () => {
    const file = syntheticFile(Math.floor(PROBE_BYTES / 2))
    const host = rangeHost(file)

    const source = await openByteSource('/small_proxy.mp4', (p) => p)

    expect(source.ranged).toBe(false)
    expect(source.size).toBe(file.length)
    expect(host.fetch).toHaveBeenCalledTimes(1)
  })
})

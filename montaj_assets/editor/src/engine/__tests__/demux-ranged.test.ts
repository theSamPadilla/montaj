/**
 * Ranged demux: build the sample index from `moov`, fetch `mdat` on demand.
 *
 * The acceptance criterion this change was written against is that
 * time-to-first-frame is INDEPENDENT of proxy size — not merely smaller. So
 * what these tests measure is bytes on the wire, not milliseconds: a source
 * whose moov is 200 KB and whose mdat is hundreds of megabytes must become a
 * fully-indexed `DemuxedSource` having moved only the header, and a decode
 * range must cost only the samples in it.
 *
 * mp4box is mocked, for the same reason `demux-truncated.test.ts` mocks it:
 * vitest/jsdom has no MP4 fixture, and container parsing is mp4box's job, not
 * ours. What IS ours is the streaming loop that hunts `moov` while skipping
 * `mdat`, the sample index built off `trak.samples`, and the on-demand loader —
 * all three of which the fake exercises exactly as the real parser would drive
 * them (`appendBuffer` returning the next wanted file position is mp4box's own
 * streaming contract, see `isofile.js`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROBE_BYTES, BLOCK_BYTES } from '../media-loader'
import { MAX_RESIDENT_VIDEO_BYTES } from '../demux'

// ── the mp4box fake ─────────────────────────────────────────────────────────

interface FakeSample {
  number: number
  track_id: number
  is_sync: boolean
  timescale: number
  dts: number
  cts: number
  duration: number
  size: number
  offset: number
}

interface FakeTrack {
  id: number
  codec: string
  timescale: number
  duration: number
  video?: { width: number; height: number }
  audio?: { sample_rate: number; channel_count: number }
  track_width: number
  track_height: number
}

const script: {
  /**
   * File offset at which the moov becomes parseable. `appendBuffer` fires
   * `onReady` once a fed chunk reaches it, and until then reports that offset
   * as the next wanted position — which is how the real parser skips an mdat
   * that sits in front of the moov.
   */
  moovAt: number
  videoTracks: FakeTrack[]
  audioTracks: FakeTrack[]
  samplesByTrack: Map<number, FakeSample[]>
  /** Samples delivered through `onSamples` on the whole-file path only. */
  deliverOnFlush: boolean
  errors: string[]
  /** Every (fileStart, length) `appendBuffer` was given, in order. */
  appends: { fileStart: number; length: number }[]
} = {
  moovAt: 0,
  videoTracks: [],
  audioTracks: [],
  samplesByTrack: new Map(),
  deliverOnFlush: false,
  errors: [],
  appends: [],
}

vi.mock('mp4box', () => ({
  createFile: () => {
    const file: Record<string, unknown> = {
      onError: undefined,
      onReady: undefined,
      onSamples: undefined,
      setExtractionOptions: () => {},
      start: () => {},
      appendBuffer: (buf: ArrayBuffer & { fileStart: number }) => {
        script.appends.push({ fileStart: buf.fileStart, length: buf.byteLength })
        for (const e of script.errors) (file.onError as (x: string) => void)?.(e)
        if (script.errors.length > 0) return buf.fileStart + buf.byteLength
        const reached =
          buf.fileStart <= script.moovAt && script.moovAt < buf.fileStart + buf.byteLength
        if (reached) {
          ;(file.onReady as (i: unknown) => void)?.({
            videoTracks: script.videoTracks,
            audioTracks: script.audioTracks,
          })
          return buf.fileStart + buf.byteLength
        }
        // Not there yet: tell the caller where the next box actually starts.
        // This is the mdat skip — the whole reason the loop follows the return
        // value instead of reading sequentially.
        return script.moovAt
      },
      flush: () => {
        if (!script.deliverOnFlush) return
        for (const [trackId, samples] of script.samplesByTrack) {
          if (samples.length === 0) continue
          ;(file.onSamples as (t: number, u: unknown, s: unknown[]) => void)?.(
            trackId,
            null,
            samples.map((s) => ({ ...s, data: new Uint8Array(s.size) })),
          )
        }
      },
      getTrackById: (id: number) => ({
        mdia: { minf: { stbl: { stsd: { entries: [] } } } },
        samples: script.samplesByTrack.get(id) ?? [],
      }),
    }
    return file
  },
  DataStream: class {
    static BIG_ENDIAN = false
    static LITTLE_ENDIAN = true
  },
}))

// ── the fake host ───────────────────────────────────────────────────────────

interface FakeHost {
  fetch: ReturnType<typeof vi.fn>
  ranges: (string | null)[]
  served: number
}

function syntheticFile(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return bytes
}

function rangeHost(file: Uint8Array, { ignoreRange = false } = {}): FakeHost {
  const host: FakeHost = { fetch: vi.fn(), ranges: [], served: 0 }
  host.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range ?? null
    host.ranges.push(header)
    const m = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null
    const [start, end] = !m || ignoreRange ? [0, file.length] : [Number(m[1]), Math.min(Number(m[2]) + 1, file.length)]
    const body = file.subarray(start, end)
    host.served += body.length
    const copy = new ArrayBuffer(body.length)
    new Uint8Array(copy).set(body)
    return {
      ok: true,
      status: !m || ignoreRange ? 200 : 206,
      statusText: 'OK',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-range' && m && !ignoreRange
            ? `bytes ${start}-${end - 1}/${file.length}`
            : null,
      },
      arrayBuffer: async () => copy,
    } as unknown as Response
  })
  vi.stubGlobal('fetch', host.fetch)
  return host
}

// ── fixtures ────────────────────────────────────────────────────────────────

function videoTrack(): FakeTrack {
  return {
    id: 1,
    codec: 'avc1.640028',
    timescale: 30000,
    duration: 30000 * 10,
    video: { width: 1280, height: 720 },
    track_width: 1280,
    track_height: 720,
  }
}

/**
 * An all-intra sample table laid out contiguously from `dataStart` — the shape
 * `lib/proxy.py` produces (`-g 1`, every frame a sync sample).
 */
function allIntraSamples(count: number, sampleSize: number, dataStart: number): FakeSample[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i,
    track_id: 1,
    is_sync: true,
    timescale: 30000,
    dts: i * 1000,
    cts: i * 1000,
    duration: 1000,
    size: sampleSize,
    offset: dataStart + i * sampleSize,
  }))
}

beforeEach(() => {
  script.moovAt = 0
  script.videoTracks = [videoTrack()]
  script.audioTracks = []
  script.samplesByTrack = new Map()
  script.deliverOnFlush = false
  script.errors = []
  script.appends = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('demux — ranged', () => {
  it('indexes a huge proxy having fetched only its header', async () => {
    // 64 MB of media behind a faststart moov. Nothing but the probe should move.
    const { demux } = await import('../demux')
    const fileSize = BLOCK_BYTES * 64
    script.samplesByTrack.set(1, allIntraSamples(600, 100_000, PROBE_BYTES))
    const host = rangeHost(syntheticFile(fileSize))

    const source = await demux('/proxies/big_proxy.mp4', (p) => p)

    expect(source.video.samples).toHaveLength(600)
    expect(source.video.codec).toBe('avc1.640028')
    expect(source.video.coded).toEqual({ width: 1280, height: 720 })
    expect(host.fetch).toHaveBeenCalledTimes(1)
    expect(host.served).toBe(PROBE_BYTES)
    // The index is complete and every frame is a keyframe — all-intra survives
    // ranged loading untouched, which is the constraint the whole design is
    // built around.
    expect(source.video.samples.every((s) => s.isKey)).toBe(true)
    expect(source.video.presIndex).toHaveLength(600)
    expect(source.video.firstPresentationTsUs).toBe(0)
  })

  it('costs the same to open whether the proxy is 4 MB or 400 MB', async () => {
    const { demux } = await import('../demux')
    // Sized to fit inside the small file; the big one has 100x the room and
    // must still cost exactly the same to open.
    const samples = allIntraSamples(30, 100_000, PROBE_BYTES)

    script.samplesByTrack.set(1, samples)
    const small = rangeHost(syntheticFile(BLOCK_BYTES * 4))
    await demux('/small.mp4', (p) => p)
    const smallServed = small.served

    script.appends = []
    script.samplesByTrack.set(1, samples)
    const big = rangeHost(syntheticFile(BLOCK_BYTES * 400))
    await demux('/big.mp4', (p) => p)

    expect(big.served).toBe(smallServed)
  })

  it('skips mdat when the moov is at the END of the file', async () => {
    // Not the faststart layout, but a proxy that arrived from somewhere else
    // could have it. mp4box reports where the next box starts; following that
    // is what turns "download 400 MB to reach the moov" into one extra request.
    const { demux } = await import('../demux')
    const fileSize = BLOCK_BYTES * 40
    const moovAt = BLOCK_BYTES * 39
    script.moovAt = moovAt
    script.samplesByTrack.set(1, allIntraSamples(100, 50_000, PROBE_BYTES))
    const host = rangeHost(syntheticFile(fileSize))

    await demux('/tail_moov.mp4', (p) => p)

    expect(script.appends[0].fileStart).toBe(0)
    // The second append starts where mp4box pointed, not one chunk after the
    // first — the 38 MB of mdat in between is never requested.
    expect(script.appends[1].fileStart).toBe(moovAt)
    expect(host.served).toBe(PROBE_BYTES + BLOCK_BYTES)
  })

  it('gives up rather than walking a file with no moov in it', async () => {
    const { demux } = await import('../demux')
    script.moovAt = Number.MAX_SAFE_INTEGER
    rangeHost(syntheticFile(BLOCK_BYTES * 3))

    await expect(demux('/headless.mp4', (p) => p)).rejects.toThrow(/no moov box found/)
  })

  it('surfaces an mp4box parse error with the src attached', async () => {
    const { demux } = await import('../demux')
    script.errors = ['bad box']
    rangeHost(syntheticFile(BLOCK_BYTES * 2))

    await expect(demux('/broken.mp4', (p) => p)).rejects.toThrow(
      /\/broken\.mp4 — mp4box parse error: bad box/,
    )
  })

  it('fails a proxy whose moov describes samples the file is too short to hold', async () => {
    // The §A.14 guard, moved to where a ranged load can see it: with no mdat
    // read there is no "onSamples never fired" signal, so truncation shows up
    // as a sample table that runs past EOF. Failing here routes the clip to the
    // Preparing placeholder instead of freezing on the previous clip's frame.
    const { demux } = await import('../demux')
    const fileSize = BLOCK_BYTES * 4
    script.samplesByTrack.set(1, allIntraSamples(200, 100_000, fileSize - 500_000))
    rangeHost(syntheticFile(fileSize))

    await expect(demux('/truncated.mp4', (p) => p)).rejects.toThrow(
      /truncated or missing mdat/,
    )
  })

  it('fails a moov that describes a video track with no samples at all', async () => {
    const { demux } = await import('../demux')
    script.samplesByTrack.set(1, [])
    rangeHost(syntheticFile(BLOCK_BYTES * 2))

    await expect(demux('/empty.mp4', (p) => p)).rejects.toThrow(/truncated or missing mdat/)
  })

  it('fails when the moov has no video track', async () => {
    const { demux } = await import('../demux')
    script.videoTracks = []
    rangeHost(syntheticFile(BLOCK_BYTES * 2))

    await expect(demux('/audio_only.mp4', (p) => p)).rejects.toThrow(/no video track/)
  })
})

describe('ChunkSource.ensure', () => {
  it('fetches only the byte window a decode range spans', async () => {
    const { demux } = await import('../demux')
    const fileSize = BLOCK_BYTES * 64
    const sampleSize = 100_000
    const dataStart = BLOCK_BYTES * 8
    script.samplesByTrack.set(1, allIntraSamples(500, sampleSize, dataStart))
    const file = syntheticFile(fileSize)
    const host = rangeHost(file)

    const source = await demux('/big.mp4', (p) => p)
    const servedAfterOpen = host.served

    // A seek on an all-intra source plans exactly one sample (`planSeek`:
    // keyframe == target), so this is the real time-to-first-frame cost.
    await source.video.ensure?.(300, 301)

    expect(host.served - servedAfterOpen).toBe(BLOCK_BYTES)
    const at = dataStart + 300 * sampleSize
    expect(source.video.samples[300].data).toEqual(file.subarray(at, at + sampleSize))
    // Only that sample was materialized — neighbours are still index-only.
    expect(source.video.samples[299].data).toHaveLength(0)
    expect(source.video.samples[301].data).toHaveLength(0)
  })

  it('returns null once the range is resident, so the hot path stays synchronous', async () => {
    const { demux } = await import('../demux')
    script.samplesByTrack.set(1, allIntraSamples(500, 100_000, BLOCK_BYTES * 8))
    const host = rangeHost(syntheticFile(BLOCK_BYTES * 64))
    const source = await demux('/big.mp4', (p) => p)

    expect(source.video.ensure?.(10, 20)).toBeInstanceOf(Promise)
    await source.video.ensure?.(10, 20)
    const fetches = host.fetch.mock.calls.length

    expect(source.video.ensure?.(10, 20)).toBeNull()
    expect(source.video.ensure?.(12, 18)).toBeNull()
    expect(host.fetch.mock.calls.length).toBe(fetches)
  })

  it('coalesces two concurrent ensures of the same range into one load', async () => {
    const { demux } = await import('../demux')
    script.samplesByTrack.set(1, allIntraSamples(500, 100_000, BLOCK_BYTES * 8))
    const host = rangeHost(syntheticFile(BLOCK_BYTES * 64))
    const source = await demux('/big.mp4', (p) => p)
    const before = host.fetch.mock.calls.length

    await Promise.all([source.video.ensure?.(40, 50), source.video.ensure?.(40, 50)])

    expect(host.fetch.mock.calls.length).toBe(before + 1)
  })

  it('clamps out-of-range indices instead of reading past the table', async () => {
    const { demux } = await import('../demux')
    script.samplesByTrack.set(1, allIntraSamples(20, 1000, PROBE_BYTES / 2))
    rangeHost(syntheticFile(BLOCK_BYTES * 4))
    const source = await demux('/p.mp4', (p) => p)

    expect(source.video.ensure?.(-5, 0)).toBeNull()
    expect(source.video.ensure?.(100, 200)).toBeNull()
    await source.video.ensure?.(18, 999)
    expect(source.video.samples[19].data).toHaveLength(1000)
  })

  it('releases old sample bytes once the resident budget is exceeded', async () => {
    // The memory half of the acceptance criterion: scrubbing the whole timeline
    // must not end with the whole proxy in memory.
    const { demux } = await import('../demux')
    const sampleSize = BLOCK_BYTES
    const count = Math.floor(MAX_RESIDENT_VIDEO_BYTES / sampleSize) + 8
    script.samplesByTrack.set(1, allIntraSamples(count, sampleSize, 0))
    rangeHost(syntheticFile(sampleSize * count))
    const source = await demux('/long.mp4', (p) => p)

    for (let i = 0; i < count; i++) await source.video.ensure?.(i, i + 1)

    const resident = source.video.samples.reduce((n, s) => n + s.data.length, 0)
    expect(resident).toBeLessThanOrEqual(MAX_RESIDENT_VIDEO_BYTES)
    // The earliest samples were dropped...
    expect(source.video.samples[0].data).toHaveLength(0)
    // ...and the most recent ones are still there, because a caller that just
    // awaited `ensure` reads them synchronously right after.
    expect(source.video.samples[count - 1].data).toHaveLength(sampleSize)
    // Dropped, not lost: asking again reloads.
    expect(source.video.ensure?.(0, 1)).toBeInstanceOf(Promise)
  })

  it('indexes and loads an audio track alongside the video one', async () => {
    const { demux } = await import('../demux')
    script.audioTracks = [
      {
        id: 2,
        codec: 'Opus',
        timescale: 48000,
        duration: 48000 * 10,
        audio: { sample_rate: 48000, channel_count: 2 },
        track_width: 0,
        track_height: 0,
      },
    ]
    // Interleaved with the video: audio packets sit between the frames, which
    // is why the block cache is what stops the two tracks re-fetching each
    // other's bytes.
    script.samplesByTrack.set(1, allIntraSamples(300, 100_000, BLOCK_BYTES * 4))
    script.samplesByTrack.set(
      2,
      Array.from({ length: 300 }, (_, i) => ({
        number: i,
        track_id: 2,
        is_sync: true,
        timescale: 48000,
        dts: i * 960,
        cts: i * 960,
        duration: 960,
        size: 400,
        offset: BLOCK_BYTES * 4 + i * 100_000 + 99_000,
      })),
    )
    const host = rangeHost(syntheticFile(BLOCK_BYTES * 64))

    const source = await demux('/av.mp4', (p) => p)
    await source.video.ensure?.(0, 10)
    const afterVideo = host.fetch.mock.calls.length
    await source.audio?.ensure?.(0, 10)

    expect(source.audio?.kind).toBe('audio')
    expect(source.audio?.audio).toEqual({ sampleRate: 48000, channelCount: 2 })
    expect(source.audio?.samples[3].data).toHaveLength(400)
    // The audio packets lived inside blocks the video pull already cached.
    expect(host.fetch.mock.calls.length).toBe(afterVideo)
  })

  it('closes the byte source on dispose', async () => {
    const { demux } = await import('../demux')
    script.samplesByTrack.set(1, allIntraSamples(50, 1000, PROBE_BYTES / 2))
    rangeHost(syntheticFile(BLOCK_BYTES * 8))
    const source = await demux('/p.mp4', (p) => p)

    source.dispose?.()

    await expect(source.video.ensure?.(40, 45)).rejects.toThrow(/byte source closed/)
  })

  it('closes the byte source when the build is aborted', async () => {
    const { demux } = await import('../demux')
    script.moovAt = Number.MAX_SAFE_INTEGER
    rangeHost(syntheticFile(BLOCK_BYTES * 3))
    const controller = new AbortController()
    const pending = demux('/p.mp4', (p) => p, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow()
  })
})

describe('demux — whole-file fallback', () => {
  it('demuxes through the T2 path when the host ignores Range', async () => {
    const { demux } = await import('../demux')
    script.deliverOnFlush = true
    script.samplesByTrack.set(1, allIntraSamples(40, 1000, 0))
    const host = rangeHost(syntheticFile(BLOCK_BYTES * 2), { ignoreRange: true })

    const source = await demux('/no_range_host.mp4', (p) => p)

    expect(source.video.samples).toHaveLength(40)
    // No `ensure`: the bytes are already in hand, so every reader stays
    // synchronous exactly as it was before ranged loading existed.
    expect(source.video.ensure).toBeUndefined()
    expect(source.dispose).toBeUndefined()
    expect(host.fetch).toHaveBeenCalledTimes(1)
  })
})

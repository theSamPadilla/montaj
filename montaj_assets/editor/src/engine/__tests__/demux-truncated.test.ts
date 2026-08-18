/**
 * A truncated proxy — container header intact, media data missing — must fail
 * the demux loudly instead of yielding an empty-but-"valid" sample table.
 *
 * This is the SP4 parity pass's one outright FAIL (`docs/qa/reference/
 * SP4-PARITY-RESULTS.md` §A.14). A file whose `ftyp` + `moov` parse but whose
 * `mdat` payload is absent makes mp4box fire `onReady` (the track and its
 * sample *table* are described in the moov) and then never fire `onSamples`
 * (there are no bytes to hand out). `demuxBytes` checked for parse errors and
 * for a missing video track, but not for a video track that produced zero
 * samples — so the source was built, `EngineSourceHost` marked the session
 * `ready`, and `scheduler.ts`'s `!source` branch never fired. The surface then
 * stayed on `picture: 'video'` for the clip's whole range: black on seek, and
 * on playback a freeze holding the *previous* clip's last frame while project
 * time advanced. Silently showing the wrong clip's picture is worse than
 * showing black, and §A.14 explicitly rules that outcome out.
 *
 * Failing here routes the clip into the existing failure path, which is
 * already correct: `state.status === 'failed'` → the scheduler's `!source`
 * branch → the Preparing placeholder scoped to that clip's range, with a
 * reason, and the rest of the project unaffected.
 *
 * mp4box is mocked because vitest/jsdom has no MP4 fixture — the same reason
 * `demux.test.ts` restricts itself to the pure sample-table helpers. What is
 * asserted here is our own guard, not mp4box's parsing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeTrack {
  id: number
  codec: string
  timescale: number
  duration: number
  video?: { width: number; height: number }
  track_width?: number
  track_height?: number
}

/** What the fake mp4box should do when `demuxBytes` drives it. */
const script: {
  videoTracks: FakeTrack[]
  /** Samples delivered per track id. Absent id → `onSamples` never fires for it. */
  samplesByTrack: Map<number, unknown[]>
  errors: string[]
} = { videoTracks: [], samplesByTrack: new Map(), errors: [] }

vi.mock('mp4box', () => {
  return {
    createFile: () => {
      const file: Record<string, unknown> = {
        onError: undefined,
        onReady: undefined,
        onSamples: undefined,
        setExtractionOptions: () => {},
        start: () => {},
        // `demuxBytes` appends then flushes. Fire onReady on append (the moov
        // is parsed) and deliver samples on flush — mirroring the real
        // ordering, so a track with no sample data simply never gets a call.
        appendBuffer: () => {
          for (const e of script.errors) (file.onError as (x: string) => void)?.(e)
          ;(file.onReady as (i: unknown) => void)?.({
            videoTracks: script.videoTracks,
            audioTracks: [],
          })
        },
        flush: () => {
          for (const [trackId, samples] of script.samplesByTrack) {
            if (samples.length === 0) continue
            ;(file.onSamples as (t: number, u: unknown, s: unknown[]) => void)?.(
              trackId,
              null,
              samples,
            )
          }
        },
        getTrackById: () => ({
          mdia: { minf: { stbl: { stsd: { entries: [] } } } },
        }),
      }
      return file
    },
  }
})

const { demuxBytes } = await import('../demux')

const videoTrack: FakeTrack = {
  id: 1,
  codec: 'av01.0.05M.08',
  timescale: 30000,
  duration: 300000, // 10s
  video: { width: 1280, height: 720 },
}

/** One mp4box-shaped sample. Ticks, not µs — `toSampleRef` rebases them. */
function rawSample(i: number, timescale = 30000) {
  const dur = timescale / 30
  return {
    cts: i * dur,
    dts: i * dur,
    duration: dur,
    is_sync: true,
    data: new Uint8Array(4),
  }
}

beforeEach(() => {
  script.videoTracks = []
  script.samplesByTrack = new Map()
  script.errors = []
})

describe('demuxBytes — truncated media', () => {
  it('throws when the video track yields no samples (moov intact, mdat missing)', () => {
    script.videoTracks = [videoTrack]
    script.samplesByTrack.set(1, []) // onSamples never fires

    expect(() => demuxBytes(new ArrayBuffer(8), 'truncated.mp4')).toThrow(/no sample data/i)
  })

  it('names the source in the error so the failure is attributable', () => {
    script.videoTracks = [videoTrack]
    script.samplesByTrack.set(1, [])

    expect(() => demuxBytes(new ArrayBuffer(8), 'clip-7-proxy.mp4')).toThrow(/clip-7-proxy\.mp4/)
  })

  it('does NOT throw when samples are present (the guard is not over-broad)', () => {
    script.videoTracks = [videoTrack]
    script.samplesByTrack.set(1, [rawSample(0), rawSample(1), rawSample(2)])

    const out = demuxBytes(new ArrayBuffer(8), 'good.mp4')
    expect(out.video.samples).toHaveLength(3)
    expect(out.video.durationS).toBeCloseTo(10, 5)
  })
})

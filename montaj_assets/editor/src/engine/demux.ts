/**
 * SP4 T2 — demux layer: parse an MP4 container with mp4box.js and expose a
 * flat, codec-agnostic sample index the decode layer (T3) can drive directly
 * with WebCodecs (`EncodedVideoChunk` / `EncodedAudioChunk`).
 *
 * Ported from `spikes/playback-engine/src/demux.ts`. Three patterns come
 * across verbatim in *behavior* because each one is the fix for a measured
 * SP1 defect, not a stylistic choice (`spikes/playback-engine/RESULTS.md`
 * §7):
 *
 *  1. **Decode-order `samples` + a separate `presIndex`** (§7.1, the spike's
 *     most severe bug). The spike originally sorted samples by CTS, which is
 *     presentation order. WebCodecs requires chunks in DECODE order; the
 *     source had B-frames (87 of the first 117 frames), so PTS ≠ DTS and
 *     `VideoDecoder` threw `Decoding error` immediately after the first
 *     keyframe and stayed dead until the worker was respawned. The bug was
 *     invisible on all-intra proxies (decode order == presentation order) —
 *     i.e. it could only ever manifest on the thing being compared against,
 *     which is exactly why it survived to the measurement stage. `samples`
 *     therefore stays in container order forever, and every *time*-based
 *     question bisects `presIndex` instead.
 *  2. **The `esds` AudioSpecificConfig walk.** avcC/hvcC/vpcC/av1C are boxes
 *     that serialize straight back into the bytes WebCodecs wants; `esds` is
 *     a nested descriptor tree that does not, so AAC needs its own walk.
 *     Kept general even though SP3's proxies are avc1+opus (neither of which
 *     needs it): the engine also has to be able to look at whatever else a
 *     host hands it, and the generality costs ~15 lines that are already
 *     written and already tested.
 *  3. **`firstPresentationTsUs` as the t=0 origin contract.** Media
 *     timestamps do not necessarily start at 0, and in decode order
 *     `samples[0]` need not carry the lowest CTS. Every consumer maps
 *     through this one number; T4's clock math is built on it.
 *
 * Deliberate deviations from the spike, each for a stated reason — see the
 * comments at `demuxBytes`, `ChunkSource.audio`, and `fps`.
 */
// mp4box ships no types; `./mp4box.d.ts` supplies them. The explicit
// reference is load-bearing for CONSUMERS of this package: an ambient
// `.d.ts` inside a dependency's `src/` is not auto-included by a host's
// `tsc` (only by this package's own `include: ["src"]`), so without this
// line montaj's ui build fails with TS2307 the moment it pulls in this file.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./mp4box.d.ts" />
import * as MP4Box from 'mp4box'
import type { MP4BoxDescriptor, MP4BoxSampleEntry, MP4Sample, MP4ArrayBuffer } from 'mp4box'
import { loadBytes, type FileUrlResolver, type LoadBytesOptions } from './media-loader'

/** One encoded sample (video frame / audio packet), ready to become an `Encoded*Chunk`. */
export interface SampleRef {
  /**
   * Composition/presentation time (cts) in microseconds.
   *
   * A FLOAT, deliberately: it is `cts / timescale * 1e6` and is left
   * un-rounded so no precision is discarded here. SP1 §7.2 is the reason
   * this is called out — `EncodedVideoChunk.timestamp` is a `long long`, so
   * a chunk fed at `33333.333` comes back off the decoder stamped `33333`,
   * and a naive `frame.timestamp < targetTsUs` pre-roll test rejects the
   * very frame that was requested (~2 of 3 seeks painted nothing). The cure
   * is a 1µs epsilon at the comparison site, which belongs to T3, not here.
   * Rounding at this layer instead would push the same error into the
   * duration/origin arithmetic.
   */
  tsUs: number
  /** Decode time (dts) in microseconds — differs from `tsUs` whenever B-frames are present. */
  dtsUs: number
  /** Sample duration in microseconds. */
  durUs: number
  /** Sync sample (keyframe): decoding may start here. */
  isKey: boolean
  /** The encoded bytes. */
  data: Uint8Array
}

/** A demuxed track: its decoder config plus its full sample index. */
export interface ChunkSource {
  kind: 'video' | 'audio'
  /**
   * The container's codec string, e.g. `av01.0.05M.08`, `hvc1.2.4.L153.B0`,
   * `Opus`, `mp4a.40.2`. Reported verbatim — normalization is the decode
   * layer's job, and it is not cosmetic: mp4box reports `'Opus'` while
   * WebCodecs requires `'opus'`, and `'Opus'.startsWith('opus')` is false,
   * so an un-normalized comparison silently drops every proxy onto the
   * wall-clock fallback (SP1 §7.5). T4 owns `normalizeAudioCodec`.
   */
  codec: string
  /** avcC/hvcC/vpcC/av1C payload, or the esds AudioSpecificConfig, for `*DecoderConfig.description`. */
  description?: Uint8Array
  /**
   * Video: frames per second, derived as `sampleCount / durationS`. Audio:
   * packets per second (kept for symmetry with the spike's shape; it is not
   * a meaningful rate for audio — use `audio.sampleRate`). 0 when the track
   * reports no duration, rather than the spike's `Infinity`/`NaN`.
   */
  fps: number
  durationS: number
  /**
   * Video: the CODED dimensions from the visual sample entry (stsd) — what
   * the decoder emits, which is what the painter draws. Distinct from tkhd's
   * `track_width`/`track_height`, the *display* size after the rotation
   * matrix; on portrait phone footage the two differ. Only `coded` is
   * carried because SP3's proxies are re-encoded by ffmpeg with rotation
   * already baked in, so display == coded for everything the engine opens.
   * `{0, 0}` for audio.
   */
  coded: { width: number; height: number }
  /**
   * Audio tracks only: the real rate/channel count from the container's
   * audio sample entry.
   *
   * Deviation from the spike, deliberate: the spike's `ChunkSource` carried
   * neither, so `audio.ts` hardcoded 48000/2 and flagged it as "load-bearing,
   * not decorative" — `AudioDecoderConfig` requires both fields. mp4box hands
   * them over for free, so T4 gets to read the container instead of assuming
   * it (with 48000/2 still available as the fallback when a container omits
   * them, which is what Opus-in-MP4 conventionally reports anyway).
   */
  audio?: { sampleRate: number; channelCount: number }
  /**
   * The samples in **DECODE order, exactly as the container stores them** —
   * NOT sorted by `tsUs`. This is a contract, not an implementation detail:
   * feeding `VideoDecoder` in presentation order throws on the first
   * non-intra frame (SP1 §7.1). Slice decode ranges out of this array.
   */
  samples: SampleRef[]
  /**
   * Indices into `samples`, ascending by `tsUs` (presentation order).
   * Seeking asks a question about presentation time, so every time→sample
   * lookup bisects this rather than `samples` directly. For all-intra
   * sources (SP3's proxies) it is just `[0, 1, 2, …]`, since cts order ==
   * dts order — which is precisely why a bug here stays invisible until a
   * B-frame source shows up.
   */
  presIndex: number[]
  /**
   * The t=0 origin: presentation time of the earliest frame in this track.
   * Media timestamps need not start at 0, so every conversion between
   * project time and media time subtracts this. Resolved once here so no
   * consumer re-derives it (and so nobody re-derives it as `samples[0].tsUs`,
   * which is the first *decoded* frame and need not carry the lowest cts).
   */
  firstPresentationTsUs: number
}

/** What `demux` returns for one media file: a video track and, if present, an audio track. */
export interface DemuxedSource {
  /** The `src` this was demuxed from — carried for logging and per-source session bookkeeping. */
  src: string
  video: ChunkSource
  audio: ChunkSource | null
}

/**
 * The subset of `ChunkSource` the pure lookups below need. Declared so tests
 * (and callers holding only a sample table) can use them without fabricating
 * a codec string, dimensions and a duration.
 */
export type SampleTable = Pick<ChunkSource, 'samples' | 'presIndex'>

// ── Pure sample-table logic ──────────────────────────────────────────────────

/**
 * Build the presentation-order index over a decode-ordered sample array:
 * `presIndex[k]` is the index in `samples` of the k-th frame by presentation
 * time.
 *
 * `Array.prototype.sort` is stable (spec-guaranteed since ES2019), so samples
 * sharing a `tsUs` keep their relative decode order — the tie-break that
 * matters if a container ever emits duplicate composition times.
 */
export function buildPresIndex(samples: readonly SampleRef[]): number[] {
  return samples.map((_, i) => i).sort((x, y) => samples[x].tsUs - samples[y].tsUs)
}

/**
 * Presentation time of the earliest frame — the natural zero of this track's
 * timeline. Cannot be `samples[0]`: in decode order that is the first
 * *decoded* frame, which with B-frames need not carry the lowest cts.
 * Returns 0 for an empty track.
 */
export function firstPresentationTsUs(
  samples: readonly SampleRef[],
  presIndex: readonly number[],
): number {
  if (samples.length === 0 || presIndex.length === 0) return 0
  return samples[presIndex[0]].tsUs
}

/**
 * DECODE index of the sample whose presentation time is the latest `<= tUs`.
 * Bisects `presIndex` (presentation order) and returns the value it points
 * at (a decode index), which is what a decode range has to be sliced
 * against. For `tUs` before the first frame, returns the earliest frame by
 * presentation time rather than failing.
 */
export function sampleAtOrBefore(src: SampleTable, tUs: number): number {
  const { samples, presIndex } = src
  if (samples.length === 0 || presIndex.length === 0) return 0

  let lo = 0
  let hi = presIndex.length - 1
  let at = presIndex[0]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[presIndex[mid]].tsUs <= tUs) {
      at = presIndex[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return at
}

/**
 * DECODE index of the keyframe to start decoding from in order to display the
 * frame at `tUs`.
 *
 * Walks back through **decode** order, not presentation order. Decoding is a
 * contiguous run of the decode-ordered array starting at a keyframe, and with
 * B-frames the frames needed to reconstruct the target can sit at
 * presentation times *after* it while preceding it in decode order — so a
 * walk that skipped samples with `tsUs > tUs` would step over the very
 * keyframe the run must start at. Returns 0 when the track has no sync sample
 * at or before the target (decode from the top).
 */
export function keyframeAtOrBefore(src: SampleTable, tUs: number): number {
  const samples = src.samples
  if (samples.length === 0) return 0

  const targetIdx = sampleAtOrBefore(src, tUs)
  for (let i = targetIdx; i >= 0; i--) {
    if (samples[i].isKey) return i
  }
  return 0
}

// ── Codec-configuration extraction ───────────────────────────────────────────

/**
 * Tags in the MPEG-4 descriptor tree an `esds` box carries:
 * ES_Descriptor → DecoderConfigDescriptor (0x04) → DecoderSpecificInfo (0x05).
 */
const DECODER_CONFIG_DESCR_TAG = 0x04
const DEC_SPECIFIC_INFO_TAG = 0x05

function findDescriptor(desc: MP4BoxDescriptor | undefined, tag: number): MP4BoxDescriptor | undefined {
  if (!desc?.descs) return undefined
  for (const child of desc.descs) {
    if (child.tag === tag) return child
  }
  return undefined
}

/**
 * Walk the `esds` descriptor tree to the raw AudioSpecificConfig bytes
 * `AudioDecoderConfig.description` wants for AAC. A different code path from
 * the box dump below on purpose: avcC/hvcC/vpcC/av1C are boxes that
 * round-trip through `box.write()`, whereas `esds` is a nested descriptor
 * tree with no such serialization.
 *
 * Returns `undefined` when the tree is absent or truncated — the caller
 * treats a missing description as "cannot configure a decoder for this
 * track", which is the honest outcome (SP1 §6/§7.1 hit exactly this on
 * QuickTime-v1 AAC, where mp4box cannot produce the config at all).
 */
export function audioSpecificConfigFor(entry: MP4BoxSampleEntry): Uint8Array | undefined {
  const esd = entry.esds?.esd
  if (!esd) return undefined
  const dcd = findDescriptor(esd, DECODER_CONFIG_DESCR_TAG)
  const dsi = findDescriptor(dcd, DEC_SPECIFIC_INFO_TAG)
  if (dsi?.data) return new Uint8Array(dsi.data)
  return undefined
}

/**
 * Extract the decoder `description` payload from a track's sample-description
 * entries.
 *
 * The canonical W3C-samples pattern for avcC/hvcC/vpcC/av1C: those
 * sample-entry child boxes serialize straight back into the bytes
 * `VideoDecoderConfig.description` wants, so the box is re-written and its
 * 8-byte header (4-byte size + 4-byte fourcc) stripped. Audio falls through
 * to the `esds` walk above.
 *
 * `undefined` is a legitimate result, not an error: AV1 in some muxes and
 * Opus in MP4 both configure fine without a description.
 */
export function descriptionForEntries(entries: MP4BoxSampleEntry[]): Uint8Array | undefined {
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // strip box header
    }
    const audioDesc = audioSpecificConfigFor(entry)
    if (audioDesc) return audioDesc
  }
  return undefined
}

// ── Demux ────────────────────────────────────────────────────────────────────

/** Convert one mp4box sample into a `SampleRef`, rebasing its ticks onto microseconds. */
function toSampleRef(s: MP4Sample, timescale: number): SampleRef {
  return {
    tsUs: (s.cts / timescale) * 1e6,
    dtsUs: (s.dts / timescale) * 1e6,
    durUs: (s.duration / timescale) * 1e6,
    isKey: !!s.is_sync,
    data: s.data,
  }
}

/**
 * Demux a complete MP4 byte buffer into its video (+ optional audio)
 * `ChunkSource`.
 *
 * **Synchronous, unlike the spike's Promise-wrapped version — deliberately.**
 * The spike wrapped this in `new Promise` because mp4box's API is
 * callback-shaped, then documented in the same file that the callbacks are
 * not actually asynchronous: `appendBuffer()` parses synchronously when
 * handed the whole file in one call, `onReady`/`onSamples` fire inside that
 * call, and `flush()` synchronously drains the remainder — the spike's
 * `resolve()` ran on the same tick regardless. Keeping the Promise would
 * therefore have bought nothing and cost T3 the ability to call this straight
 * from the decode worker, and cost these tests an `await` on every case.
 * Errors surface as a thrown `Error` where the spike rejected; the timing is
 * identical either way.
 *
 * @param label used only in error messages (the `src` that produced `bytes`).
 */
export function demuxBytes(bytes: ArrayBuffer, label = 'media'): DemuxedSource {
  const file = MP4Box.createFile()

  let videoTrackId: number | null = null
  let audioTrackId: number | null = null
  let videoCoded = { width: 0, height: 0 }
  let videoCodec = ''
  let audioCodec = ''
  let audioParams: { sampleRate: number; channelCount: number } | undefined
  let videoTimescale = 1
  let audioTimescale = 1
  let videoDurationTicks = 0
  let audioDurationTicks = 0

  const videoSamples: SampleRef[] = []
  const audioSamples: SampleRef[] = []
  // mp4box reports parse failures through `onError` rather than throwing, so
  // they are collected and re-thrown below. Collected into an array (not a
  // single nullable) so nothing depends on TypeScript's narrowing of a `let`
  // that is only ever written from inside a callback.
  const errors: string[] = []

  file.onError = (e) => {
    errors.push(String(e))
  }

  file.onReady = (info) => {
    const vTrack = info.videoTracks?.[0]
    const aTrack = info.audioTracks?.[0]

    if (vTrack) {
      videoTrackId = vTrack.id
      videoCodec = vTrack.codec
      videoTimescale = vTrack.timescale || 1
      videoDurationTicks = vTrack.duration
      // CODED dimensions (stsd), not tkhd's display size — see
      // `ChunkSource.coded`. `track_width/height` is the fallback only
      // because a 0x0 coded size would break decoder configuration outright.
      videoCoded = {
        width: vTrack.video?.width ?? vTrack.track_width,
        height: vTrack.video?.height ?? vTrack.track_height,
      }
      file.setExtractionOptions(vTrack.id, null, { nbSamples: Infinity })
    }

    if (aTrack) {
      audioTrackId = aTrack.id
      audioCodec = aTrack.codec
      audioTimescale = aTrack.timescale || 1
      audioDurationTicks = aTrack.duration
      if (aTrack.audio) {
        audioParams = {
          sampleRate: aTrack.audio.sample_rate,
          channelCount: aTrack.audio.channel_count,
        }
      }
      file.setExtractionOptions(aTrack.id, null, { nbSamples: Infinity })
    }

    file.start()
  }

  file.onSamples = (trackId, _user, samples) => {
    const target =
      trackId === videoTrackId ? videoSamples : trackId === audioTrackId ? audioSamples : null
    if (!target) return
    const timescale = trackId === videoTrackId ? videoTimescale : audioTimescale
    for (const s of samples) target.push(toSampleRef(s, timescale))
  }

  const buffer = bytes as MP4ArrayBuffer
  buffer.fileStart = 0
  file.appendBuffer(buffer)
  file.flush()

  if (errors.length > 0) {
    throw new Error(`demux: ${label} — mp4box parse error: ${errors.join('; ')}`)
  }
  if (videoTrackId === null) {
    throw new Error(`demux: no video track in ${label}`)
  }
  // A described track that hands out no samples means the moov parsed but the
  // media data is not there — a truncated file, or one whose `mdat` header
  // declares bytes the file does not contain. mp4box reports no error for
  // this: `onReady` fires off the sample table in the moov, and `onSamples`
  // simply never comes.
  //
  // Failing here is load-bearing. An empty table is not a degraded source, it
  // is an unplayable one, and every downstream helper tolerates it silently
  // (`sampleAtOrBefore`/`keyframeAtOrBefore`/`firstPresentationTsUs` all
  // return 0 for an empty table). Left unchecked it built a "valid" source,
  // `EngineSourceHost` marked the session `ready`, and the scheduler's
  // `!source` branch never fired — so the clip's range stayed on
  // `picture: 'video'` and playback froze holding the PREVIOUS clip's last
  // frame while project time advanced. Showing the wrong clip's picture with
  // no error surfaced is the outcome the SP4 checklist §A.14 rules out.
  // Throwing routes the clip into the existing failure path, which already
  // does the right thing: Preparing placeholder, scoped to that clip, with a
  // reason attached.
  if (videoSamples.length === 0) {
    throw new Error(
      `demux: ${label} — video track has no sample data (truncated or missing mdat)`,
    )
  }

  const buildTrack = (
    kind: 'video' | 'audio',
    trackId: number,
    codec: string,
    samples: SampleRef[],
    durationTicks: number,
    timescale: number,
  ): ChunkSource => {
    const presIndex = buildPresIndex(samples)
    const durationS = durationTicks / timescale
    const trak = file.getTrackById(trackId)
    return {
      kind,
      codec,
      description: trak ? descriptionForEntries(trak.mdia.minf.stbl.stsd.entries) : undefined,
      // Guarded against the spike's unguarded divide: a track reporting zero
      // duration produced Infinity (or NaN for an empty track), which then
      // propagated into every downstream frame-budget calculation.
      fps: durationS > 0 ? samples.length / durationS : 0,
      durationS,
      coded: kind === 'video' ? videoCoded : { width: 0, height: 0 },
      ...(kind === 'audio' && audioParams ? { audio: audioParams } : {}),
      samples,
      presIndex,
      firstPresentationTsUs: firstPresentationTsUs(samples, presIndex),
    }
  }

  return {
    src: label,
    video: buildTrack('video', videoTrackId, videoCodec, videoSamples, videoDurationTicks, videoTimescale),
    audio:
      audioTrackId === null
        ? null
        : buildTrack('audio', audioTrackId, audioCodec, audioSamples, audioDurationTicks, audioTimescale),
  }
}

/**
 * Load and demux one media source.
 *
 * `fileUrl` is injected rather than assumed — see `media-loader.ts` for why
 * (and for the ranged-loading follow-up that will eventually replace the
 * whole-file fetch underneath this).
 */
export async function demux(
  src: string,
  fileUrl: FileUrlResolver,
  options: LoadBytesOptions = {},
): Promise<DemuxedSource> {
  const bytes = await loadBytes(src, fileUrl, options)
  return demuxBytes(bytes, src)
}

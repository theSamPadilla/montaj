/**
 * SP4 T2 — hand-written type declarations for `mp4box` (the 0.5.x line).
 *
 * mp4box.js ships no types of its own: its `package.json` has no `types`
 * field, `main` points at a plain-JS UMD bundle (`dist/mp4box.all.js`), and
 * there is no `@types/mp4box` for the 0.5 line. Without this file every
 * `import * as MP4Box from 'mp4box'` is a TS7016 error under `strict`.
 *
 * The spike (`spikes/playback-engine/src/mp4box.d.ts`) got away with the
 * one-liner `declare module 'mp4box';`, which types the whole module as
 * `any`. That is fine for a throwaway harness and wrong for a published
 * package: `@bycrux/editor` ships `src/` and hosts typecheck it, so an `any`
 * module would silently erase every mistake in `demux.ts` — including the
 * exact class of mistake (reading `cts` where `dts` was meant) that SP1 bug
 * §7.1 was. These declarations therefore cover *only what `demux.ts` calls*,
 * typed honestly, and stop there. Everything mp4box can do beyond muxing our
 * proxies is deliberately absent rather than stubbed.
 *
 * This file lives under `src/` on purpose: `package.json`'s `files` list
 * publishes `src`, and `demux.ts` pulls it into any host's program with an
 * explicit `/// <reference path>` (a bare ambient `.d.ts` sitting in a
 * package directory is NOT auto-included by a consumer's `tsc`, only by this
 * package's own `include: ["src"]`).
 *
 * Field names are mp4box's own (snake_case, `is_sync`, `cts`/`dts`) — kept
 * verbatim so this file reads as a description of the library rather than a
 * second naming convention to keep in sync.
 */
declare module 'mp4box' {
  /**
   * mp4box's byte reader/writer. Only used here to re-serialize a codec
   * configuration box (avcC/hvcC/vpcC/av1C) back into the raw bytes
   * `VideoDecoderConfig.description` wants.
   *
   * Note the inverted-looking constants: mp4box models endianness as a
   * boolean where `LITTLE_ENDIAN === true` and `BIG_ENDIAN === false`. They
   * are typed as `boolean` rather than a literal union precisely so nobody
   * is tempted to write `true`/`false` at a call site instead of naming the
   * constant.
   */
  export class DataStream {
    static BIG_ENDIAN: boolean
    static LITTLE_ENDIAN: boolean
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    /** The bytes written so far, trimmed to `position`. */
    buffer: ArrayBuffer
    position: number
    /**
     * Declared for `demux.test.ts`'s stand-in box, which writes a real
     * 8-byte box header + payload so the header-strip in
     * `descriptionForEntries` is asserted against mp4box's actual
     * `DataStream` rather than a hand-rolled imitation of it.
     */
    writeUint8Array(arr: Uint8Array): void
  }

  /**
   * A parsed ISOBMFF box. `write` is the only member `demux.ts` touches: it
   * re-emits the box (8-byte header + payload) into a `DataStream`.
   */
  export interface MP4BoxBox {
    write(stream: DataStream): void
  }

  /**
   * One node of the MPEG-4 descriptor tree mp4box builds while parsing an
   * `esds` box. Unlike the boxes above this is NOT round-trippable with
   * `write()` — it is a nested descriptor tree, which is why extracting an
   * AudioSpecificConfig needs its own walk (see `demux.ts`).
   */
  export interface MP4BoxDescriptor {
    tag: number
    descs?: MP4BoxDescriptor[]
    /** Present on DecoderSpecificInfo (tag 0x05): the raw AudioSpecificConfig bytes. */
    data?: ArrayLike<number>
  }

  /**
   * One entry of a track's sample-description box (`stsd`). Which codec-config
   * child is present depends on the track's codec; all four are optional and
   * `demux.ts` takes the first one it finds.
   */
  export interface MP4BoxSampleEntry {
    avcC?: MP4BoxBox
    hvcC?: MP4BoxBox
    vpcC?: MP4BoxBox
    av1C?: MP4BoxBox
    esds?: { esd?: MP4BoxDescriptor }
  }

  /**
   * The slice of a `trak` box `demux.ts` walks: the `stsd` entries, and the
   * sample list mp4box builds from the sample tables.
   *
   * `samples` is populated by `buildSampleLists()` the moment `moov` finishes
   * parsing — BEFORE any `mdat` byte has been seen — which is what makes ranged
   * loading possible: every sample's `offset`/`size`/`cts`/`dts`/`is_sync` is
   * already known, and only `data` is missing. `demux.ts`'s ranged path reads
   * this array directly instead of going through `setExtractionOptions` +
   * `onSamples`, because the extraction API's whole job is to hand back sample
   * DATA, which is precisely the thing we are trying not to download.
   */
  export interface MP4BoxTrak {
    mdia: { minf: { stbl: { stsd: { entries: MP4BoxSampleEntry[] } } } }
    samples: MP4Sample[]
  }

  /**
   * A track as reported by `onReady`'s info object.
   *
   * `duration` is in this track's own `timescale` (mdhd), not the movie
   * timescale — `movie_duration`/`movie_timescale` carry that pair separately.
   *
   * `track_width`/`track_height` come from tkhd and describe the *display*
   * size after the track's rotation matrix; `video.width`/`video.height` come
   * from the visual sample entry and are the CODED size the decoder needs.
   * On portrait phone footage these differ.
   */
  export interface MP4TrackInfo {
    id: number
    codec: string
    timescale: number
    duration: number
    nb_samples: number
    track_width: number
    track_height: number
    /** Present on video tracks. */
    video?: { width: number; height: number }
    /** Present on audio tracks. */
    audio?: { sample_rate: number; channel_count: number; sample_size: number }
  }

  /** The info object handed to `onReady` once the moov box has been parsed. */
  export interface MP4Info {
    duration: number
    timescale: number
    isFragmented: boolean
    tracks: MP4TrackInfo[]
    videoTracks: MP4TrackInfo[]
    audioTracks: MP4TrackInfo[]
  }

  /**
   * One extracted sample, as delivered to `onSamples` — **in decode order**,
   * exactly as the container stores it. `cts` is presentation time and `dts`
   * decode time, both in the track's timescale; they differ whenever the
   * track carries B-frames.
   */
  export interface MP4Sample {
    number: number
    track_id: number
    is_sync: boolean
    timescale: number
    dts: number
    cts: number
    duration: number
    size: number
    /**
     * Byte offset of this sample's data in the FILE, resolved from
     * `stco`/`co64` + `stsc` while the sample list is built. Known from the
     * moov alone, which is what the ranged loader ranges on.
     */
    offset: number
    /**
     * The sample's encoded bytes. Typed as always-present because it is, on
     * every sample delivered through `onSamples` — mp4box only emits a sample
     * once it has read the data. A sample taken straight off
     * `MP4BoxTrak.samples` is a different animal: mp4box has not filled this in
     * yet, which is exactly why the ranged path reads `offset`/`size` and
     * fetches the bytes itself rather than touching this field.
     */
    data: Uint8Array
  }

  /**
   * An `ArrayBuffer` tagged with its offset in the source file. mp4box reads
   * `fileStart` off every buffer handed to `appendBuffer` to know where the
   * chunk belongs; with a whole-file load it is always 0.
   */
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number
  }

  /** The parser handle returned by `createFile()`. */
  export interface MP4File {
    /** Fires (synchronously, inside `appendBuffer`) once `moov` is parsed. */
    onReady?: (info: MP4Info) => void
    /** Fires with a human-readable message; mp4box does not throw. */
    onError?: (e: string) => void
    /** Fires with a batch of samples in DECODE order for one track. */
    onSamples?: (trackId: number, user: unknown, samples: MP4Sample[]) => void
    /** Returns the next expected `fileStart`. */
    appendBuffer(data: MP4ArrayBuffer): number
    /** Begin emitting samples for tracks registered via `setExtractionOptions`. */
    start(): void
    stop(): void
    /** Synchronously drains any samples not yet emitted. */
    flush(): void
    setExtractionOptions(
      trackId: number,
      user?: unknown,
      options?: { nbSamples?: number; rapAlignement?: boolean },
    ): void
    getTrackById(trackId: number): MP4BoxTrak | undefined
    releaseUsedSamples(trackId: number, sampleNumber: number): void
  }

  /**
   * @param keepMdatData when false, mdat bytes are dropped after parsing.
   *   `demux.ts` leaves it at the default (true) because it extracts every
   *   sample's `data` up front.
   */
  export function createFile(keepMdatData?: boolean): MP4File
}

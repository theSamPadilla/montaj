/**
 * SP4 T2 — byte loader for the playback engine's demuxer.
 *
 * The spike's `media-loader.ts` could hardcode its transport (an Electron
 * `window.montajSpike.readFile` bridge, else `fetch('/media/' + rel)`)
 * because it owned its whole world. `@bycrux/editor` is a library and owns
 * none of it: a host path like `/Users/…/orig_proxy_hable1.mp4` means
 * nothing to a browser, and each host maps it differently (montaj's ui →
 * `/api/files?path=…`; Hub → a presigned R2 URL). The editor already has
 * exactly one primitive for that — `EditorAdapter.fileUrl(path)` — and the
 * legacy player already routes proxy sources through it unconditionally
 * (`useVideoPlayback.ts`: `el.src = fileUrlRef.current(playbackSrcFor(clip))`).
 * So `loadBytes` takes the same function by injection and applies it the same
 * way; T6 threads `adapter.fileUrl` straight through, no adapter change and
 * no new host contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RANGED LOADING — why this module returns a byte SOURCE, not bytes
 * ─────────────────────────────────────────────────────────────────────────
 * T2 shipped `loadBytes`: one `fetch(url).then(r => r.arrayBuffer())` for the
 * whole proxy before a single frame could be decoded. That was correct for the
 * proxies SP3 sized (tens of MB) and it is the engine's clearest scaling limit
 * once they are not — time-to-first-frame grew with FILE SIZE, because nothing
 * decodes until the last byte lands, and every open clip held its full proxy
 * resident. A 2:19 source encoded all-intra is ~400 MB, so "Preparing preview…"
 * sat on screen for as long as that download took, and a silence-trimmed B-roll
 * timeline — fifty clips off one proxy — paid it while needing only a small
 * byte-window each.
 *
 * All-intra is NOT the thing to fix (it is what makes a scrub decode exactly
 * one frame; a GOP was measured ~50% slower per seek and rejected). The fix is
 * to stop reading the file end-to-end: `openByteSource` returns a handle that
 * knows the file's LENGTH and can serve arbitrary byte ranges, so `demux.ts`
 * fetches `moov` (a couple hundred KB, sized by DURATION not bitrate), builds
 * the sample index from it, and then pulls only the `mdat` spans the playhead
 * actually touches. Time-to-first-frame becomes a function of the moov plus one
 * frame's bytes — independent of how big the proxy is.
 *
 * Two properties this deliberately keeps:
 *
 *  - **A whole-file fallback.** A host whose `fileUrl` target ignores `Range`
 *    answers the probe with `200` and the entire body; that is not an error,
 *    it is the old behavior, so the source reports `ranged: false` and serves
 *    every read out of the buffer it already has. montaj's `/api/files` serves
 *    206/416 via Starlette's `FileResponse` and Hub's presigned R2 URLs do it
 *    natively, so this is the rare path, not the common one.
 *  - **Block-aligned caching.** Reads are rounded out to {@link BLOCK_BYTES}
 *    and cached, because the audio and video tracks of one proxy are
 *    INTERLEAVED: the audio packets for a second of media are scattered through
 *    the same megabytes as that second's video frames. Without alignment the
 *    audio clock would re-fetch, byte for byte, spans the frame server had just
 *    pulled. With it they share, and the cache is what bounds resident memory
 *    ({@link MAX_CACHED_BYTES}) instead of the file size doing it.
 */

/**
 * A host path → fetchable URL mapper. Structurally identical to
 * `EditorAdapter['fileUrl']`, declared locally so the engine layer does not
 * take a dependency on the whole adapter surface just to read bytes.
 */
export type FileUrlResolver = (path: string) => string

export interface LoadBytesOptions {
  /**
   * Cancels an in-flight load. T5 terminates a per-source decode session on
   * every clip-boundary swap; a load still running for the source it just
   * left should not keep occupying a connection (or resolve into a session
   * that no longer exists).
   */
  signal?: AbortSignal
}

/**
 * Fetch a media source's complete bytes.
 *
 * No longer the demuxer's path — {@link openByteSource} is (see the module
 * doc). Kept as the package's one-call "give me this file" primitive, and as
 * the thing the whole-file fallback is defined against.
 *
 * `src` is a host path exactly as it appears on a project item (`proxySrc`,
 * `normalizedSrc`, `src`) — it is passed to `fileUrl` unconditionally,
 * matching `useVideoPlayback.ts`'s handling. Hosts whose `fileUrl` is
 * identity for already-absolute URLs get that behavior for free; the engine
 * does not second-guess the mapping.
 *
 * Throws (never returns a partial buffer) on a non-2xx response, so the
 * caller's failure path is a single `catch` — T5 routes a failed proxy load
 * to the same "Preparing preview…" clip state as a proxy that has not
 * arrived yet, rather than reverting the project to the legacy player.
 */
export async function loadBytes(
  src: string,
  fileUrl: FileUrlResolver,
  options: LoadBytesOptions = {},
): Promise<ArrayBuffer> {
  if (!src) throw new Error('loadBytes: empty src')

  const url = fileUrl(src)
  const res = await fetch(url, { signal: options.signal })
  if (!res.ok) {
    throw new Error(`loadBytes: ${src} → ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
  }
  return res.arrayBuffer()
}

// ── Ranged byte source ──────────────────────────────────────────────────────

/**
 * How much of the file the opening probe asks for.
 *
 * Doubles as the range-support test (a host that honours it answers `206` and
 * a `Content-Range` carrying the total length; one that does not answers `200`
 * and the whole file) and as the first read, so a `+faststart` proxy — which
 * ffmpeg writes with `ftyp` and `moov` at the FRONT, see `lib/proxy.py` — is
 * usually parseable after exactly one round trip. Deliberately equal to
 * {@link BLOCK_BYTES} so the probe's bytes land as a normal cache block and the
 * demuxer's first `read` is free rather than a second request for the same
 * megabyte.
 */
export const PROBE_BYTES = 1024 * 1024

/**
 * Read granularity. Every range request is rounded out to a multiple of this,
 * so two tracks reading the same region of an interleaved file hit one cached
 * block instead of issuing two overlapping fetches (see the module doc).
 */
export const BLOCK_BYTES = 1024 * 1024

/**
 * Ceiling on cached file bytes per source. The point of ranged loading is that
 * memory stops tracking file size, so this has to be a hard cap and not a hint:
 * once it is exceeded the least-recently-used spans are dropped, and a source
 * that is scrubbed end to end costs this much, not its own size.
 */
export const MAX_CACHED_BYTES = 8 * 1024 * 1024

/**
 * A random-access handle on one media file.
 *
 * `size` is known before any media data is read — that is the whole point, it
 * is what lets `demux.ts` walk top-level boxes and skip `mdat` instead of
 * downloading it.
 */
export interface MediaByteSource {
  /** The `src` this reads, for error messages. */
  readonly src: string
  /** Total length of the file in bytes. */
  readonly size: number
  /**
   * `true` when the host answered the opening probe with `206 Partial Content`
   * — i.e. reads really are ranged. `false` means the host ignored `Range` and
   * handed over the whole file, which is the T2 behavior preserved as a
   * fallback; {@link whole} is then non-null and no further network I/O happens.
   */
  readonly ranged: boolean
  /** The complete file, on the non-ranged fallback path only; `null` when ranged. */
  readonly whole: ArrayBuffer | null
  /**
   * Bytes for `[start, end)`. Clamped to the file. The returned array may be a
   * view into a cached block, so callers that keep the bytes must copy.
   */
  read(start: number, end: number): Promise<Uint8Array>
  /** Drop every cached byte and abort reads still in flight. Idempotent. */
  close(): void
}

/** One cached, block-aligned span of the file. */
interface CachedSpan {
  start: number
  end: number
  bytes: Uint8Array
}

function alignDown(n: number): number {
  return Math.floor(n / BLOCK_BYTES) * BLOCK_BYTES
}

function alignUp(n: number): number {
  return Math.ceil(n / BLOCK_BYTES) * BLOCK_BYTES
}

/**
 * Total file length out of a `Content-Range: bytes 0-1048575/402653184` header.
 *
 * Returns `null` for a header that is missing, unparseable, or reports the
 * total as `*` (length unknown). The caller treats every one of those the same
 * way — as "this host is not usable for ranged reads" — and falls back to the
 * whole-file load rather than guessing a length it would then walk boxes
 * against.
 */
export function totalFromContentRange(header: string | null | undefined): number | null {
  if (!header) return null
  const m = /^\s*bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)\s*$/i.exec(header)
  if (!m) return null
  const total = Number(m[3])
  return Number.isFinite(total) && total > 0 ? total : null
}

class RangedByteSource implements MediaByteSource {
  readonly whole: ArrayBuffer | null = null
  /** LRU, oldest first — Map insertion order, re-inserted on hit. */
  private readonly spans = new Map<string, CachedSpan>()
  private readonly inflight = new Map<string, Promise<CachedSpan>>()
  private cachedBytes = 0
  private closed = false
  private readonly controller = new AbortController()

  constructor(
    readonly src: string,
    readonly size: number,
    private readonly url: string,
    head: Uint8Array,
    headStart: number,
  ) {
    if (head.length > 0) {
      this.store({ start: headStart, end: headStart + head.length, bytes: head })
    }
  }

  readonly ranged = true

  async read(start: number, end: number): Promise<Uint8Array> {
    const lo = Math.max(0, Math.min(start, this.size))
    const hi = Math.max(lo, Math.min(end, this.size))
    if (hi === lo) return new Uint8Array(0)
    if (this.closed) throw new Error(`read: ${this.src} — byte source closed`)

    const hit = this.find(lo, hi)
    if (hit) return hit.bytes.subarray(lo - hit.start, hi - hit.start)

    const spanStart = alignDown(lo)
    const spanEnd = Math.min(alignUp(hi), this.size)
    const key = `${spanStart}:${spanEnd}`
    let pending = this.inflight.get(key)
    if (!pending) {
      pending = this.fetchSpan(spanStart, spanEnd).finally(() => {
        this.inflight.delete(key)
      })
      this.inflight.set(key, pending)
    }
    const span = await pending
    return span.bytes.subarray(lo - span.start, hi - span.start)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.spans.clear()
    this.cachedBytes = 0
    this.controller.abort()
  }

  private find(start: number, end: number): CachedSpan | null {
    for (const [key, span] of this.spans) {
      if (span.start > start || span.end < end) continue
      // Touch: re-insert so Map iteration order stays oldest-first.
      this.spans.delete(key)
      this.spans.set(key, span)
      return span
    }
    return null
  }

  private async fetchSpan(start: number, end: number): Promise<CachedSpan> {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      signal: this.controller.signal,
    })
    if (!res.ok) {
      throw new Error(
        `read: ${this.src} [${start}-${end - 1}] → ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      )
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // A host that answers `200` to a ranged read handed back the WHOLE file
    // (some proxies drop the header on a retry). Honour what actually arrived
    // rather than the offsets we asked for, so the bytes are still indexed
    // correctly; the span simply covers more of the file than requested.
    const span: CachedSpan =
      res.status === 206
        ? { start, end: start + bytes.length, bytes }
        : { start: 0, end: bytes.length, bytes }
    this.store(span)
    return span
  }

  private store(span: CachedSpan): void {
    if (this.closed || span.bytes.length === 0) return
    const key = `${span.start}:${span.end}`
    const existing = this.spans.get(key)
    if (existing) {
      this.spans.delete(key)
      this.cachedBytes -= existing.bytes.length
    }
    this.spans.set(key, span)
    this.cachedBytes += span.bytes.length
    // Evict oldest-first, but never the span just stored — a read is about to
    // slice out of it.
    while (this.cachedBytes > MAX_CACHED_BYTES && this.spans.size > 1) {
      const oldest = this.spans.keys().next()
      if (oldest.done) break
      const victim = this.spans.get(oldest.value)
      this.spans.delete(oldest.value)
      if (victim) this.cachedBytes -= victim.bytes.length
    }
  }
}

/** The whole-file fallback: a byte source over bytes that are already resident. */
class WholeFileByteSource implements MediaByteSource {
  readonly ranged = false
  readonly size: number
  private view: Uint8Array | null

  constructor(
    readonly src: string,
    readonly whole: ArrayBuffer,
  ) {
    this.size = whole.byteLength
    this.view = new Uint8Array(whole)
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (!this.view) throw new Error(`read: ${this.src} — byte source closed`)
    const lo = Math.max(0, Math.min(start, this.size))
    const hi = Math.max(lo, Math.min(end, this.size))
    return this.view.subarray(lo, hi)
  }

  close(): void {
    this.view = null
  }
}

/**
 * Open a media source for random access.
 *
 * One request goes out: a `Range` read of the first {@link PROBE_BYTES}. It
 * answers three questions at once — does this host do ranged reads, how long is
 * the file, and what is in its first megabyte (which for a `+faststart` proxy is
 * `ftyp` + `moov`, i.e. everything the demuxer needs to build a sample index).
 *
 * A `200` answer means the host ignored `Range` and sent the whole file; that
 * body becomes a {@link WholeFileByteSource} and the caller demuxes it exactly
 * as it did before ranged loading existed. Same for a `206` whose
 * `Content-Range` does not carry a usable total length: without a length there
 * is no box walk to do, so falling back is more honest than guessing.
 *
 * Throws on a non-2xx response, matching {@link loadBytes} so callers keep a
 * single `catch`.
 */
export async function openByteSource(
  src: string,
  fileUrl: FileUrlResolver,
  options: LoadBytesOptions = {},
): Promise<MediaByteSource> {
  if (!src) throw new Error('openByteSource: empty src')

  const url = fileUrl(src)
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    signal: options.signal,
  })
  if (!res.ok) {
    throw new Error(
      `openByteSource: ${src} → ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    )
  }

  const body = await res.arrayBuffer()
  if (res.status !== 206) return new WholeFileByteSource(src, body)

  const total = totalFromContentRange(res.headers?.get?.('Content-Range'))
  if (total === null) return new WholeFileByteSource(src, body)
  // A 206 that already covers the file is the whole file — skip the range
  // machinery for a proxy small enough to arrive in the probe.
  if (body.byteLength >= total) return new WholeFileByteSource(src, body)

  return new RangedByteSource(src, total, url, new Uint8Array(body), 0)
}

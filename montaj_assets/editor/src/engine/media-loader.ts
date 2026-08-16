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
 * WHOLE-FILE LOAD — and the named follow-up that replaces it
 * ─────────────────────────────────────────────────────────────────────────
 * This fetches the *entire* proxy into one ArrayBuffer before demuxing, which
 * is what the spike measured (§6: 30fps sustained, <1GB) and what SP3's
 * proxies are sized for — a CRF-35 AV1 editing proxy of a several-minute
 * source is tens of MB, and the whole point of the proxy tier is that it is
 * small enough to treat this way. It is nonetheless the engine's clearest
 * scaling limit: time-to-first-frame grows with file size (nothing decodes
 * until the last byte lands) and every open clip holds its full proxy
 * resident.
 *
 * FOLLOW-UP (named, deliberately NOT built here): **ranged loading** — issue
 * `Range` requests for `moov` first, build the sample index from it, then
 * fetch mdat byte ranges on demand around the playhead, feeding mp4box
 * incrementally via `appendBuffer` (which already takes a `fileStart` offset
 * for exactly this reason — see `mp4box.d.ts`'s `MP4ArrayBuffer`). Doing it
 * would change this module's contract from "bytes" to "byte source" and would
 * additionally require every host's `fileUrl` target to honour
 * `Accept-Ranges` — montaj's `/api/files` and Hub's presigned R2 URLs both
 * need checking, which is why it is a follow-up with a real investigation in
 * front of it rather than a stretch goal inside T2.
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

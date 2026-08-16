/**
 * SP3 fix B2 — proxy playback capability gate + per-session failure suppression.
 *
 * Editing proxies are AV1+Opus in MP4. Not every browser decodes that
 * (Safari on pre-M3 Macs has no AV1 decode and no Opus-in-MP4 at all), and a
 * `<video>` element given an undecodable src fails SILENTLY — a black preview
 * with no event the user can act on. Two defenses, both editor-side so
 * timeline-core stays pure (no environment probing in the resolver):
 *
 *   1. Capability gate: probed once per session. Unsupported ⇒ `gateProxy()`
 *      strips `proxySrc` from the item BEFORE src selection, so the tier
 *      chain falls through to normalizedSrc/src exactly as if no proxy
 *      existed.
 *   2. Failure suppression: when a proxy that passed the probe still fails to
 *      decode (corrupt file, dangling pointer after an out-of-band delete),
 *      the error handler marks that proxySrc failed for the rest of the
 *      session and the player reloads the clip without its proxy tier.
 *
 * jsdom note: the vitest environment stubs `canPlayType` to report support
 * (see src/test-setup.ts) so the existing proxy-selection tests keep meaning;
 * the unsupported path is tested via `__setProxySupportForTests`.
 */

const PROXY_MIME = 'video/mp4; codecs="av01.0.05M.08, opus"'

let supportedCache: boolean | null = null

export function proxyPlaybackSupported(): boolean {
  if (supportedCache !== null) return supportedCache
  if (typeof document === 'undefined') {
    supportedCache = false
    return supportedCache
  }
  let ok = false
  try {
    const ms = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
    if (ms?.isTypeSupported?.(PROXY_MIME)) {
      ok = true
    } else {
      ok = document.createElement('video').canPlayType(PROXY_MIME) !== ''
    }
  } catch {
    ok = false
  }
  supportedCache = ok
  return supportedCache
}

/** Test hook: force (true/false) or reset (null) the cached probe result. */
export function __setProxySupportForTests(value: boolean | null): void {
  supportedCache = value
}

const failedProxies = new Set<string>()

/** Record a proxy file that failed to decode this session. */
export function markProxyFailed(proxySrc: string): void {
  failedProxies.add(proxySrc)
}

/** True when this item's proxy is present, supported, and not failed. */
export function isProxyUsable(proxySrc: string | undefined): boolean {
  return !!proxySrc && proxyPlaybackSupported() && !failedProxies.has(proxySrc)
}

/** Test hook: clear the per-session failure set. */
export function __clearFailedProxiesForTests(): void {
  failedProxies.clear()
}

/**
 * Return the item as-is when its proxy is usable, otherwise a shallow copy
 * with `proxySrc` removed — the input object is never mutated (it is shared
 * project state).
 */
export function gateProxy<T extends { proxySrc?: string }>(item: T): T {
  if (!item.proxySrc || isProxyUsable(item.proxySrc)) return item
  const gated = { ...item }
  delete (gated as { proxySrc?: string }).proxySrc
  return gated
}

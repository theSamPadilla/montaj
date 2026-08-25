/** SP3 fix B2 — capability gate + failure suppression. */
import { describe, it, expect, afterEach } from 'vitest'
import {
  gateProxy,
  isProxyUsable,
  markProxyFailed,
  proxyPlaybackSupported,
  __clearFailedProxiesForTests,
  __setProxySupportForTests,
} from '../proxySupport'

afterEach(() => {
  __setProxySupportForTests(null)
  __clearFailedProxiesForTests()
})

describe('proxyPlaybackSupported', () => {
  it('reports supported under the test-setup canPlayType stub', () => {
    __setProxySupportForTests(null)
    expect(proxyPlaybackSupported()).toBe(true)
  })

  it('probes for the codec the proxies are actually encoded in', () => {
    // PROXY_MIME is module-private, so pin it where it is observable: the
    // string handed to the capability probe. Without this, nothing in the
    // suite ties the gate to the encoder — `lib/proxy.py` could move to a new
    // codec and every test here would still pass while the editor silently
    // judged real proxies undecodable (or worse, decodable on stale evidence).
    __setProxySupportForTests(null)
    const seen: string[] = []
    const ms = (globalThis as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
    const realIsTypeSupported = ms?.isTypeSupported
    const realCanPlayType = HTMLMediaElement.prototype.canPlayType
    if (ms) ms.isTypeSupported = (t: string) => { seen.push(t); return true }
    HTMLMediaElement.prototype.canPlayType = function (t: string) { seen.push(t); return 'probably' }
    try {
      proxyPlaybackSupported()
    } finally {
      if (ms) ms.isTypeSupported = realIsTypeSupported
      HTMLMediaElement.prototype.canPlayType = realCanPlayType
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('video/mp4; codecs="avc1.640028, opus"')
  })
})

describe('gateProxy', () => {
  const item = { id: 'c1', src: '/a/orig.mov', proxySrc: '/a/orig_proxy_hable1.mp4' }

  it('passes the item through untouched when the proxy is usable', () => {
    __setProxySupportForTests(true)
    expect(gateProxy(item)).toBe(item) // same reference — no needless copies
  })

  it('strips proxySrc when playback is unsupported, without mutating the input', () => {
    __setProxySupportForTests(false)
    const gated = gateProxy(item)
    expect(gated.proxySrc).toBeUndefined()
    expect(gated.src).toBe('/a/orig.mov')
    expect(item.proxySrc).toBe('/a/orig_proxy_hable1.mp4') // input untouched
  })

  it('strips proxySrc after the proxy is marked failed, even when supported', () => {
    __setProxySupportForTests(true)
    markProxyFailed(item.proxySrc)
    expect(isProxyUsable(item.proxySrc)).toBe(false)
    expect(gateProxy(item).proxySrc).toBeUndefined()
  })

  it('leaves proxy-less items alone regardless of support', () => {
    __setProxySupportForTests(false)
    const plain: { id: string; src: string; proxySrc?: string } = { id: 'c2', src: '/b/orig.mov' }
    expect(gateProxy(plain)).toBe(plain)
  })
})

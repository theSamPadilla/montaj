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
    const plain = { id: 'c2', src: '/b/orig.mov' }
    expect(gateProxy(plain)).toBe(plain)
  })
})

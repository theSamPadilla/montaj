/**
 * SP4 T1 — eligibility gate: pure project-shape check + the (mockable)
 * WebCodecs capability probe. `proxySupport.test.ts` is the style precedent
 * (independent module-level cache, reset per test via a `__setXForTests`
 * hook). jsdom has no WebCodecs at all, so `VideoDecoder`/`AudioDecoder` are
 * stubbed directly on `globalThis` per test, mirroring how
 * `VideoEditor.test.tsx` stubs `AudioContext`/`ResizeObserver`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  checkProjectShapeEligibility,
  engineCapabilitySupported,
  evaluateEngineEligibility,
  __setEngineCapabilityForTests,
} from '../eligibility'
import type { EditorProject as Project, VisualItem } from '../../schema'

function project(clips: VisualItem[]): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items: clips }],
  }
}

function clip(overrides: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c1', type: 'video', start: 0, end: 5, proxySrc: '/a/orig_proxy_hable1.mp4', ...overrides }
}

function stubVideoDecoder(supported: boolean) {
  ;(globalThis as unknown as { VideoDecoder: Pick<typeof VideoDecoder, 'isConfigSupported'> }).VideoDecoder = {
    isConfigSupported: async () => ({ supported }),
  }
}

function stubAudioDecoder(supported: boolean) {
  ;(globalThis as unknown as { AudioDecoder: Pick<typeof AudioDecoder, 'isConfigSupported'> }).AudioDecoder = {
    isConfigSupported: async () => ({ supported }),
  }
}

afterEach(() => {
  __setEngineCapabilityForTests(null)
  delete (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder
  delete (globalThis as unknown as { AudioDecoder?: unknown }).AudioDecoder
})

describe('checkProjectShapeEligibility', () => {
  it('is eligible when every track-0 video item has proxySrc and no nobg_preview_src', () => {
    expect(checkProjectShapeEligibility(project([clip(), clip({ id: 'c2' })]))).toEqual({ eligible: true })
  })

  it('is vacuously eligible when track-0 has no video items (canvas-only project)', () => {
    expect(checkProjectShapeEligibility(project([]))).toEqual({ eligible: true })
  })

  it('ignores non-video track-0 items (background images) entirely', () => {
    const bg: VisualItem = { id: 'img1', type: 'image', start: 0, end: 5 }
    expect(checkProjectShapeEligibility(project([bg, clip()]))).toEqual({ eligible: true })
  })

  it('reports missing proxy', () => {
    const result = checkProjectShapeEligibility(project([clip({ proxySrc: undefined })]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/proxySrc/)
  })

  it('reports a nobg item even when it also has proxySrc', () => {
    const result = checkProjectShapeEligibility(project([clip({ nobg_preview_src: '/a/nobg.webm' })]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/nobg_preview_src/)
  })

  it('stops at the first disqualifying clip (does not need to scan every item)', () => {
    const result = checkProjectShapeEligibility(project([clip({ id: 'bad', proxySrc: undefined }), clip({ id: 'ok' })]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('bad')
  })
})

describe('engineCapabilitySupported', () => {
  it('is false when WebCodecs is absent (jsdom has no VideoDecoder/AudioDecoder)', async () => {
    expect(await engineCapabilitySupported()).toBe(false)
  })

  it('probes and caches VideoDecoder+AudioDecoder support (second call does not re-probe)', async () => {
    let videoCalls = 0
    ;(globalThis as unknown as { VideoDecoder: Pick<typeof VideoDecoder, 'isConfigSupported'> }).VideoDecoder = {
      isConfigSupported: async () => { videoCalls++; return { supported: true } },
    }
    stubAudioDecoder(true)

    expect(await engineCapabilitySupported()).toBe(true)
    expect(await engineCapabilitySupported()).toBe(true)
    expect(videoCalls).toBe(1)
  })

  it('is false when the video codec is unsupported even if audio is', async () => {
    stubVideoDecoder(false)
    stubAudioDecoder(true)
    expect(await engineCapabilitySupported()).toBe(false)
  })

  it('is false when the audio codec is unsupported even if video is', async () => {
    stubVideoDecoder(true)
    stubAudioDecoder(false)
    expect(await engineCapabilitySupported()).toBe(false)
  })

  it('never throws — a probe that rejects resolves to false', async () => {
    ;(globalThis as unknown as { VideoDecoder: Pick<typeof VideoDecoder, 'isConfigSupported'> }).VideoDecoder = {
      isConfigSupported: async () => { throw new Error('boom') },
    }
    stubAudioDecoder(true)
    await expect(engineCapabilitySupported()).resolves.toBe(false)
  })
})

describe('evaluateEngineEligibility', () => {
  it('all-good: shape passes and capability passes', async () => {
    __setEngineCapabilityForTests(true)
    expect(await evaluateEngineEligibility(project([clip()]))).toEqual({ eligible: true })
  })

  it('unsupported codec: shape passes but the capability probe fails', async () => {
    __setEngineCapabilityForTests(false)
    const result = await evaluateEngineEligibility(project([clip()]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/WebCodecs/)
  })

  it('missing proxy: shape fails before the capability probe is even consulted', async () => {
    __setEngineCapabilityForTests(true)
    const result = await evaluateEngineEligibility(project([clip({ proxySrc: undefined })]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/proxySrc/)
  })

  it('nobg item: shape fails regardless of capability', async () => {
    __setEngineCapabilityForTests(true)
    const result = await evaluateEngineEligibility(project([clip({ nobg_preview_src: '/a/nobg.webm' })]))
    expect(result.eligible).toBe(false)
    expect(result.reason).toMatch(/nobg_preview_src/)
  })
})

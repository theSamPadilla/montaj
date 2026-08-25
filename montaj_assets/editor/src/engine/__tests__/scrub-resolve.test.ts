/**
 * The scrubber's resolver mirrors `planTick`'s track-0 precedence, so its
 * null branches are the ones worth pinning: gap, canvas project, missing
 * proxy, higher-precedence src the engine can't decode. The happy path
 * (proxied track-0 clip) is covered indirectly by `scheduler.test.ts` and
 * directly by the T5 wiring tests.
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'
import { createScrubResolver } from '../scrub-resolve'

function clip(id: string, start: number, end: number, extra: Partial<VisualItem> = {}): VisualItem {
  return {
    id,
    type: 'video',
    src: `/media/${id}.mov`,
    proxySrc: `/proxies/${id}_proxy.mp4`,
    start,
    end,
    inPoint: 0,
    outPoint: end - start,
    ...extra,
  }
}

function overlay(id: string, start: number, end: number): VisualItem {
  return { id, type: 'overlay', src: `/overlays/${id}.jsx`, start, end }
}

function project(track0: VisualItem[], overlays: VisualItem[] = []): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: overlays.length > 0 ? [track0, overlays] : [track0],
  } as unknown as Project
}

describe('createScrubResolver', () => {
  it('returns null when the getter yields no project', () => {
    const resolve = createScrubResolver(() => null)
    expect(resolve(0)).toBeNull()
  })

  it('returns null in a gap between track-0 clips', () => {
    const p = project([clip('a', 0, 2), clip('b', 5, 7)])
    const resolve = createScrubResolver(() => p)
    expect(resolve(3)).toBeNull()
  })

  it('returns null on a canvas project (no track-0 video items)', () => {
    const p = project([], [overlay('o', 0, 5)])
    const resolve = createScrubResolver(() => p)
    expect(resolve(1)).toBeNull()
  })

  it('returns null for a clip with no proxySrc yet', () => {
    const p = project([clip('a', 0, 4, { proxySrc: undefined })])
    const resolve = createScrubResolver(() => p)
    expect(resolve(1)).toBeNull()
  })

  it('returns null when a higher-precedence preview src outranks the proxy', () => {
    // `nobg_preview_src` beats `proxySrc` in the preview chain; the engine's
    // demuxer is MP4-only, so `engineSrcFor` blocks it and the scrubber goes
    // silent — same rule that keeps the whole project on <video> fallback.
    const p = project([clip('a', 0, 4, { nobg_preview_src: '/proxies/a_nobg.webm' })])
    const resolve = createScrubResolver(() => p)
    expect(resolve(1)).toBeNull()
  })

  it('resolves to the proxy src and source-media time on the happy path', () => {
    const c = clip('a', 2, 6, { inPoint: 10, outPoint: 14 })
    const p = project([c])
    const resolve = createScrubResolver(() => p)
    // projectS=3 is 1s into the clip; mediaS = inPoint + 1 = 11.
    expect(resolve(3)).toEqual({ src: c.proxySrc, mediaS: 11 })
  })

  it('picks the earliest-start clip on overlap (mirrors planTick tiebreak)', () => {
    const early = clip('early', 0, 5)
    const late = clip('late', 3, 8)
    const p = project([early, late])
    const resolve = createScrubResolver(() => p)
    const out = resolve(4)
    expect(out?.src).toBe(early.proxySrc)
  })

  it('re-reads the project on every call so edits are observed', () => {
    let current: Project = project([clip('a', 0, 4)])
    const resolve = createScrubResolver(() => current)
    expect(resolve(1)).not.toBeNull()
    current = project([])
    expect(resolve(1)).toBeNull()
  })
})

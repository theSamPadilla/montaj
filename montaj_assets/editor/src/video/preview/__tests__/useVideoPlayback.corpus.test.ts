import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { containsTime, resolveAt, sourceWindow } from '@bycrux/timeline-core'
import { useVideoPlayback } from '../useVideoPlayback'
import { engineSrcFor } from '../../../engine/scheduler'
import { withItemTracks } from '../../timeline/timeline-model'
import type { EditorProject, VisualItem } from '../../../schema'

// The fixture is imported by RELATIVE path, not as `@bycrux/timeline-core/fixtures/…`:
// the package's `exports` map declares only the `"."` entry, so subpath imports are
// not part of its public API and T6 does not get to widen it. Everything else in this
// file goes through the package's real barrel.
import negativeStart from '../../../../../timeline-core/fixtures/negative-start.json'
// SP3: T4's proxySrc-tier fixture — four tracks[0] clips spanning every
// combination of {proxySrc, nobg_preview_src} presence (proxy-00 neither,
// proxy-01 proxySrc only, proxy-10 nobg_preview_src only, proxy-11 both, where
// nobg wins). Its resolver golden lives at
// timeline-core/expected/proxy-matrix.json and is exercised end-to-end by
// timeline-core's own corpus.test.mjs; what's checked HERE is the same parity
// contract as negative-start above — that the editor hook's derived `clips`
// collection agrees with `resolveAt`/`sourceWindow` — now covering the new tier.
import proxyMatrix from '../../../../../timeline-core/fixtures/proxy-matrix.json'
import proxyMatrixExpected from '../../../../../timeline-core/expected/proxy-matrix.json'

// ── Corpus parity: useVideoPlayback's derived collections vs. the resolver ────
//
// `useVideoPlayback` does not expose a Scene. It exposes the editor's own
// PARTITION of the timeline — `clips` (tracks[0] videos, sorted by start),
// `tracks0NonVideo` (everything else on tracks[0]) and `overlayTracks`
// (tracks[1..]) — and each consumer applies the activation predicate itself.
// This test reassembles those three collections back into a flat, ordered scene
// and asserts it is exactly what `resolveAt(project, t, {variant: 'preview'})`
// reports: same items, same track indices, same kinds, same source windows.
//
// `negative-start.json` is the corpus's "background reel anchored before the
// origin" case: a tracks[0] video over [0, 6) with a tracks[1] JSX overlay over
// [-0.5, 5.5). It exercises the partition (a clip AND an overlay track), the
// half-open predicate at both ends, and a negative `start` — while keeping ONE
// item per track, so the same-trackIdx tie-order divergence (D7 in
// KNOWN-DIVERGENCES.md) can't muddy the comparison.
const project = negativeStart as unknown as EditorProject

// -0.25 → overlay only (before the clip starts, after the overlay does)
//  2.00 → both on screen
//  5.75 → clip only (the overlay ended at 5.5; the clip runs to 6)
const TIMESTAMPS = [-0.25, 2.0, 5.75]

interface FlatItem {
  id: string
  trackIdx: number
  kind: string
}

/**
 * Reassemble the editor's three derived collections into the resolver's flat,
 * back-to-front scene: track 0 first, then each overlay track in order. Track
 * indices are absolute (overlayTracks[0] is project track 1) because that is
 * what `ResolvedItem.trackIdx` reports.
 */
function editorSceneAt(
  derived: {
    clips: VisualItem[]
    tracks0NonVideo: VisualItem[]
    overlayTracks: VisualItem[][]
  },
  t: number,
): FlatItem[] {
  const flat: FlatItem[] = []
  const push = (items: VisualItem[], trackIdx: number) => {
    for (const item of items) {
      if (containsTime(item.start, item.end, t)) flat.push({ id: item.id, trackIdx, kind: item.type })
    }
  }
  push(derived.clips, 0)
  push(derived.tracks0NonVideo, 0)
  derived.overlayTracks.forEach((items, i) => push(items, i + 1))
  return flat.sort((a, b) => a.trackIdx - b.trackIdx)
}

// `proj` defaults to the negative-start fixture so every existing call site
// below is unchanged; the proxy-matrix block passes its own project explicitly.
function resolverSceneAt(t: number, proj: EditorProject = project): FlatItem[] {
  return resolveAt(withItemTracks(proj), t, { variant: 'preview' }).items.map((r) => ({
    id: r.item.id as string,
    trackIdx: r.trackIdx,
    kind: r.kind,
  }))
}

// Testing Library auto-cleans between tests, so the hook is mounted fresh per
// case at the timestamp under test rather than reused and re-rendered.
function derivedAt(t: number, proj: EditorProject = project) {
  return renderHook(() => useVideoPlayback(proj, t, () => {}, (p) => p)).result.current
}

describe('useVideoPlayback derived collections vs. resolveAt (negative-start corpus fixture)', () => {
  it.each(TIMESTAMPS)('agrees on what is on screen at t=%s', (t) => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(t)
    expect(editorSceneAt({ clips, tracks0NonVideo, overlayTracks }, t)).toEqual(resolverSceneAt(t))
  })

  it('splits the fixture the way the resolver labels it', () => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(TIMESTAMPS[1])
    expect(clips.map((c) => c.id)).toEqual(['mainClip'])
    expect(tracks0NonVideo).toEqual([])
    expect(overlayTracks.map((tr) => tr.map((i) => i.id))).toEqual([['bgReel']])
  })

  it.each(TIMESTAMPS)('seeks the active clip where the resolver says, at t=%s', (t) => {
    const { clips } = derivedAt(t)
    const scene = resolveAt(withItemTracks(project), t, { variant: 'preview' })
    const videos = scene.items.filter((r) => r.kind === 'video')
    // t=-0.25 is before the only clip starts — assert that, so a fixture change
    // that silently empties this loop can't turn the case into a no-op.
    expect(videos.length).toBe(t < 0 ? 0 : 1)
    for (const resolved of videos) {
      const clip = clips.find((c) => c.id === resolved.item.id)!
      // What the hook assigns to `video.currentTime` for this clip at this
      // instant (useVideoPlayback's scrub branch), against ResolvedItem.seek.
      const inPoint = sourceWindow(clip, 'preview').inPoint
      expect(Math.max(inPoint, inPoint + (t - clip.start))).toBeCloseTo(resolved.seek, 10)
      expect(resolved.window).toEqual(sourceWindow(clip, 'preview'))
    }
  })

  it('reports an empty scene past the end of every item (no last-clip fallback)', () => {
    // The resolver has no fallback; PreviewPlayer's `?? clips[clips.length - 1]`
    // is editor-side presentation and lives there, not here.
    expect(resolverSceneAt(6.5)).toEqual([])
  })
})

// ── Corpus parity: same contract, proxy-matrix fixture (SP3) ──────────────────
//
// proxy-matrix.json is four tracks[0] clips, one per combination of
// {proxySrc, nobg_preview_src}: proxy-00 has neither (falls through to
// normalizedSrc), proxy-01 has proxySrc only, proxy-10 has nobg_preview_src
// only, proxy-11 has both (nobg wins — see chooseSrcRaw in
// timeline-core/src/source-window.js). No overlay tracks, so this fixture
// complements negative-start rather than replacing it: it exercises the new
// tier through the SAME `clips` → `sourceWindow` path production code uses,
// while negative-start keeps covering the partition/overlay-track side.
const proxyMatrixProject = proxyMatrix as unknown as EditorProject

interface ProxyMatrixGolden {
  sourceWindow: Record<string, { preview: unknown; render: unknown }>
}
const proxyMatrixGolden = proxyMatrixExpected as unknown as ProxyMatrixGolden

// One timestamp per clip (each clip spans 2s: [0,2), [2,4), [4,6), [6,8)),
// matching timeline-core/expected/proxy-matrix.json's resolveAt.preview.
const TIMESTAMPS_PROXY = [0, 2, 4, 6]

describe('useVideoPlayback derived collections vs. resolveAt (proxy-matrix corpus fixture)', () => {
  it.each(TIMESTAMPS_PROXY)('agrees on what is on screen at t=%s', (t) => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(t, proxyMatrixProject)
    expect(editorSceneAt({ clips, tracks0NonVideo, overlayTracks }, t)).toEqual(resolverSceneAt(t, proxyMatrixProject))
  })

  it('splits the fixture the way the resolver labels it (four clips, no overlay tracks)', () => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(TIMESTAMPS_PROXY[0], proxyMatrixProject)
    expect(clips.map((c) => c.id)).toEqual(['proxy-00', 'proxy-01', 'proxy-10', 'proxy-11'])
    expect(tracks0NonVideo).toEqual([])
    expect(overlayTracks).toEqual([])
  })

  it.each(TIMESTAMPS_PROXY)('seeks the active clip where the resolver says, at t=%s', (t) => {
    const { clips } = derivedAt(t, proxyMatrixProject)
    const scene = resolveAt(withItemTracks(proxyMatrixProject), t, { variant: 'preview' })
    const videos = scene.items.filter((r) => r.kind === 'video')
    // Every fixture timestamp lands inside exactly one clip's [start, end) —
    // assert that so a fixture edit that empties this loop can't go unnoticed.
    expect(videos.length).toBe(1)
    for (const resolved of videos) {
      const clip = clips.find((c) => c.id === resolved.item.id)!
      const inPoint = sourceWindow(clip, 'preview').inPoint
      expect(Math.max(inPoint, inPoint + (t - clip.start))).toBeCloseTo(resolved.seek, 10)
      expect(resolved.window).toEqual(sourceWindow(clip, 'preview'))
    }
  })

  it('resolves the proxySrc/nobg_preview_src tier per clip the same way the resolver golden does', () => {
    // Direct tier-selection check, independent of any timestamp: each clip's
    // `sourceWindow(clip, 'preview').src` — reached through `clips`, the same
    // collection `playbackSrcFor` consumes in useVideoPlayback.ts — must match
    // the committed golden. This is what actually pins proxy-01 to its
    // proxySrc and proxy-11 to nobg_preview_src (proxy over it) rather than
    // just "some src or other".
    const { clips } = derivedAt(TIMESTAMPS_PROXY[0], proxyMatrixProject)
    expect(clips).toHaveLength(4)
    for (const clip of clips) {
      expect(sourceWindow(clip, 'preview')).toEqual(proxyMatrixGolden.sourceWindow[clip.id].preview)
    }
  })

  // ── SP4 T6: the ENGINE path reads the same window ──────────────────────────
  //
  // The engine cannot open every src the preview chain can — the masters are
  // 4K 10-bit HEVC and `nobg_preview_src` is VP9 WebM, while its demuxer is
  // MP4-only and its decoder is configured for AV1 — so `engineSrcFor` narrows
  // the chain's answer down to "the proxy, or nothing". What must NOT differ is
  // the INPUT: both paths ask `sourceWindow(clip, 'preview')`, one shared
  // resolver call, never a second copy of the precedence chain. This asserts
  // that at the pure level, per clip, over the same corpus fixture:
  //
  //   • whenever the engine accepts a clip, the src it accepts is bit-identical
  //     to the src the legacy player would load (the golden's `.src`);
  //   • whenever it declines, it declines because the SHARED window chose
  //     something other than the proxy — never because it disagreed about what
  //     the window is.
  //
  // proxy-11 is the case that matters: `nobg_preview_src` outranks the proxy in
  // the chain, so the legacy player loads the alpha preview and the engine must
  // decline rather than quietly decode the proxy (which still has the
  // background the user just removed in it).
  it('selects the engine-path src from the same sourceWindow results as the legacy path', () => {
    const { clips } = derivedAt(TIMESTAMPS_PROXY[0], proxyMatrixProject)
    const verdicts: Record<string, { src: string; blocked?: string }> = {}
    for (const clip of clips) {
      const golden = proxyMatrixGolden.sourceWindow[clip.id].preview as { src: string }
      const window = sourceWindow(clip, 'preview')
      // Same input as the legacy path, and as the committed golden.
      expect(window.src).toBe(golden.src)
      const verdict = engineSrcFor(clip, window)
      // Accepted ⇒ identical to what legacy would load. Declined ⇒ empty.
      expect(verdict.src === '' || verdict.src === golden.src).toBe(true)
      verdicts[clip.id] = verdict
    }
    expect(verdicts).toEqual({
      'proxy-00': { src: '', blocked: 'no editing proxy yet' },
      'proxy-01': { src: (proxyMatrixGolden.sourceWindow['proxy-01'].preview as { src: string }).src },
      'proxy-10': { src: '', blocked: 'no editing proxy yet' },
      'proxy-11': { src: '', blocked: 'a higher-precedence preview source the engine cannot decode' },
    })
  })
})

// ── Reload effect: the clip-identity memo key must include proxySrc ───────────
//
// useVideoPlayback.ts:522-536 tracks clip identity (nobg_preview_src|proxySrc|
// src|inPoint|outPoint per clip) in a ref, and only reloads the active <video>
// element when that string changes — otherwise overlay-only edits would tear
// down and restart playback on every keystroke. SP3's proxySrc arrives via SSE
// mid-session: the proxy step finishes AFTER the project is already loaded and
// playing, so the field appears on a clip whose src the <video> element already
// has loaded. Without proxySrc in the identity string, that arrival is
// invisible to the effect and the preview never picks up the proxy.
//
// Fixtures can't exercise this — it's about the SAME logical clip gaining a
// field BETWEEN renders — so this uses renderHook's own rerender with two
// hand-built projects instead of a corpus fixture. And because this file is
// `.ts`, not `.tsx`, there's no JSX to mount a real `<video ref={...}>`
// through the render tree; the ref is attached directly to a detached
// `<video>` element after the first render instead. That's a legitimate way to
// drive this specific effect: it only ever reads `video0Ref.current` /
// `video1Ref.current`, never the DOM position of the element.
describe('useVideoPlayback reload effect — proxySrc identity (SP3 mid-session arrival)', () => {
  // jsdom doesn't implement HTMLMediaElement.pause — the identity effect calls
  // it on the inactive slot as part of a load. Stub it so the test exercises
  // the effect without jsdom's "not implemented" console noise (same pattern
  // as captionPositioning.test.tsx / VideoEditor.test.tsx, minus `play` and
  // `AudioContext`: this test never calls play() or wires audio).
  const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  afterEach(() => { pauseSpy.mockClear() })

  const baseClip = { id: 'c1', type: 'video' as const, start: 0, end: 10, inPoint: 0, outPoint: 10, src: '/corpus/orig.mp4' }
  const projectWith = (clip: VisualItem): EditorProject => ({
    id: 'reload-test',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items: [clip] }],
  })

  it('reloads only when proxySrc actually changes, not on every re-render', () => {
    const { result, rerender } = renderHook(
      ({ project }: { project: EditorProject }) => useVideoPlayback(project, 0, () => {}, (p) => p),
      { initialProps: { project: projectWith({ ...baseClip }) } },
    )

    const active   = document.createElement('video')
    const inactive = document.createElement('video')
    result.current.video0Ref.current = active
    result.current.video1Ref.current = inactive

    // Step 1 — warm-up load: the initial mount ran with video0Ref still null
    // (attached above, after render), so its effect early-returned without
    // recording an identity. This rerender is the first one the effect can
    // actually act on; it must load the clip's src into the active slot.
    inactive.setAttribute('src', 'sentinel')
    rerender({ project: projectWith({ ...baseClip }) })
    expect(active.src).toContain('/corpus/orig.mp4')
    expect(inactive.hasAttribute('src')).toBe(false) // cleared as part of the load

    // Step 2 — control: a brand-new project/clip object with IDENTICAL fields
    // (same src, same in/outPoint, still no proxySrc) must produce the SAME
    // identity string and skip the reload entirely. Re-arm the sentinel and
    // confirm it survives untouched — proving the effect body did not run.
    inactive.setAttribute('src', 'sentinel')
    rerender({ project: projectWith({ ...baseClip }) })
    expect(inactive.getAttribute('src')).toBe('sentinel')

    // Step 3 — the fix under test: proxySrc appears on the SAME clip (id,
    // src, in/outPoint all unchanged) — exactly what an SSE proxy-ready event
    // looks like against an already-loaded project. This must be recognized
    // as an identity change: the sentinel gets cleared again (the effect body
    // ran) and the active slot reloads onto the proxy path. Without proxySrc
    // in the identity string this step is indistinguishable from step 2 — the
    // sentinel would survive and `active.src` would stay on the original file.
    rerender({ project: projectWith({ ...baseClip, proxySrc: '/corpus/proxy.mp4' }) })
    expect(inactive.hasAttribute('src')).toBe(false)
    expect(active.src).toContain('/corpus/proxy.mp4')
  })
})

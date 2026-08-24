import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  sourceWindow,
  playbackSrcFor as resolvePlaybackSrc,
  projectEnd as timelineProjectEnd,
  audioWindow,
} from '@bycrux/timeline-core'
import { gateProxy, isProxyUsable, markProxyFailed } from './proxySupport'
import {
  getSharedAudioContext,
  latencySeconds,
  peekSharedAudioContext,
  resumeAudioContextFromGesture,
  type MontajWindow,
} from './audio-context'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../schema'
import { effectiveItemAudio, enabledTrackItems, enabledTracks, withEnabledItemTracks } from '../timeline/timeline-model'

// Typed extension for video elements that cache their GainNode
interface MontajVideoElement extends HTMLVideoElement {
  __montajGain?: GainNode
}

// ── Source-window helpers ───────────────────────────────────────────────────
//
// The three functions below are thin wrappers over @bycrux/timeline-core with
// the variant pinned to 'preview'. The canonical implementation — and the full
// reasoning, with both the editor and render originals quoted verbatim next to
// the branch that reproduces them — lives in
// `montaj_assets/timeline-core/src/source-window.js`. Read that module's header
// before changing anything here; the same math also drives the render engine,
// and preview/render differences are deliberate, not accidental.
//
// The short version of why these exist at all:
//
//   • `normalizedSrc` is a per-WINDOW normalized cache: it covers exactly
//     [normalizedInPoint, normalizedInPoint + duration] of the original source
//     and plays from its own time 0. Items always store inPoint/outPoint in
//     ORIGINAL-source coordinates, so whenever the cache is the loaded src the
//     points must be rebased by the cache origin
//     (`normalizedInPoint ?? inPoint ?? 0`) or every seek lands in the wrong
//     place. When `normalizedInPoint` is absent (legacy caches) the origin
//     collapses to `inPoint`, reproducing the old rebase-to-0 behavior.
//
//   • `nobg_preview_src` (VP9 WebM with alpha) covers the FULL source, not a
//     window, so it is NOT rebased — and it takes precedence over the cache.
//     `nobg_src` is the ProRes 4444 render-only artifact and is never loaded
//     into a <video> element; browsers can't decode ProRes.
//
//   • `proxySrc` (SP3) is the full-source, all-intra 720p H.264+Opus editing
//     proxy generated automatically at import. It also covers the FULL
//     source, so it is NOT rebased either — same shape as `nobg_preview_src`.
//     It sits AFTER `nobg_preview_src` in the precedence chain (an alpha
//     preview always wins over the plain proxy), and is preview-only: render
//     never reads it, and it is never written into project.json by render.

// SP3 precedence, most to least specific: nobg_preview_src > proxySrc >
// normalizedSrc (rebased) > src.

/**
 * Resolve the file path the browser should load for previewing this clip.
 *
 * `'preview'` always yields a string (`''` when the clip has no src field at
 * all) — the `?? ''` below is a type narrowing, not a runtime fallback; see the
 * `src` note on `SourceWindow` in timeline-core's index.d.ts.
 */
function playbackSrcFor(clip: { src?: string; nobg_preview_src?: string; normalizedSrc?: string; proxySrc?: string }): string {
  // gateProxy (SP3 fix B2): strip an unsupported/failed proxy BEFORE the tier
  // chain runs, so unsupported browsers fall through to normalizedSrc/src
  // instead of a silently-black <video>.
  return resolvePlaybackSrc(gateProxy(clip), 'preview') ?? ''
}

/**
 * The inPoint the preview should SEEK to for this clip, accounting for the
 * normalizedSrc cache origin. `sourceWindow(clip, 'preview').inPoint`.
 */
export function effectiveInPoint(clip: { inPoint?: number; normalizedInPoint?: number; nobg_preview_src?: string; normalizedSrc?: string; proxySrc?: string; src?: string }): number {
  return sourceWindow(gateProxy(clip), 'preview').inPoint
}

/**
 * The outPoint in the loaded src's own timeline, rebased by the cache origin
 * when the normalizedSrc cache is what's actually loaded (the boundary/loop
 * checks below compare against `video.currentTime`, i.e. cache time).
 * `sourceWindow(clip, 'preview').outPoint`.
 *
 * Returns undefined when no outPoint is stored, so callers keep their existing
 * fallback (clip.end - clip.start + effectiveInPoint).
 */
export function effectiveOutPoint(clip: { inPoint?: number; outPoint?: number; normalizedInPoint?: number; nobg_preview_src?: string; normalizedSrc?: string; proxySrc?: string; src?: string }): number | undefined {
  return sourceWindow(gateProxy(clip), 'preview').outPoint
}

/**
 * The GainNode value for one clip on `track` — the ONLY place this hook turns
 * audio settings into a number.
 *
 * Track settings fold into the clip's own via `effectiveItemAudio`: volume
 * MULTIPLIES (a clip the editor already turned down stays proportionally
 * quieter when its track is pulled down) and mute is either/or. `track` is
 * `undefined` for a project with no tracks at all, and its `volume`/`muted` are
 * absent on every track nobody has touched — both reduce to the clip's own
 * values, which is what every project got before track settings existed.
 *
 * The four gain-setting sites below all route through this rather than reading
 * `clip.muted`/`clip.volume` themselves. Folding by writing the effective
 * values ONTO the clip is not an option: `clips` holds the project's own item
 * objects by reference (see `enabledTrackItems`), and the renderer and the
 * server both mutate those in place.
 */
export function clipGain(
  track: Pick<VisualTrack, 'volume' | 'muted'> | undefined,
  clip: Pick<VisualItem, 'volume' | 'muted'>,
): number {
  const { volume, muted } = effectiveItemAudio(track, clip)
  return muted ? 0 : volume
}

export function useVideoPlayback(
  project: Project,
  currentTime: number,
  onTimeUpdate: (t: number) => void,
  fileUrl: (path: string) => string,
) {
  // Double-buffer video elements for seamless clip transitions
  const video0Ref     = useRef<HTMLVideoElement>(null)
  const video1Ref     = useRef<HTMLVideoElement>(null)
  const activeSlotRef = useRef<0 | 1>(0)
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0)
  // Tracks what src is preloaded in the inactive slot (relative URL)
  const preloadSrcRef = useRef('')

  const activeIdxRef  = useRef(0)
  const seekingRef    = useRef(false)
  const lastTimeRef   = useRef(currentTime)
  const loopOffsetRef = useRef(0)
  const rafRef        = useRef<number | null>(null)
  const rafLastMs     = useRef<number | null>(null)
  // rAF clock for VIDEO projects — drives clip-boundary detection at ~60Hz
  // instead of the <video> element's coarse `timeupdate` event (~4Hz). See the
  // effect below for why.
  const videoRafRef   = useRef<number | null>(null)
  const audioRefsMap  = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioSrcMap   = useRef<Map<string, string>>(new Map())
  // Web Audio API: GainNode per audio track allows volume > 1.0 (amplification).
  // All gain nodes route through the shared window AudioContext (see getSharedAudioContext).
  const gainNodesMap  = useRef<Map<string, GainNode>>(new Map())
  // Video slot GainNodes — route video element audio through Web Audio API for amplification (volume > 1.0)
  const videoGainRef  = useRef<[GainNode | null, GainNode | null]>([null, null])
  const [isPlaying, setIsPlaying] = useState(false)
  const isPlayingRef = useRef(false)
  // Keep ref in sync so effects with narrow deps can read current playing state
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  const [showVideo, setShowVideo] = useState(true)
  // Bumped when a proxy fails to decode (SP3 fix B2) — the clip-identity
  // effect depends on it, so the bump forces the reload that drops the
  // now-suppressed proxy tier.
  const [proxyFailTick, setProxyFailTick] = useState(0)

  // Gap clock — advances time through lift-style gaps between primary clips
  const gapRAFRef     = useRef<number | null>(null)
  const inGapRef      = useRef(false)
  const gapWallRef    = useRef(0)
  const gapFromRef    = useRef(0)
  const gapTargetRef  = useRef(0)
  const gapNextIdxRef = useRef(0)

  // Keep fileUrl in a ref so callbacks that captured it early don't go stale
  const fileUrlRef = useRef(fileUrl)
  useEffect(() => { fileUrlRef.current = fileUrl }, [fileUrl])

  // The AUDIBLE-time bridge to the store. Every playback-advance emission in
  // this hook (rAF canvas tick, gap tick, `handleTimeUpdate`, clip-switch and
  // end-of-clip snaps) routes through this instead of calling `onTimeUpdate`
  // directly. The `<video>` element's `currentTime` and the RAF wall-clock both
  // report the same frames-consumed lead the engine's master clock does — the
  // audio graph is shared — so the picture leads the ear by exactly
  // `latencySeconds` unless we subtract it here. Read live off the shared ctx
  // so device switches take effect on the very next emission; clamp ≥ 0.
  // Scrubs never come through here: the scrub effect updates `lastTimeRef`
  // without emitting, so seek/scrub display is unaffected.
  const emitTime = useCallback((t: number) => {
    // `peek` never creates: production reaches this only during playback, whose
    // gesture-anchored `togglePlay` has already minted the shared ctx — no ctx
    // means no gesture yet, so the frames-consumed clock has nothing audible
    // behind it to lag, and pass-through is the correct behavior.
    const ctx = peekSharedAudioContext()
    onTimeUpdate(ctx ? Math.max(0, t - latencySeconds(ctx)) : t)
  }, [onTimeUpdate])

  function getActiveVideo() { return activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current }
  function getInactiveVideo() { return activeSlotRef.current === 0 ? video1Ref.current : video0Ref.current }

  // ── Video timeline ─────────────────────────────────────────────────────────
  // Only video items drive the double-buffer player; non-video items (images, etc.)
  // in tracks[0] are exposed separately for the preview to render as a background layer.
  const clips           = useMemo(() => (enabledTrackItems(project)[0] ?? []).filter(c => c.type === 'video').sort((a, b) => a.start - b.start), [project])
  const tracks0NonVideo = useMemo(() => (enabledTrackItems(project)[0] ?? []).filter(c => c.type !== 'video'), [project])
  const overlayTracks   = useMemo(() => enabledTrackItems(project).slice(1), [project])

  // The track `clips` came out of, kept alongside them because its own
  // volume/mute fold into every clip on it (see `clipGain`).
  // `enabledTrackItems(project)[0]` hands back items and drops the track object
  // that carries those settings; `enabledTracks` is the same filter in the same
  // order, so `[0]` here is `[0]` there by construction.
  const videoTrack      = useMemo(() => enabledTracks(project)[0], [project])

  // Canvas project: no primary video in tracks[0] (e.g. image-only background track)
  const isCanvasProject = clips.length === 0

  // Total project end — includes opaque overlays and audio that extend beyond video clips.
  // Used to decide whether to keep playing after the last video clip ends.
  //
  // SP4 T8: this VIDEO-mode formula is `@bycrux/timeline-core`'s `projectEnd`
  // (`src/durations.js`) ported verbatim FROM this exact memo — the two are
  // byte-identical for every well-formed project, so calling the shared
  // implementation here is a no-op substitution, not a behavior change. This
  // is deliberately NOT shared with the CANVAS-mode ceiling below
  // (`canvasMaxEndRef`, which excludes audio) — the two ends are legitimately
  // different formulas (see `durations.js`'s module header) and only this one
  // has a shared home.
  const projectEnd = useMemo(() => timelineProjectEnd(withEnabledItemTracks(project)), [project])

  // Wire a video slot through a Web Audio GainNode (once per element — createMediaElementSource
  // can only be called once). After this, video.volume/muted have no audible effect; all volume
  // control goes through the GainNode, which supports values > 1.0 for amplification.
  //
  // `getSharedAudioContext` / `resumeAudioContextFromGesture` used to live here as
  // private helpers; SP4 T4 MOVED them to `./audio-context` (unchanged) so the
  // WebCodecs engine consumes the same context and the same gesture rule instead
  // of growing a second copy. Their full rationale lives in that module's header.

  /**
   * Start playback on a wired <video> from a user gesture. Video frame
   * production is gated on the shared AudioContext clock running, and the
   * context is created suspended inside a useEffect — so the FIRST play after a
   * hard refresh fires while resume() is still pending and renders no frames
   * until the next seek. resume() is gesture-credited at the synchronous call
   * site here, so wait for it to actually resolve to 'running' before calling
   * play(); the page already has sticky activation from the click, so the
   * deferred play() is not autoplay-blocked.
   */
  function playFromGesture(video: HTMLVideoElement) {
    // Wire this slot to Web Audio on the first play (not at load) so the paused
    // poster frame can render. This also creates the shared AudioContext inside
    // the gesture, so the resume() below is gesture-credited.
    ensureVideoGain(activeSlotRef.current)
    const cur = clips[activeIdxRef.current]
    if (cur) applyClipVolume(cur)
    const w = window as Window & MontajWindow
    const ctx = w.__montajSharedCtx
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(
        () => { void video.play().catch(() => {}) },
        () => { void video.play().catch(() => {}) },
      )
    } else {
      void video.play().catch(() => {})
    }
  }

  // Start playback on a slot during an automated clip-boundary switch (context
  // already running — no gesture needed). If the slot isn't buffered yet (a slow
  // non-faststart HEVC tail-moov fetch can still be in flight), play() may reject
  // with AbortError; retry on `canplay` so the switch never dead-stops at the cut.
  function playSoon(video: HTMLVideoElement) {
    const p = video.play()
    if (p) p.catch(() => {
      const onCanPlay = () => { video.removeEventListener('canplay', onCanPlay); video.play().catch(() => {}) }
      video.addEventListener('canplay', onCanPlay)
    })
  }

  function ensureVideoGain(slot: 0 | 1): GainNode | null {
    if (videoGainRef.current[slot]) return videoGainRef.current[slot]
    const video = slot === 0 ? video0Ref.current : video1Ref.current
    if (!video) return null
    // createMediaElementSource can only be called ONCE per <video> element,
    // and source/gain/context must all belong to the same AudioContext.
    // Cache the gain on the element so it survives React strict-mode
    // double-invocation and component remounts.
    const v = video as MontajVideoElement
    if (!v.__montajGain) {
      const ctx = getSharedAudioContext()
      const source = ctx.createMediaElementSource(video)
      const gain = ctx.createGain()
      source.connect(gain)
      gain.connect(ctx.destination)
      v.__montajGain = gain
    }
    videoGainRef.current[slot] = v.__montajGain ?? null
    return v.__montajGain ?? null
  }

  // Existing gain for a slot WITHOUT wiring it. Wiring (createMediaElementSource)
  // is deferred to the first play gesture so the paused poster frame can render —
  // a <video> wired to a suspended AudioContext produces no frames at all.
  function getVideoGain(slot: 0 | 1): GainNode | null {
    const v = (slot === 0 ? video0Ref.current : video1Ref.current) as MontajVideoElement | null
    return (v && v.__montajGain) ?? null
  }

  // Set video clip volume via GainNode (supports amplification > 1.0). Muted clips
  // — or clips on a muted track — get gain 0; the rest get the clip's volume
  // scaled by its track's (`clipGain`). No-op until the slot is
  // wired (first play) — there's no audio to control on a paused poster, and
  // wiring here would gate the poster frame on the suspended context.
  function applyClipVolume(clip: { muted?: boolean; volume?: number }) {
    const slot = activeSlotRef.current
    const gain = getVideoGain(slot)
    if (gain) gain.gain.value = clipGain(videoTrack, clip)
  }

  // Apply video clip volume via Web Audio GainNode (supports > 1.0 amplification).
  // `videoTrack` is a dep in its own right: pulling the TRACK's fader while the
  // clips themselves are untouched has to reach the live gain node too.
  useEffect(() => {
    const idx = activeIdxRef.current
    const clip = clips[idx]
    if (!clip) return
    applyClipVolume(clip)
  }, [clips, videoTrack, activeSlot])

  // maxEnd for the canvas rAF clock — the furthest overlay/caption end. Kept in
  // a ref, updated by its own cheap effect, so the rAF effect below doesn't tear
  // down and rebuild on every project spread (only isPlaying/onTimeUpdate matter
  // to it). onTimeUpdate is the stable clock.set identity.
  const canvasMaxEndRef = useRef(0)
  useEffect(() => {
    const captionEnd = (project.captions?.segments ?? []).reduce((m: number, s) => Math.max(m, s.end), 0)
    canvasMaxEndRef.current = Math.max(
      overlayTracks.flat().reduce((m, i) => Math.max(m, i.end), 0),
      captionEnd,
    )
  }, [overlayTracks, project.captions])

  useEffect(() => {
    if (!isCanvasProject) return

    function tick(ms: number) {
      const maxEnd = canvasMaxEndRef.current
      if (rafLastMs.current !== null) {
        const dt   = (ms - rafLastMs.current) / 1000
        const next = Math.min(lastTimeRef.current + dt, maxEnd)
        lastTimeRef.current = next
        emitTime(next)
        if (next >= maxEnd) {
          setIsPlaying(false)
          rafRef.current = null
          rafLastMs.current = null
          return
        }
      }
      rafLastMs.current = ms
      rafRef.current = requestAnimationFrame(tick)
    }

    if (isPlaying) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      rafLastMs.current = null
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isPlaying, isCanvasProject, emitTime])

  // ── Multi-track audio management ───────────────────────────────────────────
  // Derive unmuted tracks. The full tracks array is a new reference on every
  // project spread, so we stabilize by comparing the *identity key* (id+muted+src)
  // rather than array reference so we don't tear down audio elements on volume drag.
  const unmutedAudioTracks = useMemo(() => {
    return (project.audio?.tracks ?? []).filter(t => !t.muted && t.src)
  }, [project.audio?.tracks])

  // Stable key: only changes when the set of unmuted track ids or their src changes.
  // Volume, start/end, inPoint/outPoint changes do NOT trigger element create/destroy.
  const audioTrackIdentity = useMemo(
    () => unmutedAudioTracks.map(t => `${t.id}:${t.src}`).join('|'),
    [unmutedAudioTracks]
  )

  // Create / destroy audio elements when track set changes
  useEffect(() => {
    const map = audioRefsMap.current
    const srcMap = audioSrcMap.current
    const gains = gainNodesMap.current
    const activeIds = new Set(unmutedAudioTracks.map(t => t.id))

    // Remove elements for tracks that were deleted or muted
    for (const [id, el] of map) {
      if (!activeIds.has(id)) {
        el.pause()
        el.src = ''
        map.delete(id)
        srcMap.delete(id)
        gains.delete(id)
      }
    }

    // Create new elements for newly-added tracks, routed through GainNode
    for (const track of unmutedAudioTracks) {
      let el = map.get(track.id)
      if (!el) {
        el = new Audio()
        el.preload = 'auto'
        map.set(track.id, el)

        // Wire through Web Audio API: element → GainNode → destination
        // This allows volume > 1.0 for amplification in preview.
        // createMediaElementSource can only be called once per element.
        const ctx = getSharedAudioContext()
        const source = ctx.createMediaElementSource(el)
        const gain = ctx.createGain()
        gain.gain.value = track.volume ?? 1
        source.connect(gain)
        gain.connect(ctx.destination)
        gains.set(track.id, gain)
      }
      if (srcMap.get(track.id) !== track.src) {
        el.src = fileUrlRef.current(track.src!)
        srcMap.set(track.id, track.src!)
      }
      // Volume is controlled via GainNode, not el.volume
      const gain = gains.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }
  // Keyed on identity string — only fires when tracks are added/removed/src changes
  }, [audioTrackIdentity])

  // Update volume in-place on every render via GainNode — cheap, no element churn
  useEffect(() => {
    for (const track of unmutedAudioTracks) {
      const gain = gainNodesMap.current.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }
  }, [unmutedAudioTracks])

  // Cleanup on unmount only. The shared AudioContext (window.__montajSharedCtx)
  // is intentionally NOT closed — it's window-scoped and reused across remounts
  // and across project pages. Audio elements are paused and dropped; their
  // MediaElementSources and GainNodes are GC'd along with them.
  useEffect(() => {
    const map = audioRefsMap.current
    const srcMap = audioSrcMap.current
    const gains = gainNodesMap.current
    const vidGains = videoGainRef.current
    return () => {
      for (const el of map.values()) { el.pause(); el.src = '' }
      map.clear()
      srcMap.clear()
      gains.clear()
      vidGains[0] = null; vidGains[1] = null
    }
  }, [])

  // syncAudioTracks reads from refs + unmutedAudioTracks for window math.
  // We use a ref to avoid recreating the callback on every track property change.
  const unmutedAudioTracksRef = useRef(unmutedAudioTracks)
  useEffect(() => { unmutedAudioTracksRef.current = unmutedAudioTracks }, [unmutedAudioTracks])

  // SP4 T8: the window/gain arithmetic is routed through timeline-core's
  // `audioWindow` (`src/audio.js`) — the pure port of exactly this logic,
  // derived-outPoint rule included — the same way `useEnginePlayback.ts`
  // already does for the WebCodecs engine path. The 0.3s re-seek threshold
  // and all other imperative behavior (play/pause calls, gain writes) are
  // kept exactly; only the pure MATH moved to the shared implementation.
  const syncAudioTracks = useCallback(function syncAudioTracks(playhead: number, playing: boolean) {
    for (const track of unmutedAudioTracksRef.current) {
      const el = audioRefsMap.current.get(track.id)
      if (!el) continue

      const win = audioWindow(track, playhead)
      if (!win.active) {
        if (!el.paused) el.pause()
        continue
      }

      if (Math.abs(el.currentTime - win.trackTime) > 0.3) {
        el.currentTime = Math.max(0, win.trackTime)
      }

      if (playing && el.paused) el.play().catch(() => {})
      if (!playing && !el.paused) el.pause()

      // `audioWindow.gain` is already `baseVolume * max(0, fadeMul)`.
      const gain = gainNodesMap.current.get(track.id)
      if (gain) gain.gain.value = win.gain
    }
  }, [])

  // Keep background audio in sync with playback (canvas and video projects)
  useEffect(() => {
    // Skip toggling during a seek — prevents audio stutter from brief pause/play events
    if (seekingRef.current) return
    syncAudioTracks(lastTimeRef.current, isPlaying)
  }, [isPlaying, syncAudioTracks])

  useEffect(() => {
    syncAudioTracks(currentTime, isPlayingRef.current)
  }, [currentTime, syncAudioTracks])

  // Space = play/pause
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        // GESTURE-ANCHORED: resume the AudioContext synchronously here. After
        // a hard page refresh, the context was first created in a useEffect
        // (no gesture) and stays suspended. With <video> wired through
        // MediaElementSource → GainNode → ctx.destination, a suspended context
        // also gates video frame production in some browsers (Safari notably).
        // Resuming inside the keydown handler credits the resume() call as
        // gesture-driven, unblocking both audio and frame advance.
        resumeAudioContextFromGesture()
        if (isCanvasProject) { setIsPlaying(prev => !prev); return }
        if (inGapRef.current) {
          if (gapRAFRef.current !== null) {
            cancelAnimationFrame(gapRAFRef.current)
            gapRAFRef.current = null
            setIsPlaying(false)
          } else {
            gapFromRef.current = lastTimeRef.current
            gapWallRef.current = performance.now()
            gapRAFRef.current  = requestAnimationFrame(tickGap)
            setIsPlaying(true)
          }
          return
        }
        const video = getActiveVideo()
        if (!video) return
        if (video.paused) { playFromGesture(video) } else { video.pause() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isCanvasProject])

  // Track clip identity to avoid reloading when only overlays change
  const clipsSourceRef = useRef('')

  // Load first clip into active slot when clips change
  useEffect(() => {
    const video = getActiveVideo()
    if (!video || !clips.length || !clips[0].src) return
    // Only reload if the actual clip sources/trim points changed — not just overlay edits.
    // Identity includes nobg_preview_src so a bg-removal completing mid-session
    // (the field appearing on a clip whose src was already loaded) triggers a
    // reload to swap the preview to the cutout version. Same reasoning covers
    // proxySrc: an SP3 proxy arriving via SSE mid-session (the field appearing
    // on a clip already loaded from its original src) must also trigger a
    // reload, or the <video> element keeps playing the pre-proxy source until
    // the next unrelated identity change happens to flush it.
    // The proxy component is GATED (SP3 fix B2): an unsupported or
    // failed-this-session proxy contributes '' — so marking a proxy failed
    // (proxyFailTick bump) changes the identity and triggers the reload that
    // swaps the clip back to its master.
    const identity = clips
      .map(c => `${c.nobg_preview_src ?? ''}|${isProxyUsable(c.proxySrc) ? c.proxySrc : ''}|${c.src}|${c.inPoint ?? 0}|${c.outPoint ?? ''}`)
      .join(',')
    if (identity === clipsSourceRef.current) return
    clipsSourceRef.current = identity
    activeIdxRef.current  = 0
    activeSlotRef.current = 0
    loopOffsetRef.current = 0
    setActiveSlot(0)
    preloadSrcRef.current = ''
    video.src = fileUrlRef.current(playbackSrcFor(clips[0]))
    video.currentTime = effectiveInPoint(clips[0])
    applyClipVolume(clips[0])
    // Clear inactive slot
    const inactive = getInactiveVideo()
    if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
  }, [clips, proxyFailTick])

  const handlePause = useCallback(() => {
    // Ignore pause events while the gap clock owns playback state
    if (inGapRef.current) return
    setIsPlaying(false)
  }, [])

  const cancelGap = useCallback(() => {
    if (gapRAFRef.current !== null) {
      cancelAnimationFrame(gapRAFRef.current)
      gapRAFRef.current = null
    }
    inGapRef.current = false
  }, [])

  const tickGap = useCallback(function tickGap() {
    if (!inGapRef.current) return
    const elapsed = (performance.now() - gapWallRef.current) / 1000
    const t = Math.min(gapFromRef.current + elapsed, gapTargetRef.current)
    lastTimeRef.current = t
    emitTime(t)

    if (t < gapTargetRef.current) {
      gapRAFRef.current = requestAnimationFrame(tickGap)
      return
    }

    // Gap over — transition to next clip (or end of project)
    inGapRef.current = false
    gapRAFRef.current = null
    const ni = gapNextIdxRef.current
    const nc = clips[ni]
    if (!nc?.src) {
      // No next clip — we were advancing through a trailing overlay/audio section.
      setIsPlaying(false)
      syncAudioTracks(t, false)
      return
    }
    const ns = (1 - activeSlotRef.current) as 0 | 1
    const nv = ns === 0 ? video0Ref.current : video1Ref.current
    lastTimeRef.current = nc.start
    emitTime(nc.start)
    activeIdxRef.current = ni
    if (nv) {
      const src = fileUrlRef.current(playbackSrcFor(nc))
      if (preloadSrcRef.current !== src) { nv.src = src; nv.currentTime = effectiveInPoint(nc) }
      const gain = ensureVideoGain(ns)
      if (gain) gain.gain.value = clipGain(videoTrack, nc)
      playSoon(nv)
    }
    void (activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current)?.pause()
    activeSlotRef.current = ns
    setActiveSlot(ns)
    setShowVideo(true)
    preloadSrcRef.current = ''
  }, [clips, videoTrack, emitTime])

  // Scrub: seek active slot when currentTime jumps externally
  useEffect(() => {
    if (Math.abs(currentTime - lastTimeRef.current) < 0.05) return
    cancelGap()
    lastTimeRef.current = currentTime
    const idx = clips.findIndex(c => currentTime >= c.start && currentTime < c.end)
    if (idx === -1) {
      // Scrubbed into a gap or image section — hide the main video so it doesn't bleed through
      setShowVideo(false)
      // If currently playing, pause the active video and restart the gap clock from the new position
      if (isPlayingRef.current) {
        const nextIdx = clips.findIndex(c => c.start > currentTime)
        if (nextIdx !== -1) {
          inGapRef.current      = true  // set before pause so handlePause ignores the event
          gapFromRef.current    = currentTime
          gapWallRef.current    = performance.now()
          gapTargetRef.current  = clips[nextIdx].start
          gapNextIdxRef.current = nextIdx
          getActiveVideo()?.pause()
          gapRAFRef.current     = requestAnimationFrame(tickGap)
        } else {
          // Scrubbed PAST the last clip into trailing empty space — there is no
          // next clip to advance to. Without this the active <video> keeps
          // playing under the hidden (showVideo=false) frame: the picture goes
          // dark but its audio keeps going. Stop playback outright.
          getActiveVideo()?.pause()
          setIsPlaying(false)
          syncAudioTracks(currentTime, false)
        }
      }
      return
    }
    setShowVideo(true)
    seekingRef.current = true
    try {
      const clipIdx = idx
      const clip = clips[clipIdx]
      if (!clip?.src) return
      activeIdxRef.current = clipIdx
      const video = getActiveVideo()
      if (!video) return
      const targetSrc = fileUrlRef.current(playbackSrcFor(clip))
      if (video.src !== targetSrc) {
        video.src = targetSrc
        // Clear preloaded inactive slot — it may no longer be the right next clip
        preloadSrcRef.current = ''
        const inactive = getInactiveVideo()
        if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
      }
      applyClipVolume(clip)
      const inPoint = effectiveInPoint(clip)
      const clipOutPoint = effectiveOutPoint(clip)
      if (clip.loop && clipOutPoint != null) {
        const loopDur = clipOutPoint - inPoint
        const elapsed = currentTime - clip.start
        const loops   = Math.floor(elapsed / loopDur)
        loopOffsetRef.current = loops * loopDur
        video.currentTime = inPoint + (elapsed % loopDur)
      } else {
        loopOffsetRef.current = 0
        video.currentTime = Math.max(inPoint, inPoint + (currentTime - clip.start))
      }
    } finally {
      // Delay clearing seekingRef so the pause/play events the browser fires
      // during currentTime assignment don't toggle isPlaying
      setTimeout(() => {
        seekingRef.current = false
        // Sync isPlaying state and audio to video's actual state after seek settles
        const v = getActiveVideo()
        if (!v) return
        setIsPlaying(!v.paused)
        syncAudioTracks(lastTimeRef.current, !v.paused)
      }, 100)
    }
  }, [currentTime, clips])

  const handleTimeUpdate = useCallback(() => {
    // Gap clock owns time during gaps — ignore timeupdate events from the paused video element
    // to prevent it from resetting currentTime and cancelling the gap clock.
    if (inGapRef.current) return
    const slot = activeSlotRef.current
    const video = slot === 0 ? video0Ref.current : video1Ref.current
    if (!video || seekingRef.current) return
    const clip = clips[activeIdxRef.current]
    if (!clip) return

    const clipInPoint = effectiveInPoint(clip)
    const outPoint = effectiveOutPoint(clip) ?? clip.end - clip.start + clipInPoint

    // Preload the next clip into the inactive slot as early as possible. The
    // source files are large 4K 10-bit HEVC with the moov atom at the END of the
    // file (not web-faststart), so the browser needs a slow tail range-fetch to
    // index and seek before it can decode. The old "~1s before end" lead was far
    // too short: at a cross-source cut the next slot wasn't ready and play()
    // stalled, freezing playback at the boundary. (Same-source cuts hid the bug —
    // the moov was already cached from the active slot.) Give the load the whole
    // current clip as runway instead; the preloadSrcRef guard keeps it idempotent
    // and a scrub clears it.
    const nextIdx = activeIdxRef.current + 1
    if (nextIdx < clips.length && clips[nextIdx].src) {
      const inactiveVideo = slot === 0 ? video1Ref.current : video0Ref.current
      const nextSrc = fileUrlRef.current(playbackSrcFor(clips[nextIdx]))
      if (inactiveVideo && preloadSrcRef.current !== nextSrc) {
        preloadSrcRef.current = nextSrc
        inactiveVideo.src = nextSrc
        inactiveVideo.currentTime = effectiveInPoint(clips[nextIdx])
        const inactiveSlot = (1 - slot) as 0 | 1
        const nextGain = ensureVideoGain(inactiveSlot)
        if (nextGain) nextGain.gain.value = clipGain(videoTrack, clips[nextIdx])
      }
    }

    // A normalized cache can encode a few ms SHORTER than its computed window
    // (outPoint − inPoint), so the <video> reaches its natural end (`ended`)
    // before currentTime ever reaches outPoint. Treat EOF as reaching the
    // boundary too — otherwise the clip switch never fires and playback stalls
    // at that clip's end (raw full-length sources never hit this; trimmed
    // window caches can).
    if (video.currentTime >= outPoint || video.ended) {
      if (clip.loop) {
        const projectT = clip.start + loopOffsetRef.current + (video.currentTime - clipInPoint)
        if (projectT < clip.end) {
          // Still within the clip's project window — loop the source video
          const loopDur = outPoint - clipInPoint
          loopOffsetRef.current += loopDur
          video.currentTime = clipInPoint
          return
        }
        // Project end reached — fall through to the stop/next-clip logic below
      }
      const nextIdx = activeIdxRef.current + 1
      if (nextIdx < clips.length && clips[nextIdx].src) {
        const next = clips[nextIdx]
        const cur  = clips[activeIdxRef.current]

        if (next.start > cur.end + 0.02) {
          // Gap between clips — hide video (black), advance time via RAF clock
          video.pause()
          setShowVideo(false)
          inGapRef.current      = true
          gapFromRef.current    = cur.end
          gapWallRef.current    = performance.now()
          gapTargetRef.current  = next.start
          gapNextIdxRef.current = nextIdx
          gapRAFRef.current     = requestAnimationFrame(tickGap)
          // Keep isPlaying=true so overlay videos (e.g. floating_head) continue playing
          setIsPlaying(true)
        } else {
          // Contiguous — immediate switch
          const nextSlot = (1 - slot) as 0 | 1
          const nextVideo = nextSlot === 0 ? video0Ref.current : video1Ref.current

          lastTimeRef.current = next.start
          emitTime(next.start)
          activeIdxRef.current = nextIdx

          if (nextVideo) {
            const nextSrc = fileUrlRef.current(playbackSrcFor(next))
            if (preloadSrcRef.current !== nextSrc) {
              nextVideo.src = nextSrc
              nextVideo.currentTime = effectiveInPoint(next)
            }
            const nextGain = ensureVideoGain(nextSlot)
            if (nextGain) nextGain.gain.value = clipGain(videoTrack, next)
            playSoon(nextVideo)
          }

          activeSlotRef.current = nextSlot
          setActiveSlot(nextSlot)
          preloadSrcRef.current = ''
          video.pause()
        }
      } else {
        // Last video clip ended
        video.pause()
        const finalTime = clips[activeIdxRef.current].end
        lastTimeRef.current = finalTime
        emitTime(finalTime)

        // If overlays or audio extend beyond the last video clip,
        // continue advancing time via the gap clock (shows overlays, plays audio).
        if (finalTime < projectEnd) {
          setShowVideo(false)
          inGapRef.current      = true
          gapFromRef.current    = finalTime
          gapWallRef.current    = performance.now()
          gapTargetRef.current  = projectEnd
          gapNextIdxRef.current = clips.length // no next clip
          gapRAFRef.current     = requestAnimationFrame(tickGap)
          setIsPlaying(true)
        }
      }
      return
    }

    const t = clip.start + loopOffsetRef.current + (video.currentTime - clipInPoint)

    // For looping clips, stop when project time reaches clip.end mid-loop
    if (clip.loop && t >= clip.end) {
      video.pause()
      lastTimeRef.current = clip.end
      emitTime(clip.end)
      for (const el of audioRefsMap.current.values()) { if (!el.paused) el.pause() }
      setIsPlaying(false)
      return
    }

    lastTimeRef.current = t
    emitTime(t)
  }, [clips, videoTrack, emitTime])

  /**
   * SP3 fix B2 — decode-failure fallback. Wired to both <video> slots'
   * onError. If the failing element was playing a clip's proxy, suppress that
   * proxy for the session and force a reload (via proxyFailTick → the
   * clip-identity effect), which re-selects src without the proxy tier.
   * Non-proxy errors keep the legacy behavior (logged, nothing else — there
   * is no better source to fall back to).
   */
  const handleVideoError = useCallback((slot: 0 | 1) => {
    const el = (slot === 0 ? video0Ref : video1Ref).current
    const current = el?.currentSrc || el?.src || ''
    // fileUrl() builds `/api/files?path=<encodeURIComponent(abs)>`, so the
    // encoded proxy path appearing in the element's src identifies the proxy
    // as what failed, regardless of URL absolutization.
    const clip = clips.find(c => c.proxySrc && isProxyUsable(c.proxySrc)
      && current.includes(encodeURIComponent(c.proxySrc)))
    if (clip?.proxySrc) {
      console.warn(
        `[montaj] proxy failed to decode — falling back to the master for this session: ${clip.proxySrc}`)
      markProxyFailed(clip.proxySrc)
      setProxyFailTick(t => t + 1)
      return
    }
    console.warn(`[montaj] video error on slot ${slot} (src: ${current || 'none'})`)
  }, [clips])

  const handleEnded = useCallback(() => {
    // For looping clips the ended event fires when the source video reaches its natural end.
    // handleTimeUpdate already handles the loop/stop decision via outPoint + clip.end checks.
    // Just call handleTimeUpdate to ensure the transition fires even if timeupdate didn't catch it.
    handleTimeUpdate()
  }, [handleTimeUpdate])

  // ── Video boundary clock ─────────────────────────────────────────────────
  // Drive clip-boundary detection from requestAnimationFrame (~60Hz) rather
  // than relying on the <video> element's `timeupdate` event, which only fires
  // ~every 250ms. Under timeupdate-gating the active clip plays up to a full
  // ~250ms PAST its outPoint before the swap fires; on a silence-trimmed
  // single-source timeline that overshoot is trimmed-out footage playing past
  // the cut — the "underlying video keeps playing in the background" bug.
  // Polling currentTime every frame tightens the boundary to ~16ms.
  // handleTimeUpdate is idempotent (preload + swap are guarded), so the
  // timeupdate event firing in addition to this is harmless. Canvas projects
  // advance time via their own rAF above and are excluded here.
  useEffect(() => {
    if (isCanvasProject || !isPlaying) {
      if (videoRafRef.current !== null) {
        cancelAnimationFrame(videoRafRef.current)
        videoRafRef.current = null
      }
      return
    }
    function pump() {
      // The gap clock owns time during gaps; handleTimeUpdate no-ops then.
      if (!inGapRef.current) handleTimeUpdate()
      videoRafRef.current = requestAnimationFrame(pump)
    }
    videoRafRef.current = requestAnimationFrame(pump)
    return () => {
      if (videoRafRef.current !== null) {
        cancelAnimationFrame(videoRafRef.current)
        videoRafRef.current = null
      }
    }
  }, [isPlaying, isCanvasProject, handleTimeUpdate])

  function togglePlay() {
    // GESTURE-ANCHORED: same rationale as the keydown handler — resume the
    // AudioContext synchronously inside this user-gesture call so a wired
    // <video> isn't trapped in a suspended Web Audio graph after page refresh.
    resumeAudioContextFromGesture()
    if (isCanvasProject) { setIsPlaying(p => !p); return }
    // If current time is in a gap/image section (not inside any video clip), drive via gap clock
    const t = lastTimeRef.current
    const inVideoClip = clips.some(c => t >= c.start && t < c.end)
    if (!inVideoClip || inGapRef.current) {
      if (gapRAFRef.current !== null) {
        // Currently playing through gap → pause
        cancelAnimationFrame(gapRAFRef.current)
        gapRAFRef.current = null
        inGapRef.current  = false
        setIsPlaying(false)
      } else {
        // Paused in gap/image section → find next video clip and advance via gap clock
        const nextIdx = clips.findIndex(c => c.start > t)
        if (nextIdx === -1) {
          // No more video clips — advance through trailing overlays/audio if any
          if (t < projectEnd) {
            inGapRef.current      = true
            gapFromRef.current    = t
            gapWallRef.current    = performance.now()
            gapTargetRef.current  = projectEnd
            gapNextIdxRef.current = clips.length
            gapRAFRef.current     = requestAnimationFrame(tickGap)
            setIsPlaying(true)
          }
          return
        }
        inGapRef.current      = true
        gapFromRef.current    = t
        gapWallRef.current    = performance.now()
        gapTargetRef.current  = clips[nextIdx].start
        gapNextIdxRef.current = nextIdx
        gapRAFRef.current     = requestAnimationFrame(tickGap)
        setIsPlaying(true)
      }
      return
    }
    const video = getActiveVideo()
    if (!video) return
    if (video.paused) { playFromGesture(video) } else { video.pause() }
  }

  return {
    video0Ref,
    video1Ref,
    activeSlotRef,
    activeSlot,
    showVideo,
    isPlaying,
    setIsPlaying,
    handleTimeUpdate,
    handlePause,
    handleEnded,
    handleVideoError,
    togglePlay,
    isCanvasProject,
    clips,
    tracks0NonVideo,
    overlayTracks,
  }
}

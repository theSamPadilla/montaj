import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorProject as Project } from '../../schema'

// Typed extension for the shared AudioContext cached on window
interface MontajWindow {
  __montajSharedCtx?: AudioContext
}

// Typed extension for video elements that cache their GainNode
interface MontajVideoElement extends HTMLVideoElement {
  __montajGain?: GainNode
}

/**
 * Resolve the file path the browser should load for previewing this clip.
 *
 * For bg-removed clips, prefer `nobg_preview_src` (small WebM with alpha,
 * browser-friendly) over `src` (the original raw file with bg present), so
 * the preview pane shows what the final render will composite — not the
 * un-cut-out source. Mirrors the same pattern used by
 * `OverlayItemsLayer.tsx:406` for tracks[1+] items; this generalises it to
 * the main-track preview so bg-removed clips placed on tracks[0] don't show
 * the wrong layer in preview while rendering correctly. Falls back to `src`
 * when `nobg_preview_src` is absent (most clips).
 *
 * Note: `nobg_src` is the ProRes 4444 render-only artifact and is NEVER
 * loaded into a `<video>` element — browsers can't decode ProRes.
 */
function playbackSrcFor(clip: { src?: string; nobg_preview_src?: string; normalizedSrc?: string }): string {
  return clip.nobg_preview_src ?? clip.normalizedSrc ?? clip.src ?? ''
}

/**
 * The inPoint the preview should SEEK to for this clip, accounting for the
 * normalizedSrc cache rebase.
 *
 * A `normalizedSrc` cache covers exactly [inPoint, outPoint] of the original
 * and STARTS AT 0 (it is only `outPoint - inPoint` seconds long). When
 * `playbackSrcFor` chooses that cache as the playback src, seeking to the
 * original `clip.inPoint` (e.g. 496.92) would land far past the end of the
 * short file → the browser clamps to EOF and the preview freezes on the last
 * frame. So when the cache is the chosen src, the effective inPoint is 0 and
 * the window maps to [0, outPoint - inPoint].
 *
 * This mirrors render's `collectAllItems` (montaj_assets/render/render.js),
 * which substitutes `item.normalizedSrc` as the src AND rebases inPoint to 0.
 *
 * The rebase applies ONLY when the cache is actually the chosen src.
 * `nobg_preview_src` takes precedence in `playbackSrcFor` and is NOT a window
 * cache (it covers the full source), so it keeps the original inPoint — exactly
 * as render's nobg path does.
 */
export function effectiveInPoint(clip: { inPoint?: number; nobg_preview_src?: string; normalizedSrc?: string; src?: string }): number {
  const usingNormalizedCache = !clip.nobg_preview_src && !!clip.normalizedSrc
  return usingNormalizedCache ? 0 : (clip.inPoint ?? 0)
}

/**
 * The outPoint in the loaded src's own timeline. For a normalizedSrc cache the
 * stored `clip.outPoint` is in ORIGINAL-source coordinates (e.g. 514.92) while
 * the cache plays in [0, outPoint - inPoint]; the boundary/loop checks compare
 * against `video.currentTime` (cache time), so the outPoint must be rebased to
 * the window length. Returns undefined when no outPoint is stored, so callers
 * keep their existing fallback (clip.end - clip.start + effectiveInPoint).
 */
export function effectiveOutPoint(clip: { inPoint?: number; outPoint?: number; nobg_preview_src?: string; normalizedSrc?: string; src?: string }): number | undefined {
  if (clip.outPoint == null) return undefined
  const usingNormalizedCache = !clip.nobg_preview_src && !!clip.normalizedSrc
  return usingNormalizedCache ? clip.outPoint - (clip.inPoint ?? 0) : clip.outPoint
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

  function getActiveVideo() { return activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current }
  function getInactiveVideo() { return activeSlotRef.current === 0 ? video1Ref.current : video0Ref.current }

  // ── Video timeline ─────────────────────────────────────────────────────────
  // Only video items drive the double-buffer player; non-video items (images, etc.)
  // in tracks[0] are exposed separately for the preview to render as a background layer.
  const clips           = useMemo(() => (project.tracks?.[0] ?? []).filter(c => c.type === 'video').sort((a, b) => a.start - b.start), [project])
  const tracks0NonVideo = useMemo(() => (project.tracks?.[0] ?? []).filter(c => c.type !== 'video'), [project])
  const overlayTracks   = useMemo(() => project.tracks?.slice(1) ?? [], [project])

  // Canvas project: no primary video in tracks[0] (e.g. image-only background track)
  const isCanvasProject = clips.length === 0

  // Total project end — includes opaque overlays and audio that extend beyond video clips.
  // Used to decide whether to keep playing after the last video clip ends.
  const projectEnd = useMemo(() => {
    const videoEnd = clips.length > 0 ? clips[clips.length - 1].end : 0
    const overlayEnd = overlayTracks.flat().reduce((m, i) => Math.max(m, i.end), 0)
    const audioEnd = (project.audio?.tracks ?? []).reduce((m, t) => Math.max(m, t.end ?? 0), 0)
    return Math.max(videoEnd, overlayEnd, audioEnd)
  }, [clips, overlayTracks, project.audio?.tracks])

  // Wire a video slot through a Web Audio GainNode (once per element — createMediaElementSource
  // can only be called once). After this, video.volume/muted have no audible effect; all volume
  // control goes through the GainNode, which supports values > 1.0 for amplification.
  //
  // CRITICAL: ALL slots AND ALL audio tracks share the SAME AudioContext. Fresh
  // AudioContexts start suspended and require a user gesture to resume. Creating
  // separate contexts (one per slot, or a separate one for audio tracks) means
  // those born inside a useEffect have no user-gesture activation — they stay
  // suspended → silent. Worse, video frame production is gated on the wired
  // AudioContext clock running, so a suspended context with a wired <video>
  // produces "video plays but no frames render" after a hard refresh.
  // Stash the single shared context on `window` so it survives strict-mode remounts
  // and is reused across audio tracks, video slots, and re-mounts.
  function getSharedAudioContext(): AudioContext {
    const w = window as Window & MontajWindow
    // If the cached context is closed (shouldn't happen, but defensive), recreate.
    if (!w.__montajSharedCtx || w.__montajSharedCtx.state === 'closed') {
      w.__montajSharedCtx = new AudioContext()
    }
    return w.__montajSharedCtx
  }

  /**
   * MUST be called from inside a user-gesture handler (keydown, click, etc.).
   * Browsers credit a `resume()` call as gesture-driven only when it happens
   * synchronously inside a gesture-rooted call stack. Calling resume() from
   * a useEffect or a setTimeout silently fails — the context stays suspended.
   *
   * Symptom of a suspended context with a wired <video>: video appears to
   * play (paused=false, currentTime advances internally per the DOM clock)
   * but no frames render and no audio plays — the entire pipeline is gated
   * on the AudioContext clock running. This bites specifically after a page
   * refresh, because SPA navigation carries gesture activation across pages
   * but a hard reload does not.
   */
  function resumeAudioContextFromGesture() {
    const w = window as Window & MontajWindow
    const ctx: AudioContext | undefined = w.__montajSharedCtx
    if (ctx && ctx.state === 'suspended') {
      // Fire-and-forget; resume() returns a Promise but the gesture-credit
      // happens at the synchronous call site, not when the promise resolves.
      ctx.resume().catch(() => {})
    }
  }

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
  // get gain 0; unmuted clips get the clip's volume value. No-op until the slot is
  // wired (first play) — there's no audio to control on a paused poster, and
  // wiring here would gate the poster frame on the suspended context.
  function applyClipVolume(clip: { muted?: boolean; volume?: number }) {
    const slot = activeSlotRef.current
    const gain = getVideoGain(slot)
    if (gain) gain.gain.value = clip.muted ? 0 : (clip.volume ?? 1)
  }

  // Apply video clip volume via Web Audio GainNode (supports > 1.0 amplification)
  useEffect(() => {
    const idx = activeIdxRef.current
    const clip = clips[idx]
    if (!clip) return
    applyClipVolume(clip)
  }, [clips, activeSlot])

  useEffect(() => {
    if (!isCanvasProject) return
    const captionEnd = (project.captions?.segments ?? []).reduce((m: number, s) => Math.max(m, s.end), 0)
    const maxEnd = Math.max(
      overlayTracks.flat().reduce((m, i) => Math.max(m, i.end), 0),
      captionEnd,
    )

    function tick(ms: number) {
      if (rafLastMs.current !== null) {
        const dt   = (ms - rafLastMs.current) / 1000
        const next = Math.min(lastTimeRef.current + dt, maxEnd)
        lastTimeRef.current = next
        onTimeUpdate(next)
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
  }, [isPlaying, isCanvasProject, overlayTracks, project, onTimeUpdate])

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

  const syncAudioTracks = useCallback(function syncAudioTracks(playhead: number, playing: boolean) {
    for (const track of unmutedAudioTracksRef.current) {
      const el = audioRefsMap.current.get(track.id)
      if (!el) continue

      const inPt = track.inPoint ?? 0
      const trackTime = (playhead - track.start) + inPt
      // Derive outPoint from the timeline span — the stored outPoint can drift
      // out of sync with start/end during trim operations, causing premature silence.
      // The HTML audio element naturally stops at end-of-file, so sourceDuration
      // acts as an implicit ceiling without needing an explicit check here.
      const outPoint = inPt + (track.end - track.start)
      const outsideWindow =
        playhead < track.start ||
        playhead >= track.end ||
        trackTime < 0 ||
        trackTime >= outPoint

      if (outsideWindow) {
        if (!el.paused) el.pause()
        continue
      }

      if (Math.abs(el.currentTime - trackTime) > 0.3) {
        el.currentTime = Math.max(0, trackTime)
      }

      if (playing && el.paused) el.play().catch(() => {})
      if (!playing && !el.paused) el.pause()

      // Apply fade-in / fade-out gain envelope
      const gain = gainNodesMap.current.get(track.id)
      if (gain) {
        const fadeIn = track.fadeIn ?? 0
        const fadeOut = track.fadeOut ?? 0
        const baseVol = track.volume ?? 1
        const elapsed = playhead - track.start
        const remaining = track.end - playhead

        let fadeMul = 1
        if (fadeIn > 0 && elapsed < fadeIn) {
          fadeMul = elapsed / fadeIn
        }
        if (fadeOut > 0 && remaining < fadeOut) {
          fadeMul = Math.min(fadeMul, remaining / fadeOut)
        }
        gain.gain.value = baseVol * Math.max(0, fadeMul)
      }
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
    // reload to swap the preview to the cutout version.
    const identity = clips
      .map(c => `${c.nobg_preview_src ?? ''}|${c.src}|${c.inPoint ?? 0}|${c.outPoint ?? ''}`)
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
  }, [clips])

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
    onTimeUpdate(t)

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
    onTimeUpdate(nc.start)
    activeIdxRef.current = ni
    if (nv) {
      const src = fileUrlRef.current(playbackSrcFor(nc))
      if (preloadSrcRef.current !== src) { nv.src = src; nv.currentTime = effectiveInPoint(nc) }
      const gain = ensureVideoGain(ns)
      if (gain) gain.gain.value = nc.muted ? 0 : (nc.volume ?? 1)
      playSoon(nv)
    }
    void (activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current)?.pause()
    activeSlotRef.current = ns
    setActiveSlot(ns)
    setShowVideo(true)
    preloadSrcRef.current = ''
  }, [clips, onTimeUpdate])

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
        if (nextGain) nextGain.gain.value = clips[nextIdx].muted ? 0 : (clips[nextIdx].volume ?? 1)
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
          onTimeUpdate(next.start)
          activeIdxRef.current = nextIdx

          if (nextVideo) {
            const nextSrc = fileUrlRef.current(playbackSrcFor(next))
            if (preloadSrcRef.current !== nextSrc) {
              nextVideo.src = nextSrc
              nextVideo.currentTime = effectiveInPoint(next)
            }
            const nextGain = ensureVideoGain(nextSlot)
            if (nextGain) nextGain.gain.value = next.muted ? 0 : (next.volume ?? 1)
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
        onTimeUpdate(finalTime)

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
      onTimeUpdate(clip.end)
      for (const el of audioRefsMap.current.values()) { if (!el.paused) el.pause() }
      setIsPlaying(false)
      return
    }

    lastTimeRef.current = t
    onTimeUpdate(t)
  }, [clips, onTimeUpdate])

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
    togglePlay,
    isCanvasProject,
    clips,
    tracks0NonVideo,
    overlayTracks,
    unmutedAudioTracks,
  }
}

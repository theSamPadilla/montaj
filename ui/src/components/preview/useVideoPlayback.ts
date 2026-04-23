import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileUrl } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

export function useVideoPlayback(
  project: Project,
  currentTime: number,
  onTimeUpdate: (t: number) => void,
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
  const audioRefsMap  = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioSrcMap   = useRef<Map<string, string>>(new Map())
  // Web Audio API: GainNode per audio track allows volume > 1.0 (amplification)
  const audioCtxRef   = useRef<AudioContext | null>(null)
  const gainNodesMap  = useRef<Map<string, GainNode>>(new Map())
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

  // Apply video clip volume via native el.volume (0–1 range; doesn't need Web Audio API)
  useEffect(() => {
    const idx = activeIdxRef.current
    const clip = clips[idx]
    if (!clip) return
    const video = getActiveVideo()
    if (video) video.volume = Math.min(1, clip.volume ?? 1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Lazily create AudioContext (must happen after user gesture for autoplay policy)
  function ensureAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext()
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {})
    }
    return audioCtxRef.current
  }

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
        const ctx = ensureAudioContext()
        const source = ctx.createMediaElementSource(el)
        const gain = ctx.createGain()
        gain.gain.value = track.volume ?? 1
        source.connect(gain)
        gain.connect(ctx.destination)
        gains.set(track.id, gain)
      }
      if (srcMap.get(track.id) !== track.src) {
        el.src = fileUrl(track.src)
        srcMap.set(track.id, track.src)
      }
      // Volume is controlled via GainNode, not el.volume
      const gain = gains.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }
  // Keyed on identity string — only fires when tracks are added/removed/src changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioTrackIdentity])

  // Update volume in-place on every render via GainNode — cheap, no element churn
  useEffect(() => {
    for (const track of unmutedAudioTracks) {
      const gain = gainNodesMap.current.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }
  }, [unmutedAudioTracks])

  // Cleanup on unmount only
  useEffect(() => {
    const map = audioRefsMap.current
    const srcMap = audioSrcMap.current
    const gains = gainNodesMap.current
    const ctx = audioCtxRef.current
    return () => {
      for (const el of map.values()) { el.pause(); el.src = '' }
      map.clear()
      srcMap.clear()
      gains.clear()
      if (ctx) ctx.close().catch(() => {})
      audioCtxRef.current = null
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
        if (isCanvasProject) { setIsPlaying(prev => !prev); return }
        if (inGapRef.current) {
          if (gapRAFRef.current !== null) {
            // Playing through gap → pause
            cancelAnimationFrame(gapRAFRef.current)
            gapRAFRef.current = null
            setIsPlaying(false)
          } else {
            // Paused in gap → resume from current position
            gapFromRef.current = lastTimeRef.current
            gapWallRef.current = performance.now()
            gapRAFRef.current  = requestAnimationFrame(tickGap)
            setIsPlaying(true)
          }
          return
        }
        const video = getActiveVideo()
        if (!video) return
        video.paused ? video.play().catch(() => {}) : video.pause()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCanvasProject])

  // Track clip identity to avoid reloading when only overlays change
  const clipsSourceRef = useRef('')

  // Load first clip into active slot when clips change
  useEffect(() => {
    const video = getActiveVideo()
    if (!video || !clips.length || !clips[0].src) return
    // Only reload if the actual clip sources/trim points changed — not just overlay edits
    const identity = clips.map(c => `${c.src}|${c.inPoint ?? 0}|${c.outPoint ?? ''}`).join(',')
    if (identity === clipsSourceRef.current) return
    clipsSourceRef.current = identity
    activeIdxRef.current  = 0
    activeSlotRef.current = 0
    loopOffsetRef.current = 0
    setActiveSlot(0)
    preloadSrcRef.current = ''
    video.src = fileUrl(clips[0].src)
    video.currentTime = clips[0].inPoint ?? 0
    video.muted = !!(clips[0].muted)
    video.volume = Math.min(1, clips[0].volume ?? 1)
    // Clear inactive slot
    const inactive = getInactiveVideo()
    if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const src = fileUrl(nc.src)
      if (preloadSrcRef.current !== src) { nv.src = src; nv.currentTime = nc.inPoint ?? 0 }
      nv.muted = !!(nc.muted)
      nv.volume = Math.min(1, nc.volume ?? 1)
      nv.play().catch(() => {})
    }
    ;(activeSlotRef.current === 0 ? video0Ref.current : video1Ref.current)?.pause()
    activeSlotRef.current = ns
    setActiveSlot(ns)
    setShowVideo(true)
    preloadSrcRef.current = ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const targetSrc = fileUrl(clip.src)
      if (video.src !== targetSrc) {
        video.src = targetSrc
        // Clear preloaded inactive slot — it may no longer be the right next clip
        preloadSrcRef.current = ''
        const inactive = getInactiveVideo()
        if (inactive) { inactive.pause(); inactive.removeAttribute('src') }
      }
      video.muted = !!(clip.muted)
      video.volume = Math.min(1, clip.volume ?? 1)
      const inPoint = clip.inPoint ?? 0
      if (clip.loop && clip.outPoint) {
        const loopDur = clip.outPoint - inPoint
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const outPoint = clip.outPoint ?? clip.end - clip.start + (clip.inPoint ?? 0)

    // Preload next clip into inactive slot ~1s before end
    const timeLeft = outPoint - video.currentTime
    if (timeLeft < 1.0) {
      const nextIdx = activeIdxRef.current + 1
      if (nextIdx < clips.length && clips[nextIdx].src) {
        const inactiveVideo = slot === 0 ? video1Ref.current : video0Ref.current
        const nextSrc = fileUrl(clips[nextIdx].src!)
        if (inactiveVideo && preloadSrcRef.current !== nextSrc) {
          preloadSrcRef.current = nextSrc
          inactiveVideo.src = nextSrc
          inactiveVideo.currentTime = clips[nextIdx].inPoint ?? 0
          inactiveVideo.muted = !!(clips[nextIdx].muted)
          inactiveVideo.volume = Math.min(1, clips[nextIdx].volume ?? 1)
        }
      }
    }

    if (video.currentTime >= outPoint) {
      if (clip.loop) {
        const projectT = clip.start + loopOffsetRef.current + (video.currentTime - (clip.inPoint ?? 0))
        if (projectT < clip.end) {
          // Still within the clip's project window — loop the source video
          const loopDur = outPoint - (clip.inPoint ?? 0)
          loopOffsetRef.current += loopDur
          video.currentTime = clip.inPoint ?? 0
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
            const nextSrc = fileUrl(next.src!)
            if (preloadSrcRef.current !== nextSrc) {
              nextVideo.src = nextSrc
              nextVideo.currentTime = next.inPoint ?? 0
            }
            nextVideo.muted = !!(next.muted)
            nextVideo.volume = Math.min(1, next.volume ?? 1)
            nextVideo.play().catch(() => {})
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

    const t = clip.start + loopOffsetRef.current + (video.currentTime - (clip.inPoint ?? 0))

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

  function togglePlay() {
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
    video.paused ? video.play().catch(() => {}) : video.pause()
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

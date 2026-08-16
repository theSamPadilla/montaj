/**
 * SP4 T6 — the WebCodecs engine's React seam.
 *
 * `useVideoPlayback` is this module's specification. It answers the same
 * questions `PreviewPlayer` asks today — *is it playing, what is on track 0,
 * what are the overlay tracks, toggle playback* — but every answer comes from
 * `engine/`'s single tick instead of two `<video>` slots and three rAF clocks.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK OWNS
 * ─────────────────────────────────────────────────────────────────────────
 *  1. **Engine lifecycle.** Created once per project IDENTITY, disposed on
 *     unmount or identity change; project EDITS go through `updateProject`
 *     (which is also how a `preparing` clip resolves when SSE delivers its
 *     proxy). Engine eligibility is NOT re-evaluated here — that is the call
 *     site's job (`PreviewPlayer`'s `useEngineMode`), per plan decision 2.
 *  2. **The clock bridge** — see `emitTime` and the scrub effect below.
 *  3. **The gesture anchors.** Both of the legacy hook's
 *     `resumeAudioContextFromGesture` call sites (`togglePlay` and the Space
 *     keydown listener) live *inside* `useVideoPlayback`, so engine mode would
 *     silently lose them. They are re-implemented here against the shared
 *     `audio-context.ts` module — the engine needs the resume MORE than the
 *     legacy path does, because a suspended context stalls its master clock
 *     and therefore stalls painting, not just audio.
 *  4. **The audio lanes.** `project.audio.tracks` stay `<audio>` elements
 *     (plan decision 5) with the legacy element/GainNode lifecycle kept
 *     verbatim; only the per-tick sync arithmetic is rewritten, onto
 *     `timeline-core`'s `audioWindow`, and driven from the engine tick rather
 *     than from a React effect on `currentTime`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT OWN
 * ─────────────────────────────────────────────────────────────────────────
 *  - **Video-item volume, including >1.0.** The legacy hook routes each
 *    `<video>` slot through a GainNode to get amplification. The engine has no
 *    element to route: `createMasterClock` takes the item's `volume`/`muted`
 *    and scales the PCM at ring-enqueue time (T4), reached from
 *    `engine/index.ts`'s `SourceRequest` → `request.item.volume`. Nothing to
 *    thread here; adding a second volume path would be the duplication the
 *    divergence registry exists to prevent.
 *  - **`<video>` slot mechanics.** No refs, no slot swap, no `onError` proxy
 *    fallback (`proxySupport.ts` gates the LEGACY player; the engine's own
 *    gate is `engine/eligibility.ts`, and a proxy that fails mid-session
 *    routes to the scheduler's `preparing` picture, not to a src downgrade).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { audioWindow } from '@bycrux/timeline-core'
import {
  createEngine,
  track0VideoItems,
  type Engine,
  type EngineStats,
  type EngineStatus,
} from '../../engine'
import { getSharedAudioContext, resumeAudioContextFromGesture } from './audio-context'
import type { EditorProject as Project, VisualItem } from '../../schema'

/**
 * The legacy scrub effect's dead-zone (`Math.abs(currentTime -
 * lastTimeRef.current) < 0.05`) — the mechanism, the constant and the reason
 * are all inherited: below it, a difference is the playhead's own rounding
 * coming back around, not a user asking to go somewhere.
 */
export const SCRUB_DEAD_ZONE_S = 0.05

/**
 * The legacy `syncAudioTracks` re-seek threshold, kept exactly. It was chosen
 * against `<video>`-derived time; the engine's measured A/V error (±4ms) is an
 * order of magnitude inside it, so it stays a *drift* correction rather than
 * becoming a per-tick re-seek.
 */
export const AUDIO_SYNC_THRESHOLD_S = 0.3

/**
 * How many engine-emitted playhead values to remember for echo suppression.
 * 120 ≈ two seconds at 60Hz — comfortably longer than any plausible React
 * render lag, short enough that a value in it is always within ~2s of the
 * playhead. See `isEcho`.
 */
const EMIT_HISTORY = 120

const IDLE_STATUS: EngineStatus = {
  transport: 'idle',
  picture: 'black',
  clipId: null,
  seeking: false,
  clock: 'fallback',
}

/**
 * What `PreviewPlayer` consumes, minus the `<video>`-slot keys (refs, slot
 * index, `onTimeUpdate`/`onPause`/`onEnded`/`onError` handlers) — in engine
 * mode those elements do not exist, and the surface renders `EngineSurface`
 * instead of the two slots. Two of the survey's slot-adjacent keys are kept
 * because `PreviewPlayer` reads them outside the slot JSX or would otherwise
 * need a second code path; both are documented at their definition below.
 */
export interface EnginePlayback {
  /** `transport === 'playing'`. Drives the play-button overlay and `OverlayItemsLayer`. */
  isPlaying: boolean
  /**
   * **Inert.** The legacy hook exposes this so the `<video>` elements' own
   * `onPlay` can push the browser's opinion of playback back into React. The
   * engine has no element with an opinion — the transport is authoritative and
   * flows the other way — so this is a documented no-op, kept only so the
   * shared surface's prop shape is one interface rather than two.
   */
  setIsPlaying: (value: boolean | ((prev: boolean) => boolean)) => void
  /**
   * The `showVideo` analog: `picture === 'video'`. The legacy hook uses it to
   * zero a slot's opacity through a gap; the engine paints its own black, so
   * this is informational for the surface (and for T7's HUD) rather than
   * load-bearing.
   */
  showVideo: boolean
  /** Gesture-anchored play/pause. Resumes the shared AudioContext first. */
  togglePlay: () => void
  /** No track-0 video items — the legacy `isCanvasProject`, same predicate. */
  isCanvasProject: boolean
  /** Track-0 video items, start-sorted. Identical to the legacy `clips` memo. */
  clips: VisualItem[]
  /** Everything else on track 0 (images, overlays). */
  tracks0NonVideo: VisualItem[]
  /** `project.tracks[1..]`. */
  overlayTracks: VisualItem[][]
  /** Live engine status — `EngineSurface` renders the picture state from it. */
  status: EngineStatus
  /** Canvas ref callback. Stable identity, so React never re-attaches on a re-render. */
  attachCanvas: (canvas: HTMLCanvasElement | null) => void
  /**
   * T7's debug HUD reads engine stats through this rather than through React
   * state, and polls it on its own timer — `status` above only changes on a
   * genuine transport/picture/clip/clock transition (`scheduler.ts`'s
   * `publish`), so fps/buffer, which move every painted frame, would sit
   * stale between those events if the HUD keyed off `status` instead. Stable
   * identity, like `attachCanvas`. `null` whenever there is no live engine
   * (between project identities, or after dispose).
   */
  getStats: () => EngineStats | null
}

export function useEnginePlayback(
  project: Project,
  currentTime: number,
  onTimeUpdate: (t: number) => void,
  fileUrl: (path: string) => string,
): EnginePlayback {
  // ── Derived collections (the legacy memos, verbatim) ──────────────────────
  // `track0VideoItems` IS the legacy `clips` memo, lifted into the scheduler so
  // one definition serves both the engine's tick and this surface.
  const clips           = useMemo(() => track0VideoItems(project), [project])
  const tracks0NonVideo = useMemo(() => (project.tracks?.[0] ?? []).filter(c => c.type !== 'video'), [project])
  const overlayTracks   = useMemo(() => project.tracks?.slice(1) ?? [], [project])
  const isCanvasProject = clips.length === 0

  const [status, setStatus] = useState<EngineStatus>(IDLE_STATUS)
  const transportRef = useRef<EngineStatus['transport']>('idle')

  const engineRef = useRef<Engine | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Latest-value refs for everything the engine's construction-time callbacks
  // read. The engine captures those callbacks ONCE (see `EngineDeps.onTime`), so
  // they must be stable and must not close over a render's values.
  const fileUrlRef = useRef(fileUrl)
  useEffect(() => { fileUrlRef.current = fileUrl }, [fileUrl])
  const onTimeRef = useRef(onTimeUpdate)
  useEffect(() => { onTimeRef.current = onTimeUpdate }, [onTimeUpdate])
  const currentTimeRef = useRef(currentTime)

  // ── The clock bridge ──────────────────────────────────────────────────────
  //
  // Two directions over ONE `PlaybackClock`, and the whole problem is telling
  // them apart:
  //
  //   engine → editor   every tick, `emitTime` writes the playhead into
  //                     `clock.set`. Timeline components re-render from it.
  //   editor → engine   Scrubber/Timeline/track rows call `clock.set(t)`
  //                     DIRECTLY (unchanged — they know nothing about either
  //                     playback path). That arrives here as a changed
  //                     `currentTime` prop and must become `engine.seek(t)`.
  //
  // `lastEmittedRef` is written BEFORE the value reaches `clock.set`, so by the
  // time React re-renders with it the mirror is already in place and the scrub
  // effect can recognize its own echo.
  const lastEmittedRef = useRef(currentTime)
  /**
   * Ring of values emitted since the last external seek.
   *
   * The dead-zone alone satisfies "an echo of the LATEST emission never seeks".
   * It does not satisfy the stronger contract — *engine-originated echoes never
   * re-trigger seeks* — because React can commit a render carrying an older
   * snapshot: at 60Hz, one 100ms hitch puts `currentTime` ~6 frames behind
   * `lastEmittedRef`, past the 0.05s dead zone, and the bridge would answer a
   * frame it emitted itself with a backwards seek (which restarts the decode
   * stream, which lengthens the hitch). Every stale echo is bit-exactly a value
   * this hook emitted, so exact membership is the exact test.
   *
   * Cleared on every external seek — never on a transport change, because
   * `pause()` publishes a status without ticking and a stale echo arriving just
   * after it would then read as a scrub and rewind the playhead. Values in the
   * ring are therefore always playback positions from the last ≤2s of the
   * CURRENT seek segment, which a scrub target cannot plausibly hit bit-exactly
   * (and if it did, it would be a scrub to where the playhead already is).
   */
  const emittedRef = useRef<number[]>([])

  const rememberEmitted = (t: number) => {
    const ring = emittedRef.current
    ring.push(t)
    if (ring.length > EMIT_HISTORY) ring.splice(0, ring.length - EMIT_HISTORY)
  }
  const isEcho = (t: number) => emittedRef.current.includes(t)

  /**
   * The transport as of RIGHT NOW, not as of the last published status.
   *
   * The engine emits the playhead and then publishes the status, so inside a
   * tick `transportRef` is one step behind — and the two ticks where that
   * matters are exactly the ones the audio lanes care about: the tick that
   * starts playback (lanes must start with it) and the tick a looping clip
   * stops on (lanes must stop with it). `transportRef` remains the fallback for
   * the window between construction and the first status.
   */
  const isEnginePlaying = () =>
    (engineRef.current?.status().transport ?? transportRef.current) === 'playing'

  // ── Audio lanes ───────────────────────────────────────────────────────────
  // Element/GainNode lifecycle lifted from `useVideoPlayback` unchanged (same
  // identity key, same "volume never churns elements" rule, same
  // never-close-the-context cleanup). Only `syncAudioTracks` is rewritten.
  const audioRefsMap = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioSrcMap  = useRef<Map<string, string>>(new Map())
  const gainNodesMap = useRef<Map<string, GainNode>>(new Map())

  const unmutedAudioTracks = useMemo(
    () => (project.audio?.tracks ?? []).filter(t => !t.muted && t.src),
    [project.audio?.tracks],
  )
  const audioTrackIdentity = useMemo(
    () => unmutedAudioTracks.map(t => `${t.id}:${t.src}`).join('|'),
    [unmutedAudioTracks],
  )
  const unmutedAudioTracksRef = useRef(unmutedAudioTracks)
  useEffect(() => { unmutedAudioTracksRef.current = unmutedAudioTracks }, [unmutedAudioTracks])

  /**
   * Slave every audio lane to the engine's playhead.
   *
   * The legacy version computed the window and the fade envelope inline; this
   * one asks `timeline-core`'s `audioWindow` — the pure port of exactly that
   * arithmetic, including the derived-outPoint rule (the stored `outPoint` can
   * drift out of sync with start/end during a trim and cause premature
   * silence). Finishing that adoption is plan decision 5.
   *
   * Stable identity (`[]` + refs), because the engine's tick callback captures
   * it once at construction.
   */
  const syncAudioTracks = useCallback(function syncAudioTracks(playhead: number, playing: boolean) {
    for (const track of unmutedAudioTracksRef.current) {
      const el = audioRefsMap.current.get(track.id)
      if (!el) continue

      const win = audioWindow(track, playhead)
      if (!win.active) {
        if (!el.paused) el.pause()
        continue
      }

      if (Math.abs(el.currentTime - win.trackTime) > AUDIO_SYNC_THRESHOLD_S) {
        el.currentTime = Math.max(0, win.trackTime)
      }
      if (playing && el.paused) el.play().catch(() => {})
      if (!playing && !el.paused) el.pause()

      // `audioWindow.gain` is already `baseVolume * max(0, fadeMul)`.
      const gain = gainNodesMap.current.get(track.id)
      if (gain) gain.gain.value = win.gain
    }
  }, [])

  // Create / destroy elements when the track SET changes (not on volume drags).
  useEffect(() => {
    const map = audioRefsMap.current
    const srcMap = audioSrcMap.current
    const gains = gainNodesMap.current
    const activeIds = new Set(unmutedAudioTracks.map(t => t.id))

    for (const [id, el] of map) {
      if (!activeIds.has(id)) {
        el.pause()
        el.src = ''
        map.delete(id)
        srcMap.delete(id)
        gains.delete(id)
      }
    }

    for (const track of unmutedAudioTracks) {
      let el = map.get(track.id)
      if (!el) {
        el = new Audio()
        el.preload = 'auto'
        map.set(track.id, el)
        // element → GainNode → destination, on the SHARED context (volume > 1.0).
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
      const gain = gains.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }

    // A lane added mid-session has to be placed at the current playhead
    // immediately; the next engine tick would otherwise be the first thing to
    // touch it, and while paused there is no next tick.
    syncAudioTracks(lastEmittedRef.current, isEnginePlaying())
  // Keyed on the identity string ALONE, exactly as the legacy hook keys it: the
  // effect must fire on adds/removes/src changes and never on a volume drag
  // (which would tear down and rebuild every element mid-playback). The closure
  // over `unmutedAudioTracks` is from the render in which the identity last
  // changed, which is the render whose track set this effect is reconciling.
  }, [audioTrackIdentity])

  // Volume in place, no element churn.
  useEffect(() => {
    for (const track of unmutedAudioTracks) {
      const gain = gainNodesMap.current.get(track.id)
      if (gain) gain.gain.value = track.volume ?? 1
    }
  }, [unmutedAudioTracks])

  // Unmount only. The shared AudioContext is window-scoped and never closed.
  useEffect(() => {
    const map = audioRefsMap.current
    const srcMap = audioSrcMap.current
    const gains = gainNodesMap.current
    return () => {
      for (const el of map.values()) { el.pause(); el.src = '' }
      map.clear()
      srcMap.clear()
      gains.clear()
    }
  }, [])

  // ── Engine lifecycle ──────────────────────────────────────────────────────

  /** Mirror-then-forward. The ORDER is the bridge's whole contract. */
  const emitTime = useCallback((t: number) => {
    lastEmittedRef.current = t
    rememberEmitted(t)
    onTimeRef.current(t)
    syncAudioTracks(t, isEnginePlaying())
  }, [syncAudioTracks])

  const handleStatus = useCallback((next: EngineStatus) => {
    // Written synchronously, ahead of the React state, because `emitTime` runs
    // inside the same tick and needs the transport that is true NOW.
    transportRef.current = next.transport
    setStatus(next)
  }, [])

  const handleError = useCallback((message: string) => {
    console.warn(`[montaj] ${message}`)
  }, [])

  // One engine per project IDENTITY. Edits go through `updateProject` below;
  // a different project id is a teardown. The engine is built from a ref rather
  // than the closed-over `project` so that an edit landing in the same commit
  // as the identity change still builds from the newest timeline.
  const projectId = project.id
  const projectRef = useRef(project)
  projectRef.current = project
  /** The project object the engine has already been told about. */
  const appliedProjectRef = useRef<Project | null>(null)

  useEffect(() => {
    const engine = createEngine(projectRef.current, {
      fileUrl: (path: string) => fileUrlRef.current(path),
      onTime: emitTime,
      onStatusChange: handleStatus,
      onError: handleError,
      startProjectS: currentTimeRef.current,
    })
    engineRef.current = engine
    lastEmittedRef.current = currentTimeRef.current
    emittedRef.current = []
    // The project object the engine was just built with is, by definition,
    // already applied — without this the edit effect below would re-apply it.
    appliedProjectRef.current = projectRef.current
    // The canvas ref callback fires during commit, BEFORE this effect, so on a
    // first mount the canvas is already here and waiting to be bound.
    if (canvasRef.current) engine.attach(canvasRef.current)
    return () => {
      engineRef.current = null
      transportRef.current = 'idle'
      engine.dispose()
    }
  }, [projectId, emitTime, handleStatus, handleError])

  // Project EDITS. `updateProject` re-runs the tick against the new timeline —
  // and is the path a `preparing` clip resolves through when SSE delivers its
  // proxySrc. Skipped for the object the engine was just built with.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (appliedProjectRef.current === project) return
    appliedProjectRef.current = project
    engine.updateProject(project)
  }, [project])

  // ── The scrub half of the bridge ──────────────────────────────────────────
  useEffect(() => {
    currentTimeRef.current = currentTime
    const engine = engineRef.current
    if (!engine) {
      // No engine yet (first render, or between project identities): the store
      // is the only truth, so adopt it as the mirror rather than seeking a
      // later engine to a stale value.
      lastEmittedRef.current = currentTime
      return
    }
    if (isEcho(currentTime)) return
    if (Math.abs(currentTime - lastEmittedRef.current) < SCRUB_DEAD_ZONE_S) return
    // External scrub. Mirror FIRST so a re-render before the engine's own echo
    // lands cannot fire a second seek for the same gesture.
    lastEmittedRef.current = currentTime
    emittedRef.current = []
    engine.seek(currentTime)
  }, [currentTime])

  // Transport transitions the tick cannot report: `pause()` publishes a status
  // but never runs a tick, so the lanes would keep playing without this.
  useEffect(() => {
    syncAudioTracks(lastEmittedRef.current, status.transport === 'playing')
  }, [status.transport, syncAudioTracks])

  // ── Gestures ──────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    // GESTURE-ANCHORED, and more load-bearing here than on the legacy path: the
    // engine's master clock counts frames an AudioWorklet has rendered, and a
    // suspended context renders none — so a suspended context freezes the
    // PICTURE, not just the sound. Must be called synchronously inside the
    // gesture for the browser to credit it.
    //
    // `getSharedAudioContext()` FIRST: `resumeAudioContextFromGesture`
    // deliberately never creates the context (see its own doc), so on the
    // very first play — nothing has reached line 307's lane-creation path yet
    // for a project with no audio tracks, and a video-only clip's context is
    // built inside `createMasterClock`, off the gesture stack entirely — the
    // context would not exist yet and there would be nothing to resume. This
    // creates it synchronously inside the gesture, so the browser credits the
    // creation (and the resume that follows) as gesture-driven.
    getSharedAudioContext()
    resumeAudioContextFromGesture()
    const engine = engineRef.current
    if (!engine) return
    if (engine.status().transport !== 'playing') {
      // `play()` runs a tick, which emits the playhead for free.
      engine.play()
      return
    }
    engine.pause()
    // `pause()` publishes a status but never ticks, so nothing else would push
    // the exact stop position into the editor's clock — the store would keep
    // whatever the last rendered frame's value was.
    emitTime(engine.clock.now())
  }, [emitTime])

  // Space = play/pause. The legacy hook's keydown block is the spec: same
  // typing-surface guard (an `<input>`, a `<textarea>` or any contentEditable
  // host — which is what the caption/overlay editors and every modal field
  // are), same `e.code === 'Space'` test, same `preventDefault()` (otherwise
  // Space scrolls the editor), same gesture-anchored resume. What it does NOT
  // reproduce is the canvas-project and in-gap branching: those existed because
  // three different clocks owned playback in three different situations, and
  // the engine has one transport for all of them.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.code !== 'Space') return
      e.preventDefault()
      togglePlay()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [togglePlay])

  // ── Canvas binding ────────────────────────────────────────────────────────
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
    engineRef.current?.attach(canvas)
  }, [])

  const setIsPlaying = useCallback(() => {
    /* inert — see the interface note */
  }, [])

  const getStats = useCallback((): EngineStats | null => engineRef.current?.stats() ?? null, [])

  return {
    isPlaying: status.transport === 'playing',
    setIsPlaying,
    showVideo: status.picture === 'video',
    togglePlay,
    isCanvasProject,
    clips,
    tracks0NonVideo,
    overlayTracks,
    status,
    attachCanvas,
    getStats,
  }
}

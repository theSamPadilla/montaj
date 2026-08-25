/**
 * The page's ONE Web Audio context, and the gesture-anchored resume that keeps
 * it running.
 *
 * SP4 T4 **moved** this out of `useVideoPlayback.ts` — it is not a copy. Both
 * playback paths need the identical context and the identical resume rule:
 *
 *   - the legacy `<video>` player wires every slot and every audio lane
 *     through `MediaElementSource → GainNode → ctx.destination`, so a
 *     suspended context silently kills audio *and* video frame production;
 *   - the WebCodecs engine (`engine/audio-clock.ts`) drives its MASTER CLOCK
 *     off an `AudioWorklet` on the same context, so a suspended context stalls
 *     the clock and therefore stalls *painting* — the same failure with a
 *     wider blast radius.
 *
 * Two copies of this logic would be a textbook divergence-registry hazard
 * (two implementations of one rule, drifting silently), which is why the
 * extraction is a hard requirement of the engine work rather than a tidy-up.
 *
 * Nothing here closes the context: it is window-scoped on purpose (see
 * `getSharedAudioContext`).
 */

/** Typed extension for the shared AudioContext cached on window. */
export interface MontajWindow {
  __montajSharedCtx?: AudioContext
}

/**
 * CRITICAL: ALL video slots AND ALL audio tracks AND the engine's master clock
 * share the SAME AudioContext. Fresh AudioContexts start suspended and require
 * a user gesture to resume. Creating separate contexts (one per slot, or a
 * separate one for audio tracks) means those born inside a useEffect have no
 * user-gesture activation — they stay suspended → silent. Worse, video frame
 * production is gated on the wired AudioContext clock running, so a suspended
 * context with a wired <video> produces "video plays but no frames render"
 * after a hard refresh.
 *
 * Stash the single shared context on `window` so it survives strict-mode
 * remounts and is reused across audio tracks, video slots, engine sessions,
 * and re-mounts.
 */
export function getSharedAudioContext(): AudioContext {
  const w = window as Window & MontajWindow
  // If the cached context is closed (shouldn't happen, but defensive), recreate.
  if (!w.__montajSharedCtx || w.__montajSharedCtx.state === 'closed') {
    w.__montajSharedCtx = new AudioContext()
  }
  return w.__montajSharedCtx
}

/**
 * Read the shared context WITHOUT creating one. Callers that need to sample a
 * live property off the context (latency, state) but must not force its
 * creation — because creation off the gesture stack is precisely the failure
 * mode `getSharedAudioContext` exists to make explicit — use this instead.
 * Returns undefined until something on the gesture stack has minted the ctx.
 */
export function peekSharedAudioContext(): AudioContext | undefined {
  return (window as Window & MontajWindow).__montajSharedCtx
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
 *
 * The engine path has the same requirement for a different reason: its master
 * clock counts frames an `AudioWorklet` has actually rendered, and a suspended
 * context renders none — the clock (and the canvas painting that follows it)
 * freezes until something resumes it from a gesture.
 *
 * Deliberately does NOT create the context: this is only ever called from a
 * gesture that is *also* about to use an already-created context, and creating
 * one here would hide the "nobody has wired audio yet" case.
 */
export function resumeAudioContextFromGesture() {
  const w = window as Window & MontajWindow
  const ctx: AudioContext | undefined = w.__montajSharedCtx
  if (ctx && ctx.state === 'suspended') {
    // Fire-and-forget; resume() returns a Promise but the gesture-credit
    // happens at the synchronous call site, not when the promise resolves.
    ctx.resume().catch(() => {})
  }
}

/**
 * Seconds between the moment a sample is handed to the output device and the
 * moment it becomes audible: the sum of `outputLatency` (the device queue) and
 * `baseLatency` (the graph's own processing lead). The engine's master clock
 * counts *frames consumed* by `process()` — a frame the clock has counted is
 * still `latencySeconds()` away from the ear, and the `<video>` fallback's
 * `currentTime` has the same gap on the same graph, so the value bridged to
 * the painter is `now() - latencySeconds(ctx)` on both paths.
 *
 * Read live on every emit (device switches can change it), clamp ≥ 0, and
 * tolerate missing fields on non-Chromium contexts / test stubs.
 */
export function latencySeconds(ctx: Pick<AudioContext, 'outputLatency' | 'baseLatency'>): number {
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0
  return Math.max(0, out + base)
}

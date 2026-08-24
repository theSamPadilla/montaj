/**
 * captionJob — the background caption-regeneration job, lifted out of the
 * editor package's blocking `CaptionRegenModal` and owned at the app root
 * instead.
 *
 * Historically, caption regeneration was a full-screen modal
 * (`montaj_assets/editor/src/video/CaptionRegenModal.tsx`) that consumed
 * `adapter.generateCaptions` for the lifetime of its own mount and blocked
 * the rest of the editor while it ran. This module moves that stream
 * consumption up to a provider mounted once at the app root
 * (`App.tsx`, T3), so a caption job survives whatever the user does in the
 * editor underneath — including navigating away from the project — and its
 * progress is read by a small top-bar readout (T4) instead of a modal.
 *
 * WHY `start` TAKES A THUNK, NOT `(projectId, opts)`:
 * The plan's literal signature was `start(projectId, opts)`, mirroring
 * `adapter.generateCaptions(projectId, opts)` directly. This module
 * deliberately deviates: `start`'s second argument is a thunk that RETURNS
 * the event stream, and the caller (EditorPage) is the one that owns the
 * adapter and calls `adapter.generateCaptions(projectId, opts)` to produce
 * it. Why: this provider mounts at the app root, which is NOT lazy-loaded
 * (`App` is a static import off `main.tsx`), while `EditorPage` — the only
 * place that constructs a `montajAdapter` — IS lazy-loaded
 * (`main.tsx:11`). If this module imported `createMontajAdapter` (or even
 * just its types eagerly enough to need the module), the whole adapter
 * graph (`lib/api`, `lib/overlay-eval`'s JSX compilation, `lib/file-watch`,
 * `lib/sse`) would be pulled out of the lazy editor chunk and into the main
 * bundle for every route that never opens an editor (the project list, the
 * workflows page, ...). Taking a thunk keeps the adapter exactly where it
 * already lives and keeps this module host-agnostic besides — it only ever
 * touches the `CaptionEvent`/`Captions` shapes, never Montaj's transport.
 *
 * STRICTMODE / CANCELLATION, AND WHY THIS ISN'T `CaptionRegenModal`'s
 * `cleanupTimerRef` DANCE:
 * `CaptionRegenModal` starts its stream from a `useEffect` that runs on
 * mount, so React StrictMode's dev-only mount → cleanup → mount double-fire
 * would otherwise start transcription (real, non-idempotent sidecar work)
 * twice — it defers teardown with a `setTimeout(0)` and rescues the pending
 * teardown if a second mount lands in the same tick.
 * That hazard is specific to effects that run on mount. Nothing here runs
 * on mount: `start()` is fired once, imperatively, from a user's click on
 * "Regenerate captions" — StrictMode does not double-invoke event handlers,
 * only effects — so there is no synchronous remount to rescue a teardown
 * against, and a `cleanupTimerRef` would be guarding against a hazard this
 * structure doesn't have.
 * What this DOES need, matching the modal's actual invariant (late events
 * must not `setState`, and cancelling must call the iterator's `return()`
 * to cancel the underlying request), is a monotonic generation counter:
 * every `start()` bumps it and captures the new value; `cancel()` and the
 * provider's own unmount both bump it too. The consuming loop checks the
 * counter before handling each event and stops the moment it's stale, so a
 * late event never lands in state. One counter replaces the modal's
 * `cancelledRef` + `unmountedRef` pair because both cases ("stop consuming")
 * collapse into the same "this generation is no longer current" check here.
 *
 * WHY `cancel()`/UNMOUNT CALL `iterator.return()` DIRECTLY (NOT JUST VIA
 * BREAKING THE LOOP):
 * The generation check above stops US from acting on a late event, but it
 * only runs when the loop wakes up to handle the NEXT event — and a
 * `large`-model transcription can go many seconds between stderr lines
 * (e.g. while the model loads), so "wait for the next event" can mean the
 * underlying request keeps running well after the user clicked Cancel. If
 * they then click "Regenerate captions" again in that window, the server
 * still has the old job open and rejects the new one with a 409
 * `concurrent_caption_job` — a red readout for a user who did nothing
 * wrong. So `start()` stashes the async iterator itself in `iteratorRef`,
 * and `cancel()`/unmount call `iteratorRef.current?.return()` eagerly and
 * synchronously, which is what actually cancels `fetch`'s reader (see
 * `generateCaptions` in `lib/api.ts` — its returned cancel does
 * `reader.cancel()`) and lets the server's `is_disconnected` poll fire and
 * kill the caption pipeline's process tree promptly.
 *
 * NO SAVE HERE:
 * The provider never calls `saveProject`. The montaj server persists the
 * regenerated captions itself as part of the caption job and broadcasts an
 * SSE frame that the editor's own project subscription reconciles (see the
 * comment above `<CaptionRegenModal>` in
 * `montaj_assets/editor/src/video/VideoEditor.tsx`: "a saveProject here
 * would double-write"). The sink this module calls on a completed job is a
 * LOCAL state patch only — EditorPage (T3) is expected to route it through
 * `applyExternal`, not a save.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { CaptionEvent, Captions } from '@bycrux/editor'

// A `large`-model transcription of a long timeline emits a lot of stderr,
// one line per log event, and this array lives for the life of the app (the
// provider never unmounts in production) — so it is capped rather than left
// to grow unbounded across however many jobs a session runs.
const MAX_LOG_LINES = 200

export interface CaptionJobState {
  status: 'idle' | 'running' | 'done' | 'error'
  logs: string[]
  error: string | null
  projectId: string | null
}

export interface CaptionJobApi extends CaptionJobState {
  /** Begin a background caption job. `run` is a thunk returning the event
   *  stream — the CALLER owns the adapter, so this module stays out of the
   *  app-root bundle's dependency on montajAdapter. No-op while a job is
   *  already running. */
  start(projectId: string, run: () => AsyncIterable<CaptionEvent>): void
  /** Stop consuming (and cancel the underlying request) and return to idle. */
  cancel(): void
  /** Clear a terminal `done`/`error` back to idle — the readout's dismiss. */
  dismiss(): void
}

/**
 * Narrow slice of `CaptionJobApi`, deliberately WITHOUT `logs`. Consumers
 * that only care about the job's phase/target/error — EditorPage's
 * `captionsGenerating` prop plumbing being the motivating case — should
 * subscribe to this via `useCaptionJobStatus()` instead of `useCaptionJob()`.
 * See that hook's comment for why the split exists.
 */
export interface CaptionJobStatusApi {
  status: CaptionJobState['status']
  projectId: CaptionJobState['projectId']
  error: CaptionJobState['error']
  start: CaptionJobApi['start']
  cancel: CaptionJobApi['cancel']
  dismiss: CaptionJobApi['dismiss']
}

type CaptionSink = (projectId: string, captions: Captions) => void

const IDLE_STATE: CaptionJobState = { status: 'idle', logs: [], error: null, projectId: null }

const CaptionJobContext = createContext<CaptionJobApi | null>(null)

// Holds the currently-registered sink. A ref (not state) so that
// registering/unregistering (useCaptionJobSink, below) never re-renders the
// provider or restarts the job — it's a mailbox `start`'s async loop reads
// from at the moment a job finishes, nothing more.
const CaptionJobSinkContext = createContext<{ current: CaptionSink | undefined } | null>(null)

// Backs useCaptionJobStatus() — see that hook's comment.
const CaptionJobStatusContext = createContext<CaptionJobStatusApi | null>(null)

function appendLogCapped(logs: string[], line: string): string[] {
  const next = [...logs, line]
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
}

export function CaptionJobProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CaptionJobState>(IDLE_STATE)

  // Latest status, readable from `start` without making `start` depend on
  // (and get re-created every time `state.status` changes).
  const statusRef = useRef(state.status)
  statusRef.current = state.status

  // Bumped by every start() (to a fresh value), by cancel(), and on
  // provider unmount. The async loop below captures its own generation at
  // start and treats a mismatch as "stop, and don't touch state" — see the
  // header comment for why this replaces CaptionRegenModal's ref pair.
  const generationRef = useRef(0)

  const sinkRef = useRef<CaptionSink | undefined>(undefined)

  // The in-flight job's async iterator (the object `run()`'s
  // `[Symbol.asyncIterator]()` returns), stashed here so cancel()/unmount
  // can call its return() DIRECTLY and EAGERLY instead of only breaking the
  // consuming loop — see the header comment ("WHY cancel()/UNMOUNT CALL
  // iterator.return() DIRECTLY") for why the generation check alone isn't
  // enough. Cleared whenever the owning loop finishes (see start()'s
  // `finally`) so a later stray cancel() can't return() a dead iterator.
  const iteratorRef = useRef<AsyncIterator<CaptionEvent> | null>(null)

  useEffect(() => {
    return () => {
      // Belt-and-suspenders: the provider is meant to live for the app's
      // whole lifetime (mounted once at the root), but tests mount/unmount
      // it, and this keeps a job's late events from touching state that no
      // longer exists. Also return()s the iterator eagerly, same as
      // cancel() below — an unmount mid-job must abort the request too, not
      // just stop listening to it.
      generationRef.current += 1
      const it = iteratorRef.current
      iteratorRef.current = null
      it?.return?.()?.catch(() => {})
    }
  }, [])

  const start = useCallback((projectId: string, run: () => AsyncIterable<CaptionEvent>) => {
    // One job at a time — the server rejects a concurrent caption job for a
    // project with a 409 anyway, so a second start here would just surface
    // as an error; refusing it up front is simpler and avoids two
    // generations racing to own the single job slot in `state`.
    if (statusRef.current === 'running') return
    // Close the guard above SYNCHRONOUSLY, not just via the render-time
    // assignment below. Two start() calls issued in the same tick (no
    // render in between) would otherwise both read statusRef.current as
    // 'idle' and both launch a job — the second one 409s. The render-time
    // assignment still runs and reconciles this in every other case
    // (error/done/cancel), so nothing else needs to change.
    statusRef.current = 'running'

    const myGen = ++generationRef.current
    setState({ status: 'running', logs: [], error: null, projectId })

    void (async () => {
      // Declared outside the try so the `finally` below can clear
      // `iteratorRef` regardless of how the loop exits (done, generation
      // mismatch, or a thrown exception) — see iteratorRef's comment above.
      let it: AsyncIterator<CaptionEvent> | undefined
      try {
        it = run()[Symbol.asyncIterator]()
        iteratorRef.current = it
        while (true) {
          const { value: ev, done } = await it.next()
          if (done) break
          // Checked after each event resolves (including the first): once
          // cancel()/unmount has moved the generation on, stop processing
          // immediately rather than act on a late event. cancel()/unmount
          // already called the iterator's return() directly (see
          // iteratorRef above) — this check just stops US from also
          // touching state for an event that arrives after that.
          if (myGen !== generationRef.current) break

          if (ev.type === 'log') {
            setState(s => (myGen !== generationRef.current ? s : { ...s, logs: appendLogCapped(s.logs, ev.message) }))
          } else if (ev.type === 'done') {
            setState(s => (myGen !== generationRef.current ? s : { ...s, status: 'done' }))
            sinkRef.current?.(projectId, ev.captions)
          } else {
            setState(s => (myGen !== generationRef.current ? s : { ...s, status: 'error', error: ev.message }))
          }
        }
      } catch (e) {
        // A thrown exception out of the stream must still land here — the
        // top-bar readout is the ONLY surface for a caption job's outcome
        // now that there's no modal, so a job may never fail silently.
        setState(s => (myGen !== generationRef.current ? s : { ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }))
      } finally {
        // Only clear if we're still the current iterator — a cancel()/
        // unmount that already fired will have nulled this out (and
        // return()'d it) itself.
        if (it && iteratorRef.current === it) iteratorRef.current = null
      }
    })()
  }, [])

  const cancel = useCallback(() => {
    // A cancel is a deliberate user action, not a failure: go straight to
    // idle rather than through 'error', and bump the generation so a late
    // event that's already mid-flight doesn't get processed.
    generationRef.current += 1
    // Abort the underlying request EAGERLY by calling the iterator's
    // return() directly, rather than relying on the consuming loop to
    // notice the generation changed on its next event — that can be many
    // seconds away (e.g. while the `large` model loads), which is long
    // enough for the user to click "Regenerate captions" again before the
    // server-side job is actually dead, and hit a 409 `concurrent_caption_
    // job` for a restart that should have just worked. See the header
    // comment for the full story.
    const it = iteratorRef.current
    iteratorRef.current = null
    it?.return?.()?.catch(() => {}) // return() must never make cancel() throw
    setState(IDLE_STATE)
  }, [])

  const dismiss = useCallback(() => {
    // Only clears a TERMINAL state. While running, dismiss() is a no-op —
    // callers that mean "stop this" must call cancel() instead; dismiss()
    // silently discarding a running job's status would leave the request
    // itself still going with nothing left tracking it.
    setState(s => (s.status === 'running' ? s : IDLE_STATE))
  }, [])

  const api: CaptionJobApi = { ...state, start, cancel, dismiss }

  // The narrow value backing useCaptionJobStatus(). Memoized so its
  // identity is stable across renders that only append a log line —
  // `state.logs` deliberately does NOT appear in this dependency list. See
  // useCaptionJobStatus()'s comment for why that matters. start/cancel/
  // dismiss are useCallback([]) and therefore stable forever, so in
  // practice this identity changes only on the (at most) twice-per-job
  // transitions to running/done/error/idle.
  const statusApi = useMemo<CaptionJobStatusApi>(() => ({
    status: state.status,
    projectId: state.projectId,
    error: state.error,
    start,
    cancel,
    dismiss,
  }), [state.status, state.projectId, state.error, start, cancel, dismiss])

  return (
    <CaptionJobContext.Provider value={api}>
      <CaptionJobSinkContext.Provider value={sinkRef}>
        {/* Nested inside (not alongside) the two providers above, so it
            shares this one CaptionJobProvider mount point — no change to
            App.tsx's provider tree is needed. */}
        <CaptionJobStatusContext.Provider value={statusApi}>
          {children}
        </CaptionJobStatusContext.Provider>
      </CaptionJobSinkContext.Provider>
    </CaptionJobContext.Provider>
  )
}

export function useCaptionJob(): CaptionJobApi {
  const ctx = useContext(CaptionJobContext)
  if (!ctx) throw new Error('useCaptionJob must be used within a CaptionJobProvider')
  return ctx
}

/**
 * Narrow subscription to the caption job: `status`/`projectId`/`error` plus
 * the three actions, WITHOUT `logs`. Prefer this over `useCaptionJob()` for
 * any consumer that doesn't render the log lines themselves (today, that's
 * everyone except `CaptionActivityIndicator`, which genuinely needs `logs`
 * and should keep using `useCaptionJob()`).
 *
 * Why this exists: `useCaptionJob()`'s value is a fresh object every render
 * of `CaptionJobProvider`, and `logs` grows by one appended line per stderr
 * line a transcription emits — so a consumer of the full hook re-renders
 * (and, transitively, re-renders everything under it) once per log line for
 * the whole duration of a multi-minute job. `useCaptionJobStatus()`'s value
 * is memoized without `logs` in its dependencies (see `statusApi` above),
 * so its identity — and therefore a consumer's render — only changes on the
 * job's actual phase/target/error transitions.
 */
export function useCaptionJobStatus(): CaptionJobStatusApi {
  const ctx = useContext(CaptionJobStatusContext)
  if (!ctx) throw new Error('useCaptionJobStatus must be used within a CaptionJobProvider')
  return ctx
}

/**
 * Registers the sink a completed job's captions are handed to. Registered by
 * whoever is mounted and cares (EditorPage); safe to have none — a job can
 * finish with no one listening (e.g. the user navigated to the project list
 * while it ran) and the provider just holds `status: 'done'` until dismissed.
 *
 * Takes `fn` by value on every render (not once) but only touches the
 * registration ref on MOUNT/UNMOUNT: `fn` is stashed in a ref that's kept
 * current every render, and the effect below installs one stable trampoline
 * that always calls whatever `fn` currently is. That's what keeps
 * registering side-effect-free — an inline callback passed fresh every
 * EditorPage render does not re-register (or restart) anything.
 */
export function useCaptionJobSink(fn: CaptionSink | undefined): void {
  const sinkContainer = useContext(CaptionJobSinkContext)
  if (!sinkContainer) throw new Error('useCaptionJobSink must be used within a CaptionJobProvider')

  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    sinkContainer.current = (projectId, captions) => fnRef.current?.(projectId, captions)
    return () => {
      sinkContainer.current = undefined
    }
  }, [sinkContainer])
}

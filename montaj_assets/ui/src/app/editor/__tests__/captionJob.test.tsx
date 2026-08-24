import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { CaptionEvent, Captions } from '@bycrux/editor'
import { CaptionJobProvider, useCaptionJob, useCaptionJobSink, useCaptionJobStatus } from '../captionJob'

// ── Fake streams ──────────────────────────────────────────────────────────
// No network involved — captionJob.tsx only ever sees `run(): AsyncIterable
// <CaptionEvent>`, exactly the shape adapter.generateCaptions produces (see
// montajAdapter.captions.test.ts and CaptionRegenModal.test.tsx, whose
// fake-stream style this follows).

const CAPTIONS: Captions = { style: 'pop', segments: [{ start: 0, end: 1, text: 'hi', words: [] }] }

/** A plain array-backed stream — fine for tests that don't need to observe
 *  an intermediate 'running' state or a mid-stream cancel. */
function arrayStream(events: CaptionEvent[]): () => AsyncIterable<CaptionEvent> {
  return () => (async function* () {
    for (const ev of events) yield ev
  })()
}

/** A stream whose generator throws instead of yielding a terminal event —
 *  covers the "never silently stuck on running" requirement. */
function throwingStream(message: string): () => AsyncIterable<CaptionEvent> {
  return () => (async function* () {
    yield { type: 'log', message: 'starting' }
    throw new Error(message)
  })()
}

/**
 * A push-driven stream the test controls one event at a time, with a real
 * `return()` so cancellation can be observed. Mirrors the queue +
 * promise-resolver bridge `montajAdapter.ts` uses for the real SSE stream.
 */
function controllableStream() {
  const queue: CaptionEvent[] = []
  let resolveNext: ((r: IteratorResult<CaptionEvent>) => void) | null = null
  let closed = false
  let returnCalls = 0

  const iterable: AsyncIterable<CaptionEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<CaptionEvent> {
      return {
        next(): Promise<IteratorResult<CaptionEvent>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { resolveNext = resolve })
        },
        return(): Promise<IteratorResult<CaptionEvent>> {
          returnCalls += 1
          closed = true
          if (resolveNext) {
            const r = resolveNext
            resolveNext = null
            r({ value: undefined, done: true })
          }
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  return {
    iterable,
    /** Delivers one event to whatever `next()` is currently pending (or
     *  queues it if nothing is waiting yet). */
    push(ev: CaptionEvent) {
      if (resolveNext) {
        const r = resolveNext
        resolveNext = null
        r({ value: ev, done: false })
      } else {
        queue.push(ev)
      }
    },
    get returnCallCount() { return returnCalls },
  }
}

/** Combines both hooks under one provider instance so sink tests can assert
 *  against the same job the sink was registered against. */
function useHarness(sink?: (projectId: string, captions: Captions) => void) {
  const job = useCaptionJob()
  useCaptionJobSink(sink)
  return job
}

describe('captionJob', () => {
  it('start consumes the stream, accumulating logs in order; status is running during and done after', async () => {
    const stream = controllableStream()
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', () => stream.iterable) })
    expect(result.current.status).toBe('running')
    expect(result.current.projectId).toBe('proj-1')

    stream.push({ type: 'log', message: 'line 1' })
    await waitFor(() => expect(result.current.logs).toEqual(['line 1']))
    expect(result.current.status).toBe('running')

    stream.push({ type: 'log', message: 'line 2' })
    await waitFor(() => expect(result.current.logs).toEqual(['line 1', 'line 2']))
    expect(result.current.status).toBe('running')

    stream.push({ type: 'done', captions: CAPTIONS })
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.logs).toEqual(['line 1', 'line 2'])
  })

  it('terminal done calls the registered sink with the projectId and the captions payload', async () => {
    const sink = vi.fn()
    const { result } = renderHook(() => useHarness(sink), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', arrayStream([{ type: 'done', captions: CAPTIONS }])) })

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('proj-1', CAPTIONS)
  })

  it('an error event sets status: error + the message and does not call the sink', async () => {
    const sink = vi.fn()
    const { result } = renderHook(() => useHarness(sink), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', arrayStream([
      { type: 'log', message: 'starting' },
      { type: 'error', message: 'multi_source' },
    ])) })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('multi_source')
    expect(sink).not.toHaveBeenCalled()
  })

  it('a stream that throws also lands in status: error, never silently stuck on running', async () => {
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', throwingStream('boom')) })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('boom')
  })

  it("cancel() stops consumption and returns to 'idle', not 'error'; a late event does not mutate state", async () => {
    const stream = controllableStream()
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', () => stream.iterable) })
    stream.push({ type: 'log', message: 'line 1' })
    await waitFor(() => expect(result.current.logs).toEqual(['line 1']))

    act(() => { result.current.cancel() })
    expect(result.current.status).toBe('idle')
    expect(result.current.logs).toEqual([])
    expect(result.current.projectId).toBeNull()

    // cancel() already called the iterator's return() eagerly and
    // synchronously (Fix 1 — see stream.returnCallCount assertion in the
    // dedicated test below), so the loop that was parked awaiting the
    // stream's next value is already dead. Deliver one more event anyway to
    // confirm it truly is inert — neither mutates state nor is treated as
    // an error.
    stream.push({ type: 'log', message: 'late line' })
    await waitFor(() => expect(stream.returnCallCount).toBe(1))
    expect(result.current.status).toBe('idle')
    expect(result.current.logs).toEqual([])
  })

  it("cancel() calls the iterator's return() eagerly — promptly, without needing another event to arrive first", async () => {
    // Regression test for Fix 1: cancel() bumping only the generation
    // counter left the underlying request running until the consuming loop
    // happened to wake up for its next event — which, for a `large`-model
    // transcription, can be many seconds away. cancel() must return() the
    // iterator itself, synchronously, not depend on a future event to
    // notice and clean up.
    const stream = controllableStream()
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', () => stream.iterable) })
    // The consuming loop is now PARKED on it.next() — no event has been
    // pushed, so nothing will wake it on its own.
    expect(stream.returnCallCount).toBe(0)

    act(() => { result.current.cancel() })

    // return() must already have fired — no event was pushed to trigger it.
    expect(stream.returnCallCount).toBe(1)
    expect(result.current.status).toBe('idle')
  })

  it('two start() calls issued synchronously in the same tick result in only one stream being created', () => {
    // Regression test for Fix 2: statusRef.current was only reconciled at
    // render time, so two start() calls with no render in between both saw
    // 'idle' and both launched a job — the second one would 409 against the
    // server's one-job-per-project rule. start() must close the guard
    // synchronously.
    const stream1 = controllableStream()
    const run1 = vi.fn(() => stream1.iterable)
    const run2 = vi.fn(arrayStream([{ type: 'done', captions: CAPTIONS }]))
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => {
      result.current.start('proj-1', run1)
      result.current.start('proj-2', run2)
    })

    expect(run1).toHaveBeenCalledTimes(1)
    expect(run2).not.toHaveBeenCalled()
    expect(result.current.projectId).toBe('proj-1')
  })

  it("useCaptionJobStatus()'s value identity is stable across log-line appends, but changes on a status transition", async () => {
    // Regression test for Fix 3: useCaptionJob()'s value is a fresh object
    // on every provider render, including one per appended log line.
    // useCaptionJobStatus() exists so a consumer that doesn't need `logs`
    // (EditorPage) isn't forced to re-render on every one of those — assert
    // that directly as an object-identity check, not a render-count proxy.
    function useIdentityHarness() {
      return { job: useCaptionJob(), status: useCaptionJobStatus() }
    }

    const stream = controllableStream()
    const { result } = renderHook(() => useIdentityHarness(), { wrapper: CaptionJobProvider })

    act(() => { result.current.job.start('proj-1', () => stream.iterable) })
    const statusAfterStart = result.current.status

    stream.push({ type: 'log', message: 'line 1' })
    await waitFor(() => expect(result.current.job.logs).toEqual(['line 1']))
    // A log line landed on the full hook's value; the narrow status value's
    // identity must be UNCHANGED.
    expect(result.current.status).toBe(statusAfterStart)

    stream.push({ type: 'log', message: 'line 2' })
    await waitFor(() => expect(result.current.job.logs).toEqual(['line 1', 'line 2']))
    expect(result.current.status).toBe(statusAfterStart)

    stream.push({ type: 'done', captions: CAPTIONS })
    await waitFor(() => expect(result.current.job.status).toBe('done'))
    // The terminal transition DOES change status/projectId/error, so the
    // memoized value's identity must change here.
    expect(result.current.status).not.toBe(statusAfterStart)
    expect(result.current.status.status).toBe('done')
  })

  it("dismiss() clears a terminal 'done' state to 'idle'", async () => {
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', arrayStream([{ type: 'done', captions: CAPTIONS }])) })
    await waitFor(() => expect(result.current.status).toBe('done'))

    act(() => { result.current.dismiss() })
    expect(result.current.status).toBe('idle')
    expect(result.current.projectId).toBeNull()
  })

  it("dismiss() clears a terminal 'error' state to 'idle'", async () => {
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', arrayStream([{ type: 'error', message: 'nope' }])) })
    await waitFor(() => expect(result.current.status).toBe('error'))

    act(() => { result.current.dismiss() })
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
  })

  it('dismiss() while running is a no-op — cancel() is required to stop a running job', () => {
    const stream = controllableStream()
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', () => stream.iterable) })
    act(() => { result.current.dismiss() })

    expect(result.current.status).toBe('running')
    expect(result.current.projectId).toBe('proj-1')
  })

  it('start is a no-op while a job is already running', () => {
    const stream = controllableStream()
    const run2 = vi.fn(arrayStream([{ type: 'done', captions: CAPTIONS }]))
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', () => stream.iterable) })
    act(() => { result.current.start('proj-2', run2) })

    expect(run2).not.toHaveBeenCalled()
    expect(result.current.projectId).toBe('proj-1')
  })

  it('caps the log array at the most recent entries rather than growing unbounded', async () => {
    const LOTS = Array.from({ length: 250 }, (_, i) => ({ type: 'log' as const, message: `line ${i}` }))
    const { result } = renderHook(() => useCaptionJob(), { wrapper: CaptionJobProvider })

    act(() => { result.current.start('proj-1', arrayStream([...LOTS, { type: 'done', captions: CAPTIONS }])) })

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.logs.length).toBeLessThanOrEqual(200)
    // Oldest lines are dropped, not newest.
    expect(result.current.logs[result.current.logs.length - 1]).toBe('line 249')
    expect(result.current.logs).not.toContain('line 0')
  })

  it('useCaptionJob throws when used outside the provider', () => {
    expect(() => renderHook(() => useCaptionJob())).toThrow(/useCaptionJob must be used within/)
  })

  it('useCaptionJobSink throws when used outside the provider', () => {
    expect(() => renderHook(() => useCaptionJobSink(undefined))).toThrow(/useCaptionJobSink must be used within/)
  })
})

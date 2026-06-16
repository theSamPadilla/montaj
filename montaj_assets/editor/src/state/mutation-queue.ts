/**
 * editor-core / state / mutation-queue — serialises async mutations.
 *
 * Ported from mission-control's inline `createMutationQueue`
 * (src/app/admin/projects/hooks/project-reducer.ts). Extracted into its own
 * module here so the optimistic project-state hook and the reducer stay
 * separable.
 *
 * The queue guarantees that enqueued functions START in submission order
 * (each waits for the previous to settle), while preserving the caller's own
 * rejection handling on the returned promise. `onceDrained` lets the SSE
 * handler defer applying server echoes until in-flight PUTs have all settled.
 */
export interface MutationQueue {
  /** Enqueue an async op; it starts only after all prior ops have settled. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>
  /** True while one or more ops are in flight. */
  isPending(): boolean
  /**
   * Run `cb` the next time the queue transitions busy → idle. If already idle,
   * `cb` runs on the next microtask. Last-writer-wins: only the most recent
   * caller is notified, so a burst of SSE frames coalesces into one dispatch.
   */
  onceDrained(cb: () => void): void
}

export function createMutationQueue(): MutationQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  let onDrain: (() => void) | null = null
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      pending++
      const next = tail.catch(() => undefined).then(() => fn())
      // Chain the decrement onto the swallowed `tail`, NOT onto `next`. The
      // caller's rejection handling lives on `next`; adding a .finally() to
      // `next` here would create a parallel promise chain that also receives
      // the rejection — with no handler attached, that surfaces as an
      // unhandled-rejection warning. Folding the decrement into `tail`
      // preserves single-handler semantics for the caller.
      tail = next.catch(() => undefined).then(() => {
        pending--
        if (pending === 0 && onDrain) {
          const cb = onDrain
          onDrain = null
          cb()
        }
      })
      return next
    },
    isPending(): boolean {
      return pending > 0
    },
    onceDrained(cb: () => void): void {
      if (pending === 0) {
        Promise.resolve().then(cb)
        return
      }
      onDrain = cb
    },
  }
}

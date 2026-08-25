import { useCallback, useState } from 'react'

/**
 * `useState` that survives a reload, backed by `localStorage`.
 *
 * Every access is wrapped: `localStorage` throws rather than returning null in
 * Safari private mode and under some embedded/iframe policies, and a layout
 * preference is never worth taking the editor down for. A read that fails, or
 * that finds a value the current build can no longer parse (an older key
 * format, a hand-edited entry), falls back to `initial` — so a bad stored value
 * degrades to the default rather than a crash loop the user can't escape
 * without clearing site data.
 *
 * The stored value is read ONCE, in the lazy `useState` initializer. This hook
 * deliberately does not subscribe to `storage` events: two editor tabs open on
 * the same project should each keep their own panel sizes, not fight over them.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  /** Guards what comes back out of storage. Return `null` to reject a stored
   *  value and fall back to `initial` — the parse boundary is where a stale or
   *  hand-edited entry gets caught. */
  revive: (raw: unknown) => T | null,
): [T, (next: T, opts?: { persist?: boolean }) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) return initial
      const parsed = revive(JSON.parse(raw))
      return parsed === null ? initial : parsed
    } catch {
      return initial
    }
  })

  /** `persist: false` updates the value without touching storage — for the
   *  intermediate frames of a drag, which would otherwise write to
   *  `localStorage` on every mousemove. Commit once when the gesture ends. */
  const set = useCallback((next: T, opts?: { persist?: boolean }) => {
    setValue(next)
    if (opts?.persist === false) return
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Quota, private mode, or a blocked storage partition — the preference
      // just doesn't persist. Not worth surfacing.
    }
  }, [key])

  return [value, set]
}

/** `revive` for a finite number inside `[min, max]`. Rejects anything else,
 *  including a stored height from a window size that no longer exists. */
export function reviveNumberInRange(min: number, max: number) {
  return (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max ? raw : null
}

/** `revive` for a plain boolean. */
export const reviveBoolean = (raw: unknown): boolean | null =>
  typeof raw === 'boolean' ? raw : null

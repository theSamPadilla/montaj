import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

// Two rates, never zero: fast while work is in flight so the count feels
// live, slow once idle so the indicator can still notice new work land
// (e.g. footage imported mid-edit) without a real polling cost — this reads
// two in-memory integers server-side.
const ACTIVE_POLL_MS = 3_000
const IDLE_POLL_MS   = 10_000

/**
 * Passive readout for the background proxy-generation drain. Complements
 * (does not replace) the ProxyMigrationModal sparkles chip in ProjectHeader,
 * which is the manual trigger a user clicks for old projects; this is what
 * shows automatic work happening on its own.
 */
export default function ProxyActivityIndicator() {
  const [status, setStatus] = useState({ running: 0, queued: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    // Bumped on every visibility-triggered restart. clearTimer() can only
    // cancel a poll that already reached its setTimeout — one still awaiting
    // api.proxyStatus() has no timer to clear, so without this a visible
    // event landing mid-flight would fork a second, uncancellable poll chain
    // instead of replacing the in-flight one.
    let runId = 0

    function clearTimer() {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    async function poll(run: number) {
      let result = { running: 0, queued: 0 }
      try {
        result = await api.proxyStatus()
      } catch {
        // Endpoint may be mid-rollout, or a transient network error — degrade
        // to "show nothing" and keep polling rather than throwing.
      }
      if (cancelled || run !== runId) return
      setStatus(result)
      if (!document.hidden) {
        const active = result.running + result.queued > 0
        timerRef.current = setTimeout(() => poll(run), active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
      }
    }

    function handleVisibility() {
      if (document.hidden) {
        clearTimer()
      } else {
        clearTimer()
        poll(++runId)
      }
    }

    poll(runId)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      cancelled = true
      clearTimer()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  const { running, queued } = status
  // Clips not yet ready to scrub — the one being encoded right now counts, it
  // is not ready either. Deliberately the same quantity the indicator's own
  // visibility keys on, so the count cannot vanish while work is still going:
  // gating it on `queued` alone dropped the number the moment the last clip
  // started encoding, and undercounted by one for the whole run before that.
  const remaining = running + queued
  if (remaining === 0) return null

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 shrink-0"
      title="Montaj is making smooth-scrubbing copies of your footage. You can keep editing while this finishes."
    >
      <Loader2 size={12} className="animate-spin" />
      <span>Getting your footage ready to edit</span>
      <span className="text-gray-400 dark:text-gray-500">
        {remaining} {remaining === 1 ? 'clip' : 'clips'} left
      </span>
    </div>
  )
}

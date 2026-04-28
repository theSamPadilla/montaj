import { useEffect, useState } from 'react'

interface LoadingModalProps {
  open: boolean
  title: string
  message?: string
  /** Hint shown after `slowAfterMs` to acknowledge an unusually long wait. */
  slowHint?: string
  slowAfterMs?: number
}

/**
 * Full-screen blocking overlay with a spinner. Used during multi-second async
 * operations where the user otherwise has no feedback that work is happening.
 *
 * Note: not focus-trapped — this is a "wait" indicator, not an interactive
 * dialog. The underlying page is blocked by the backdrop; nothing inside the
 * modal needs keyboard focus.
 */
export function LoadingModal({
  open,
  title,
  message,
  slowHint,
  slowAfterMs = 15_000,
}: LoadingModalProps) {
  const [showSlowHint, setShowSlowHint] = useState(false)

  useEffect(() => {
    if (!open || !slowHint) {
      setShowSlowHint(false)
      return
    }
    const timer = setTimeout(() => setShowSlowHint(true), slowAfterMs)
    return () => clearTimeout(timer)
  }, [open, slowHint, slowAfterMs])

  if (!open) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="mx-4 w-full max-w-md rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow-xl">
        <div className="flex items-start gap-4">
          <Spinner />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{title}</p>
            {message && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{message}</p>
            )}
            {showSlowHint && slowHint && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{slowHint}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 shrink-0 animate-spin text-blue-500"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

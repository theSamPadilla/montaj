import { useEffect, useState } from 'react'

// Tailwind `md` breakpoint is 768px. `max-width: 767.98px` matches Tailwind's
// own breakpoint semantics — `md:` utilities kick in at 768px and up.
const MOBILE_QUERY = '(max-width: 767.98px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(MOBILE_QUERY).matches
  })

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}

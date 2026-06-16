export function formatTime(s: number): string {
  const m   = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}:${sec.padStart(4, '0')}`
}

export function pct(t: number, totalDuration: number): number {
  return totalDuration > 0 ? (t / totalDuration) * 100 : 0
}

export function ratioFromClientX(clientX: number, scrubberRect: DOMRect): number {
  const x = clientX - scrubberRect.left
  return Math.max(0, Math.min(1, x / scrubberRect.width))
}

export const trackRow     = 'relative h-10 bg-gray-100 dark:bg-gray-900 rounded overflow-hidden cursor-pointer'
export const trackRowTall = 'relative h-14 bg-gray-100 dark:bg-gray-900 rounded overflow-hidden cursor-pointer'

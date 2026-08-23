import { timeToX, type Viewport } from './canvas/viewport'
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
// Same as `trackRow`, but for the captions row: unlike the canvas rows, empty
// caption space isn't clickable-to-seek, so it should show the default arrow
// rather than the pointing hand `trackRow` gives every other row. Individual
// caption segments still carry their own cursor-pointer/cursor-ew-resize.
export const trackRowCaptions = 'relative h-10 bg-gray-100 dark:bg-gray-900 rounded overflow-hidden cursor-default'

/**
 * Where a time span sits on a DOM row, in whichever coordinate space the row's
 * surface actually uses: percentages of the whole project in legacy DOM mode,
 * absolute pixels off the canvas viewport when one is active.
 *
 * The single place that choice is made, so a row and its playhead line cannot
 * disagree about it. `end` may be omitted for a zero-width span (a line).
 */
export function timeSpanStyle(
  start: number,
  end: number | null,
  totalDuration: number,
  viewport: Viewport | null,
): { left: string; width?: string } {
  if (viewport) {
    const left = `${timeToX(start, viewport)}px`
    return end === null ? { left } : { left, width: `${Math.max(0, (end - start) * viewport.pxPerSecond)}px` }
  }
  const left = `${pct(start, totalDuration)}%`
  return end === null ? { left } : { left, width: `${pct(end - start, totalDuration)}%` }
}

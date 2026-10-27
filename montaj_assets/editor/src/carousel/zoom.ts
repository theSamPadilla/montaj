// §587 M6: the rail layout's zoom.
//
// A zoom is "Fit", "Fill" or a percentage. A percentage is the slide's SCALE
// times 100: 100% draws one slide pixel as one CSS pixel (a 1080 px wide slide
// is 1080 CSS px wide), 200% draws it twice that. Gestures, the chrome, text
// scale, crop, band and snap all take this scale, so nothing else changes.

export type Zoom = { mode: 'fit' } | { mode: 'fill' } | { mode: 'pct'; pct: number }

export const ZOOM_MIN = 10
export const ZOOM_MAX = 300
/** The steps zoom in and zoom out walk through, percent. */
export const ZOOM_STEPS = [10, 25, 50, 75, 100, 150, 200, 300] as const

export const FIT: Zoom = { mode: 'fit' }

export function clampPct(pct: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(pct)))
}

/**
 * The slide scale for a zoom. `fitScale` is today's fit (the slide inside the
 * view, never above real size). Fill is fit-to-height: the slide as tall as the
 * view allows, which is larger than Fit when Fit is limited by the width (the
 * canvas then scrolls sideways); it never drops below Fit and never passes the
 * zoom maximum.
 */
export function zoomScale(zoom: Zoom, fitScale: number, heightScale: number): number {
  if (zoom.mode === 'fit') return fitScale
  if (zoom.mode === 'fill') return Math.min(ZOOM_MAX / 100, Math.max(fitScale, heightScale))
  return clampPct(zoom.pct) / 100
}

/** What the % button shows. */
export function zoomLabel(zoom: Zoom): string {
  if (zoom.mode === 'fit') return 'Fit'
  if (zoom.mode === 'fill') return 'Fill'
  return `${clampPct(zoom.pct)}%`
}

/** The next step above (`dir` 1) or below (-1) the current percent. */
export function stepZoom(currentPct: number, dir: 1 | -1): Zoom {
  const eps = 0.5
  const next = dir === 1
    ? ZOOM_STEPS.find((s) => s > currentPct + eps)
    : [...ZOOM_STEPS].reverse().find((s) => s < currentPct - eps)
  return { mode: 'pct', pct: next ?? (dir === 1 ? ZOOM_MAX : ZOOM_MIN) }
}

export type ZoomAction = 'in' | 'out' | 'fit' | 'fill' | '100' | '200'

export function applyZoomAction(action: ZoomAction, currentPct: number): Zoom {
  switch (action) {
    case 'in': return stepZoom(currentPct, 1)
    case 'out': return stepZoom(currentPct, -1)
    case 'fit': return FIT
    case 'fill': return { mode: 'fill' }
    case '100': return { mode: 'pct', pct: 100 }
    case '200': return { mode: 'pct', pct: 200 }
  }
}

const isMod = (e: KeyboardEvent) => !!(e.metaKey || e.ctrlKey) && !e.altKey

/** Cmd (Ctrl off Apple) with +, = (the unshifted plus), -, 0 or 1. */
export function zoomKeyAction(e: KeyboardEvent): ZoomAction | null {
  if (!isMod(e)) return null
  if (e.key === '=' || e.key === '+') return 'in'
  if (e.key === '-' || e.key === '_') return 'out'
  if (e.key === '0') return 'fit'
  if (e.key === '1') return '100'
  return null
}

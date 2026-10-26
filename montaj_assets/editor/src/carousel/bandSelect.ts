// Drag-select (§586 M6): which elements a selection band touches.

export interface BandBox {
  x: number
  y: number
  w: number
  h: number
  /** Degrees about the box's centre, as the canvas turns the element. */
  rotation?: number
}

export interface BandRect {
  x: number
  y: number
  w: number
  h: number
}

/** The rectangle two corner points span, whichever way the band was dragged. */
export function bandRect(a: { x: number; y: number }, b: { x: number; y: number }): BandRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/**
 * Whether a turned box and an axis-aligned rectangle touch, by the separating
 * axis test: the shapes are apart when some edge direction of either one
 * separates their projections. Edges that meet count as touching.
 */
export function bandTouches(box: BandBox, rect: BandRect): boolean {
  const theta = ((box.rotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const corners = [
    [-box.w / 2, -box.h / 2],
    [box.w / 2, -box.h / 2],
    [box.w / 2, box.h / 2],
    [-box.w / 2, box.h / 2],
  ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }))
  const rectCorners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ]
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: cos, y: sin },
    { x: -sin, y: cos },
  ]
  const EPS = 1e-9
  for (const axis of axes) {
    const project = (pts: Array<{ x: number; y: number }>) => {
      const v = pts.map((p) => p.x * axis.x + p.y * axis.y)
      return { min: Math.min(...v), max: Math.max(...v) }
    }
    const a = project(corners)
    const b = project(rectCorners)
    if (a.max < b.min - EPS || b.max < a.min - EPS) return false
  }
  return true
}

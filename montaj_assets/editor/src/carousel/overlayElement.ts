import type { EditorAdapter, GlobalOverlay, OverlayElement, Project } from '../types'

/**
 * The overlay templates a project can add: the global ones plus its profile's,
 * deduped by `jsxPath`. Shared by the "+ Overlay" picker and the Elements panel.
 */
export async function loadOverlays(adapter: EditorAdapter<Project>, project: Pick<Project, 'profile'>): Promise<GlobalOverlay[]> {
  const lists: GlobalOverlay[][] = [await adapter.listGlobalOverlays()]
  if (project.profile) lists.push((await adapter.listProfileOverlays?.(project.profile)) ?? [])
  const seen = new Set<string>()
  const combined: GlobalOverlay[] = []
  for (const list of lists) {
    for (const o of list) {
      if (seen.has(o.jsxPath)) continue
      seen.add(o.jsxPath)
      combined.push(o)
    }
  }
  return combined
}

export const OVERLAY_BOX = { w: 800, h: 200 } as const

/** The kinds of shipped template the Elements panel lists in sections of their own (§587), in order. */
export const ELEMENT_CATEGORIES = ['shape', 'arrow', 'line', 'frame', 'callout'] as const
export type ElementCategory = typeof ELEMENT_CATEGORIES[number]

export function elementCategory(overlay: Pick<GlobalOverlay, 'category'>): ElementCategory | null {
  return (ELEMENT_CATEGORIES as readonly string[]).includes(overlay.category ?? '') ? overlay.category as ElementCategory : null
}

/** The order the Elements panel shows the shipped templates in (§587 F-I): the
 *  basics first, the blobs last. A template not named here follows, in the order listed. */
const ELEMENT_ORDER: readonly string[] = [
  'shape-rect', 'shape-rounded-rect', 'shape-ellipse', 'shape-triangle', 'shape-diamond', 'shape-pill', 'shape-semicircle',
  'shape-ring', 'shape-hexagon', 'shape-octagon', 'shape-polygon', 'shape-star', 'shape-heart', 'shape-check', 'shape-x',
  'shape-plus', 'shape-cross', 'shape-blob-1', 'shape-blob-2', 'shape-blob-3', 'shape-blob-4',
  'shape-arrow', 'arrow-double', 'arrow-curved', 'arrow-chevron',
  'line-straight', 'line-arrow', 'line-dashed', 'line-dot-ends', 'line-bar-ends',
  'frame-border', 'frame-double', 'frame-corners',
  'callout-speech-round', 'callout-speech-rect', 'callout-box', 'callout-thought',
]

/** `list` in the panel's order (a stable sort; it is not changed). */
export function orderElements<T extends Pick<GlobalOverlay, 'name'>>(list: readonly T[]): T[] {
  const rank = (o: T) => { const i = ELEMENT_ORDER.indexOf(o.name); return i < 0 ? ELEMENT_ORDER.length : i }
  return [...list].sort((a, b) => rank(a) - rank(b))
}

/** A shipped shape's own width over height (its sidecar's `aspect`), or 1. */
export function elementAspect(overlay: Pick<GlobalOverlay, 'aspect'>): number {
  const a = overlay.aspect
  return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : 1
}

/** A box of `aspect` whose longer side is `long`. */
export function aspectBox(long: number, aspect: number): { w: number; h: number } {
  return aspect >= 1 ? { w: long, h: Math.round(long / aspect) } : { w: Math.round(long * aspect), h: long }
}

/** What a shipped template is called on its tile and its layer row: its sidecar's description, else its folder name. */
export const overlayTileLabel = (overlay: Pick<GlobalOverlay, 'description' | 'name'>): string => overlay.description?.trim() || overlay.name

/** The box a new element of `overlay` gets on a slide of `resolution`: a square
 *  (or a box of the template's own `aspect`) for a shape, an arrow or a callout,
 *  a wide thin box for a line, most of the slide for a frame, and `OVERLAY_BOX`
 *  for any other template. */
export function newOverlayBox(overlay: Pick<GlobalOverlay, 'category' | 'aspect'>, resolution: readonly [number, number]): { w: number; h: number } {
  const [w, h] = resolution
  const short = Math.min(w, h)
  switch (elementCategory(overlay)) {
    case 'shape':
    case 'arrow':
    case 'callout': return aspectBox(Math.round(short * 0.4), elementAspect(overlay))
    case 'line': return { w: Math.round(w * 0.6), h: Math.max(24, Math.round(short * 0.05)) }
    case 'frame': return { w: Math.round(w * 0.7), h: Math.round(h * 0.7) }
    default: return { ...OVERLAY_BOX }
  }
}

/**
 * The type on a drag of an Elements tile (§587). The drag carries nothing to
 * read: the editor believes it only while a tile drag of its own is under way
 * (the tile hands the template over on dragstart), so another page or app
 * putting the same type on a drag adds nothing.
 */
export const TEMPLATE_DND_MIME = 'application/x-montaj-overlay-template'

/** A new overlay element for `overlay`, its props seeded from the declared defaults,
 *  in its kind's box (`newOverlayBox`), centred on `at` (slide px) or on the slide. */
export function newOverlayElement(overlay: GlobalOverlay, resolution: readonly [number, number], at?: { x: number; y: number }): OverlayElement {
  const [w, h] = resolution
  const box = newOverlayBox(overlay, resolution)
  const centre = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : { x: w / 2, y: h / 2 }
  const durationProp = overlay.props.find(p => p.name === 'duration')
  const duration = typeof durationProp?.default === 'number' ? durationProp.default : 60
  const props = Object.fromEntries(
    overlay.props.filter(p => p.default !== undefined).map(p => [p.name, p.default]),
  )
  return {
    id: crypto.randomUUID(),
    type: 'overlay',
    overlay: { template: overlay.jsxPath, props },
    frame: Math.max(0, duration - 1),
    x: Math.round(centre.x - box.w / 2),
    y: Math.round(centre.y - box.h / 2),
    w: box.w,
    h: box.h,
    rotation: 0,
  }
}

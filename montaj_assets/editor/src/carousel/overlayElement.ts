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

/** A new overlay element for `overlay`, its props seeded from the declared defaults, centred on the slide. */
export function newOverlayElement(overlay: GlobalOverlay, resolution: readonly [number, number]): OverlayElement {
  const [w, h] = resolution
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
    x: Math.round(w / 2 - OVERLAY_BOX.w / 2),
    y: Math.round(h / 2 - OVERLAY_BOX.h / 2),
    w: OVERLAY_BOX.w,
    h: OVERLAY_BOX.h,
    rotation: 0,
  }
}

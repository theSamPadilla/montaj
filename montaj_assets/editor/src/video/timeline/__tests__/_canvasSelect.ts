/**
 * Canvas-timeline test helpers — select a clip, drag a clip, focus the surface.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The DOM timeline gave every clip an element, so a test could say
 * `fireEvent.click(await screen.findByText('▪ video'))` and be done. The canvas
 * has ONE surface and no per-clip nodes: the address of a clip is a
 * (clientX, clientY) pair, and computing it means composing the same three
 * things the production code composes — `computeTimelineLayout` for the row's
 * `y`, `timeToX` through a `Viewport` for the item's `x`, and the surface's own
 * offset from the page.
 *
 * Four test files already do that by hand (Timeline.backgroundClick /
 * .fadeCurveMenu / .crossfade / .keyframeMenu). This is that work factored out
 * so the DOM-era tests can migrate mechanically rather than each re-deriving
 * the math.
 *
 * ── The two pinned constants, and nothing else ───────────────────────────
 * jsdom lays every element out at 0×0, so a `clientX → item` hit-test would
 * resolve nothing at all. `installCanvasHarness` pins the canvas surface to a
 * real rect — `SURFACE_LEFT` from the left of the page, `SURFACE_WIDTH` wide —
 * and that rect is the ONLY hardcoded geometry here. Everything else (px per
 * second, row `y`, item `x`) is read out of the production math, so a change to
 * a row height or the fit rule moves these helpers with it instead of
 * silently mis-aiming.
 *
 * The scale therefore follows from the project: the surface fits the whole
 * timeline on mount (`withSurfaceWidth` → `fitViewport`), and "the whole
 * timeline" is `computeDerivedTiming(project).totalDuration` — content duration
 * PLUS the drag headroom (`+ max(5, content * 0.2)`), not the content duration.
 * A 4s project therefore fits 9s across 1000px, not 4s. Never assume a round
 * px/second; call `canvasViewport`.
 *
 * ── Not a test file ──────────────────────────────────────────────────────
 * Vitest collects `src/**\/*.{test,spec}.{ts,tsx}` (vitest.config.ts), so the
 * leading underscore is cosmetic — what keeps this out of the suite is that it
 * is neither `.test.` nor `.spec.`. Its own coverage lives in
 * `_canvasSelect.test.tsx`.
 */

import { act, fireEvent } from '@testing-library/react'
import type { Project } from '../../../types'
import { computeTimelineLayout } from '../canvas/draw'
import { AUDIO_EDGE_TOLERANCE_PX, PLAYHEAD_GRAB_PX, VISUAL_EDGE_TOLERANCE_PX } from '../canvas/hit-test'
import { fitPxPerSecond, timeToX, type Viewport } from '../canvas/viewport'
import { computeDerivedTiming } from '../timeline-model'
import { DRAG_THRESHOLD_PX } from '../useItemDragDrop'

/** How far the canvas surface sits from the left of the page. Non-zero on
 *  purpose: the real surface is inset by the track rail, and a helper that
 *  pinned it at 0 would let an off-by-the-rail bug pass. */
export const SURFACE_LEFT = 100

/** The surface's width, and therefore the denominator of the fit zoom. */
export const SURFACE_WIDTH = 1000

/** The surface's height. Only `observeSurface` reads it (for the backing
 *  store); no hit-test consults it, so it just has to be non-degenerate. */
export const SURFACE_HEIGHT = 200

// ── Harness ──────────────────────────────────────────────────────────────

/**
 * Stub `getContext` and `getBoundingClientRect` for a canvas-mode test, and
 * hand back the teardown.
 *
 * Typical use:
 *
 *     let uninstall: () => void
 *     beforeEach(() => { uninstall = installCanvasHarness() })
 *     afterEach(() => { cleanup(); uninstall() })
 *
 * `getContext` returns a Proxy that no-ops every 2D call — the painter runs for
 * real, it just draws nowhere. `createLinearGradient` is special-cased because
 * the painter calls `.addColorStop` on what it returns.
 */
export function installCanvasHarness(): () => void {
  const realGetContext = HTMLCanvasElement.prototype.getContext
  const realGetRect = Element.prototype.getBoundingClientRect

  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
        return () => {}
      },
      set() { return true },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext

  // The canvas surface sits inset from the left of the column — that gap is the
  // track rail, which is why a click at clientX < SURFACE_LEFT has no time.
  // Everything else gets a rect that spans the whole column, so a test that
  // measures some other element doesn't get a 0×0 back.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const isSurface = (this as HTMLElement).hasAttribute?.('data-timeline-canvas')
    const left = isSurface ? SURFACE_LEFT : 0
    const width = isSurface ? SURFACE_WIDTH : SURFACE_LEFT + SURFACE_WIDTH
    return {
      x: left, y: 0, top: 0, left, right: left + width, bottom: SURFACE_HEIGHT,
      width, height: SURFACE_HEIGHT, toJSON: () => ({}),
    } as DOMRect
  }

  return () => {
    HTMLCanvasElement.prototype.getContext = realGetContext
    Element.prototype.getBoundingClientRect = realGetRect
  }
}

/** The canvas surface node — the element every pointer gesture is dispatched
 *  on, and the one `installCanvasHarness` gives a real rect to. */
export function canvasSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('[data-timeline-canvas]')
  if (!surface) {
    throw new Error(
      '[_canvasSelect] no [data-timeline-canvas] in the container — is the timeline mounted?',
    )
  }
  return surface as HTMLElement
}

/**
 * Focus the element Timeline's own Delete/Enter bindings are scoped to.
 *
 * Those bindings only fire with focus inside Timeline's `tabIndex={0}` root
 * (see Timeline.tsx), and the canvas surface itself is `tabIndex={-1}`, so
 * this walks up to the root rather than focusing the surface. A real press
 * does the same thing from inside `TimelineCanvas`'s own `down` handler; this
 * is for tests that need the focus WITHOUT a press (e.g. a selection made
 * through the preview).
 */
export function focusCanvasRoot(container: HTMLElement): void {
  const surface = canvasSurface(container)
  const root = (surface.closest('[tabindex="0"]') as HTMLElement | null) ?? surface
  root.focus()
}

// ── Coordinates ──────────────────────────────────────────────────────────

/**
 * The viewport a freshly mounted surface settles to: fitted to the whole
 * timeline, scrolled to 0.
 *
 * This mirrors what `TimelineCanvas` actually does on mount — `observeSurface`
 * fires once synchronously with the stubbed rect, and `withSurfaceWidth` on a
 * zero-scale viewport falls through to `fitViewport`. It is only valid for a
 * surface nobody has zoomed or scrolled since; a test that clicks "Zoom in"
 * first must compute its own.
 */
export function canvasViewport(project: Project): Viewport {
  const { totalDuration } = computeDerivedTiming(project)
  return {
    pxPerSecond: fitPxPerSecond(SURFACE_WIDTH, totalDuration),
    scrollSeconds: 0,
    widthPx: SURFACE_WIDTH,
  }
}

/** Page x for a timeline time, on a freshly mounted surface. */
export function timeToClientX(project: Project, t: number): number {
  return SURFACE_LEFT + timeToX(t, canvasViewport(project))
}

/** How a caller names the thing to press. `{ type }` picks the FIRST visual
 *  item of that kind in draw order (topmost row first), which is what
 *  `findByText('▪ video')` used to resolve to; `{ id }` addresses one item
 *  exactly, and reaches audio bars and caption blocks too. */
export type CanvasItemSelector = { id: string } | { type: string }

/** A resolved target's span in time and its band on the surface. */
export interface CanvasTarget {
  id: string
  start: number
  end: number
  /** Top of the row / lane / caption band the target lives in. */
  y: number
  height: number
  /** The trim-handle width to stay clear of when picking a press point. */
  edgeTolerancePx: number
}

/** Where `selector` sits on a freshly mounted surface. Throws (loudly, with the
 *  ids that ARE there) rather than returning null — a mis-typed id in a test
 *  should read as a broken test, not as a gesture that quietly did nothing. */
export function resolveCanvasTarget(project: Project, selector: CanvasItemSelector): CanvasTarget {
  const layout = computeTimelineLayout(project)
  const known: string[] = []

  for (const row of layout.rows) {
    for (const item of row.items) {
      known.push(item.id)
      const match = 'id' in selector ? item.id === selector.id : item.type === selector.type
      if (match) {
        return {
          id: item.id, start: item.start, end: item.end,
          y: row.y, height: row.height, edgeTolerancePx: VISUAL_EDGE_TOLERANCE_PX,
        }
      }
    }
  }

  // Audio bars and caption blocks are addressable by id only — neither carries
  // a `type` field, and the DOM helpers this replaces never selected one.
  if ('id' in selector) {
    for (const lane of layout.lanes) {
      for (const track of lane.tracks) {
        known.push(track.id)
        if (track.id === selector.id) {
          return {
            id: track.id, start: track.start, end: track.end,
            y: lane.y, height: lane.height, edgeTolerancePx: AUDIO_EDGE_TOLERANCE_PX,
          }
        }
      }
    }
    for (const band of layout.captions ?? []) {
      for (const seg of band.segments) {
        if (typeof seg.id !== 'string') continue
        known.push(seg.id)
        if (seg.id === selector.id) {
          return {
            id: seg.id, start: seg.start, end: seg.end,
            y: band.y, height: band.height, edgeTolerancePx: AUDIO_EDGE_TOLERANCE_PX,
          }
        }
      }
    }
  }

  const asked = 'id' in selector ? `id ${JSON.stringify(selector.id)}` : `type ${JSON.stringify(selector.type)}`
  throw new Error(`[_canvasSelect] no timeline item matching ${asked}. Ids in this project: ${known.join(', ') || '(none)'}`)
}

export interface CanvasPointOptions {
  /** Press at this absolute timeline time instead of the target's middle. */
  at?: number
  /** Where the playhead is, so the press point can stay clear of its grab
   *  band. Defaults to 0, which is where every mounted test starts. */
  playheadTime?: number
}

/**
 * A page point that lands on the target's BODY — clear of both trim handles,
 * and clear of the playhead's grab band.
 *
 * The playhead dodge is not fussiness. `grabsPlayhead` gives the playhead
 * priority over a clip body, so a press within `PLAYHEAD_GRAB_PX` of the red
 * line starts a SCRUB and never selects anything. A clip that starts at t=0
 * with the playhead parked at 0 is the common case for these fixtures, so the
 * dodge earns its keep whenever the item is short enough for its middle to
 * fall inside the band.
 */
export function canvasItemPoint(
  project: Project,
  selector: CanvasItemSelector,
  opts: CanvasPointOptions = {},
): { clientX: number; clientY: number } {
  const target = resolveCanvasTarget(project, selector)
  const viewport = canvasViewport(project)

  const clientY = target.y + target.height / 2

  if (opts.at !== undefined) {
    return { clientX: SURFACE_LEFT + timeToX(opts.at, viewport), clientY }
  }

  const x0 = timeToX(target.start, viewport)
  const x1 = timeToX(target.end, viewport)
  // Inside both handles by a pixel. A degenerate span (a clip narrower than
  // two handles) leaves no body at all, in which case the middle is the least
  // wrong answer and the caller gets an edge hit — visible immediately as a
  // trim rather than a selection.
  const lo = x0 + target.edgeTolerancePx + 1
  const hi = x1 - target.edgeTolerancePx - 1
  const middle = (x0 + x1) / 2
  let x = lo <= hi ? Math.min(Math.max(middle, lo), hi) : middle

  const playheadX = timeToX(opts.playheadTime ?? 0, viewport)
  if (lo <= hi && Math.abs(x - playheadX) <= PLAYHEAD_GRAB_PX) {
    const right = playheadX + PLAYHEAD_GRAB_PX + 1
    const left = playheadX - PLAYHEAD_GRAB_PX - 1
    if (right <= hi) x = right
    else if (left >= lo) x = left
  }

  return { clientX: SURFACE_LEFT + x, clientY }
}

// ── Gestures ─────────────────────────────────────────────────────────────

/** Named exactly as the DOM event fields are, so a migrated call site keeps
 *  the modifier flags it already had (`{ metaKey: true }`). */
export interface CanvasModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

function mouseInit(point: { clientX: number; clientY: number }, mods: CanvasModifiers) {
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    button: 0,
    bubbles: true,
  }
}

/** `TimelineCanvas` attaches move/up to `document` for the life of a gesture
 *  (the DOM drag hooks' pattern), so those two go straight to `document`
 *  rather than through the surface. `act` is explicit here because
 *  `document.dispatchEvent` is not one of RTL's own wrapped fire helpers. */
function dispatchOnDocument(type: 'mousemove' | 'mouseup', init: ReturnType<typeof mouseInit>): void {
  act(() => { document.dispatchEvent(new MouseEvent(type, init)) })
}

export interface CanvasSelectOptions extends CanvasPointOptions, CanvasModifiers {}

/**
 * Click a timeline item on the canvas — the canvas-native replacement for
 * `fireEvent.click(await screen.findByText('▪ video'))`.
 *
 * Press and release with no movement in between, which is exactly what the
 * pointer machine reads as a click: selection happens on RELEASE from the
 * `pressed` state, and only for a press that never crossed
 * `DRAG_THRESHOLD_PX`. The modifier semantics are the machine's own
 * `isAdditive` — shift OR meta OR ctrl extends the selection, a bare click
 * replaces it — so `{ metaKey: true }` here means what it meant on the DOM
 * block.
 */
export function selectCanvasItem(
  container: HTMLElement,
  project: Project,
  selector: CanvasItemSelector,
  opts: CanvasSelectOptions = {},
): void {
  const surface = canvasSurface(container)
  const point = canvasItemPoint(project, selector, opts)
  const init = mouseInit(point, opts)
  fireEvent.mouseDown(surface, init)
  dispatchOnDocument('mouseup', init)
}

export interface CanvasDragOptions extends CanvasModifiers {
  /** Absolute timeline time to press at. Defaults to the target's body point. */
  fromTime?: number
  /** Absolute timeline time to release at. Mutually exclusive with `dxPx`. */
  toTime?: number
  /** Horizontal travel in page pixels, instead of `toTime`. */
  dxPx?: number
  /** Vertical travel in page pixels — a cross-track move. Defaults to 0. */
  dyPx?: number
  /** How many intermediate `mousemove`s to send. Defaults to 5. */
  steps?: number
  /** Where the playhead is, so the press point stays clear of its grab band. */
  playheadTime?: number
}

/**
 * Drag a timeline item across the canvas: press, travel in `steps` moves,
 * release.
 *
 * The intermediate moves are not decoration. Each one drives a fresh
 * `projectChange` (a live, uncommitted edit) and only the RELEASE emits the
 * single `commit` — which is exactly the property "a whole drag undoes in one
 * step, not one step per mousemove" tests, so collapsing this to one move
 * would stop testing the thing.
 *
 * Throws when the requested travel wouldn't cross `DRAG_THRESHOLD_PX`: below
 * it the machine keeps the gesture a click, and a test that meant to drag
 * would silently assert against a selection instead.
 */
export function dragCanvasItem(
  container: HTMLElement,
  project: Project,
  selector: CanvasItemSelector,
  opts: CanvasDragOptions,
): void {
  const surface = canvasSurface(container)
  const from = canvasItemPoint(project, selector, {
    at: opts.fromTime,
    playheadTime: opts.playheadTime,
  })

  if (opts.toTime === undefined && opts.dxPx === undefined) {
    throw new Error('[_canvasSelect] dragCanvasItem needs either `toTime` or `dxPx`')
  }
  const toX = opts.toTime !== undefined
    ? timeToClientX(project, opts.toTime)
    : from.clientX + (opts.dxPx as number)
  const toY = from.clientY + (opts.dyPx ?? 0)

  const dx = toX - from.clientX
  const dy = toY - from.clientY
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
    throw new Error(
      `[_canvasSelect] a ${Math.hypot(dx, dy).toFixed(1)}px drag never crosses DRAG_THRESHOLD_PX `
      + `(${DRAG_THRESHOLD_PX}) — the machine would keep this a click. Ask for more travel, `
      + 'or use selectCanvasItem if a click is what you meant.',
    )
  }

  const steps = Math.max(1, opts.steps ?? 5)
  fireEvent.mouseDown(surface, mouseInit(from, opts))
  for (let i = 1; i <= steps; i++) {
    const at = { clientX: from.clientX + (dx * i) / steps, clientY: from.clientY + (dy * i) / steps }
    dispatchOnDocument('mousemove', mouseInit(at, opts))
  }
  dispatchOnDocument('mouseup', mouseInit({ clientX: toX, clientY: toY }, opts))
}

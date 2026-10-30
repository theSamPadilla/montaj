/// <reference types="vitest/globals" />
import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { maskAt, maskPolygon } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { applyOverlayChanges, useDragOverlay, type OverlayChanges, type OverlayCommitOptions } from '../useDragOverlay'
import { trackFor } from '../../keyframeOps'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { mediaBoxOf } from './mediaBox'

// §616 U2: the on-canvas mask gizmo on a selected video or image clip, through
// the real OverlayItemsLayer and the real commit (`applyOverlayChanges`, the
// body of VideoEditor's handleOverlayChange), so a gesture travels the whole
// path a user's does: handle -> live preview -> one commit on release ->
// writeProp (a key at the playhead on an animated prop, the static `mask`
// field otherwise).
//
// The preview frame is the 1080 x 1920 canvas at RENDER_SCALE, and the frame's
// measured rect is that same size at (0, 0), so on an unmoved, unscaled,
// unrotated clip one client pixel is one box pixel.

const RENDER_SCALE = 0.1
const BOX_W = 1080 * RENDER_SCALE // 108
const BOX_H = 1920 * RENDER_SCALE // 192
const RECT = { width: BOX_W, height: BOX_H, left: 0, top: 0, right: BOX_W, bottom: BOX_H, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

// start = 2, so keyframe `t` (item-relative) differs from the playhead.
const PLAYHEAD = 5
const LOCAL_T = 3

const MASK = { shape: 'ellipse' as const, x: 0.5, y: 0.5, w: 0.5, h: 0.25 }
// In box pixels: centre (54, 96), rx 27, ry 24.

const clip = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'c', type: 'image', src: 'c.png', start: 2, end: 12, mask: MASK, ...over,
} as VisualItem)

const commits: Array<[string, OverlayChanges, OverlayCommitOptions | undefined]> = []
let latest: VisualItem
let dragStateSpy: ReturnType<typeof vi.fn>

function Host({ initial, selected = true, onTrack0 = false }: { initial: VisualItem; selected?: boolean; onTrack0?: boolean }) {
  const [item, setItem] = useState(initial)
  latest = item
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef)
  const project = {
    id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 },
    tracks: onTrack0 ? [[item]] : [[], [item]],
  } as unknown as EditorProject
  return (
    <div ref={(el) => { if (el) el.getBoundingClientRect = () => RECT; containerRef.current = el }}>
      <OverlayItemsLayer
        project={project}
        currentTime={PLAYHEAD}
        isPlaying={false}
        isCanvasProject={false}
        overlayTracks={onTrack0 ? [] : [[item]]}
        tracks0NonVideo={onTrack0 ? [item] : []}
        renderScale={RENDER_SCALE}
        selectedOverlayId={selected ? item.id : undefined}
        onOverlayChange={(id, changes, options) => {
          commits.push([id, changes, options])
          setItem(prev => applyOverlayChanges(prev, changes, PLAYHEAD, options))
        }}
        containerRef={containerRef}
        dragState={drag.dragState}
        setDragState={(s) => { dragStateSpy(s); drag.setDragState(s) }}
        liveOffset={drag.liveOffset}
        liveScale={drag.liveScale}
        liveRotation={drag.liveRotation}
        snapGuides={drag.snapGuides}
        snapRotation={drag.snapRotation}
        compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
        fileUrl={(pth: string) => pth}
      />
    </div>
  )
}

/** Press on `el` at `from`, move to `to`, release there. */
function drag(el: Element, from: { x: number; y: number }, to: { x: number; y: number }, release: { altKey?: boolean } = {}) {
  fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, pointerId: 1, button: 0 })
  fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1, ...release })
}

/** The polygon's `points` attribute as numbers. */
function pointsOf(el: Element): number[][] {
  return (el.getAttribute('points') ?? '').trim().split(/\s+/).map(p => p.split(',').map(Number))
}

beforeAll(() => {
  // jsdom has no PointerEvent; without one RTL builds a bare Event that drops
  // clientX and altKey.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEvent extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 }
    }
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEvent
  }
})

beforeEach(() => {
  commits.length = 0
  dragStateSpy = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('mask gizmo: when it shows', () => {
  it('shows on a selected masked image clip, with its eight squares, rotate handle and feather ring', () => {
    render(<Host initial={clip()} />)
    expect(screen.getByLabelText('Move mask')).toBeTruthy()
    expect(screen.getAllByLabelText('Resize mask')).toHaveLength(8)
    expect(screen.getByLabelText('Rotate mask')).toBeTruthy()
    expect(screen.getByLabelText('Mask feather').tagName.toLowerCase()).toBe('polygon')
    expect(screen.queryByRole('button', { name: 'Mask feather', hidden: true })?.tagName.toLowerCase()).not.toBe('button')
  })

  it('shows on a selected masked video clip', () => {
    render(<Host initial={clip({ type: 'video', src: 'c.mp4', inPoint: 0 })} />)
    expect(screen.getByLabelText('Move mask')).toBeTruthy()
  })

  it('shows on a masked track-0 image', () => {
    render(<Host initial={clip()} onTrack0 />)
    expect(screen.getByLabelText('Move mask')).toBeTruthy()
  })

  it('is absent when the clip is not selected', () => {
    render(<Host initial={clip()} selected={false} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
  })

  it('is absent on an overlay, even one carrying a stray mask', () => {
    render(<Host initial={clip({ type: 'overlay', src: 'o.jsx', props: {} })} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
  })

  it('is absent with no mask', () => {
    render(<Host initial={clip({ mask: undefined })} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
  })

  it('is absent when the mask is turned off (enabled: false)', () => {
    render(<Host initial={clip({ mask: { ...MASK, enabled: false } })} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
  })

  it('keeps its canvas handles out of the tab order (the inspector is the keyboard path)', () => {
    const { container } = render(<Host initial={clip()} />)
    const handles = Array.from(container.querySelectorAll('[data-mask-handle]'))
    expect(handles).toHaveLength(9)
    for (const h of handles) expect(h.getAttribute('tabindex')).toBe('-1')
  })

  it('draws no text on the canvas', () => {
    const { container } = render(<Host initial={clip({ mask: { ...MASK, feather: 0.1 } })} />)
    const gizmo = container.querySelector('[data-mask-gizmo]') as HTMLElement
    expect(gizmo).toBeTruthy()
    expect(gizmo.textContent).toBe('')
  })
})

describe('mask gizmo: outline and feather rings', () => {
  it('the outline is maskPolygon for the box', () => {
    const { container } = render(<Host initial={clip({ mask: { ...MASK, rotation: 30 } })} />)
    const outline = container.querySelector('[data-testid="mask-outline"]')!
    const expected = maskPolygon(maskAt(clip({ mask: { ...MASK, rotation: 30 } }), LOCAL_T)!, BOX_W, BOX_H)
    const got = pointsOf(outline)
    expect(got).toHaveLength(expected.length)
    got.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i][0], 2)
      expect(y).toBeCloseTo(expected[i][1], 2)
    })
    expect(outline.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    expect(outline.getAttribute('fill')).toBe('none')
  })

  it('the SVG viewBox is the box in preview pixels', () => {
    const { container } = render(<Host initial={clip({ scaleX: 0.5, scaleY: 0.8 })} />)
    const svg = container.querySelector('[data-mask-gizmo] svg')!
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${BOX_W * 0.5} ${BOX_H * 0.8}`)
  })

  it('feather 0: one faint dashed outer ring 8 px out; feathered: two, at band / 2', () => {
    const plain = render(<Host initial={clip()} />)
    const one = plain.container.querySelectorAll('[data-testid="mask-feather-ring"]')
    expect(one).toHaveLength(1)
    expect(one[0].getAttribute('opacity')).toBe('0.4')
    expect(one[0].getAttribute('stroke-dasharray')).toBeTruthy()
    const base = maskAt(clip(), LOCAL_T)!
    const want = maskPolygon({ ...base, w: base.w + 16 / BOX_W, h: base.h + 16 / BOX_H }, BOX_W, BOX_H)
    const got = pointsOf(one[0])
    got.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i][0], 2)
      expect(y).toBeCloseTo(want[i][1], 2)
    })
    plain.unmount()
    const { container } = render(<Host initial={clip({ mask: { ...MASK, feather: 0.2 } })} />)
    const rings = container.querySelectorAll('[data-testid="mask-feather-ring"]')
    expect(rings).toHaveLength(2)
    for (const r of Array.from(rings)) {
      expect(r.getAttribute('stroke-dasharray')).toBeTruthy()
      expect(r.getAttribute('opacity')).toBe('0.8')
    }
  })

  it('the feather ring is a wide transparent stroke after the move polygon', () => {
    const { container } = render(<Host initial={clip()} />)
    const ring = screen.getByLabelText('Mask feather')
    expect(ring.getAttribute('stroke')).toBe('transparent')
    expect(ring.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    expect(ring.getAttribute('role')).toBe('button')
    const all = Array.from(container.querySelectorAll('svg [aria-label]'))
    expect(all.indexOf(ring)).toBeGreaterThan(all.indexOf(screen.getByLabelText('Move mask')))
  })
})

describe('mask gizmo: hit priority', () => {
  it('a press inside the outline moves the mask, not the clip', () => {
    render(<Host initial={clip()} />)
    const move = screen.getByLabelText('Move mask')
    fireEvent.mouseDown(move, { clientX: 54, clientY: 96 })
    fireEvent.pointerDown(move, { clientX: 54, clientY: 96, pointerId: 1, button: 0 })
    expect(dragStateSpy).not.toHaveBeenCalled()
    fireEvent.pointerUp(move, { clientX: 54, clientY: 96, pointerId: 1 })
  })

  it('a press outside the outline still moves the clip', () => {
    const { container } = render(<Host initial={clip()} />)
    // The image sits in its media box, inside its wrapper (the clip's drag target).
    const wrapper = mediaBoxOf(container.querySelector('img[src="c.png"]')!).parentElement!
    fireEvent.mouseDown(wrapper, { clientX: 5, clientY: 5 })
    expect(dragStateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c', type: 'move' }))
  })
})

describe('mask gizmo: gestures', () => {
  it('moving by +10% of the box commits mask.x + 0.1 with no track', () => {
    render(<Host initial={clip()} />)
    drag(screen.getByLabelText('Move mask'), { x: 54, y: 96 }, { x: 54 + 0.1 * BOX_W, y: 96 })
    expect(commits).toHaveLength(1)
    expect(commits[0][1].maskX).toBeCloseTo(0.6)
    expect(latest.mask!.x).toBeCloseTo(0.6)
    expect(latest.mask!.y).toBeCloseTo(0.5)
    expect(latest.keyframes).toBeUndefined()
  })

  it('previews live before the release, and commits once', () => {
    const { container } = render(<Host initial={clip()} />)
    const move = screen.getByLabelText('Move mask')
    fireEvent.pointerDown(move, { clientX: 54, clientY: 96, pointerId: 1, button: 0 })
    fireEvent.pointerMove(move, { clientX: 54 + 0.1 * BOX_W, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(0)
    const outline = container.querySelector('[data-testid="mask-outline"]')!
    const live = maskPolygon(maskAt(clip({ mask: { ...MASK, x: 0.6 } }), LOCAL_T)!, BOX_W, BOX_H)
    expect(pointsOf(outline)[0][0]).toBeCloseTo(live[0][0], 2)
    // The picture's mask follows too: the media box's mask image is the live one.
    const mediaBox = mediaBoxOf(container.querySelector('img[src="c.png"]')!)
    expect(mediaBox.style.maskImage).toContain(encodeURIComponent(`${Math.round(live[0][0] * 100) / 100},`))
    fireEvent.pointerUp(move, { clientX: 54 + 0.1 * BOX_W, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(1)
  })

  it('with a maskX track the move keys maskX at the playhead', () => {
    const track = { prop: 'maskX' as const, points: [{ t: 0, value: 0.3 }, { t: 6, value: 0.6 }] }
    // At localT 3: 0.45.
    render(<Host initial={clip({ keyframes: [track] })} />)
    drag(screen.getByLabelText('Move mask'), { x: 0.45 * BOX_W, y: 96 }, { x: 0.55 * BOX_W, y: 96 })
    expect(trackFor(latest, 'maskX')!.points).toEqual([
      { t: 0, value: 0.3 },
      { t: LOCAL_T, value: expect.closeTo(0.55, 10) },
      { t: 6, value: 0.6 },
    ])
    expect(latest.mask!.x).toBe(0.5)
  })

  it('a corner drag changes w and h about the centre', () => {
    render(<Host initial={clip()} />)
    const se = screen.getAllByLabelText('Resize mask').find(b => b.getAttribute('data-mask-handle') === 'se')!
    drag(se, { x: 81, y: 120 }, { x: 91, y: 130 })
    expect(latest.mask!.w).toBeCloseTo(0.5 + 20 / BOX_W)
    expect(latest.mask!.h).toBeCloseTo(0.25 + 20 / BOX_H)
    expect(latest.mask!.x).toBe(0.5)
  })

  it('an edge drag changes one axis', () => {
    render(<Host initial={clip()} />)
    const e = screen.getAllByLabelText('Resize mask').find(b => b.getAttribute('data-mask-handle') === 'e')!
    drag(e, { x: 81, y: 96 }, { x: 91, y: 110 })
    expect(latest.mask!.w).toBeCloseTo(0.5 + 20 / BOX_W)
    expect(latest.mask!.h).toBe(0.25)
    expect(commits[0][1].maskH).toBeUndefined()
  })

  it('the rotate handle turns the mask about its centre', () => {
    render(<Host initial={clip()} />)
    // From straight above the centre to straight right of it: +90°.
    drag(screen.getByLabelText('Rotate mask'), { x: 54, y: 40 }, { x: 110, y: 96 })
    expect(latest.mask!.rotation).toBeCloseTo(90)
  })

  it('a 270 degree drag in three moves turns the mask 270, not -90', () => {
    render(<Host initial={clip()} />)
    const rot = screen.getByLabelText('Rotate mask')
    // Clockwise about the centre (54, 96): up, right, down, left.
    fireEvent.pointerDown(rot, { clientX: 54, clientY: 40, pointerId: 1, button: 0 })
    fireEvent.pointerMove(rot, { clientX: 110, clientY: 96, pointerId: 1 })
    fireEvent.pointerMove(rot, { clientX: 54, clientY: 152, pointerId: 1 })
    fireEvent.pointerMove(rot, { clientX: -2, clientY: 96, pointerId: 1 })
    fireEvent.pointerUp(rot, { clientX: -2, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(1)
    expect(commits[0][1].maskRotation).toBeCloseTo(270)
  })

  it('dragging the feather ring outward by 10 px widens the band by 20 px', () => {
    // Ellipse rx 27 about (54, 96); the outer ring at feather 0.1 (band 10.8)
    // is 5.4 px out, on the right at x = 54 + 27 + 5.4.
    const mask = { ...MASK, feather: 0.1 }
    render(<Host initial={clip({ mask })} />)
    const x = 54 + 27 + 5.4
    drag(screen.getByLabelText('Mask feather'), { x, y: 96 }, { x: x + 10, y: 96 })
    expect(latest.mask!.feather).toBeCloseTo(0.1 + 20 / BOX_W)
  })

  it('dragging it inward past zero clamps to 0', () => {
    render(<Host initial={clip({ mask: { ...MASK, feather: 0.1 } })} />)
    const x = 54 + 27 + 5.4
    drag(screen.getByLabelText('Mask feather'), { x, y: 96 }, { x: x - 30, y: 96 })
    expect(latest.mask!.feather).toBe(0)
  })

  it('at feather 0 the ring is grabbable 8 px out', () => {
    render(<Host initial={clip()} />)
    drag(screen.getByLabelText('Mask feather'), { x: 54 + 27 + 8, y: 96 }, { x: 54 + 27 + 18, y: 96 })
    expect(latest.mask!.feather).toBeCloseTo(20 / BOX_W)
  })

  it('there is no feather button any more', () => {
    const { container } = render(<Host initial={clip({ mask: { ...MASK, feather: 0.1 } })} />)
    expect(container.querySelector('button[aria-label="Mask feather"]')).toBeNull()
    expect(container.querySelector('[data-mask-handle="feather"]')).toBeNull()
  })

  it('a wipe: dragging its outer line away from the visible side widens the feather', () => {
    // Wipe edge at x = 54, visible side to the left; feather 0.1 -> band 10.8,
    // outer line 5.4 px to the right.
    render(<Host initial={clip({ mask: { shape: 'wipe', x: 0.5, y: 0.5, rotation: 0, feather: 0.1 } })} />)
    const ring = screen.getByLabelText('Mask feather')
    expect(ring.tagName.toLowerCase()).toBe('line')
    drag(ring, { x: 54 + 5.4, y: 96 }, { x: 54 + 5.4 + 10, y: 96 })
    expect(latest.mask!.feather).toBeCloseTo(0.1 + 20 / BOX_W)
  })

  it('a drag on a rotated, scaled clip maps the pointer into the box', () => {
    // Turned 90° and at half size, centred: a drag DOWN the screen is +x in
    // the box, and one screen pixel is one box pixel (the box is drawn at its
    // own size).
    render(<Host initial={clip({ rotation: 90, scale: 0.5 })} />)
    const boxW = BOX_W * 0.5
    drag(screen.getByLabelText('Move mask'), { x: 54, y: 96 }, { x: 54, y: 96 + 0.1 * boxW })
    expect(latest.mask!.x).toBeCloseTo(0.6)
    expect(latest.mask!.y).toBeCloseTo(0.5)
  })

  it('Option at release goes through as shiftAnimation', () => {
    render(<Host initial={clip()} />)
    drag(screen.getByLabelText('Move mask'), { x: 54, y: 96 }, { x: 60, y: 96 }, { altKey: true })
    expect(commits[0][2]).toEqual({ shiftAnimation: true })
  })
})

describe('mask gizmo: a mask grown past the clip', () => {
  // 160% of the box: every handle's real place is outside the frame, which
  // clips to the canvas, so each is pinned just inside the clip's edge.
  const BIG = { ...MASK, w: 1.6, h: 1.6 }

  it('keeps every handle inside the box', () => {
    render(<Host initial={clip({ mask: BIG })} />)
    const buttons = [...screen.getAllByLabelText('Resize mask'), screen.getByLabelText('Rotate mask')]
    for (const b of buttons) {
      expect(b.getAttribute('data-pinned')).toBe('true')
      const left = parseFloat((b as HTMLElement).style.left)
      const top = parseFloat((b as HTMLElement).style.top)
      expect(left).toBeGreaterThan(0)
      expect(left).toBeLessThan(100)
      expect(top).toBeGreaterThan(0)
      expect(top).toBeLessThan(100)
    }
  })

  it('a pinned edge square drags as the real edge would', () => {
    render(<Host initial={clip({ mask: BIG })} />)
    const e = screen.getAllByLabelText('Resize mask').find(b => b.getAttribute('data-mask-handle') === 'e')!
    drag(e, { x: 90, y: 96 }, { x: 80, y: 96 })
    expect(latest.mask!.w).toBeCloseTo(1.6 - 20 / BOX_W)
    expect(latest.mask!.h).toBe(1.6)
  })
})

describe('mask gizmo: a wipe', () => {
  const wipe = clip({ mask: { shape: 'wipe', x: 0.5, y: 0.5 } })

  it('has no resize squares; it moves by its edge line and rotates on it', () => {
    const { container } = render(<Host initial={wipe} />)
    expect(screen.queryAllByLabelText('Resize mask')).toHaveLength(0)
    expect(screen.getByLabelText('Rotate mask')).toBeTruthy()
    expect(container.querySelector('[data-testid="mask-outline"]')!.tagName.toLowerCase()).toBe('line')
    drag(screen.getByLabelText('Move mask'), { x: 54, y: 20 }, { x: 54 + 0.1 * BOX_W, y: 30 })
    expect(latest.mask!.x).toBeCloseTo(0.6)
  })

  it('a wipe dragged off the box still commits, on a release anywhere (the window)', () => {
    render(<Host initial={wipe} />)
    const move = screen.getByLabelText('Move mask')
    fireEvent.pointerDown(move, { clientX: 54, clientY: 96, pointerId: 1, button: 0 })
    fireEvent.pointerMove(move, { clientX: 54 + 0.8 * BOX_W, clientY: 96, pointerId: 1 })
    // The line is off the box now; the release lands elsewhere.
    fireEvent.pointerUp(window, { clientX: 54 + 0.8 * BOX_W, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(1)
    expect(commits[0][1].maskX).toBeCloseTo(1.3)
    expect(latest.mask!.x).toBeCloseTo(1.3)
  })

  it('unmounting mid-drag ends the gesture with one commit', () => {
    const { unmount } = render(<Host initial={wipe} />)
    const move = screen.getByLabelText('Move mask')
    fireEvent.pointerDown(move, { clientX: 54, clientY: 96, pointerId: 1, button: 0 })
    fireEvent.pointerMove(move, { clientX: 54 + 0.1 * BOX_W, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(0)
    unmount()
    expect(commits).toHaveLength(1)
    expect(commits[0][1].maskX).toBeCloseTo(0.6)
  })
})

describe('mask gizmo: a mask covering the whole box', () => {
  const full = clip({ mask: { shape: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, radius: 0.1 } })

  it('moves the mask by a stroke band only, so the centre still moves the clip', () => {
    render(<Host initial={full} />)
    const move = screen.getByLabelText('Move mask')
    expect(move.getAttribute('fill')).toBe('none')
    expect(move.style.pointerEvents).toBe('stroke')
    expect(move.getAttribute('stroke-width')).toBe('16')
  })

  it('a mask that stays inside the box keeps its filled move area', () => {
    render(<Host initial={clip()} />)
    expect(screen.getByLabelText('Move mask').style.pointerEvents).toBe('fill')
  })

  it('the mask squares on the clip\'s own handles sit under them (z 45), the others above (z 60)', () => {
    const first = render(<Host initial={full} />)
    const z = (h: string) => (screen.getAllByLabelText('Resize mask').find(b => b.getAttribute('data-mask-handle') === h) as HTMLElement).style.zIndex
    expect(z('se')).toBe('45')
    expect(z('n')).toBe('45')
    expect(z('nw')).toBe('45')
    first.unmount()
    // A mask inside the box clears the clip's handles.
    render(<Host initial={clip()} />)
    const inner = screen.getAllByLabelText('Resize mask').filter(b => (b as HTMLElement).style.zIndex === '60')
    expect(inner).toHaveLength(8)
  })

  it('the clip\'s se handle is reachable: it sits at z 50 over the mask square', () => {
    const { container } = render(<Host initial={full} />)
    const se = container.querySelector('[data-handle="se"]') as HTMLElement
    expect(se.className).toContain('z-50')
  })
})


// §616: a path mask uses the whole-shape gizmo exactly like an ellipse or rect.
describe('mask gizmo: a path', () => {
  // A U: arms down both sides, the notch open at the bottom.
  const U: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0.7, 1], [0.7, 0.4], [0.3, 0.4], [0.3, 1], [0, 1]]
  const PATH = { shape: 'path' as const, points: U, x: 0.5, y: 0.5, w: 0.5, h: 0.25 }
  // Box px: centre (54, 96), 54 x 48, so x 27..81, y 72..120.

  it('shows on a selected path-masked clip with the eight squares, rotate handle and feather ring', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    expect(screen.getByLabelText('Move mask')).toBeTruthy()
    expect(screen.getAllByLabelText('Resize mask')).toHaveLength(8)
    expect(screen.getByLabelText('Rotate mask')).toBeTruthy()
    expect(screen.getByLabelText('Mask feather').tagName.toLowerCase()).toBe('polygon')
  })

  it('the outline is maskPolygon for the path, and the move area fills evenodd', () => {
    const item = clip({ mask: { ...PATH, rotation: 20 } })
    const { container } = render(<Host initial={item} />)
    const expected = maskPolygon(maskAt(item, LOCAL_T)!, BOX_W, BOX_H)
    const got = pointsOf(container.querySelector('[data-testid="mask-outline"]')!)
    expect(got).toHaveLength(U.length)
    got.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i][0], 2)
      expect(y).toBeCloseTo(expected[i][1], 2)
    })
    expect(screen.getByLabelText('Move mask').getAttribute('fill-rule')).toBe('evenodd')
  })

  it('moving by +10% of the box commits mask.x + 0.1 and keeps the points', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    drag(screen.getByLabelText('Move mask'), { x: 30, y: 80 }, { x: 30 + 0.1 * BOX_W, y: 80 })
    expect(commits).toHaveLength(1)
    expect(latest.mask!.x).toBeCloseTo(0.6)
    expect(latest.mask!.points).toEqual(U)
    expect(latest.mask!.shape).toBe('path')
  })

  it('a corner drag changes w and h about the centre', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    const se = screen.getAllByLabelText('Resize mask').find(b => b.getAttribute('data-mask-handle') === 'se')!
    drag(se, { x: 81, y: 120 }, { x: 91, y: 130 })
    expect(latest.mask!.w).toBeCloseTo(0.5 + 20 / BOX_W)
    expect(latest.mask!.h).toBeCloseTo(0.25 + 20 / BOX_H)
  })

  it('the rotate handle turns the mask about its centre', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    const rot = screen.getByLabelText('Rotate mask')
    drag(rot, { x: 54, y: 72 - 24 }, { x: 54 + 24, y: 96 })
    expect(latest.mask!.rotation).toBeCloseTo(90)
  })

  it('dragging the feather ring outward by 10 px widens the band by 20 px', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    // Feather 0: the ring sits 8 px outside the right arm's edge (x 81).
    drag(screen.getByLabelText('Mask feather'), { x: 81 + 8, y: 96 }, { x: 81 + 18, y: 96 })
    expect(latest.mask!.feather).toBeCloseTo(20 / BOX_W)
  })

  it('a feather drag across the notch measures from the path, not from a convex hull', () => {
    render(<Host initial={clip({ mask: PATH })} />)
    // Notch (outside the shape): x 43.2..64.8, open below the bar's lower edge at y = 72 + 48 * 0.4 = 91.2.
    // From 2 px under the bar (out by 2) to 8 px under it (out by 8, still nearer the bar than the notch walls
    // 10.8 px away): +6 out, so the band widens by 12 px.
    drag(screen.getByLabelText('Mask feather'), { x: 54, y: 91.2 + 2 }, { x: 54, y: 91.2 + 8 })
    expect(latest.mask!.feather).toBeCloseTo(12 / BOX_W)
  })

  it('draws no text on the canvas', () => {
    const { container } = render(<Host initial={clip({ mask: PATH })} />)
    expect(container.querySelector('[data-mask-gizmo] text')).toBeNull()
  })
})

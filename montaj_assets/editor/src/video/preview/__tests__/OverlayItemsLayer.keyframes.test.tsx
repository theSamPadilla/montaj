/// <reference types="vitest/globals" />
import { render } from '@testing-library/react'
import { geometryAt, geometryFor } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'

// T1.2 (SP9b Phase 1) — the preview must sample curve-aware geometry through
// @bycrux/timeline-core's `geometryAt` for keyframed OVERLAYS, and must NOT
// animate image/video CLIPS even when they carry a `keyframes` field: the
// renderer composites clips through `geometryFor` directly (encode-segment.js
// :305 and :375) with no per-frame browser step to bake a moving transform
// into, so animating a clip here would be a preview/render divergence — see
// the comment at OverlayItemsLayer.tsx's interactive-tracks geometry call
// site. No easing/interpolation math is duplicated in this file — every
// expected value below is produced by calling geometryAt/geometryFor
// directly, the same functions the component itself calls.

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function makeProject(): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[]],
  } as unknown as EditorProject
}

function renderLayer(item: VisualItem, opts: {
  currentTime: number
  liveOffset?: { id: string; x: number; y: number } | null
  liveScale?: { id: string; scale: number } | null
  liveRotation?: { id: string; rotation: number } | null
}) {
  const utils = render(
    <OverlayItemsLayer
      project={makeProject()}
      currentTime={opts.currentTime}
      isPlaying={false}
      isCanvasProject={false}
      overlayTracks={[[item]]}
      tracks0NonVideo={[]}
      renderScale={0.2}
      selectedOverlayId={undefined}
      containerRef={{ current: document.createElement('div') }}
      dragState={null}
      setDragState={vi.fn()}
      liveOffset={opts.liveOffset ?? null}
      liveScale={opts.liveScale ?? null}
      liveRotation={opts.liveRotation ?? null}
      snapGuides={emptySnap}
      snapRotation={null}
      compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
      fileUrl={(pth: string) => pth}
    />,
  )
  // The item's wrapper is the outermost div — see OverlayItemsLayer.edit.test.tsx.
  const wrapper = utils.container.querySelector('div') as HTMLDivElement
  return { ...utils, wrapper }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

// start=5; offsetX animates 0 -> 100 and opacity animates 1 -> 0 across
// item-relative t=[0,10]. Chosen so that treating absolute `currentTime` as
// localT (the bug this file guards against) produces a clearly different,
// wrong number at currentTime=5 than the correct item-relative sample.
function keyframedOverlay(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'kf-overlay',
    type: 'overlay',
    src: 'o.jsx',
    start: 5,
    end: 15,
    props: {},
    keyframes: [
      { prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] },
      { prop: 'opacity', points: [{ t: 0, value: 1 }, { t: 10, value: 0 }] },
    ],
    ...over,
  } as VisualItem
}

// PARITY-CRITICAL, KEEP IN SYNC WITH render/test/overlay-transform-parity
// .test.mjs's `previewStyle` (verbatim copy of OverlayItemsLayer.tsx's own
// `wrapperStyle` template — that file carries a matching comment pointing
// back here). That suite proves the RENDER bake matches this exact literal
// template, but it cannot import this .tsx component into its plain
// node:test runner, so it hand-transcribes the template instead of reading
// it from the real component. The test below is what closes that gap: it
// pins the SAME template against what OverlayItemsLayer ACTUALLY renders, so
// a drift in the component's real template fails THIS test even though the
// render-side suite has no way to see it.
function previewStyle(g: ReturnType<typeof geometryAt>) {
  return {
    transform: `translate(${g.offsetX}%, ${g.offsetY}%) rotate(${g.rotation}deg) scale(${g.scale})`,
    transformOrigin: 'center center',
    opacity: g.opacity,
  }
}

describe('OverlayItemsLayer — keyframed geometry (T1.2)', () => {
  it('pins the REAL rendered wrapper style against the same literal template the render-side parity test uses', () => {
    const item = keyframedOverlay()
    const g = geometryAt(item, 'overlay', 10 - item.start) // currentTime=10 -> localT=5, mid-curve
    const want = previewStyle(g)

    const { wrapper } = renderLayer(item, { currentTime: 10 })

    expect(wrapper.style.transform).toBe(want.transform)
    expect(wrapper.style.transformOrigin).toBe(want.transformOrigin)
    expect(wrapper.style.opacity).toBe(String(want.opacity))
  })

  it('samples different transform/opacity at two currentTime values, matching geometryAt', () => {
    const item = keyframedOverlay()

    const at5 = renderLayer(item, { currentTime: 5 })
    const g5  = geometryAt(item, 'overlay', 5 - item.start)
    expect(at5.wrapper.style.transform).toContain(`translate(${g5.offsetX}%,`)
    expect(at5.wrapper.style.opacity).toBe(String(g5.opacity))
    at5.unmount()

    const at10 = renderLayer(item, { currentTime: 10 })
    const g10  = geometryAt(item, 'overlay', 10 - item.start)
    expect(at10.wrapper.style.transform).toContain(`translate(${g10.offsetX}%,`)
    expect(at10.wrapper.style.opacity).toBe(String(g10.opacity))
    at10.unmount()

    // Sanity: the two samples actually differ, so this test cannot pass by
    // accident even if geometryAt were never wired up at all.
    expect(g5.offsetX).not.toBe(g10.offsetX)
    expect(g5.opacity).not.toBe(g10.opacity)
  })

  it('uses ITEM-RELATIVE time, not absolute project time', () => {
    // item.start = 5, keyframe at localT=0 has offsetX=0. At currentTime=5
    // the correct localT is 0, so offsetX must be exactly 0. A wiring bug
    // that passed absolute `currentTime` as localT would land at localT=5 —
    // halfway between the t=0 (value 0) and t=10 (value 100) keyframes —
    // producing offsetX=50 instead. The two outcomes are far enough apart
    // that this cannot pass by luck.
    const item = keyframedOverlay()
    const { wrapper } = renderLayer(item, { currentTime: 5 })

    expect(wrapper.style.transform).toContain('translate(0%,')
    expect(wrapper.style.transform).not.toContain('translate(50%,')
  })

  it('a keyframe-less overlay renders identically at every currentTime (no regression)', () => {
    const item = {
      id: 'static-overlay', type: 'overlay', src: 'o.jsx', start: 0, end: 10,
      offsetX: 12, offsetY: -8, scale: 1.3, rotation: 15, opacity: 0.6, props: {},
    } as VisualItem

    const at2 = renderLayer(item, { currentTime: 2 })
    const transformAt2 = at2.wrapper.style.transform
    const opacityAt2   = at2.wrapper.style.opacity
    at2.unmount()

    const at8 = renderLayer(item, { currentTime: 8 })
    expect(at8.wrapper.style.transform).toBe(transformAt2)
    expect(at8.wrapper.style.opacity).toBe(opacityAt2)
  })

  it('does NOT animate an image clip carrying keyframes (clip/overlay asymmetry is deliberate)', () => {
    const item = {
      id: 'kf-image', type: 'image', src: 'img.png', start: 5, end: 15,
      offsetX: 42, opacity: 0.9,
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    } as VisualItem

    const at5 = renderLayer(item, { currentTime: 5 })
    const t5  = at5.wrapper.style.transform
    at5.unmount()
    const at10 = renderLayer(item, { currentTime: 10 })
    const t10  = at10.wrapper.style.transform

    // Both must equal the STATIC geometryFor result — keyframes never consulted.
    const gStatic = geometryFor(item, 'image')
    expect(t5).toContain(`translate(${gStatic.offsetX}%,`)
    expect(t10).toBe(t5)
  })

  it('does NOT animate a video clip carrying keyframes', () => {
    const item = {
      id: 'kf-video', type: 'video', src: 'vid.mp4', start: 5, end: 15,
      offsetX: 7, inPoint: 0,
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    } as VisualItem

    const at5 = renderLayer(item, { currentTime: 5 })
    const t5  = at5.wrapper.style.transform
    at5.unmount()
    const at10 = renderLayer(item, { currentTime: 10 })
    expect(at10.wrapper.style.transform).toBe(t5)
  })

  it('a live drag overrides the sampled curve value', () => {
    const item = keyframedOverlay()
    const { wrapper } = renderLayer(item, {
      currentTime: 10,
      liveOffset: { id: item.id, x: -33, y: 4 },
    })

    // Without the drag, offsetX at currentTime=10 (localT=5) samples to 50 —
    // the drag value must win instead.
    expect(wrapper.style.transform).toContain('translate(-33%, 4%)')
    expect(wrapper.style.transform).not.toContain('translate(50%,')
  })
})

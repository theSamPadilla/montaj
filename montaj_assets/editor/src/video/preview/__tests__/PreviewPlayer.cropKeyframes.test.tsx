/**
 * PV55 phase 2 P3: the tracks[0] base clip's crop style follows the SAMPLED
 * crop at the playhead when the crop is keyframed, and an un-keyframed clip's
 * crop style never depends on time (its memo is not recomputed per frame).
 */
import { act, render } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import * as cropStyleModule from '../sourceCropStyle'
import type { EditorProject as Project, VisualItem } from '../../../schema'

const FRAME = 100

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 12, inPoint: 0,
    sourceWidth: 1920, sourceHeight: 1080, sourceCrop: { x: 0, y: 0, w: 0.5, h: 1 }, ...over,
  } as VisualItem
}

function mount(item: VisualItem, playhead: number) {
  const clock = createPlaybackClock(playhead)
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as Project
  const utils = render(
    <PreviewPlayer project={project} clock={clock} selectedOverlayId={undefined}
      onOverlayChange={() => {}} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />,
  )
  const left = () => (utils.container.querySelector('video') as HTMLElement).style.left
  return { clock, left }
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: FRAME, height: FRAME } }]) }
    unobserve() {}
    disconnect() {}
  }
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
})
afterEach(() => vi.restoreAllMocks())

describe('base clip crop style (PV55 phase 2)', () => {
  // cropX 0 -> 0.5 over the clip's 10 s; w 0.5, h 1 static.
  const keyed = () => clip({ keyframes: [{ prop: 'cropX', points: [{ t: 0, value: 0 }, { t: 10, value: 0.5 }] }] })

  it('a keyframed crop moves with the playhead', () => {
    const { clock, left } = mount(keyed(), 2) // localT 0: cropX 0
    const at0 = left()
    act(() => clock.set(7)) // localT 5: cropX 0.25
    const at5 = left()
    act(() => clock.set(12)) // localT 10: cropX 0.5
    const at10 = left()
    const want = (x: number) => cropStyleModule.sourceCropVideoStyle({
      crop: { x, y: 0, w: 0.5, h: 1 }, sourceWidth: 1920, sourceHeight: 1080, frameWidth: FRAME, frameHeight: FRAME,
    })!.left
    expect(at0).toBe(want(0))
    expect(at5).toBe(want(0.25))
    expect(at10).toBe(want(0.5))
    expect(new Set([at0, at5, at10]).size).toBe(3)
  })

  it('an un-keyframed crop never recomputes its style as the playhead moves', () => {
    const spy = vi.spyOn(cropStyleModule, 'sourceCropVideoStyle')
    const { clock } = mount(clip(), 2)
    const calls = spy.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    act(() => clock.set(4))
    act(() => clock.set(7))
    expect(spy.mock.calls.length).toBe(calls)
  })

  it('a keyframed crop does recompute per playhead move', () => {
    const spy = vi.spyOn(cropStyleModule, 'sourceCropVideoStyle')
    const { clock } = mount(keyed(), 2)
    const calls = spy.mock.calls.length
    act(() => clock.set(4))
    expect(spy.mock.calls.length).toBeGreaterThan(calls)
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, cleanup } from '@testing-library/react'
import type { VisualItem } from '../../schema'
import { VideoSourceCropOverlay } from '../VideoSourceCropOverlay'

afterEach(() => cleanup())

// Aspect-matched fixture: wrapper 400×500, source 800×1000. The rendered source
// fills the wrapper with no letterbox, so crop fractions map 1:1 onto wrapper px
// (x over 400, y over 500). Initial crop (0.2,0.2,0.6,0.6) → px rect (80,100)–(320,400).
function makeItem(overrides: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'v1',
    type: 'video',
    src: '/clip.mov',
    start: 0,
    end: 5,
    sourceWidth: 800,
    sourceHeight: 1000,
    sourceCrop: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    ...overrides,
  }
}

describe('VideoSourceCropOverlay', () => {
  it('renders the 8 crop handles for a video item with known source dims', () => {
    const { getByTestId } = render(
      <VideoSourceCropOverlay
        item={makeItem()}
        resolveSrc={() => '/clip.mov'}
        wrapperWidth={400}
        wrapperHeight={500}
        onChange={vi.fn()}
        onSrcDimsLoaded={vi.fn()}
      />,
    )
    for (const h of ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']) {
      expect(getByTestId(`crop-handle-${h}`)).toBeTruthy()
    }
  })

  it('emits onChange exactly once on pointer-up (not per move) with the final clamped [0,1] fractions', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <VideoSourceCropOverlay
        item={makeItem()}
        resolveSrc={() => '/clip.mov'}
        wrapperWidth={400}
        wrapperHeight={500}
        onChange={onChange}
        onSrcDimsLoaded={vi.fn()}
      />,
    )

    const se = getByTestId('crop-handle-se')
    // Simulate a full drag sequence: pointerdown → multiple pointermoves → pointerup.
    // jsdom has no PointerEvent constructor, so fireEvent.pointer* drops
    // clientX/Y. Dispatch MouseEvents under the pointer* type names instead —
    // MouseEvent carries clientX/Y and React listens on the event type string.
    se.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 400 }))
    // Multiple intermediate moves — onChange must NOT be called during these.
    se.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 290, clientY: 400 }))
    se.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 270, clientY: 400 }))

    // onChange must not fire during move — only after release.
    expect(onChange).not.toHaveBeenCalled()

    // Release — final position: SE handle moved left 50 px from start (320 → 270).
    se.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 270, clientY: 400 }))

    // onChange called exactly once on pointer-up.
    expect(onChange).toHaveBeenCalledTimes(1)

    const next = onChange.mock.calls[0][0]
    // dx = -50 px over a 400-px-wide rendered source = -0.125 fractions.
    expect(next.x).toBeCloseTo(0.2)
    expect(next.y).toBeCloseTo(0.2)
    expect(next.w).toBeCloseTo(0.6 - 50 / 400) // 0.475
    expect(next.h).toBeCloseTo(0.6)
    // All emitted fractions stay within [0, 1].
    for (const v of [next.x, next.y, next.w, next.h]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('reads source dims from the <video> loadedmetadata when not supplied on the item', () => {
    const onSrcDimsLoaded = vi.fn()
    const { container } = render(
      <VideoSourceCropOverlay
        item={makeItem({ sourceWidth: undefined, sourceHeight: undefined })}
        resolveSrc={() => '/clip.mov'}
        wrapperWidth={400}
        wrapperHeight={500}
        onChange={vi.fn()}
        onSrcDimsLoaded={onSrcDimsLoaded}
      />,
    )
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'videoWidth', { value: 800, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 1000, configurable: true })
    fireEvent.loadedMetadata(video)
    expect(onSrcDimsLoaded).toHaveBeenCalledWith({ width: 800, height: 1000 })
  })
})

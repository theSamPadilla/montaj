/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'

// Mounts OverlayItemsLayer in isolation with the minimal prop surface it needs.
// Mirrors the fake-adapter capability shims from VideoEditor.test.tsx
// (compileOverlay resolves to a no-op factory), driving the preview layer
// directly so the double-click → onEditOverlay routing is exercisable. The
// props dialog itself now lives in VideoEditor, so the layer only reports the
// intent via onEditOverlay.
const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function makeProject(): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[]],
  } as unknown as EditorProject
}

function renderLayer(item: VisualItem, opts: { selected?: boolean } = {}) {
  const onEditOverlay = vi.fn()
  const onOverlayChange = vi.fn()
  const containerRef = { current: document.createElement('div') }
  const utils = render(
    <OverlayItemsLayer
      project={makeProject()}
      currentTime={1}
      isPlaying={false}
      isCanvasProject={false}
      overlayTracks={[[item]]}
      tracks0NonVideo={[]}
      renderScale={0.2}
      selectedOverlayId={opts.selected === false ? undefined : item.id}
      onOverlayChange={onOverlayChange}
      onEditOverlay={onEditOverlay}
      containerRef={containerRef}
      dragState={null}
      setDragState={vi.fn()}
      liveOffset={null}
      liveScale={null}
      liveRotation={null}
      snapGuides={emptySnap}
      snapRotation={null}
      compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
      fileUrl={(pth: string) => pth}
    />,
  )
  return { ...utils, onEditOverlay, onOverlayChange }
}

// The overlay's async compileOverlay resolves after each test's assertions,
// flushing a CustomOverlay state update outside act(). Harmless fake-compiler
// artifact; silence the console noise the way VideoEditor.test does.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const overlayItem = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'overlay-1',
  type: 'overlay',
  src: 'o.jsx',
  start: 0,
  end: 10,
  props: { homeName: 'x' },
  ...over,
} as VisualItem)

describe('OverlayItemsLayer — double-click to edit overlay', () => {
  it('double-clicking a selected JSX overlay requests the props dialog', () => {
    const { container, onEditOverlay } = renderLayer(overlayItem())

    // The overlay wrapper (outermost div) carries the onDoubleClick handler.
    const wrapper = container.querySelector('div') as HTMLDivElement
    fireEvent.dblClick(wrapper)

    expect(onEditOverlay).toHaveBeenCalledWith('overlay-1')
  })

  it('does not request editing when the overlay is not selected', () => {
    const { container, onEditOverlay } = renderLayer(overlayItem(), { selected: false })

    const wrapper = container.querySelector('div') as HTMLDivElement
    fireEvent.dblClick(wrapper)

    expect(onEditOverlay).not.toHaveBeenCalled()
  })

  it('no longer renders an inline text editor or an in-layer pencil / modal', () => {
    const { container } = renderLayer(overlayItem({ props: { text: 'Hi' } }))

    const wrapper = container.querySelector('div') as HTMLDivElement
    fireEvent.dblClick(wrapper)

    // The dialog is owned by VideoEditor now: the layer neither inline-edits nor
    // renders the modal or a floating pencil itself.
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Edit overlay' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit overlay props' })).toBeNull()
  })
})

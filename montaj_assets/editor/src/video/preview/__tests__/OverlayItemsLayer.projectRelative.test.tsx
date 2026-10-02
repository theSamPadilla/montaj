/// <reference types="vitest/globals" />
import { render, screen, act, waitFor } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'

// An overlay `src` may be project-relative (`overlays/st_spotlight.jsx`, what
// the Hub template recipe writes). Render resolves it against the project's
// directory; the preview can only do the same if the host is told which
// project the overlay belongs to, so the layer hands the project id to the
// host's compileOverlay and watchFile.

const factory: OverlayFactory = (frame) => <span data-testid="ov">{frame}</span>

const item = {
  id: 'o1', type: 'overlay', src: 'overlays/st_spotlight.jsx', start: 0, end: 10, props: {},
} as unknown as VisualItem
const project = {
  id: 'proj-1', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]],
} as unknown as EditorProject
const snap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function layer(
  frameNo: number,
  compileOverlay: (src: string, projectId?: string) => Promise<OverlayFactory>,
  watchFile: (path: string, onChange: () => void, projectId?: string) => () => void,
) {
  return (
    <OverlayItemsLayer
      project={project}
      currentTime={frameNo / 30}
      isPlaying={false}
      isCanvasProject={false}
      overlayTracks={[[item]]}
      tracks0NonVideo={[]}
      renderScale={0.2}
      selectedOverlayId={undefined}
      onOverlayChange={vi.fn()}
      onEditOverlay={vi.fn()}
      containerRef={{ current: document.createElement('div') }}
      dragState={null}
      setDragState={vi.fn()}
      liveOffset={null}
      liveScale={null}
      liveRotation={null}
      snapGuides={snap}
      snapRotation={null}
      compileOverlay={compileOverlay}
      watchFile={watchFile}
      fileUrl={(p: string) => p}
    />
  )
}

describe('OverlayItemsLayer: project-relative overlay src', () => {
  it('compiles the overlay with its project id', async () => {
    const compileOverlay = vi.fn(async () => factory)
    render(layer(1, compileOverlay, vi.fn(() => () => {})))
    await screen.findByTestId('ov')
    expect(compileOverlay).toHaveBeenCalled()
    for (const call of compileOverlay.mock.calls) {
      expect(call).toEqual(['overlays/st_spotlight.jsx', 'proj-1'])
    }
  })

  it('watches the overlay with its project id', async () => {
    const watchFile = vi.fn((_p: string, _cb: () => void, _id?: string) => () => {})
    render(layer(1, vi.fn(async () => factory), watchFile))
    await screen.findByTestId('ov')
    expect(watchFile).toHaveBeenCalled()
    for (const call of watchFile.mock.calls) {
      expect([call[0], call[2]]).toEqual(['overlays/st_spotlight.jsx', 'proj-1'])
    }
  })

  it('a new frame neither recompiles nor resubscribes', async () => {
    const compileOverlay = vi.fn(async () => factory)
    const watchFile = vi.fn((_p: string, _cb: () => void, _id?: string) => () => {})
    const { rerender } = render(layer(1, compileOverlay, watchFile))
    await screen.findByTestId('ov')
    const compiles = compileOverlay.mock.calls.length
    const watches = watchFile.mock.calls.length
    rerender(layer(2, compileOverlay, watchFile))
    await act(async () => {})
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('2'))
    expect(compileOverlay.mock.calls.length).toBe(compiles)
    expect(watchFile.mock.calls.length).toBe(watches)
  })
})

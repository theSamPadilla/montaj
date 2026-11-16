/**
 * "View in 3D": hovering the preview while a 3D item is on screen shows a button at the frame's top right;
 * a click calls `onViewScene3d` with that item and the item time, and never selects or drags an overlay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project } from '../../../schema'

const scene = (id: string, start: number, end: number) => ({ id, type: 'overlay', src: 'engine:scene3d', start, end, props: {} })
const plain = { id: 'o1', type: 'overlay', src: 'a.jsx', start: 0, end: 10, props: {} }

function makeProject(items: unknown[]): Project {
  return { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [items] } as unknown as Project
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    resume() { return Promise.resolve() }
    close() {}
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function makeFootageProject(tracks: unknown[][]): Project {
  return { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks } as unknown as Project
}
const clip = (id: string, start: number, end: number) => ({ id, type: 'video', src: `${id}.mp4`, start, end, inPoint: 0, outPoint: end - start })

function mountProject(project: Project, t: number, extra: Record<string, unknown> = {}) {
  const view = render(
    <PreviewPlayer project={project} clock={createPlaybackClock(t)} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} {...extra} />,
  )
  return { ...view, frame: view.container.querySelector('[data-montaj-preview-frame]') as HTMLElement }
}

function mount(items: unknown[], t: number, extra: Record<string, unknown> = {}) {
  const view = render(
    <PreviewPlayer
      project={makeProject(items)}
      clock={createPlaybackClock(t)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
      {...extra}
    />,
  )
  const frame = view.container.querySelector('[data-montaj-preview-frame]') as HTMLElement
  return { ...view, frame }
}

describe('PreviewPlayer View in 3D', () => {
  it('shows no button without the prop', () => {
    const { frame } = mount([scene('s1', 2, 6)], 3)
    fireEvent.pointerEnter(frame)
    expect(screen.queryByLabelText('View in 3D')).toBeNull()
  })

  it('shows no button when no 3D item is at the playhead', () => {
    const { frame } = mount([plain, scene('s1', 5, 8)], 3, { onViewScene3d: vi.fn() })
    fireEvent.pointerEnter(frame)
    expect(screen.queryByLabelText('View in 3D')).toBeNull()
  })

  it('shows the button only while hovered, and a click calls back with the item and its time', () => {
    const onViewScene3d = vi.fn()
    const { frame } = mount([plain, scene('s1', 2, 6)], 3.5, { onViewScene3d })
    expect(screen.queryByLabelText('View in 3D')).toBeNull()
    fireEvent.pointerEnter(frame)
    fireEvent.click(screen.getByLabelText('View in 3D'))
    expect(onViewScene3d).toHaveBeenCalledTimes(1)
    expect(onViewScene3d).toHaveBeenCalledWith({ itemId: 's1', itemTime: 1.5 })
    fireEvent.pointerLeave(frame)
    expect(screen.queryByLabelText('View in 3D')).toBeNull()
  })

  it('uses the topmost 3D item when several are on screen', () => {
    const onViewScene3d = vi.fn()
    const { frame } = mount([scene('low', 0, 10), scene('high', 1, 10)], 4, { onViewScene3d })
    fireEvent.pointerEnter(frame)
    fireEvent.click(screen.getByLabelText('View in 3D'))
    expect(onViewScene3d).toHaveBeenCalledWith({ itemId: 'high', itemTime: 3 })
  })

  it('does not select, edit or drag an overlay', () => {
    const onOverlayChange = vi.fn()
    const onEditOverlay = vi.fn()
    const onSelectCaption = vi.fn()
    const { frame } = mount([scene('s1', 2, 6)], 3, { onViewScene3d: vi.fn(), onOverlayChange, onEditOverlay, onSelectCaption })
    fireEvent.pointerEnter(frame)
    const btn = screen.getByLabelText('View in 3D')
    fireEvent.pointerDown(btn)
    fireEvent.click(btn)
    fireEvent.doubleClick(btn)
    expect(onOverlayChange).not.toHaveBeenCalled()
    expect(onEditOverlay).not.toHaveBeenCalled()
    expect(onSelectCaption).not.toHaveBeenCalled()
  })

  it('finds a 3D item on track 0 between video clips in a footage project', () => {
    const onViewScene3d = vi.fn()
    const project = makeFootageProject([[clip('c1', 0, 2), scene('s0', 2, 6), clip('c2', 6, 8)]])
    const { frame } = mountProject(project, 3.5, { onViewScene3d })
    fireEvent.pointerEnter(frame)
    fireEvent.click(screen.getByLabelText('View in 3D'))
    expect(onViewScene3d).toHaveBeenCalledWith({ itemId: 's0', itemTime: 1.5 })
  })

  it('prefers a 3D item on an overlay track over one on track 0', () => {
    const onViewScene3d = vi.fn()
    const project = makeFootageProject([[clip('c1', 0, 2), scene('s0', 2, 6), clip('c2', 6, 8)], [scene('top', 1, 7)]])
    const { frame } = mountProject(project, 3.5, { onViewScene3d })
    fireEvent.pointerEnter(frame)
    fireEvent.click(screen.getByLabelText('View in 3D'))
    expect(onViewScene3d).toHaveBeenCalledWith({ itemId: 'top', itemTime: 2.5 })
  })
})

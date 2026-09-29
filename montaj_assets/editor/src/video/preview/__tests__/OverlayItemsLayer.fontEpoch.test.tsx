/// <reference types="vitest/globals" />
import React from 'react'
import { render, screen, act, waitFor } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { OverlayPreview } from '../../../preview/OverlayPreview'

// The compiled factory calls the overlay component as a function, so its hooks
// run in the host. The stub mirrors that: a hook inside the factory call.
let mounts = 0
const factory: OverlayFactory = (frame) => {
  React.useEffect(() => { mounts++ }, [])
  return <span data-testid="ov">{frame}</span>
}

const orig = Object.getOwnPropertyDescriptor(document, 'fonts')
function setFonts(v: unknown) {
  Object.defineProperty(document, 'fonts', { value: v, configurable: true })
}

const item = {
  id: 'o1', type: 'overlay', src: 'o.jsx', start: 0, end: 10, props: {},
} as unknown as VisualItem
const project = {
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]],
} as unknown as EditorProject
const snap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function layer(frameNo: number) {
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
      compileOverlay={async () => factory}
      fileUrl={(p: string) => p}
    />
  )
}
function preview(frame: number) {
  return (
    <OverlayPreview
      template="o.jsx" props={{}} frame={frame} fps={30} duration={60}
      compileOverlay={async () => factory}
    />
  )
}

beforeEach(() => { mounts = 0 })
afterEach(() => {
  if (orig) Object.defineProperty(document, 'fonts', orig)
  else delete (document as unknown as Record<string, unknown>).fonts
})

const cases: Array<[string, (n: number) => React.ReactElement]> = [
  ['CustomOverlay', layer],
  ['OverlayPreview', preview],
]

describe.each(cases)('%s font epoch', (_name, make) => {
  it('(a) remounts the body when a font finishes loading', async () => {
    const fonts = new EventTarget()
    setFonts(fonts)
    render(make(1))
    await screen.findByTestId('ov')
    // findBy resolves when the span is in the DOM; the mount effect that counts
    // can run a tick later, so wait for it rather than read it.
    await waitFor(() => expect(mounts).toBe(1))
    act(() => { fonts.dispatchEvent(new Event('loadingdone')) })
    await waitFor(() => expect(mounts).toBe(2))
    expect(screen.getByTestId('ov')).toBeTruthy()
  })

  it('(b) a frame change re-renders without remounting', async () => {
    setFonts(new EventTarget())
    const { rerender } = render(make(1))
    await screen.findByTestId('ov')
    await waitFor(() => expect(mounts).toBe(1))
    rerender(make(2))
    await act(async () => {})
    expect(screen.getByTestId('ov').textContent).toBe('2')
    expect(mounts).toBe(1)
  })

  it('(c) works without document.fonts', async () => {
    setFonts(undefined)
    render(make(1))
    expect((await screen.findByTestId('ov')).textContent).toBe('1')
    await waitFor(() => expect(mounts).toBe(1))
  })
})

// A watchFile recompile swaps the factory in place. The new overlay must mount
// fresh, not inherit the old overlay's hook list (guardedFactory in the host
// turns a hook-count mismatch into a badge rather than a throw).
describe('CustomOverlay live edit', () => {
  function guarded(Comp: (p: { frame: number }) => React.ReactElement): OverlayFactory {
    return (frame) => {
      try { return Comp({ frame }) } catch (e) { return <span data-testid="ov">badge: {String((e as Error).message)}</span> }
    }
  }
  const v1 = guarded(() => { const [w] = React.useState(() => 'measured-v1'); return <span data-testid="ov">{w}</span> })
  const v2 = guarded(() => { const [w] = React.useState(() => 'measured-v2'); return <span data-testid="ov">{w}</span> })
  const v3 = guarded(() => { const [w] = React.useState(() => 'v3'); React.useRef(0); return <span data-testid="ov">{w}</span> })

  function run(next: OverlayFactory) {
    let onChange: () => void = () => {}
    let current: OverlayFactory = v1
    const el = React.cloneElement(layer(1), {
      compileOverlay: async () => current,
      watchFile: (_p: string, cb: () => void) => { onChange = cb; return () => {} },
    })
    render(el)
    return { reload: () => { current = next; onChange() } }
  }

  it('a mount-time value is re-measured after an edit', async () => {
    setFonts(new EventTarget())
    const { reload } = run(v2)
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('measured-v1'))
    await act(async () => { reload() })
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('measured-v2'))
  })

  it('an edit that adds a hook draws the overlay, not a badge', async () => {
    setFonts(new EventTarget())
    const { reload } = run(v3)
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('measured-v1'))
    await act(async () => { reload() })
    await waitFor(() => expect(screen.getByTestId('ov').textContent).toBe('v3'))
  })
})

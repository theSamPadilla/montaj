import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// Element lock (§586 M5): a locked element can be selected and styled, but its
// placement, crop, image and existence are fixed.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => lockProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.png' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  } as FakeAdapter
}

/** el-a locked and el-b free (images), el-c a free image, el-ov a locked text overlay. */
function lockProject(): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test',
    workflow: 'carousel',
    status: 'draft',
    editingPrompt: '',
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [
      {
        id: 'slide-0',
        base_color: '#ffffff',
        elements: [
          { id: 'el-a', type: 'image', src: 'a.png', x: 100, y: 100, w: 200, h: 100, rotation: 0, locked: true },
          { id: 'el-b', type: 'image', src: 'b.png', x: 500, y: 400, w: 100, h: 300, rotation: 0 },
          { id: 'el-c', type: 'image', src: 'c.png', x: 700, y: 700, w: 100, h: 100, rotation: 0 },
          {
            id: 'el-ov',
            type: 'overlay',
            overlay: { template: '/overlays/text.jsx', props: { text: 'Hello', fontWeight: '400' } },
            frame: 0,
            x: 50, y: 800, w: 600, h: 150, rotation: 0,
            locked: true,
          },
        ],
      },
    ],
  } as Project
}

const CMD = { metaKey: true }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.setPointerCapture = vi.fn()
})
afterEach(() => vi.restoreAllMocks())

function wrapperOf(id: string): HTMLElement {
  const els = document.querySelectorAll(`[data-element-id="${id}"]`)
  return els[els.length - 1] as HTMLElement
}
function chromeOf(id: string): HTMLElement {
  return (document.querySelector(`[data-chrome-for="${id}"]`) as HTMLElement | null) ?? document.createElement('div')
}
const outlined = (id: string) => chromeOf(id).style.outline.includes('solid')
const handlesOn = (id: string) => chromeOf(id).querySelector('[data-testid="resize-handle-nw"]') !== null
const rotateOn = (id: string) => chromeOf(id).querySelector('[data-testid="rotate-handle"]') !== null
const elementsOf = (p: Project) => p.slides![0].elements
const byId = (p: Project, id: string) => elementsOf(p).find((e) => e.id === id)!
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project

async function mount(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}) {
  const adapter = makeFakeAdapter()
  const onProjectChange = vi.fn()
  const r = render(<CarouselEditor project={lockProject()} adapter={adapter} onProjectChange={onProjectChange} {...extra} />)
  await waitFor(() => wrapperOf('el-a'))
  return { adapter, onProjectChange, r }
}

async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { target.dispatchEvent(e) })
  return e
}
async function click(id: string) {
  await act(async () => { fireEvent.click(wrapperOf(id)) })
}
function pointer(target: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}
async function shiftClick(id: string) {
  const w = wrapperOf(id)
  await act(async () => {
    pointer(w, 'pointerdown', { shiftKey: true, clientX: 10, clientY: 10 })
    pointer(window, 'pointerup')
    fireEvent.click(w, { shiftKey: true })
  })
}
async function dragFrom(id: string, dx = 80, dy = 60) {
  await act(async () => {
    pointer(wrapperOf(id), 'pointerdown', { clientX: 100, clientY: 100 })
    pointer(window, 'pointermove', { clientX: 100 + dx, clientY: 100 + dy })
    pointer(window, 'pointerup')
  })
}
const LOCK_KEY = { code: 'KeyL', altKey: true, shiftKey: true }

describe('CarouselEditor: element lock (§586 M5)', () => {
  it('a locked element can be selected by click and Cmd+A, shows its outline but no handles, and its cursor is the arrow', async () => {
    await mount()
    await click('el-a')
    expect(outlined('el-a')).toBe(true)
    expect(handlesOn('el-a')).toBe(false)
    expect(rotateOn('el-a')).toBe(false)
    expect(wrapperOf('el-a').style.cursor).toBe('default')
    expect(wrapperOf('el-b').style.cursor).toBe('grab')

    await click('el-b')
    expect(handlesOn('el-b')).toBe(true)
    await key('a', CMD)
    expect(outlined('el-a')).toBe(true)
    expect(outlined('el-ov')).toBe(true)
  })

  it('dragging a locked element moves and starts nothing, and saves nothing', async () => {
    const { adapter, onProjectChange } = await mount()
    await dragFrom('el-a')
    expect(adapter.saveCalls).toHaveLength(0)
    const p = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    expect(byId(p, 'el-a')).toMatchObject({ x: 100, y: 100 })
    // The press selects it, as a click does.
    expect(outlined('el-a')).toBe(true)
  })

  it('arrow keys do not nudge a locked element, and move the free ones in a mixed selection', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await key('ArrowRight')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    expect(adapter.saveCalls).toHaveLength(0)

    await shiftClick('el-b')
    await key('ArrowRight')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a')).toMatchObject({ x: 100, y: 100, locked: true })
    expect(byId(last(adapter), 'el-b')).toMatchObject({ x: 501, y: 400 })
  })

  it('Delete leaves a locked element; with a free one selected too, only the free one goes, in one undo step', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await key('Delete')
    expect(adapter.saveCalls).toHaveLength(0)
    expect(wrapperOf('el-a')).toBeTruthy()

    await shiftClick('el-b')
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['el-a', 'el-c', 'el-ov'])
  })

  it('the panel Delete button is disabled for a locked element', async () => {
    const { adapter, r } = await mount()
    await click('el-a')
    const del = r.getAllByRole('button', { name: 'Delete' }).pop() as HTMLButtonElement
    expect(del.disabled).toBe(true)
    await act(async () => { fireEvent.click(del) })
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('Crop and Replace are disabled, and the X, Y, W, H and rotation fields are read-only', async () => {
    const { r } = await mount()
    await click('el-a')
    expect((r.getByTitle('Crop image') as HTMLButtonElement).disabled).toBe(true)
    expect((r.getByTitle('Replace image') as HTMLButtonElement).disabled).toBe(true)
    for (const name of ['X', 'Y', 'W', 'H', 'Rotation']) {
      expect((r.getByRole('spinbutton', { name }) as HTMLInputElement).disabled).toBe(true)
    }
    // A free element keeps them.
    await click('el-b')
    expect((r.getByTitle('Crop image') as HTMLButtonElement).disabled).toBe(false)
    expect((r.getByRole('spinbutton', { name: 'X' }) as HTMLInputElement).disabled).toBe(false)
  })

  it('double-click on a locked image does not enter crop mode', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-a')) })
    expect(wrapperOf('el-a').querySelector('img[alt="Crop source"]')).toBeNull()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('align leaves a locked element out: single align is disabled, a selection aligns only the free ones', async () => {
    const { adapter, r } = await mount()
    await click('el-a')
    expect((r.getByRole('button', { name: 'Align left' }) as HTMLButtonElement).disabled).toBe(true)

    await shiftClick('el-b')
    await shiftClick('el-c')
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a')).toMatchObject({ x: 100, y: 100 })
    // b and c align to the box they cover (500..800), the locked one is not part of it.
    expect(byId(last(adapter), 'el-b')).toMatchObject({ x: 500 })
    expect(byId(last(adapter), 'el-c')).toMatchObject({ x: 500 })
  })

  it('Cut copies a locked element but does not remove it; Paste brings an unlocked copy', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await key('x', CMD)
    expect(adapter.saveCalls).toHaveLength(0)
    expect(wrapperOf('el-a')).toBeTruthy()
    await key('v', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(last(adapter))
    expect(els).toHaveLength(5)
    expect(els[4]).toMatchObject({ src: 'a.png' })
    expect((els[4] as { locked?: boolean }).locked).toBeUndefined()
    expect(byId(last(adapter), 'el-a').locked).toBe(true)
  })

  it('Cmd+D copies a locked element unlocked', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await key('d', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const els = elementsOf(last(adapter))
    expect(els[0].locked).toBe(true)
    expect(els[1]).toMatchObject({ src: 'a.png', x: 120 })
    expect(els[1].locked).toBeUndefined()
  })

  it('layer order keys still move a locked element', async () => {
    const { adapter } = await mount()
    await click('el-a')
    // matchesLayerKey reads the physical key.
    const e = new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', metaKey: true, bubbles: true, cancelable: true })
    await act(async () => { document.dispatchEvent(e) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    expect(elementsOf(last(adapter)).map((x) => x.id).indexOf('el-a')).toBeGreaterThan(0)
    expect(byId(last(adapter), 'el-a').locked).toBe(true)
  })

  it('text of a locked overlay still edits on double-click, and a style change still applies', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-ov')) })
    expect(r.queryByRole('textbox', { name: 'Edit text' })).not.toBeNull()
    await key('Escape', {}, r.getByRole('textbox', { name: 'Edit text' }))

    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Bold' })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    const ov = byId(last(adapter), 'el-ov') as { overlay: { props: Record<string, unknown> }; locked?: boolean }
    expect(ov.overlay.props.fontWeight).toBe('700')
    expect(ov.locked).toBe(true)
  })

  it('a group drag moves only the unlocked members', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await shiftClick('el-b')
    await dragFrom('el-b', 200, 120)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a')).toMatchObject({ x: 100, y: 100 })
    const b = byId(last(adapter), 'el-b')
    expect(b.x).not.toBe(500)
  })
})

describe('CarouselEditor: the lock key (§586 M5)', () => {
  it('Opt+Shift+L locks the selection, then unlocks it, each as one undo step', async () => {
    const { adapter } = await mount({ lockKey: true })
    await click('el-b')
    await shiftClick('el-c')
    const e = await key('Ø', LOCK_KEY)
    expect(e.defaultPrevented).toBe(true)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-b').locked).toBe(true)
    expect(byId(last(adapter), 'el-c').locked).toBe(true)

    await key('Ø', LOCK_KEY)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(byId(last(adapter), 'el-b').locked).toBeUndefined()
    expect(byId(last(adapter), 'el-c').locked).toBeUndefined()

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(3))
    expect(byId(last(adapter), 'el-b').locked).toBe(true)
    expect(byId(last(adapter), 'el-c').locked).toBe(true)
  })

  it('with any selected element locked, the key unlocks them all', async () => {
    const { adapter } = await mount({ lockKey: true })
    await click('el-a')
    await shiftClick('el-b')
    await key('Ø', LOCK_KEY)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a').locked).toBeUndefined()
    expect(byId(last(adapter), 'el-b').locked).toBeUndefined()
  })

  it('does nothing without the lockKey prop', async () => {
    const { adapter } = await mount()
    await click('el-b')
    const e = await key('Ø', LOCK_KEY)
    expect(e.defaultPrevented).toBe(false)
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('Cmd or Ctrl with Alt+Shift+L is not the lock key', async () => {
    const { adapter } = await mount({ lockKey: true })
    await click('el-b')
    await key('l', { ...LOCK_KEY, metaKey: true })
    await key('l', { ...LOCK_KEY, ctrlKey: true })
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('the lock is in the saved project', async () => {
    const { adapter } = await mount({ lockKey: true })
    await click('el-b')
    await key('Ø', LOCK_KEY)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(JSON.parse(JSON.stringify(last(adapter))).slides[0].elements[1]).toMatchObject({ id: 'el-b', locked: true })
  })
})

describe('CarouselEditor: the lock key in the controls list (§586 M5)', () => {
  it('lists the lock key only with lockKey on', async () => {
    const seen: string[][] = []
    const renderControls = (ctx: { sections: Array<{ entries: Array<{ label: string }> }> }) => {
      seen.push(ctx.sections.flatMap((s) => s.entries.map((e) => e.label)))
      return null
    }
    await mount({ renderControls })
    expect(seen[seen.length - 1]).not.toContain('Lock or unlock')
    seen.length = 0
    document.body.innerHTML = ''
    await mount({ renderControls, lockKey: true })
    expect(seen[seen.length - 1]).toContain('Lock or unlock')
  })
})

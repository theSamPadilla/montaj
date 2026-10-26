import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

// Element lock (§586 M5): a locked element can be selected, copied and layered,
// but its place and its content (text, style, image, crop) are fixed until it
// is unlocked.

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

/** A locked text (el-ov), a free text to copy a style from (t-src) and one to paste onto (t-free). */
function textProject(): Project {
  const p = lockProject()
  const text = (id: string, label: string, color: string, y: number, extra: object = {}) => ({
    id, type: 'overlay', overlay: { template: '/overlays/text.jsx', props: { text: label, fontWeight: '400', color } },
    frame: 0, x: 50, y, w: 400, h: 100, rotation: 0, ...extra,
  })
  p.slides![0].elements = [
    text('el-ov', 'Hello', '#000000', 50, { locked: true }),
    text('t-src', 'Src', '#ff0000', 300),
    text('t-free', 'Free', '#00ff00', 500),
  ] as never
  return p
}
const propsOf = (p: Project, id: string) => (byId(p, id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props

async function mount(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}, project: Project = lockProject()) {
  const adapter = makeFakeAdapter()
  const onProjectChange = vi.fn()
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={onProjectChange} {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id]')).not.toBeNull())
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
  })

  it('pressing a locked element without moving selects it, as a click does, and saves nothing', async () => {
    const { adapter } = await mount()
    await act(async () => {
      pointer(wrapperOf('el-a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointerup')
    })
    expect(adapter.saveCalls).toHaveLength(0)
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

  it('align leaves a locked element out: single align is disabled, a selection aligns only the free ones, to the box the whole selection covers', async () => {
    const { adapter, r } = await mount()
    await click('el-a')
    expect((r.getByRole('button', { name: 'Align left' }) as HTMLButtonElement).disabled).toBe(true)

    await shiftClick('el-b')
    await shiftClick('el-c')
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align left' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a')).toMatchObject({ x: 100, y: 100 })
    // b and c align to the box all three cover, so to the locked one's edge.
    expect(byId(last(adapter), 'el-b')).toMatchObject({ x: 100 })
    expect(byId(last(adapter), 'el-c')).toMatchObject({ x: 100 })
  })

  it('two selected, one locked: the align controls show, and align moves only the free one to the locked one', async () => {
    const { adapter, r } = await mount()
    await click('el-a')
    await shiftClick('el-b')
    const left = r.getByRole('button', { name: 'Align left' }) as HTMLButtonElement
    expect(left.disabled).toBe(false)
    await act(async () => { fireEvent.click(left) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a')).toMatchObject({ x: 100, y: 100 })
    expect(byId(last(adapter), 'el-b')).toMatchObject({ x: 100 })
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

  it('double-click on a locked text overlay opens no inline editor and saves nothing', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-ov')) })
    expect(r.queryByRole('textbox', { name: 'Edit text' })).toBeNull()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('the text controls of a locked text overlay are disabled and write nothing', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    const bold = r.getByRole('button', { name: 'Bold' })
    expect(bold.matches(':disabled')).toBe(true)
    expect(r.getByRole('spinbutton', { name: 'Frame' }).matches(':disabled')).toBe(true)
    await act(async () => { fireEvent.click(bold) })
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('a locked element is unlocked by its badge, and then its text edits and styles', async () => {
    const { adapter, r } = await mount()
    await click('el-ov')
    await act(async () => { fireEvent.click(chromeOf('el-ov').querySelector('[data-testid="lock-badge"]')!) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(r.getByRole('button', { name: 'Bold' }).matches(':disabled')).toBe(false)

    await act(async () => { fireEvent.doubleClick(wrapperOf('el-ov')) })
    expect(r.queryByRole('textbox', { name: 'Edit text' })).not.toBeNull()
    await key('Escape', {}, r.getByRole('textbox', { name: 'Edit text' }))

    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Bold' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    const ov = byId(last(adapter), 'el-ov') as { overlay: { props: Record<string, unknown> }; locked?: boolean }
    expect(ov.overlay.props.fontWeight).toBe('700')
    expect(ov.locked).toBeUndefined()
  })

  it('style paste onto a locked and an unlocked text styles only the unlocked one, in one undo step', async () => {
    const { adapter } = await mount({}, textProject())
    await click('t-src')
    await key('c', { metaKey: true, altKey: true, code: 'KeyC' })
    await click('el-ov')
    await shiftClick('t-free')
    await key('√', { metaKey: true, altKey: true, code: 'KeyV' })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-ov')).toMatchObject({ text: 'Hello', color: '#000000' })
    expect(propsOf(last(adapter), 't-free')).toMatchObject({ text: 'Free', color: '#ff0000' })
    expect(byId(last(adapter), 'el-ov').locked).toBe(true)

    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 't-free').color).toBe('#00ff00')
  })

  it('style paste onto only locked text writes nothing', async () => {
    const { adapter } = await mount({}, textProject())
    await click('t-src')
    await key('c', { metaKey: true, altKey: true, code: 'KeyC' })
    await click('el-ov')
    await key('√', { metaKey: true, altKey: true, code: 'KeyV' })
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('style copy reads a locked text, and the paste lands on a free one', async () => {
    const { adapter } = await mount({}, textProject())
    await click('el-ov')
    await key('c', { metaKey: true, altKey: true, code: 'KeyC' })
    await click('t-free')
    await key('√', { metaKey: true, altKey: true, code: 'KeyV' })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 't-free').color).toBe('#000000')
  })

  it('layer order still moves a locked text overlay', async () => {
    const { adapter } = await mount({}, textProject())
    await click('el-ov')
    const e = new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', metaKey: true, bubbles: true, cancelable: true })
    await act(async () => { document.dispatchEvent(e) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    expect(elementsOf(last(adapter)).map((x) => x.id).indexOf('el-ov')).toBeGreaterThan(0)
    expect(propsOf(last(adapter), 'el-ov')).toMatchObject({ text: 'Hello', color: '#000000' })
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

function loadImage(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

describe('CarouselEditor: lock key and crop, select all, distribute (§586 M5)', () => {
  it('Opt+Shift+L in crop mode applies the crop as its own step, then locks', async () => {
    const { adapter, r } = await mount({ lockKey: true })
    await click('el-b')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    const source = chromeOf('el-b').querySelector<HTMLImageElement>('img[alt="Crop source"]')!
    await act(async () => { loadImage(source, 200, 300) })
    const handle = chromeOf('el-b').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
    const root = document.querySelector('[data-interactive]') as HTMLElement
    const d = 40 * (parseFloat(root.style.width) / 1080)
    await act(async () => {
      pointer(handle, 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(handle, 'pointermove', { clientX: -d, clientY: 0 })
      pointer(handle, 'pointerup', { clientX: -d, clientY: 0 })
      fireEvent.click(handle)
    })

    await key('Ø', LOCK_KEY)
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(1))
    // The crop is saved before the lock: the saves before the last hold it unlocked.
    const els = adapter.saveCalls.map((c) => byId(c.project, 'el-b') as ImageElement)
    const locked = els[els.length - 1]
    expect(locked.locked).toBe(true)
    expect(locked.crop).toBeTruthy()
    for (const e of els.slice(0, -1)) {
      expect(e.crop).toEqual(locked.crop)
      expect(e.locked).toBeUndefined()
    }
    // The lock is its own undo step: one undo unlocks and keeps the crop.
    const before = adapter.saveCalls.length
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(before))
    const undone = byId(last(adapter), 'el-b') as ImageElement
    expect(undone.locked).toBeUndefined()
    expect(undone.crop).toEqual(locked.crop)
  })

  /** One slide of 100 px images at the given x, the first one locked. */
  const rowProject = (xs: number[]): Project => {
    const p = lockProject()
    p.slides![0].elements = xs.map((x, i) => ({ id: `r${i}`, type: 'image', src: `r${i}.png`, x, y: 100, w: 100, h: 100, rotation: 0, ...(i === 0 ? { locked: true } : {}) })) as never
    return p
  }

  it('Cmd+A then Delete removes the two free elements in one step and keeps the locked one selected', async () => {
    const { adapter } = await mount({}, rowProject([0, 200, 400]))
    await click('r1')
    await key('a', CMD)
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['r0'])
    expect(outlined('r0')).toBe(true)
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(elementsOf(last(adapter)).map((e) => e.id)).toEqual(['r0', 'r1', 'r2'])
  })

  it('distribute with a locked element among the selected leaves the locked one where it is', async () => {
    const { adapter, r } = await mount({}, rowProject([0, 100, 150, 700]))
    await click('r0')
    await key('a', CMD)
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Distribute horizontally' })) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const xs = elementsOf(last(adapter)).map((e) => e.x)
    expect(xs[0]).toBe(0)
    // The locked one stays and counts as an end of the spread: the rest even out after it.
    expect(xs.slice(1)).toEqual([233, 467, 700])
  })
})

describe('CarouselEditor: lock badge (§586 M5b)', () => {
  const badgeOf = (id: string) => chromeOf(id).querySelector<HTMLElement>('[data-testid="lock-badge"]')

  it('shows only on a selected locked element, with or without the lock key', async () => {
    await mount()
    expect(badgeOf('el-a')).toBeNull()
    await click('el-a')
    expect(badgeOf('el-a')).not.toBeNull()
    expect(badgeOf('el-a')!.getAttribute('aria-label')).toBe('Unlock')
    await click('el-b')
    expect(badgeOf('el-a')).toBeNull()
    expect(badgeOf('el-b')).toBeNull()
  })

  it('a click unlocks in one undo step, keeps the element selected with its handles, and Cmd+Z relocks', async () => {
    const { adapter } = await mount()
    await click('el-a')
    await act(async () => { fireEvent.click(badgeOf('el-a')!) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(byId(last(adapter), 'el-a').locked).toBeUndefined()
    expect(badgeOf('el-a')).toBeNull()
    expect(handlesOn('el-a')).toBe(true)
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(byId(last(adapter), 'el-a').locked).toBe(true)
    expect(outlined('el-a')).toBe(true)
  })

  it('saves a crop picked on another image before the unlock, as its own step', async () => {
    const { adapter, r } = await mount()
    await click('el-b')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    const source = chromeOf('el-b').querySelector<HTMLImageElement>('img[alt="Crop source"]')!
    await act(async () => { loadImage(source, 200, 300) })
    const handle = chromeOf('el-b').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
    const root = document.querySelector('[data-interactive]') as HTMLElement
    const d = 40 * (parseFloat(root.style.width) / 1080)
    await act(async () => {
      pointer(handle, 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(handle, 'pointermove', { clientX: -d, clientY: 0 })
      pointer(handle, 'pointerup', { clientX: -d, clientY: 0 })
      fireEvent.click(handle)
    })
    // Selecting the locked image leaves crop mode, applying the crop; the badge
    // click then unlocks as a step of its own.
    await click('el-a')
    expect(badgeOf('el-a')).not.toBeNull()
    await act(async () => { fireEvent.click(badgeOf('el-a')!) })
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(1))
    const els = adapter.saveCalls.map((c) => byId(c.project, 'el-a'))
    expect(els[els.length - 1].locked).toBeUndefined()
    expect((byId(last(adapter), 'el-b') as ImageElement).crop).toBeTruthy()
    // The crop was saved on its own, while the image was still locked.
    expect(byId(adapter.saveCalls[0].project, 'el-a').locked).toBe(true)
  })

  it('a press beside the badge still reaches the element', async () => {
    await mount()
    await click('el-a')
    const badge = badgeOf('el-a')!
    expect(badge.style.pointerEvents).toBe('auto')
    expect(chromeOf('el-a').style.pointerEvents).toBe('none')
    expect(document.querySelector('[data-slide-chrome]')!.getAttribute('style')).toContain('pointer-events: none')
  })
})

describe('CarouselEditor: an external lock lands mid-gesture (§586 batch 2)', () => {
  async function mountLive(project: Project = lockProject()) {
    const adapter = makeFakeAdapter()
    let push: ((p: Project) => void) | undefined
    adapter.subscribe = (_id, onFrame) => { push = onFrame; return () => {} }
    const onProjectChange = vi.fn()
    const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={onProjectChange} />)
    await waitFor(() => expect(document.querySelector('[data-element-id]')).not.toBeNull())
    await waitFor(() => expect(push).toBeDefined())
    const lockExternally = async (id: string) => {
      const p = structuredClone(project)
      p.slides![0].elements = p.slides![0].elements.map((e) => (e.id === id ? { ...e, locked: true } : e)) as never
      await act(async () => { push!(p) })
    }
    return { adapter, r, lockExternally }
  }
  const handleOf = (id: string, testId: string) => chromeOf(id).querySelector(`[data-testid="${testId}"]`) as HTMLElement

  /** A free edit afterwards is one save and one undo step that leaves el-b where the lock found it. */
  async function nextEditIsOwnStep(adapter: FakeAdapter, expected: Record<string, number>) {
    const before = adapter.saveCalls.length
    // The release's click is swallowed once; the second lands.
    await click('el-c')
    await click('el-c')
    await key('ArrowRight')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(byId(last(adapter), 'el-b')).toMatchObject(expected)
    await key('z', CMD)
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 2))
    expect(byId(last(adapter), 'el-c')).toMatchObject({ x: 700 })
    expect(byId(last(adapter), 'el-b')).toMatchObject(expected)
  }

  it('a drag released after the element was locked leaves it where it was and records nothing', async () => {
    const { adapter, lockExternally } = await mountLive()
    await click('el-b')
    await act(async () => {
      pointer(wrapperOf('el-b'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 180, clientY: 160 })
    })
    await lockExternally('el-b')
    await act(async () => { pointer(window, 'pointerup') })
    expect(adapter.saveCalls).toHaveLength(0)
    await nextEditIsOwnStep(adapter, { x: 500, y: 400 })
  })

  it('a resize released after the element was locked leaves it and records nothing', async () => {
    const { adapter, lockExternally } = await mountLive()
    await click('el-b')
    await act(async () => {
      pointer(handleOf('el-b', 'resize-handle-se'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 40, clientY: 40 })
    })
    await lockExternally('el-b')
    await act(async () => { pointer(window, 'pointerup', { clientX: 40, clientY: 40 }) })
    expect(adapter.saveCalls).toHaveLength(0)
    await nextEditIsOwnStep(adapter, { w: 100, h: 300 })
  })

  it('a rotation released after the element was locked leaves it and records nothing', async () => {
    const { adapter, lockExternally } = await mountLive()
    await click('el-b')
    await act(async () => {
      pointer(handleOf('el-b', 'rotate-handle'), 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 60, clientY: 20 })
    })
    await lockExternally('el-b')
    await act(async () => { pointer(window, 'pointerup', { clientX: 60, clientY: 20 }) })
    expect(adapter.saveCalls).toHaveLength(0)
    await nextEditIsOwnStep(adapter, { rotation: 0 })
  })

  it('a crop open when the image is locked ends without applying, and Esc writes nothing', async () => {
    const { adapter, r, lockExternally } = await mountLive()
    await click('el-b')
    await act(async () => { fireEvent.click(r.getByTitle('Crop image')) })
    const source = chromeOf('el-b').querySelector<HTMLImageElement>('img[alt="Crop source"]')!
    await act(async () => { loadImage(source, 200, 300) })
    const handle = chromeOf('el-b').querySelector('[data-testid="crop-handle-e"]') as HTMLElement
    const root = document.querySelector('[data-interactive]') as HTMLElement
    const d = 40 * (parseFloat(root.style.width) / 1080)
    await act(async () => {
      pointer(handle, 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(handle, 'pointermove', { clientX: -d, clientY: 0 })
      pointer(handle, 'pointerup', { clientX: -d, clientY: 0 })
      fireEvent.click(handle)
    })
    await lockExternally('el-b')
    expect(chromeOf('el-b').querySelector('img[alt="Crop source"]')).toBeNull()
    await key('Escape')
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('an inline text edit open when the text is locked closes and keeps the text', async () => {
    const free = lockProject()
    free.slides![0].elements = free.slides![0].elements.map((e) => (e.id === 'el-ov' ? { ...e, locked: undefined } : e)) as never
    const { adapter, r, lockExternally } = await mountLive(free)
    await click('el-ov')
    await act(async () => { fireEvent.doubleClick(wrapperOf('el-ov')) })
    expect(r.getByRole('textbox', { name: 'Edit text' })).toBeTruthy()
    await lockExternally('el-ov')
    expect(r.queryByRole('textbox', { name: 'Edit text' })).toBeNull()
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

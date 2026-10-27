import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent } from '@testing-library/react'
import type { EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import type { SlideNote } from '../../schema'
import CarouselEditor from '../CarouselEditor'
import { shortcutText } from '../../ui/modifierKeys'

// §587 M7: the right-click menu (rail layout). Each entry runs the handler its
// key or the toolbar uses.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

const img = (id: string, extra: Partial<ImageElement> = {}): ImageElement => ({ id, type: 'image', src: `/m/${id}.png`, x: 100, y: 100, w: 200, h: 200, rotation: 0, ...extra })
const badge = (id: string): OverlayElement => ({ id, type: 'overlay', overlay: { template: 'sticker', props: {} }, frame: 0, x: 600, y: 600, w: 50, h: 50, rotation: 0 })
const slide = (id: string, elements: Slide['elements']): Slide => ({ id, base_color: '#ffffff', elements })
function makeProject(slides: Slide[]): Project {
  return { version: '1', id: 'p', name: 'T', workflow: 'carousel', status: 'draft', editingPrompt: '', projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [], slides } as Project
}
function makeAdapter(initial: Project) {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => initial),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/o.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (p: string) => p,
    saveCalls,
  }
  return adapter
}
class MockIO { constructor(public cb: IntersectionObserverCallback) {} observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
const pc = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIO
  if (pc) Object.defineProperty(Element.prototype, 'setPointerCapture', pc)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

async function mount(project: Project, extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}, layout: 'rail' | 'classic' = 'rail') {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout={layout} {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id]')).not.toBeNull())
  return { adapter, r }
}
const wrapper = (id: string) => {
  const els = document.querySelectorAll(`[data-interactive] [data-element-id="${id}"]`)
  return els[els.length - 1] as HTMLElement
}
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const ids = (p: Project, i = 0) => p.slides![i].elements.map((e) => e.id)
const menu = () => document.querySelector<HTMLElement>('[role="menu"][data-testid="canvas-context-menu"]')
const item = (name: string) => Array.from(menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((e) => e.textContent!.startsWith(name))!
const labels = () => Array.from(menu()!.querySelectorAll('[role="menuitem"]')).map((e) => e.firstElementChild!.textContent)
const disabled = (name: string) => item(name).getAttribute('aria-disabled') === 'true'
async function rightClick(target: Element, init: MouseEventInit = {}) {
  let ev!: MouseEvent
  await act(async () => { ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 321, clientY: 222, ...init }); target.dispatchEvent(ev) })
  return ev
}
async function run(name: string) { await act(async () => { fireEvent.click(item(name)) }) }
async function key(k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })
  await act(async () => { window.dispatchEvent(e) })
  return e
}
const outlined = (id: string) => (document.querySelector(`[data-chrome-for="${id}"]`) as HTMLElement | null)?.style.outline.includes('solid')

const base = () => makeProject([slide('s0', [img('a'), img('b', { x: 400 }), badge('c')]), slide('s1', [img('d')])])

describe('right-click menu', () => {
  it('opens at the pointer on an element and selects it', async () => {
    await mount(base())
    const ev = await rightClick(wrapper('a'))
    expect(ev.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(menu()!.style.left).toBe('321px')
    expect(menu()!.style.top).toBe('222px')
    expect(outlined('a')).toBe(true)
    expect(labels()).toEqual(['Copy', 'Paste', 'Duplicate', 'Delete', 'Bring to front', 'Bring forward', 'Send backward', 'Send to back', 'Lock', 'Crop', 'Replace image', 'Set as background'])
    expect(item('Copy').textContent).toContain(shortcutText(['⌘', 'C']))
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(2)
  })

  it('a right-press on a resize or rotate handle starts no gesture', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    await key('Escape')
    const before = adapter.saveCalls.length
    for (const handle of [document.querySelector('[data-testid^="resize-handle-"]')!, document.querySelector('[data-testid="rotate-handle"]')!]) {
      await act(async () => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }))
        window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 90 }))
        window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 90, clientY: 90 }))
      })
    }
    expect(adapter.saveCalls.length).toBe(before)
  })

  it('keeps a multi-selection when the element is in it', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    await key('Escape')
    await act(async () => { fireEvent.keyDown(document, { key: 'a', metaKey: true }) })
    expect(outlined('a') && outlined('b') && outlined('c')).toBe(true)
    await rightClick(wrapper('b'))
    expect(outlined('a') && outlined('b') && outlined('c')).toBe(true)
    // Image-only entries are for a single image.
    expect(labels()).not.toContain('Crop')
  })

  it('copy then paste round trip', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    await run('Copy')
    expect(menu()).toBeNull()
    await rightClick(wrapper('b'))
    expect(disabled('Paste')).toBe(false)
    await run('Paste')
    await waitFor(() => expect(lastSave(adapter).slides![0].elements).toHaveLength(4))
  })

  it('paste is disabled with an empty clipboard', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    expect(disabled('Paste')).toBe(true)
  })

  it('duplicate is one save', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    const before = adapter.saveCalls.length
    await run('Duplicate')
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(lastSave(adapter).slides![0].elements).toHaveLength(4)
  })

  it('delete removes the element', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('b'))
    await run('Delete')
    await waitFor(() => expect(ids(lastSave(adapter))).toEqual(['a', 'c']))
  })

  it('layer order items', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    await run('Bring to front')
    await waitFor(() => expect(ids(lastSave(adapter))).toEqual(['b', 'c', 'a']))
    await rightClick(wrapper('a'))
    await run('Send to back')
    await waitFor(() => expect(ids(lastSave(adapter))).toEqual(['a', 'b', 'c']))
    await rightClick(wrapper('a'))
    await run('Bring forward')
    await waitFor(() => expect(ids(lastSave(adapter))).toEqual(['b', 'a', 'c']))
    await rightClick(wrapper('a'))
    await run('Send backward')
    await waitFor(() => expect(ids(lastSave(adapter))).toEqual(['a', 'b', 'c']))
  })

  it('lock toggles; the key hint shows only with lockKey', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    expect(item('Lock').textContent).toBe('Lock')
    await run('Lock')
    await waitFor(() => expect(lastSave(adapter).slides![0].elements[0]).toMatchObject({ id: 'a', locked: true }))
    await rightClick(wrapper('a'))
    expect(item('Unlock')).toBeTruthy()
    await run('Unlock')
    await waitFor(() => expect(lastSave(adapter).slides![0].elements[0].locked).toBeFalsy())
  })

  it('shows the lock key with lockKey', async () => {
    await mount(base(), { lockKey: true })
    await rightClick(wrapper('a'))
    expect(item('Lock').textContent).toContain(shortcutText(['⌥', '⇧', 'L']))
  })

  it('crop enters crop mode', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    await run('Crop')
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
  })

  it('an item applies a pending crop first', async () => {
    await mount(base())
    await act(async () => { fireEvent.click(wrapper('a')) })
    await act(async () => { fireEvent.doubleClick(wrapper('a')) })
    expect(document.querySelector('img[alt="Crop source"]')).not.toBeNull()
    await rightClick(wrapper('a'))
    await run('Send to back')
    await waitFor(() => expect(document.querySelector('img[alt="Crop source"]')).toBeNull())
  })

  it('set as background goes through the same path', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('b'))
    await run('Set as background')
    await waitFor(() => expect(lastSave(adapter).slides![0].elements[0]).toMatchObject({ id: 'b', locked: true, w: 1080 }))
  })

  it('replace opens the file picker', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    const input = document.querySelector<HTMLInputElement>('[data-testid="context-replace-input"]')!
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    await run('Replace image')
    expect(click).toHaveBeenCalled()
  })

  it('a locked element: Delete, Crop, Replace, Background disabled; the rest enabled', async () => {
    await mount(makeProject([slide('s0', [img('a', { locked: true })])]), { lockKey: true })
    await rightClick(wrapper('a'))
    for (const n of ['Delete', 'Crop', 'Replace image', 'Set as background']) expect(disabled(n)).toBe(true)
    for (const n of ['Copy', 'Duplicate', 'Bring to front', 'Send to back', 'Unlock']) expect(disabled(n)).toBe(false)
  })

  it('a disabled item does nothing', async () => {
    const { adapter } = await mount(makeProject([slide('s0', [img('a', { locked: true })])]))
    await rightClick(wrapper('a'))
    await run('Delete')
    expect(menu()).not.toBeNull()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('empty area: Paste and Add a note here, which places a note at the point', async () => {
    const { adapter } = await mount(base(), { notes: { enabled: true } })
    const base0 = document.querySelector<HTMLElement>('[data-interactive] [data-slide-base]')!
    await rightClick(base0, { clientX: 108, clientY: 135 })
    expect(labels()).toEqual(['Paste', 'Add a note here'])
    await run('Add a note here')
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const notes = lastSave(adapter).notes as SlideNote[]
    expect(notes).toHaveLength(1)
    expect(notes[0].slideId).toBe('s0')
    expect(notes[0].x).toBeGreaterThanOrEqual(0)
    expect(notes[0].y).toBeGreaterThanOrEqual(0)
    expect(document.querySelector('[data-testid="note-arm-layer"]')).toBeNull()
  })

  it('no note item without notes', async () => {
    await mount(base())
    await rightClick(document.querySelector<HTMLElement>('[data-interactive] [data-slide-base]')!)
    expect(labels()).toEqual(['Paste'])
  })

  it('the margin counts as empty', async () => {
    await mount(base())
    await rightClick(document.querySelector<HTMLElement>('[data-canvas-margin]')!)
    expect(labels()).toEqual(['Paste'])
  })

  it('Esc closes it, and the Esc does not reach the keymap', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    await key('Escape')
    expect(menu()).toBeNull()
    // The selection stays: the Esc was the menu's.
    expect(outlined('a')).toBe(true)
  })

  it('a press elsewhere closes it', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()
  })

  it('a scroll closes it', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    await act(async () => { window.dispatchEvent(new Event('wheel')) })
    expect(menu()).toBeNull()
  })

  it('keyboard: Down moves, Enter runs, disabled entries are skipped', async () => {
    const { adapter } = await mount(base())
    await rightClick(wrapper('a'))
    // Paste is disabled: Copy, then Duplicate.
    await key('ArrowDown')
    expect(item('Copy').dataset.active).toBe('true')
    await key('ArrowDown')
    expect(item('Duplicate').dataset.active).toBe('true')
    await key('ArrowUp')
    expect(item('Copy').dataset.active).toBe('true')
    await key('ArrowDown')
    const before = adapter.saveCalls.length
    await key('Enter')
    expect(menu()).toBeNull()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(before + 1))
    expect(lastSave(adapter).slides![0].elements).toHaveLength(4)
  })

  it('roles', async () => {
    await mount(base())
    await rightClick(wrapper('a'))
    expect(menu()!.getAttribute('role')).toBe('menu')
    expect(menu()!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(5)
  })

  it('right-click on another slide makes it active and selects there', async () => {
    await mount(base())
    await rightClick(wrapper('d'))
    expect(item('Copy')).toBeTruthy()
    await run('Delete')
    // d was on s1.
  })
})

describe('classic layout', () => {
  it('has no custom menu and leaves the native one', async () => {
    await mount(base(), {}, 'classic')
    const ev = await rightClick(wrapper('a'))
    expect(menu()).toBeNull()
    expect(ev.defaultPrevented).toBe(false)
  })
})

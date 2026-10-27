import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'
import { isApplePlatform } from '../../ui/modifierKeys'

// §587 round 3: groups. Select several, Group (toolbar, right-click menu,
// Cmd+G); a group selects, moves, resizes and turns as one; Layers shows it as
// one row that opens; a lock covers its members; a copy is a new group.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

const img = (id: string, extra: Partial<ImageElement> = {}): ImageElement => ({ id, type: 'image', src: `/m/${id}.png`, x: 100, y: 100, w: 200, h: 200, rotation: 0, ...extra })
const txt = (id: string, extra: Partial<OverlayElement> = {}): OverlayElement => ({ id, type: 'overlay', overlay: { template: 'text', props: { text: 'Hi', fontSize: '80' } }, frame: 0, x: 400, y: 100, w: 200, h: 100, rotation: 0, ...extra })
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

async function mount(project: Project) {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" lockKey />)
  await waitFor(() => expect(document.querySelector('[data-interactive] [data-element-id]')).not.toBeNull())
  return { adapter, r }
}
const wrapper = (id: string) => {
  const els = document.querySelectorAll(`[data-interactive] [data-element-id="${id}"]`)
  return els[els.length - 1] as HTMLElement
}
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const els = (p: Project) => p.slides![0].elements
const toolbar = () => document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Element"]')
const tool = (name: string) => toolbar()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ?? null
const groupBox = () => document.querySelector<HTMLElement>('[data-group-chrome]')
const chromeOutlined = (id: string) => (document.querySelector(`[data-chrome-for="${id}"]`) as HTMLElement | null)?.style.outline.includes('solid') ?? false
// This jsdom has no PointerEvent: a MouseEvent named for it carries the keys and the point.
const pointer = (target: EventTarget, type: string, init: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
async function click(id: string, init: MouseEventInit = {}) {
  await act(async () => {
    pointer(wrapper(id), 'pointerdown', { clientX: 10, clientY: 10, ...init })
    pointer(window, 'pointerup')
    fireEvent.click(wrapper(id), init)
  })
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => { fireEvent.keyDown(document, { key: k, ...init }) })
}
const cmd = isApplePlatform() ? { metaKey: true } : { ctrlKey: true }
async function press(button: HTMLElement | null) {
  expect(button).not.toBeNull()
  await act(async () => { fireEvent.click(button!) })
}
async function undo() { await key('z', cmd) }

const two = () => makeProject([slide('s0', [img('a'), txt('b'), img('c', { x: 700, y: 700, w: 100, h: 100 })])])
const grouped = () => makeProject([slide('s0', [img('a', { group: 'g' }), txt('b', { group: 'g' }), img('c', { x: 700, y: 700, w: 100, h: 100 })])])

describe('Group and Ungroup', () => {
  it('the toolbar groups two selected elements, one undo step; the group then shows one box and Ungroup', async () => {
    const { adapter } = await mount(two())
    await click('a')
    await click('b', { shiftKey: true })
    expect(tool('Ungroup')).toBeNull()
    await press(tool('Group'))
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b, c] = els(lastSave(adapter))
    expect(typeof a.group).toBe('string')
    expect(b.group).toBe(a.group)
    expect(c.group).toBeUndefined()
    // Still selected, now as one group: its box, not two outlines.
    expect(groupBox()).not.toBeNull()
    expect(chromeOutlined('a') || chromeOutlined('b')).toBe(false)
    expect(tool('Ungroup')).not.toBeNull()
    expect(tool('Group')).toBeNull()

    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).map((e) => e.group)).toEqual([undefined, undefined, undefined])
  })

  it('Cmd+G groups and Cmd+Shift+G ungroups, each one undo step', async () => {
    const { adapter } = await mount(two())
    await click('a')
    await click('b', { shiftKey: true })
    await key('g', cmd)
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    expect(els(lastSave(adapter))[0].group).toBeTruthy()
    await key('G', { ...cmd, shiftKey: true })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).every((e) => e.group === undefined && !('group' in e))).toBe(true)
    // The members stay selected after Ungroup: each outlined again.
    expect(chromeOutlined('a') && chromeOutlined('b')).toBe(true)
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(3))
    expect(els(lastSave(adapter))[0].group).toBeTruthy()
  })

  it('Cmd+G with one element selected does nothing', async () => {
    const { adapter } = await mount(two())
    await click('a')
    await key('g', cmd)
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(0)
  })

  it('the right-click menu has Group for several and Ungroup for a group', async () => {
    const { adapter } = await mount(two())
    await click('a')
    await click('b', { shiftKey: true })
    const rightClick = async (id: string) => act(async () => { wrapper(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })) })
    const item = (name: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((e) => e.textContent!.startsWith(name))
    await rightClick('a')
    expect(item('Ungroup')).toBeUndefined()
    await act(async () => { fireEvent.click(item('Group')!) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    await rightClick('b')
    expect(item('Group')).toBeUndefined()
    await act(async () => { fireEvent.click(item('Ungroup')!) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).some((e) => e.group)).toBe(false)
  })

  it('a right-click on a member of an unselected group selects the whole group', async () => {
    await mount(grouped())
    await act(async () => { wrapper('b').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })) })
    expect(groupBox()).not.toBeNull()
  })
})

describe('selecting a group', () => {
  it('a click on any member selects the whole group', async () => {
    await mount(grouped())
    await click('b')
    expect(groupBox()).not.toBeNull()
    expect(tool('Ungroup')).not.toBeNull()
  })

  it('a Cmd-click reaches one member inside the group; a click on a sibling then stays inside', async () => {
    await mount(grouped())
    const w = wrapper('a')
    const scale = parseFloat(w.style.width) / 200
    // Inside a's box (a is under nothing).
    await act(async () => {
      pointer(w, 'pointerdown', { ...cmd, clientX: 150 * scale, clientY: 150 * scale })
      pointer(window, 'pointerup')
      fireEvent.click(w, cmd)
    })
    expect(groupBox()).toBeNull()
    expect(chromeOutlined('a')).toBe(true)
    expect(chromeOutlined('b')).toBe(false)
    await click('b')
    expect(groupBox()).toBeNull()
    expect(chromeOutlined('b')).toBe(true)
    expect(chromeOutlined('a')).toBe(false)
  })

  it('shift-click adds and takes out the whole group', async () => {
    await mount(grouped())
    await click('c')
    await click('a', { shiftKey: true })
    expect(chromeOutlined('a') && chromeOutlined('b') && chromeOutlined('c')).toBe(true)
    await click('b', { shiftKey: true })
    expect(chromeOutlined('a') || chromeOutlined('b')).toBe(false)
    expect(chromeOutlined('c')).toBe(true)
  })
})

describe('group gestures', () => {
  it('dragging a member moves the whole group by one delta, one undo step', async () => {
    const { adapter } = await mount(grouped())
    await act(async () => {
      pointer(wrapper('a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 160, clientY: 190 })
      pointer(window, 'pointerup')
      fireEvent.click(wrapper('a'))
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b, c] = els(lastSave(adapter))
    const dx = a.x - 100
    const dy = a.y - 100
    expect(dx).toBeGreaterThan(0)
    expect([b.x - 400, b.y - 100]).toEqual([dx, dy])
    expect([c.x, c.y]).toEqual([700, 700])
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).map((e) => [e.x, e.y])).toEqual([[100, 100], [400, 100], [700, 700]])
  })

  it('a corner of the group box scales every member and its text, one undo step', async () => {
    const { adapter } = await mount(grouped())
    await click('a')
    const scale = parseFloat(wrapper('a').style.width) / 200
    // The group box: x 100..600, y 100..300. Drag se by +250 x +100 slide px: the ratio holds (1.5).
    const h = groupBox()!.querySelector('[data-testid="group-resize-handle-se"]')!
    await act(async () => {
      pointer(h, 'pointerdown', { clientX: 0, clientY: 0 })
      pointer(window, 'pointermove', { clientX: 250 * scale, clientY: 100 * scale })
      pointer(window, 'pointerup')
    })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b] = els(lastSave(adapter)) as [ImageElement, OverlayElement]
    expect([a.x, a.y, a.w, a.h]).toEqual([100, 100, 300, 300])
    expect([b.x, b.y, b.w, b.h]).toEqual([550, 100, 300, 150])
    expect(b.overlay.props.fontSize).toBe('120')
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    const [ua, ub] = els(lastSave(adapter)) as [ImageElement, OverlayElement]
    expect([ua.w, ub.w, ub.overlay.props.fontSize]).toEqual([200, 200, '80'])
  })

  it('the rotate handle turns every member about the mean of their centres, one undo step', async () => {
    const { adapter } = await mount(grouped())
    await click('a')
    const scale = parseFloat(wrapper('a').style.width) / 200
    // The box is x 100..600, y 100..300; the pivot is the mean of the centres
    // (200, 200) and (500, 150): (350, 175). jsdom lays nothing out, so the box
    // sits at (0, 0) on screen and the pivot at (250, 75) slide px from there.
    const px = 250 * scale
    const py = 75 * scale
    const h = groupBox()!.querySelector('[data-testid="group-rotate-handle"]')!
    // From above the pivot to its right is a quarter turn.
    await act(async () => {
      pointer(h, 'pointerdown', { clientX: px, clientY: py - 100 })
      pointer(window, 'pointermove', { clientX: px + 100, clientY: py })
    })
    // The previewed box turns about the pivot too.
    expect(groupBox()!.style.transformOrigin).toBe(`${px}px ${py}px`)
    await act(async () => { pointer(window, 'pointerup') })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b] = els(lastSave(adapter))
    expect([a.rotation, b.rotation]).toEqual([90, 90])
    // a's centre (200, 200) goes to (325, 25); b's (500, 150) to (375, 325).
    expect([a.x + a.w / 2, a.y + a.h / 2]).toEqual([325, 25])
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([375, 325])
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).map((e) => e.rotation)).toEqual([0, 0, 0])
  })
})

describe('a hidden member', () => {
  it('stays in the group but out of its box', async () => {
    const p = grouped()
    const adapter = makeAdapter(p)
    render(<CarouselEditor project={p} adapter={adapter} onProjectChange={vi.fn()} layout="rail" lockKey hiddenElementIds={['b']} />)
    await waitFor(() => expect(document.querySelector('[data-interactive] [data-element-id]')).not.toBeNull())
    await click('a')
    const scale = parseFloat(wrapper('a').style.width) / 200
    expect(groupBox()).not.toBeNull()
    // a alone: 200 x 200 at (100, 100); b (400..600) is not in it.
    expect(parseFloat(groupBox()!.style.width)).toBeCloseTo(200 * scale)
    expect(parseFloat(groupBox()!.style.height)).toBeCloseTo(200 * scale)
  })
})

describe('lock, copies and delete', () => {
  it('Lock on a group locks every member: no handles, no move, no Ungroup; the badge unlocks all of it in one step', async () => {
    const { adapter } = await mount(grouped())
    await click('a')
    await press(tool('Lock'))
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    expect(els(lastSave(adapter)).slice(0, 2).every((e) => e.locked === true)).toBe(true)
    expect(groupBox()!.querySelector('[data-testid^="group-resize-handle"]')).toBeNull()
    expect(tool('Ungroup')!.disabled).toBe(true)
    await key('G', { ...cmd, shiftKey: true })
    await act(async () => {
      pointer(wrapper('a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 200, clientY: 200 })
      pointer(window, 'pointerup')
    })
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(1)
    await act(async () => { fireEvent.click(groupBox()!.querySelector('[data-testid="lock-badge"]')!) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).some((e) => e.locked)).toBe(false)
  })

  it('a locked member holds the whole group in place', async () => {
    const p = grouped()
    p.slides![0].elements[1] = { ...p.slides![0].elements[1], locked: true }
    const { adapter } = await mount(p)
    await act(async () => {
      pointer(wrapper('a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 200, clientY: 200 })
      pointer(window, 'pointerup')
    })
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(0)
  })

  const lockedB = () => {
    const p = grouped()
    p.slides![0].elements[1] = { ...p.slides![0].elements[1], locked: true }
    return p
  }
  const enter = async (id: string) => {
    const w = wrapper(id)
    const scale = parseFloat(w.style.width) / 200
    await act(async () => {
      pointer(w, 'pointerdown', { ...cmd, clientX: 150 * scale, clientY: 150 * scale })
      pointer(window, 'pointerup')
      fireEvent.click(w, cmd)
    })
  }

  it('arrow keys move no member of a group with a locked member', async () => {
    const { adapter } = await mount(lockedB())
    await click('a')
    await click('c', { shiftKey: true })
    await key('ArrowRight')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b, c] = els(lastSave(adapter))
    expect([a.x, b.x, c.x]).toEqual([100, 400, 701])
  })

  it('arrow keys move nothing for one member entered in a group with a locked member', async () => {
    const { adapter } = await mount(lockedB())
    await enter('a')
    expect(chromeOutlined('a')).toBe(true)
    await key('ArrowRight')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(0)
  })

  it('Delete removes no member of a group with a locked member', async () => {
    const { adapter } = await mount(lockedB())
    await click('a')
    await click('c', { shiftKey: true })
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    expect(els(lastSave(adapter)).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('Delete on one entered member of a group with a locked member does nothing', async () => {
    const { adapter } = await mount(lockedB())
    await enter('a')
    await key('Delete')
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(0)
  })

  it('Align moves no member of a group with a locked member', async () => {
    const { adapter, r } = await mount(lockedB())
    await click('a')
    await click('c', { shiftKey: true })
    await act(async () => { fireEvent.click(within(toolbar()!).getByRole('button', { name: 'Position' })) })
    // The covered box is x 100..800: centred, a free a would go to 350 and c goes to 400.
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Align center' })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const [a, b, c] = els(lastSave(adapter))
    expect([a.x, b.x, c.x]).toEqual([100, 400, 400])
  })

  it('a drag of one entered member of a group with a locked member moves nothing', async () => {
    const { adapter } = await mount(lockedB())
    await enter('a')
    await act(async () => {
      pointer(wrapper('a'), 'pointerdown', { clientX: 100, clientY: 100 })
      pointer(window, 'pointermove', { clientX: 200, clientY: 200 })
      pointer(window, 'pointerup')
      fireEvent.click(wrapper('a'))
    })
    await act(async () => {})
    expect(adapter.saveCalls.length).toBe(0)
  })

  it('Cmd+D on a group makes a new group in front of it, one undo step', async () => {
    const { adapter } = await mount(grouped())
    await click('a')
    await key('d', cmd)
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const all = els(lastSave(adapter))
    expect(all).toHaveLength(5)
    const copies = all.filter((e) => !['a', 'b', 'c'].includes(e.id))
    expect(copies).toHaveLength(2)
    expect(copies[0].group).toBe(copies[1].group)
    expect(copies[0].group).not.toBe('g')
    // The copies are next to each other, in front of the original group.
    expect(all.map((e) => e.group ?? '-')).toEqual(['g', 'g', copies[0].group, copies[0].group, '-'])
    // The copy is selected, as its own group.
    expect(groupBox()).not.toBeNull()
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter))).toHaveLength(3)
  })

  it('Delete of one member leaves the other out of any group, in the same undo step', async () => {
    const { adapter } = await mount(grouped())
    await enter('a')
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    const left = els(lastSave(adapter))
    expect(left.map((e) => e.id)).toEqual(['b', 'c'])
    expect(left.some((e) => 'group' in e)).toBe(false)
    await click('b')
    expect(groupBox()).toBeNull()
    await undo()
    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    expect(els(lastSave(adapter)).map((e) => [e.id, e.group ?? '-'])).toEqual([['a', 'g'], ['b', 'g'], ['c', '-']])
  })

  it('a group of one shows no group box', async () => {
    const p = grouped()
    p.slides![0].elements.splice(0, 1)
    await mount(p)
    await click('b')
    expect(groupBox()).toBeNull()
    expect(chromeOutlined('b')).toBe(true)
  })

  it('Delete removes the whole group, one undo step', async () => {
    const { adapter } = await mount(grouped())
    await click('b')
    await key('Delete')
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    expect(els(lastSave(adapter)).map((e) => e.id)).toEqual(['c'])
  })
})

describe('the editor never scatters a group', () => {
  it('the classic panel\'s Bring forward on the front member keeps the group together', async () => {
    const p = grouped()
    const adapter = makeAdapter(p)
    const r = render(<CarouselEditor project={p} adapter={adapter} onProjectChange={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('[data-interactive] [data-element-id]')).not.toBeNull())
    const w = wrapper('b')
    const scale = parseFloat(w.style.width) / 200
    await act(async () => {
      pointer(w, 'pointerdown', { ...cmd, clientX: 450 * scale, clientY: 150 * scale })
      pointer(window, 'pointerup')
      fireEvent.click(w, cmd)
    })
    expect(r.queryByTitle('Bring forward')).not.toBeNull()
    await act(async () => { fireEvent.click(r.getByTitle('Bring forward')) })
    await act(async () => {})
    for (const call of adapter.saveCalls) {
      const groups = els(call.project).map((e) => e.group ?? '-')
      expect(groups.join('')).toMatch(/^-*g*-*$/)
    }
  })
})

describe('Layers', () => {
  const openLayers = async (r: ReturnType<typeof render>) => {
    await act(async () => { fireEvent.click(within(r.getByRole('navigation', { name: 'Editor rail' })).getByRole('button', { name: 'Layers' })) })
  }
  const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>('[data-layer-id]')).map((e) => e.dataset.layerId)

  it('a group is one row that opens to its members; the row selects the group, a member row one member', async () => {
    const { r } = await mount(grouped())
    await openLayers(r)
    expect(rowIds()).toEqual(['c', 'group:g'])
    const groupRow = document.querySelector<HTMLElement>('[data-layer-id="group:g"]')!
    await act(async () => { fireEvent.click(within(groupRow).getByRole('button', { name: 'Expand' })) })
    expect(rowIds()).toEqual(['c', 'group:g', 'b', 'a'])
    await act(async () => { fireEvent.click(within(groupRow).getByRole('button', { name: 'Select Group' })) })
    expect(groupBox()).not.toBeNull()
    const memberRow = document.querySelector<HTMLElement>('[data-layer-id="a"]')!
    await act(async () => { fireEvent.click(within(memberRow).getByRole('button', { name: /^Select/ })) })
    expect(groupBox()).toBeNull()
    expect(chromeOutlined('a')).toBe(true)
  })

  it('a group of one is a plain row', async () => {
    const p = grouped()
    p.slides![0].elements.splice(0, 1)
    const { r } = await mount(p)
    await openLayers(r)
    expect(rowIds()).toEqual(['c', 'b'])
  })

  it('the group row\'s lock locks every member in one step', async () => {
    const { r, adapter } = await mount(grouped())
    await openLayers(r)
    const groupRow = document.querySelector<HTMLElement>('[data-layer-id="group:g"]')!
    await act(async () => { fireEvent.click(within(groupRow).getByRole('button', { name: 'Lock Group' })) })
    await waitFor(() => expect(adapter.saveCalls.length).toBe(1))
    expect(els(lastSave(adapter)).map((e) => e.locked === true)).toEqual([true, true, false])
  })
})

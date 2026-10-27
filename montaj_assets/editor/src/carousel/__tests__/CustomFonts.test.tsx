import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { CustomFont, EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

// §587 r3: your own fonts. The upload lives in the host's Library; the font
// menu has one "Add your fonts" item that hands off to the host, and the
// host's fonts lead the list.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function textEl(id: string, y: number, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'overlay', frame: 0, x: 300, y, w: 400, h: 100, rotation: 0,
    ...extra,
    overlay: {
      template: '/overlays/text.jsx',
      props: { text: 'Hello', fontFamily: '"Inter", system-ui, sans-serif', fontSize: '32px', color: '#111111', fontWeight: '400', fontStyle: 'normal', textAlign: 'left' },
    },
  }
}

function makeProject(slide1: Record<string, unknown>[] = [textEl('el-u', 300)]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [
      { id: 'slide-0', base_color: '#ffffff', elements: [textEl('el-t', 700), textEl('el-locked', 400, { locked: true })] },
      { id: 'slide-1', base_color: '#ff0000', elements: slide1 },
    ],
  } as Project
}

function makeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  } as FakeAdapter
}

const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  vi.restoreAllMocks()
  if (pointerCapture) Object.defineProperty(Element.prototype, 'setPointerCapture', pointerCapture)
  else delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
})

async function mount(extra: Partial<React.ComponentProps<typeof CarouselEditor>> = {}, project: Project = makeProject()) {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" {...extra} />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-t"]')).not.toBeNull())
  return { adapter, r }
}

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const byId = (p: Project, id: string) => p.slides!.flatMap((s) => s.elements).find((e) => e.id === id)!
const propsOf = (p: Project, id: string) => (byId(p, id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props
const filesOf = (p: Project, id: string) => (byId(p, id) as unknown as { fontFiles?: unknown }).fontFiles
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
async function click(id: string) { await act(async () => { fireEvent.click(wrapperOf(id)) }) }
async function press(button: HTMLElement) { await act(async () => { fireEvent.click(button) }) }
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true, ...init })) })
}
const tb = (r: ReturnType<typeof render>, name: string) => within(r.getByRole('toolbar', { name: 'Element' })).getByRole('button', { name }) as HTMLButtonElement
const listbox = (r: ReturnType<typeof render>) => r.getByRole('listbox')

const FONTS: CustomFont[] = [
  { family: 'Brand Sans', url: '/fonts/brand-sans.ttf', src: '/lib/brand-sans.ttf' },
  { family: 'Acme Serif', url: '/fonts/acme.otf', src: '/lib/acme.otf' },
]
const BRAND = { fonts: { heading: '"Poppins", system-ui, sans-serif', googleFonts: ['Poppins:wght@400;700'] } }

describe('Your own fonts (§587 r3)', () => {
  it('"Add your fonts" calls the host, and closes the menu', async () => {
    const onAddFonts = vi.fn()
    const { r } = await mount({ onAddFonts })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('button', { name: 'Add your fonts' }))
    expect(onAddFonts).toHaveBeenCalledTimes(1)
    expect(r.queryByRole('listbox')).toBeNull()
  })

  it('no "Add your fonts" without the host callback', async () => {
    const { r } = await mount({ customFonts: FONTS })
    await click('el-t')
    await press(tb(r, 'Font family'))
    expect(within(listbox(r)).queryByRole('button', { name: 'Add your fonts' })).toBeNull()
  })

  it('the host fonts lead the list, after Use brand default, each in its own face', async () => {
    const { r } = await mount({ customFonts: FONTS, brand: BRAND })
    await click('el-t')
    await press(tb(r, 'Font family'))
    const options = within(listbox(r)).getAllByRole('option')
    expect(options.slice(0, 4).map((o) => o.textContent)).toEqual(['Use brand default', 'Brand Sans', 'Acme Serif', 'System'])
    expect((options[1] as HTMLElement).style.fontFamily).toContain('Brand Sans')
  })

  it('picking one writes the family and its file in one save and one undo step', async () => {
    const { adapter, r } = await mount({ customFonts: FONTS })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Brand Sans' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').fontFamily).toBe('"Brand Sans", system-ui, sans-serif')
    expect(filesOf(last(adapter), 'el-t')).toEqual([{ family: 'Brand Sans', src: '/lib/brand-sans.ttf' }])
    // The button names the picked family.
    expect(tb(r, 'Font family').textContent).toContain('Brand Sans')
    await key('z', { metaKey: true })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(propsOf(last(adapter), 'el-t').fontFamily).toBe('"Inter", system-ui, sans-serif')
    expect(filesOf(last(adapter), 'el-t')).toBeUndefined()
  })

  it('importFont: the host turns the pick into the file the project keeps', async () => {
    const importFont = vi.fn(async (f: CustomFont) => `/proj/${f.family}.ttf`)
    const { adapter, r } = await mount({ customFonts: FONTS, importFont })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Acme Serif' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(importFont).toHaveBeenCalledWith(FONTS[1])
    expect(filesOf(last(adapter), 'el-t')).toEqual([{ family: 'Acme Serif', src: '/proj/Acme Serif.ttf' }])
  })

  it('a family the project already holds a file for reuses it: no second import', async () => {
    const importFont = vi.fn(async () => '/proj/new.ttf')
    const held = textEl('el-u', 300, { fontFiles: [{ family: 'Brand Sans', src: '/proj/brand-sans.ttf' }] })
    const { adapter, r } = await mount({ customFonts: FONTS, importFont }, makeProject([held]))
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Brand Sans' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(importFont).not.toHaveBeenCalled()
    expect(filesOf(last(adapter), 'el-t')).toEqual([{ family: 'Brand Sans', src: '/proj/brand-sans.ttf' }])
  })

  it('a failed import writes nothing', async () => {
    const importFont = vi.fn(async () => { throw new Error('nope') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { adapter, r } = await mount({ customFonts: FONTS, importFont })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Brand Sans' }))
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
  })

  it('a list pick after a custom font drops the file', async () => {
    const { adapter, r } = await mount({ customFonts: FONTS })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Brand Sans' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Lato' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(2))
    expect(filesOf(last(adapter), 'el-t')).toBeUndefined()
  })

  it('malformed fontFiles on another element never break a pick', async () => {
    const importFont = vi.fn(async (f: CustomFont) => `/proj/${f.family}.ttf`)
    const held = textEl('el-u', 300, { fontFiles: [null, { family: 3 }, 'x', { family: 'Brand Sans' }] })
    const { adapter, r } = await mount({ customFonts: FONTS, importFont }, makeProject([held]))
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Brand Sans' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(importFont).toHaveBeenCalledTimes(1)
    expect(filesOf(last(adapter), 'el-t')).toEqual([{ family: 'Brand Sans', src: '/proj/Brand Sans.ttf' }])
  })

  it('a slow import never overwrites a later pick', async () => {
    let finish!: (src: string) => void
    const importFont = vi.fn(() => new Promise<string>((res) => { finish = res }))
    const { adapter, r } = await mount({ customFonts: FONTS, importFont })
    await click('el-t')
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Acme Serif' }))
    await press(tb(r, 'Font family'))
    await press(within(listbox(r)).getByRole('option', { name: 'Lato' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    await act(async () => { finish('/proj/acme.otf') })
    await settle()
    expect(adapter.saveCalls).toHaveLength(1)
    expect(String(propsOf(last(adapter), 'el-t').fontFamily)).toContain('Lato')
    expect(filesOf(last(adapter), 'el-t')).toBeUndefined()
  })

  it('a locked element keeps its font', async () => {
    const { adapter, r } = await mount({ customFonts: FONTS, onAddFonts: vi.fn() })
    await click('el-locked')
    expect(tb(r, 'Font family').disabled).toBe(true)
    await settle()
    expect(adapter.saveCalls).toHaveLength(0)
  })
})

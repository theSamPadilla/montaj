import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../types'
import CarouselEditor from '../CarouselEditor'

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})
vi.mock('../photoColours', () => ({ photoColoursOf: vi.fn(async () => []) }))

// §587 round 3: a word or range inside a text box gets its own colour, bold,
// italic or underline. With text selected in the inline editor the toolbar's
// style buttons style that range alone (the element's `runs`); with none they
// style the whole element, as before.

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

const TEMPLATE = '/rt/render/templates/overlays/static-text/static-text.jsx'

function textEl(id: string, y: number, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id, type: 'overlay', frame: 0, x: 200, y, w: 600, h: 120, rotation: 0, ...extra,
    overlay: { template: TEMPLATE, props: { text: 'Make it red', fontSize: '48', color: '#111111', fontWeight: '400', fontStyle: 'normal', textAlign: 'left', ...props } },
  }
}

function makeProject(): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [],
    slides: [{
      id: 'slide-0', base_color: '#ffffff',
      elements: [
        textEl('el-t', 200),
        textEl('el-runs', 500, { text: 'ab cd', runs: '[{"t":"ab "},{"t":"cd","c":"#ff0000","b":1}]' }),
      ],
    }],
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

async function mount() {
  const adapter = makeAdapter()
  const r = render(<CarouselEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(document.querySelector('[data-element-id="el-t"]')).not.toBeNull())
  return { adapter, r }
}

const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }
const last = (a: FakeAdapter) => a.saveCalls[a.saveCalls.length - 1].project
const propsOf = (p: Project, id: string) =>
  (p.slides![0].elements.find((e) => e.id === id) as unknown as { overlay: { props: Record<string, unknown> } }).overlay.props
const toolbar = (r: ReturnType<typeof render>) => r.getByRole('toolbar', { name: 'Element' })
const tb = (r: ReturnType<typeof render>, name: string) => within(toolbar(r)).getByRole('button', { name }) as HTMLButtonElement
const editorOf = (r: ReturnType<typeof render>) => r.getByRole('textbox', { name: 'Edit text' })
async function press(button: HTMLElement) { await act(async () => { fireEvent.click(button) }) }

async function edit(r: ReturnType<typeof render>, id: string) {
  await act(async () => { fireEvent.click(wrapperOf(id)) })
  await act(async () => { fireEvent.doubleClick(wrapperOf(id)) })
  return editorOf(r)
}

/** The DOM point `index` chars into `root`'s text. */
function pointAt(root: HTMLElement, index: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n as Text).data.length
    if (index <= seen + len) return [n, index - seen]
    seen += len
  }
  return [root, root.childNodes.length]
}

/** Selects `word` in the editor as a person would, and lets the editor see it. */
async function selectWord(editor: HTMLElement, word: string) {
  const start = editor.textContent!.indexOf(word)
  expect(start).toBeGreaterThanOrEqual(0)
  const range = document.createRange()
  range.setStart(...pointAt(editor, start))
  range.setEnd(...pointAt(editor, start + word.length))
  await act(async () => {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

/** The editor span drawing `word`. */
const spanOf = (editor: HTMLElement, word: string) =>
  Array.from(editor.querySelectorAll('span')).find((s) => s.textContent === word) as HTMLElement | undefined

describe('Styled runs from the inline editor (§587 round 3)', () => {
  it('Bold with a word selected bolds that word alone, in one save, and the editor shows it', async () => {
    const { adapter, r } = await mount()
    const editor = await edit(r, 'el-t')
    await selectWord(editor, 'red')
    expect(tb(r, 'Bold').getAttribute('aria-pressed')).toBe('false')

    await press(tb(r, 'Bold'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const props = propsOf(last(adapter), 'el-t')
    expect(props.runs).toBe('[{"t":"Make it "},{"t":"red","b":1}]')
    expect(props.text).toBe('Make it red')
    expect(props.fontWeight).toBe('400')
    // Still editing, the word drawn bold, the button on for the range.
    expect(editorOf(r)).toBe(editor)
    expect(spanOf(editor, 'red')?.style.fontWeight).toBe('700')
    expect(tb(r, 'Bold').getAttribute('aria-pressed')).toBe('true')
  })

  it('the text colour with a word selected colours that word alone', async () => {
    const { adapter, r } = await mount()
    const editor = await edit(r, 'el-t')
    await selectWord(editor, 'red')
    await press(tb(r, 'Text color'))
    const panel = r.getByRole('region', { name: 'Colour panel' })
    await press(within(panel).getByRole('button', { name: 'Default color #ef4444' }))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const props = propsOf(last(adapter), 'el-t')
    expect(props.runs).toBe('[{"t":"Make it "},{"t":"red","c":"#ef4444"}]')
    expect(props.color).toBe('#111111')
    expect(spanOf(editor, 'red')?.style.color).toBe('rgb(239, 68, 68)')
  })

  it('Underline with a word selected underlines it', async () => {
    const { adapter, r } = await mount()
    const editor = await edit(r, 'el-t')
    await selectWord(editor, 'it')
    await press(tb(r, 'Underline'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    expect(propsOf(last(adapter), 'el-t').runs).toBe('[{"t":"Make "},{"t":"it","u":1},{"t":" red"}]')
  })

  it('with no selection, Bold styles the whole element as before', async () => {
    const { adapter, r } = await mount()
    await act(async () => { fireEvent.click(wrapperOf('el-t')) })
    await press(tb(r, 'Bold'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const props = propsOf(last(adapter), 'el-t')
    expect(props.fontWeight).toBe('700')
    expect(props.runs).toBeUndefined()
  })

  it('with no selection, Bold on an element with runs bolds all of it and clears each run\'s bold', async () => {
    const { adapter, r } = await mount()
    await act(async () => { fireEvent.click(wrapperOf('el-runs')) })
    await press(tb(r, 'Bold'))
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const props = propsOf(last(adapter), 'el-runs')
    expect(props.fontWeight).toBe('700')
    expect(props.runs).toBe('[{"t":"ab "},{"t":"cd","c":"#ff0000"}]')
  })

  it('the editor opens with the element\'s runs drawn, and typing inside a styled word keeps it styled', async () => {
    const { adapter, r } = await mount()
    const editor = await edit(r, 'el-runs')
    expect(spanOf(editor, 'cd')?.style.color).toBe('rgb(255, 0, 0)')
    // Type an "x" between c and d, as the browser does: into that span's text.
    const text = spanOf(editor, 'cd')!.firstChild as Text
    await act(async () => {
      text.data = 'cxd'
      const sel = window.getSelection()!
      const range = document.createRange()
      range.setStart(text, 2)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      fireEvent.input(editor)
    })
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const props = propsOf(last(adapter), 'el-runs')
    expect(props.text).toBe('ab cxd')
    expect(props.runs).toBe('[{"t":"ab "},{"t":"cxd","c":"#ff0000","b":1}]')
  })
})

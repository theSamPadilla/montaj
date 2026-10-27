import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, fireEvent, screen, within } from '@testing-library/react'
import type { EditorAdapter, GlobalOverlay, ImageElement, OverlayElement, Project, RenderEvent, Slide } from '../../types'
import CarouselEditor from '../CarouselEditor'

// §587 round 2, F-I: the fuller shape set in the Elements panel, listed from
// the real sidecars as serve lists them: the sections in order, a click on a
// tile of each new section, and the toolbar's swatch and Stroke button on the
// new templates.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn(async () => null) }
})

type Sidecar = Omit<GlobalOverlay, 'name' | 'jsxPath'>
const FILES = import.meta.glob('../../../../render/templates/overlays/*/*.json', { eager: true, import: 'default' }) as Record<string, Sidecar>
const jsx = (name: string) => `/rt/render/templates/overlays/${name}/${name}.jsx`
// As serve lists them: sorted by folder name, the sidecar's fields, its jsx path.
const SYSTEM: GlobalOverlay[] = Object.entries(FILES)
  .flatMap(([p, s]) => {
    const [dir, file] = p.split('/').slice(-2)
    return file === `${dir}.json` ? [{ ...s, name: dir, jsxPath: jsx(dir) } as GlobalOverlay] : []
  })
  .sort((a, b) => a.name.localeCompare(b.name))
const byName = (name: string) => SYSTEM.find((o) => o.name === name)!

const img = (id: string): ImageElement => ({ id, type: 'image', src: `${id}.png`, x: 100, y: 100, w: 200, h: 200, rotation: 0 })
const placed = (name: string, x: number, y: number): OverlayElement => ({
  id: `el-${name}`, type: 'overlay', frame: 59, x, y, w: 120, h: 120, rotation: 0,
  overlay: { template: jsx(name), props: Object.fromEntries(byName(name).props.filter((p) => p.default !== undefined).map((p) => [p.name, p.default])) },
})
function makeProject(elements: Slide['elements'] = [img('el-0')]): Project {
  return {
    version: '1', id: 'proj-1', name: 'Test', workflow: 'carousel', status: 'draft', editingPrompt: '',
    projectType: 'carousel', settings: { resolution: [1080, 1080] }, assets: [], slides: [{ id: 's0', base_color: '#ffffff', elements }],
  } as Project
}

function makeAdapter(initial: Project) {
  const saveCalls: Array<{ id: string; project: Project }> = []
  const adapter: EditorAdapter<Project> & { saveCalls: typeof saveCalls } = {
    loadProject: vi.fn(async () => initial),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.png' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => SYSTEM),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    saveCalls,
  }
  return adapter
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => { vi.restoreAllMocks() })

async function mount(project = makeProject()) {
  const adapter = makeAdapter(project)
  const r = render(<CarouselEditor project={project} adapter={adapter} onProjectChange={vi.fn()} layout="rail" />)
  await waitFor(() => expect(document.querySelectorAll('[data-slide-section]').length).toBe(1))
  await act(async () => {})
  return { adapter, r }
}
const openRail = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) })) }) }
const panel = () => screen.getByRole('region', { name: 'Elements panel' })
const tile = (name: string) => within(panel()).findByRole('button', { name })
const lastSave = (a: ReturnType<typeof makeAdapter>) => a.saveCalls[a.saveCalls.length - 1].project
const overlays = (p: Project) => p.slides![0].elements.filter((e) => e.type === 'overlay') as OverlayElement[]
const wrapperOf = (id: string) => { const els = document.querySelectorAll(`[data-element-id="${id}"]`); return els[els.length - 1] as HTMLElement }

const SECTIONS = ['Shapes', 'Arrows', 'Lines', 'Frames', 'Callouts']
const NEW_TILES: Record<string, string[]> = {
  Shapes: ['Heart', 'Diamond', 'Hexagon', 'Octagon', 'Pill', 'Semicircle', 'Ring', 'Plus', 'Cross', 'X', 'Checkmark', 'Blob 1', 'Blob 2', 'Blob 3', 'Blob 4'],
  Arrows: ['Arrow', 'Double arrow', 'Curved arrow', 'Chevron'],
  Lines: ['Dot line', 'Bar line'],
  Callouts: ['Speech bubble', 'Speech box', 'Callout', 'Thought bubble'],
}

describe('Elements panel: the fuller shape set (§587 F-I)', () => {
  it('the sections sit in order: Shapes, Arrows, Lines, Frames, Callouts, each with its tiles', async () => {
    await mount()
    await openRail('Elements')
    await tile('Heart')
    const headings = within(panel()).getAllByRole('heading').map((h) => h.textContent).filter((t) => SECTIONS.includes(t ?? ''))
    expect(headings).toEqual(SECTIONS)
    for (const [section, names] of Object.entries(NEW_TILES)) {
      const box = within(panel()).getByRole('heading', { name: section }).closest('section') as HTMLElement
      for (const name of names) expect(within(box).getByRole('button', { name }), `${section}: ${name}`).toBeTruthy()
    }
    // The block arrow is in Arrows, not Shapes; the arrow line is a line.
    const shapes = within(panel()).getByRole('heading', { name: 'Shapes' }).closest('section') as HTMLElement
    expect(within(shapes).queryByRole('button', { name: 'Arrow' })).toBeNull()
    const lines = within(panel()).getByRole('heading', { name: 'Lines' }).closest('section') as HTMLElement
    expect(within(lines).getByRole('button', { name: 'Arrow line' })).toBeTruthy()
  })

  it('the Shapes section opens on the basics, in order', async () => {
    await mount()
    await openRail('Elements')
    await tile('Heart')
    const shapes = within(panel()).getByRole('heading', { name: 'Shapes' }).closest('section') as HTMLElement
    const labels = within(shapes).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(labels.slice(0, 4)).toEqual(['Rectangle', 'Rounded rectangle', 'Ellipse', 'Triangle'])
    expect(labels.slice(-4)).toEqual(['Blob 1', 'Blob 2', 'Blob 3', 'Blob 4'])
  })

  it.each([
    ['Heart', 'shape-heart', [432, 432]],
    ['Pill', 'shape-pill', [432, 216]],
    ['Curved arrow', 'arrow-curved', [432, 270]],
    ['Dot line', 'line-dot-ends', [648, 54]],
    ['Speech bubble', 'callout-speech-round', [432, 346]],
  ] as const)('a click on %s adds it to the slide with its defaults, centred, in its box', async (label, name, box) => {
    const { adapter } = await mount()
    await openRail('Elements')
    await act(async () => { fireEvent.click(await tile(label)) })
    await waitFor(() => expect(adapter.saveCalls).toHaveLength(1))
    const [o] = overlays(lastSave(adapter))
    expect(o.overlay.template).toBe(jsx(name))
    const defaults = Object.fromEntries(byName(name).props.filter((p) => p.default !== undefined).map((p) => [p.name, p.default]))
    expect(o.overlay.props).toEqual(defaults)
    expect([o.w, o.h]).toEqual(box)
    expect([Math.round(o.x + o.w / 2), Math.round(o.y + o.h / 2)]).toEqual([540, 540])
  })
})

describe('Element toolbar on the new templates (§587 F-I)', () => {
  const NAMES = ['shape-heart', 'shape-ring', 'arrow-curved', 'line-bar-ends', 'callout-speech-rect', 'shape-blob-2']
  const project = () => makeProject([img('el-0'), ...NAMES.map((n, i) => placed(n, 20 + (i % 3) * 300, 400 + Math.floor(i / 3) * 300))])

  it('each shows the colour swatch and the Stroke button; a capped line also its arrow toggles', async () => {
    const { r } = await mount(project())
    for (const name of NAMES) {
      await act(async () => { fireEvent.click(wrapperOf(`el-${name}`)) })
      const bar = r.getByRole('toolbar', { name: 'Element' })
      expect(within(bar).queryByRole('button', { name: 'Stroke' }), name).not.toBeNull()
      expect(bar.querySelector('[data-colour-swatch]'), name).not.toBeNull()
      const arrows = within(bar).queryByRole('button', { name: 'End arrow' })
      if (name.startsWith('line-')) expect(arrows, name).not.toBeNull()
      else expect(arrows, name).toBeNull()
    }
  })

  it('the swatch opens on a filled shape\'s fill and a line\'s stroke', async () => {
    const { r } = await mount(project())
    await act(async () => { fireEvent.click(wrapperOf('el-shape-heart')) })
    expect(r.getByRole('toolbar', { name: 'Element' }).querySelector('[data-colour-swatch]')?.closest('button')?.getAttribute('title')).toBe('Fill color')
    await act(async () => { fireEvent.click(wrapperOf('el-line-bar-ends')) })
    expect(r.getByRole('toolbar', { name: 'Element' }).querySelector('[data-colour-swatch]')?.closest('button')?.getAttribute('title')).toBe('Stroke color')
  })
})

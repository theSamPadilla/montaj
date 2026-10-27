// The page `groups.test.mjs` drives in a real browser (§587 round 3, groups).
//
// The real CarouselEditor in the rail layout, on one slide with a photo, the
// shipped shape-rect overlay and a static-text box, plus a fourth element out
// of the way. The overlays are the real templates from render/templates/overlays,
// called as the host's compiler calls them. The editor's latest project is kept
// on `window.__project`.
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, OverlayFactory, Project, RenderEvent } from '../../src/types'
import ShapeRect from '../../../render/templates/overlays/shape-rect/shape-rect.jsx'
import StaticText from '../../../render/templates/overlays/static-text/static-text.jsx'

type Template = (props: Record<string, unknown>) => React.ReactElement | null
const TEMPLATES: Record<string, Template> = {
  'shape-rect': ShapeRect as Template,
  'static-text': StaticText as Template,
}

const photo = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#3a3"/></svg>',
)}`
const image = (id: string, extra: Partial<ImageElement>): ImageElement =>
  ({ id, type: 'image', src: photo, x: 0, y: 0, w: 300, h: 300, rotation: 0, ...extra })
const overlay = (id: string, template: string, box: { x: number; y: number; w: number; h: number }, props: Record<string, unknown>): OverlayElement =>
  ({ id, type: 'overlay', ...box, rotation: 0, overlay: { template: `/rt/render/templates/overlays/${template}/${template}.jsx`, props } }) as OverlayElement

const project = {
  version: '1', id: 'p', name: 'Groups', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{
    id: 's0', base_color: '#ffffff', elements: [
      image('img', { x: 100, y: 120, w: 300, h: 300 }),
      overlay('rect', 'shape-rect', { x: 460, y: 160, w: 300, h: 200 }, { fill: '#bdbdbd', stroke: '#111111', strokeWidth: '6' }),
      overlay('text', 'static-text', { x: 100, y: 480, w: 400, h: 160 }, { text: 'Hi there', fontSize: '80', textAlign: 'left' }),
      image('far', { x: 700, y: 1000, w: 200, h: 200 }),
    ],
  }],
} as Project

declare global {
  interface Window {
    __project: Project | null
    __ready: boolean
  }
}
window.__project = null

const adapter: EditorAdapter<Project> = {
  loadProject: async () => project,
  saveProject: async () => {},
  subscribe: () => () => {},
  render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/o.png' } },
  resolveImageSrc: (el: ImageElement) => el.src,
  compileOverlay: async (template: string): Promise<OverlayFactory> => {
    const name = template.split('/').pop()!.replace(/\.jsx$/, '')
    const Component = TEMPLATES[name]
    if (!Component) throw new Error(`no template ${name}`)
    return (frame, fps, duration, props) => Component({ frame, fps, duration, ...props })
  },
  listGlobalOverlays: async () => [],
  listSystemOverlays: async () => [],
  uploadFile: async () => '/path',
  fileUrl: (p: string) => p,
}

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 1400, height: 1000, display: 'flex' }}>
    <CarouselEditor project={project} adapter={adapter} onProjectChange={(p) => { window.__project = p }} layout="rail" />
  </div>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

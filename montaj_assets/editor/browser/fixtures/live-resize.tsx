// The page `live-resize.test.mjs` drives in a real browser (§587 round 2, F-E).
//
// The real CarouselEditor in the rail layout, on one slide with a photo, a
// cropped photo, the shipped frame-corners, shape-rect and line-straight
// overlays, and a static-text box. The overlays are the real templates from
// render/templates/overlays, bundled in and called as the host's compiler
// calls them (the component as a function of frame, fps, duration and props).
// The editor's latest project is kept on `window.__project`, and how many
// times each template has rendered on `window.__renders`.
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, OverlayFactory, Project, RenderEvent } from '../../src/types'
import FrameCorners from '../../../render/templates/overlays/frame-corners/frame-corners.jsx'
import ShapeRect from '../../../render/templates/overlays/shape-rect/shape-rect.jsx'
import LineStraight from '../../../render/templates/overlays/line-straight/line-straight.jsx'
import StaticText from '../../../render/templates/overlays/static-text/static-text.jsx'

type Template = (props: Record<string, unknown>) => React.ReactElement | null
const TEMPLATES: Record<string, Template> = {
  'frame-corners': FrameCorners as Template,
  'shape-rect': ShapeRect as Template,
  'line-straight': LineStraight as Template,
  'static-text': StaticText as Template,
}

// Four flat quadrants, so a crop shows a known part.
const photo = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">'
  + '<rect width="200" height="200" fill="#d33"/><rect x="200" width="200" height="200" fill="#3a3"/>'
  + '<rect y="200" width="200" height="200" fill="#33d"/><rect x="200" y="200" width="200" height="200" fill="#dd3"/></svg>',
)}`
const image = (id: string, extra: Partial<ImageElement>): ImageElement =>
  ({ id, type: 'image', src: photo, x: 0, y: 0, w: 300, h: 300, rotation: 0, ...extra })
const overlay = (id: string, template: string, box: { x: number; y: number; w: number; h: number }, props: Record<string, unknown>): OverlayElement =>
  ({ id, type: 'overlay', ...box, rotation: 0, overlay: { template: `/rt/templates/overlays/${template}/${template}.jsx`, props } }) as OverlayElement

const project = {
  version: '1', id: 'p', name: 'Live resize', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{
    id: 's0', base_color: '#ffffff', elements: [
      image('img', { x: 60, y: 60, w: 300, h: 300 }),
      image('crop', { x: 420, y: 60, w: 300, h: 200, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }),
      overlay('frame', 'frame-corners', { x: 60, y: 420, w: 300, h: 300 }, { stroke: '#111111', strokeWidth: '8', cornerLength: '20' }),
      overlay('rect', 'shape-rect', { x: 420, y: 420, w: 300, h: 200 }, { fill: '#bdbdbd', stroke: '#111111', strokeWidth: '6' }),
      overlay('line', 'line-straight', { x: 60, y: 800, w: 400, h: 40 }, { stroke: '#111111', strokeWidth: '8' }),
      overlay('text', 'static-text', { x: 520, y: 800, w: 400, h: 160 }, { text: 'Hi there', fontSize: '80', textAlign: 'left' }),
    ],
  }],
} as Project

declare global {
  interface Window {
    __project: Project | null
    __renders: Record<string, number>
    __ready: boolean
  }
}
window.__project = null
window.__renders = {}

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
    // Each call is one render of that overlay: the test counts them.
    return (frame, fps, duration, props) => {
      window.__renders[name] = (window.__renders[name] ?? 0) + 1
      return Component({ frame, fps, duration, ...props })
    }
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

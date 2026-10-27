// The page `text-runs.test.mjs` drives in a real browser (§587 round 3).
//
// The real CarouselEditor in the rail layout, on one slide with one static-text
// box drawn by the real template from render/templates/overlays, called as the
// host's compiler calls it. Every save is kept on `window.__saves`.
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, OverlayFactory, Project, RenderEvent } from '../../src/types'
import StaticText from '../../../render/templates/overlays/static-text/static-text.jsx'

type Template = (props: Record<string, unknown>) => React.ReactElement | null

const text: OverlayElement = {
  id: 't', type: 'overlay', x: 140, y: 500, w: 800, h: 240, rotation: 0,
  overlay: {
    template: '/rt/render/templates/overlays/static-text/static-text.jsx',
    props: { text: 'Make it red', fontSize: '96', color: '#111111', fontWeight: '400', fontStyle: 'normal', textAlign: 'center' },
  },
} as OverlayElement

const project = {
  version: '1', id: 'p', name: 'Runs', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{ id: 's0', base_color: '#ffffff', elements: [text] }],
} as Project

declare global {
  interface Window {
    __saves: Project['slides'][]
    __ready: boolean
  }
}
window.__saves = []

const adapter: EditorAdapter<Project> = {
  loadProject: async () => project,
  saveProject: async (_id: string, p: Project) => { window.__saves.push(JSON.parse(JSON.stringify(p.slides))) },
  subscribe: () => () => {},
  render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/o.png' } },
  resolveImageSrc: (el: ImageElement) => el.src,
  compileOverlay: async (): Promise<OverlayFactory> =>
    (frame, fps, duration, props) => (StaticText as Template)({ frame, fps, duration, ...props }),
  listGlobalOverlays: async () => [],
  listSystemOverlays: async () => [],
  uploadFile: async () => '/path',
  fileUrl: (p: string) => p,
}

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 1400, height: 1000, display: 'flex' }}>
    <CarouselEditor project={project} adapter={adapter} onProjectChange={() => {}} layout="rail" />
  </div>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

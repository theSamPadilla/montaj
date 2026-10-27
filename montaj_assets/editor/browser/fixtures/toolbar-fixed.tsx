// The page `toolbar-fixed.test.mjs` drives in a real browser (§587 round 2, R8).
//
// The real CarouselEditor in the rail layout, filling the window, on a project
// of three tall slides (1080 x 1350), so the stack scrolls. Each has a tall
// image across its middle; the first also a text near its top. The adapter
// keeps every save's element ids per slide on `window.__saves`. The editor's
// layout classes are given real CSS by the test page.
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent } from '../../src/types'

const picture = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${fill}"/></svg>`)}`
const image = (id: string, fill: string): ImageElement =>
  ({ id, type: 'image', src: picture(fill), x: 290, y: 400, w: 500, h: 700, rotation: 0 })
const text: OverlayElement = {
  id: 't', type: 'overlay', x: 100, y: 80, w: 880, h: 200, rotation: 0,
  overlay: { template: '/overlays/text.jsx', props: { text: 'Hello', fontFamily: 'Inter', fontSize: 80, color: '#000000' } },
}

const project = {
  version: '1', id: 'p', name: 'Toolbar', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [
    { id: 's0', base_color: '#ffffff', elements: [image('a', '#d33'), text] },
    { id: 's1', base_color: '#eeeeee', elements: [image('b', '#3a3')] },
    { id: 's2', base_color: '#dddddd', elements: [image('c', '#33d')] },
  ],
} as Project

declare global {
  interface Window {
    __ready: boolean
    __saves: string[][][]
  }
}
window.__saves = []

const adapter: EditorAdapter<Project> = {
  loadProject: async () => project,
  saveProject: async (_id: string, p: Project) => { window.__saves.push(p.slides!.map((sl) => sl.elements.map((e) => e.id))) },
  subscribe: () => () => {},
  render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/o.png' } },
  resolveImageSrc: (el: ImageElement) => el.src,
  compileOverlay: async () => () => null,
  listGlobalOverlays: async () => [],
  listSystemOverlays: async () => [],
  uploadFile: async () => '/path',
  fileUrl: (p: string) => p,
}

createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <CarouselEditor project={project} adapter={adapter} onProjectChange={() => {}} layout="rail" />
  </div>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

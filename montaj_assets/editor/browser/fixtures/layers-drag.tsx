// The page `layers-drag.test.mjs` drives in a real browser (§587 round 2, R1).
//
// The real CarouselEditor in the rail layout, on a project of one slide with
// three images, back to front `a`, `b` (locked), `c`. The adapter keeps every
// save on `window.__saves`, so the test reads the stack the editor wrote.
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, Project, RenderEvent } from '../../src/types'

const picture = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${fill}"/></svg>`)}`
const image = (id: string, fill: string, extra: Partial<ImageElement> = {}): ImageElement =>
  ({ id, type: 'image', src: picture(fill), x: 100, y: 100, w: 300, h: 300, rotation: 0, ...extra })

const project = {
  version: '1', id: 'p', name: 'Layers', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{ id: 's0', base_color: '#ffffff', elements: [image('a', '#d33'), image('b', '#3a3', { locked: true }), image('c', '#33d')] }],
} as Project

declare global {
  interface Window {
    __saves: string[][]
    __ready: boolean
  }
}
window.__saves = []

const adapter: EditorAdapter<Project> = {
  loadProject: async () => project,
  saveProject: async (_id: string, p: Project) => { window.__saves.push(p.slides![0].elements.map((e) => e.id)) },
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
  <div style={{ width: 1200, height: 900, display: 'flex' }}>
    <CarouselEditor project={project} adapter={adapter} onProjectChange={() => {}} layout="rail" />
  </div>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

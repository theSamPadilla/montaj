// The page `colour-swatch.test.mjs` drives in a real browser (§587 round 2, R9).
//
// The real CarouselEditor in the rail layout, on one slide with a photo and a
// rectangle shape. The shape's compiled overlay draws a box in its `fill`, so
// the test can read the colour the canvas shows. The adapter keeps every save
// on `window.__saves`.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent } from '../../src/types'

// Two flat bands, so the photo's palette is known: orange, then navy. The band
// edge falls on a whole pixel of the sampler's 48 px copy (250 x 48 / 400 = 30),
// so the vector edge draws no blended row.
const photo = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="250" fill="#f08020"/><rect y="250" width="400" height="150" fill="#102060"/></svg>',
)}`
const image: ImageElement = { id: 'p', type: 'image', src: photo, x: 80, y: 80, w: 300, h: 300, rotation: 0 }
const rect: OverlayElement = {
  id: 'r', type: 'overlay', x: 540, y: 600, w: 360, h: 360, rotation: 0,
  overlay: { template: '/rt/templates/overlays/shape-rect/shape-rect.jsx', props: { fill: '#bdbdbd', stroke: '#111111', strokeWidth: '0' } },
} as OverlayElement

const project = {
  version: '1', id: 'p', name: 'Swatch', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{ id: 's0', base_color: '#ffffff', elements: [image, rect] }],
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
  compileOverlay: async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) =>
    createElement('div', { 'data-shape-box': '', style: { width: '100%', height: '100%', background: String(props.fill) } }),
  listGlobalOverlays: async () => [],
  listSystemOverlays: async () => [],
  uploadFile: async () => '/path',
  fileUrl: (p: string) => p,
}

createRoot(document.getElementById('root')!).render(
  <div style={{ width: 1400, height: 900, display: 'flex' }}>
    <CarouselEditor project={project} adapter={adapter} onProjectChange={() => {}} layout="rail" />
  </div>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

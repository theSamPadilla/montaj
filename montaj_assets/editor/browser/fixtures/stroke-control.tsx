// The page `stroke-control.test.mjs` drives in a real browser (§587 round 2, F-F).
//
// The real CarouselEditor in the rail layout, on one slide with a line. The
// line is the shipped line-straight template itself, so the test reads the SVG
// the canvas draws. The adapter keeps every save on `window.__saves`.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import CarouselEditor from '../../src/carousel/CarouselEditor'
import type { EditorAdapter, ImageElement, OverlayElement, Project, RenderEvent } from '../../src/types'
// @ts-expect-error: a plain JSX template with no types
import LineStraight from '../../../render/templates/overlays/line-straight/line-straight.jsx'

const line: OverlayElement = {
  id: 'l', type: 'overlay', x: 140, y: 600, w: 800, h: 80, rotation: 0,
  overlay: { template: '/rt/render/templates/overlays/line-straight/line-straight.jsx', props: { stroke: '#111111', strokeWidth: 12, arrowhead: 'none' } },
} as OverlayElement

const project = {
  version: '1', id: 'p', name: 'Stroke', workflow: 'carousel', status: 'draft', editingPrompt: '',
  projectType: 'carousel', settings: { resolution: [1080, 1350] }, assets: [],
  slides: [{ id: 's0', base_color: '#ffffff', elements: [line] }],
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
  compileOverlay: async () => (_f: number, _fps: number, _d: number, props: Record<string, unknown>) => createElement(LineStraight, props),
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

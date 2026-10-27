// The page `live-resize.test.mjs` drives for the video editor (§587 round 2, F-E).
//
// The real PreviewPlayer (the video editor's preview) on a 1080 x 1920 project
// with no base clip and one overlay track holding the shipped shape-polygon
// (a hexagon) and frame-corners templates, called as the host's compiler calls
// them. A gesture's commit goes through `applyOverlayChanges`, as VideoEditor's
// handleOverlayChange does. The latest project is kept on `window.__project`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import PreviewPlayer from '../../src/video/preview/PreviewPlayer'
import { applyOverlayChanges } from '../../src/video/preview/useDragOverlay'
import { createPlaybackClock } from '../../src/video/playback-clock'
import type { EditorProject, VisualItem } from '../../src/schema'
import type { OverlayFactory } from '../../src/types'
import ShapePolygon from '../../../render/templates/overlays/shape-polygon/shape-polygon.jsx'
import FrameCorners from '../../../render/templates/overlays/frame-corners/frame-corners.jsx'

type Template = (props: Record<string, unknown>) => React.ReactElement | null
const TEMPLATES: Record<string, Template> = {
  'shape-polygon': ShapePolygon as Template,
  'frame-corners': FrameCorners as Template,
}

const item = (id: string, template: string, extra: Partial<VisualItem>, props: Record<string, unknown>) =>
  ({ id, type: 'overlay', src: `/rt/render/templates/overlays/${template}/${template}.jsx`, start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 0.4, rotation: 0, props, ...extra }) as unknown as VisualItem

const initial = {
  version: '1', id: 'v', name: 'Video live resize', status: 'draft',
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [[], [
    item('hex', 'shape-polygon', { offsetY: -20 }, { fill: '#2a9d3a', points: '6' }),
    item('corners', 'frame-corners', { offsetY: 22 }, { stroke: '#111111', strokeWidth: '8' }),
  ]],
} as unknown as EditorProject

declare global {
  interface Window {
    __project: EditorProject
    __select: (id: string) => void
    __ready: boolean
  }
}

const clock = createPlaybackClock(1)
const compileOverlay = async (src: string): Promise<OverlayFactory> => {
  const name = src.split('/').pop()!.replace(/\.jsx$/, '')
  const Component = TEMPLATES[name]
  if (!Component) throw new Error(`no template ${name}`)
  return (frame, fps, duration, props) => Component({ frame, fps, duration, ...props })
}

function App() {
  const [project, setProject] = useState(initial)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  window.__project = project
  window.__select = setSelected
  return (
    <div style={{ width: 600, height: 960, display: 'flex' }}>
      <PreviewPlayer
        project={project}
        clock={clock}
        selectedOverlayId={selected}
        onOverlayChange={(id, changes, options) => setProject((p) => ({
          ...p,
          tracks: p.tracks!.map((t) => t.map((it) => (it.id === id ? applyOverlayChanges(it, changes, 1, options) : it))),
        }) as EditorProject)}
        compileOverlay={compileOverlay}
        fileUrl={(p) => p}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

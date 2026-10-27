// The page `social-stage.test.mjs` drives: the real PreviewPlayer in a host box
// sized the way VideoEditor sizes it (`socialStageSize`), with a social preview
// picked or not.
//
//   res=WxH        the project's resolution (1080x1080, 1080x1350, 1920x1080, 1080x1920)
//   social=tiktok|youtube|instagram|none
//
// The frame is filled edge to edge by a shape-rect (so its bounds show against
// the black), with a hexagon in the middle.
import { createRoot } from 'react-dom/client'
import PreviewPlayer from '../../src/video/preview/PreviewPlayer'
import { socialStageSize } from '../../src/video/preview/SocialSafeZoneOverlay'
import { fitBoxStyle } from '../../src/video/preview/fitBox'
import { getOverlayDesignCanvas } from '../../src/video/design-canvas'
import { createPlaybackClock } from '../../src/video/playback-clock'
import type { EditorProject, VisualItem } from '../../src/schema'
import type { OverlayFactory } from '../../src/types'
import ShapeRect from '../../../render/templates/overlays/shape-rect/shape-rect.jsx'
import ShapePolygon from '../../../render/templates/overlays/shape-polygon/shape-polygon.jsx'

const q = new URLSearchParams(location.search)
const [RW, RH] = (q.get('res') ?? '1080x1080').split('x').map(Number)
const social = q.get('social') === 'none' ? undefined : (q.get('social') ?? undefined)

type Template = (props: Record<string, unknown>) => React.ReactElement | null
const TEMPLATES: Record<string, Template> = { 'shape-rect': ShapeRect as Template, 'shape-polygon': ShapePolygon as Template }

const item = (id: string, template: string, scale: number, props: Record<string, unknown>) =>
  ({ id, type: 'overlay', src: `/rt/render/templates/overlays/${template}/${template}.jsx`, start: 0, end: 10, offsetX: 0, offsetY: 0, scale, rotation: 0, props }) as unknown as VisualItem

const project = {
  version: '1', id: 's', name: 'Social stage', status: 'draft',
  settings: { resolution: [RW, RH], fps: 30 },
  tracks: [[
    item('bg', 'shape-rect', 1, { fill: '#3a6ea5' }),
    item('hex', 'shape-polygon', 0.3, { fill: '#f4c542', points: '6' }),
  ]],
} as unknown as EditorProject

declare global {
  interface Window { __ready: boolean }
}

const clock = createPlaybackClock(0)
const compileOverlay = async (src: string): Promise<OverlayFactory> => {
  const Component = TEMPLATES[src.split('/').pop()!.replace(/\.jsx$/, '')]
  return (frame, fps, duration, props) => Component({ frame, fps, duration, ...props })
}

// VideoEditor's preview row: a size container, and in it the host box.
function App() {
  const [w, h] = getOverlayDesignCanvas(project.settings?.resolution)
  return (
    <div data-host-row="" style={{ width: 640, height: 640, display: 'flex', alignItems: 'center', justifyContent: 'center', containerType: 'size', background: '#000' }}>
      <div data-host-box="" style={{ position: 'relative', ...fitBoxStyle(...socialStageSize(social, w, h)) }}>
        <PreviewPlayer
          project={project}
          clock={clock}
          compileOverlay={compileOverlay}
          fileUrl={(p) => p}
          socialPreview={social}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

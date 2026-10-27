// The page `play-glyph.test.mjs` drives: the real PreviewPlayer, on the playback
// path and timeline the query string names.
//
//   engine=1|0     the engine (the app's default) or the legacy <video> player
//   kind=video     one 1.5 s clip (fixtures/play-glyph-clip.mp4, H.264 + Opus,
//                  proxied, so the engine takes it)
//   kind=canvas    no clip: one overlay track that ends at 1.5 s
//   overlay=1      a hexagon over the middle of the frame (track 1)
//   src=missing    the clip points at a file that is not there
//
// A gesture's commit goes through `applyOverlayChanges`, as VideoEditor's
// handleOverlayChange does. The latest project, the playing state and every
// console.warn are kept on `window` for the test.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import PreviewPlayer from '../../src/video/preview/PreviewPlayer'
import { applyOverlayChanges } from '../../src/video/preview/useDragOverlay'
import { createPlaybackClock } from '../../src/video/playback-clock'
import type { EditorProject, VisualItem } from '../../src/schema'
import type { OverlayFactory } from '../../src/types'
import ShapePolygon from '../../../render/templates/overlays/shape-polygon/shape-polygon.jsx'

const q = new URLSearchParams(location.search)
const ENGINE = q.get('engine') === '1'
const KIND = q.get('kind') ?? 'video'
const SRC = q.get('src') === 'missing' ? '/missing.mp4' : '/play-glyph-clip.mp4'

const clip = {
  id: 'c1', type: 'video', src: SRC, proxySrc: SRC, start: 0, end: 1.5, inPoint: 0, outPoint: 1.5,
  sourceWidth: 180, sourceHeight: 320,
} as unknown as VisualItem
const hexagon = (end: number) => ({
  id: 'hex', type: 'overlay', src: '/rt/render/templates/overlays/shape-polygon/shape-polygon.jsx',
  start: 0, end, offsetX: 0, offsetY: 0, scale: 0.4, rotation: 0, props: { fill: '#2a9d3a', points: '6' },
}) as unknown as VisualItem

const tracks: VisualItem[][] = KIND === 'canvas'
  ? [[hexagon(1.5)]]
  : [[clip], q.get('overlay') === '1' ? [hexagon(1.5)] : []]

const initial = {
  version: '1', id: 'p', name: 'Play glyph', status: 'draft',
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks,
} as unknown as EditorProject

declare global {
  interface Window {
    __project: EditorProject
    __select: (id: string | undefined) => void
    __setTime: (t: number) => void
    __time: () => number
    __playing: boolean
    __warns: string[]
    __ready: boolean
  }
}

window.__warns = []
const warn = console.warn.bind(console)
console.warn = (...args: unknown[]) => { window.__warns.push(args.map(String).join(' ')); warn(...args) }
window.__playing = false

const clock = createPlaybackClock(0)
window.__setTime = (t) => clock.set(t)
window.__time = () => clock.get()
const compileOverlay = async (): Promise<OverlayFactory> =>
  (frame, fps, duration, props) => (ShapePolygon as (p: Record<string, unknown>) => React.ReactElement)({ frame, fps, duration, ...props })

function App() {
  const [project, setProject] = useState(initial)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  window.__project = project
  window.__select = setSelected
  return (
    <div style={{ width: 360, height: 640, display: 'flex' }}>
      <PreviewPlayer
        project={project}
        clock={clock}
        selectedOverlayId={selected}
        onOverlayChange={(id, changes, options) => setProject((p) => ({
          ...p,
          tracks: p.tracks!.map((t) => t.map((it) => (it.id === id ? applyOverlayChanges(it, changes, 1, options) : it))),
        }) as EditorProject)}
        onPlayingChange={(p) => { window.__playing = p }}
        compileOverlay={compileOverlay}
        fileUrl={(p) => p}
        engine={ENGINE ? { enabled: true } : undefined}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))

// The page `audio-drop.test.mjs` drives (a sound dragged from the Media bin onto the video timeline).
//
// A draggable card that starts the drag as the app's AudioCard does (AUDIO_DND_MIME on dragstart), above the real
// TimelineCanvas on a project with one video clip and one audio lane. The canvas commits through the same
// onProjectChange + onOverlayEdit pair the editor uses; the latest project is kept on `window.__project`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TimelineCanvas from '../../src/video/timeline/canvas/TimelineCanvas'
import { createViewportStore } from '../../src/video/timeline/canvas/viewport'
import { createPlaybackClock } from '../../src/video/playback-clock'
import { computeTimelineLayout } from '../../src/video/timeline/canvas/draw'
import { AUDIO_DND_MIME } from '../../src/types'
import type { Project } from '../../src/types'

declare global {
  interface Window {
    __project: Project
    __layout: () => ReturnType<typeof computeTimelineLayout>
    __ready: boolean
  }
}

const initial = {
  version: '1', id: 'v', name: 'Audio drop', status: 'draft',
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: '/a.mp4', start: 0, end: 8, inPoint: 0, outPoint: 8, sourceDuration: 20 }] }],
  audio: { tracks: [{ id: 'aud-0', src: '/p/a.mp3', start: 0, end: 2, lane: 0, sourceDuration: 2 }] },
} as unknown as Project

const SOUND = { src: '/p/assets/bed.mp3', sourceDuration: 4, name: 'bed.mp3', type: 'music' }

const store = createViewportStore()
const clock = createPlaybackClock(1)
store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 })

function App() {
  const [project, setProject] = useState<Project>(initial)
  window.__project = project
  window.__layout = () => computeTimelineLayout(project)
  window.__ready = true
  return (
    <div style={{ width: 1000 }}>
      <div
        id="card"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(AUDIO_DND_MIME, JSON.stringify(SOUND))
          e.dataTransfer.effectAllowed = 'copy'
        }}
        style={{ width: 120, height: 60, background: '#1f2937', color: '#fff', margin: '10px 0' }}
      >
        bed.mp3
      </div>
      <div id="timeline" style={{ position: 'relative', width: 1000, height: 300, background: '#111827' }}>
        <TimelineCanvas
          project={project}
          clock={clock}
          store={store}
          totalDuration={13}
          fps={30}
          selectedIds={[]}
          onSelectItem={() => {}}
          onProjectChange={setProject}
          onOverlayEdit={setProject}
          onInspectClip={() => {}}
          onInspectAudio={() => {}}
          onHoverScrub={() => {}}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

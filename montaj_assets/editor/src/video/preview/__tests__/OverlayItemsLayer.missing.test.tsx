/// <reference types="vitest/globals" />
import { useRef } from 'react'
import { render, cleanup } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { useDragOverlay } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { MissingClipsProvider, enabledMissingClips } from '../../missingClips'

afterEach(cleanup)

const project = {
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [
    { id: 't0', items: [] },
    { id: 't1', items: [
      { id: 'ov', type: 'video', src: '/m/broll.mp4', start: 0, end: 10 },
      { id: 'im', type: 'image', src: '/m/logo.png', start: 0, end: 10 },
    ] },
  ],
} as unknown as EditorProject

function Harness({ ids }: { ids?: ReadonlySet<string> }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, undefined)
  const items = (project.tracks as unknown as Array<{ items: VisualItem[] }>)[1].items
  return (
    <MissingClipsProvider ids={ids} notify={undefined}>
      <div ref={containerRef}>
        <OverlayItemsLayer
          project={project}
          currentTime={1}
          isPlaying={false}
          isCanvasProject={false}
          overlayTracks={[items]}
          tracks0NonVideo={[]}
          renderScale={0.2}
          containerRef={containerRef}
          dragState={drag.dragState}
          setDragState={drag.setDragState}
          liveOffset={drag.liveOffset}
          liveScale={drag.liveScale}
          liveRotation={drag.liveRotation}
          snapGuides={drag.snapGuides}
          snapRotation={drag.snapRotation}
          compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
          fileUrl={(p: string) => p}
        />
      </div>
    </MissingClipsProvider>
  )
}

const srcs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('video, img')).map(e => e.getAttribute('src') ?? '')

describe('missingClips: overlay-track items', () => {
  it('sets no src and draws nothing for a missing overlay video or image', () => {
    const { container } = render(<Harness ids={new Set(['ov', 'im'])} />)
    expect(srcs(container).join('|')).not.toMatch(/broll|logo/)
  })

  it('still draws them without the prop', () => {
    const { container } = render(<Harness />)
    expect(srcs(container).join('|')).toMatch(/broll/)
  })

  it('counts overlay-track items in the list play and export refuse with', () => {
    expect(enabledMissingClips(project, new Set(['ov', 'im'])).map(c => c.name)).toEqual(['broll.mp4', 'logo.png'])
  })
})

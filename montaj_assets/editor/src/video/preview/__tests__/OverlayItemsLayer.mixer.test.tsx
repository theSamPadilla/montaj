/// <reference types="vitest/globals" />
import { useRef } from 'react'
import { render } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { useDragOverlay } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'

// §190: in mixer mode the engine's preview mixer plays an overlay-track
// video's sound from the conform of its ORIGINAL `src`, so the `<video>`
// (which may be loading a proxy) must play muted, or the sound doubles. A
// source the plan left out keeps its own sound exactly as today, and so does
// the `<video>` path, which passes no `audioInMix` at all.

const clip = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'v', type: 'video', src: '/media/broll.mov', proxySrc: '/p/broll_proxy.mp4', start: 0, end: 10, inPoint: 0, ...over,
} as VisualItem)

function project(item: VisualItem): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'main', items: [] }, { id: 'upper', items: [item] }],
  } as unknown as EditorProject
}

function Harness({ item, audioInMix }: { item: VisualItem; audioInMix?: (src: string) => boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, undefined)
  return (
    <div ref={containerRef}>
      <OverlayItemsLayer
        project={project(item)}
        currentTime={1}
        isPlaying={false}
        isCanvasProject={false}
        overlayTracks={[[item]]}
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
        fileUrl={(pth: string) => pth}
        audioInMix={audioInMix}
      />
    </div>
  )
}

function videoOf(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video')
  if (!video) throw new Error('no <video> rendered for the overlay-track clip')
  return video
}

describe('OverlayItemsLayer: an overlay video the preview mixer plays is muted', () => {
  it('muted when the mixer plays its source, asked by the ORIGINAL src', () => {
    const asked: string[] = []
    const { container } = render(<Harness item={clip()} audioInMix={(src) => { asked.push(src); return true }} />)
    expect(videoOf(container).muted).toBe(true)
    expect(asked).toContain('/media/broll.mov')
  })

  it('keeps its own sound when the plan left its source out', () => {
    const { container } = render(<Harness item={clip()} audioInMix={() => false} />)
    expect(videoOf(container).muted).toBe(false)
  })

  it('keeps its own sound with no mixer at all (the <video> path)', () => {
    const { container } = render(<Harness item={clip()} />)
    expect(videoOf(container).muted).toBe(false)
  })

  it('gets it back when the mixer lets go of the source', () => {
    const { container, rerender } = render(<Harness item={clip()} audioInMix={() => true} />)
    expect(videoOf(container).muted).toBe(true)
    rerender(<Harness item={clip()} audioInMix={() => false} />)
    expect(videoOf(container).muted).toBe(false)
  })
})

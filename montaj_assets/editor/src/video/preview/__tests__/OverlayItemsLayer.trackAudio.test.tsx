/// <reference types="vitest/globals" />
import { useRef } from 'react'
import { render } from '@testing-library/react'
import type { EditorProject, VisualItem, VisualTrack } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { useDragOverlay } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'

// A video on an overlay track plays through its own `<video>` element here,
// not through `useVideoPlayback`'s gain graph, so this layer is its own fold
// point for the track's audio settings. Muting a whole track silenced its
// clips in the export (render.js `collectAllItems` folds them) but not in the
// preview, where each clip's own `muted` was all this element read. The fold
// is `effectiveItemAudio` (timeline-model.ts): mute is either/or, volume
// multiplies.

function project(upper: Partial<VisualTrack>, item: VisualItem): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 'main', items: [] },
      { id: 'upper', items: [item], ...upper },
    ],
  } as unknown as EditorProject
}

const clip = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'v', type: 'video', src: 'clip.mp4', start: 0, end: 10, inPoint: 0, ...over,
} as VisualItem)

function Harness({ upper = {}, item, muted }: { upper?: Partial<VisualTrack>; item: VisualItem; muted?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, undefined)
  return (
    <div ref={containerRef}>
      <OverlayItemsLayer
        project={project(upper, item)}
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
        muted={muted}
      />
    </div>
  )
}

function videoOf(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video')
  if (!video) throw new Error('no <video> rendered for the overlay-track clip')
  return video
}

describe('OverlayItemsLayer: an overlay-track video follows its track’s audio settings', () => {
  it('a muted track silences its clip, though the clip itself is not muted', () => {
    const { container } = render(<Harness upper={{ muted: true }} item={clip({ muted: false })} />)
    expect(videoOf(container).muted).toBe(true)
  })

  it('a clip on a track nobody muted plays, and a muted clip stays muted', () => {
    const { container, rerender } = render(<Harness item={clip()} />)
    expect(videoOf(container).muted).toBe(false)
    rerender(<Harness item={clip({ muted: true })} />)
    expect(videoOf(container).muted).toBe(true)
  })

  it('unmuting the track brings the clip back', () => {
    const { container, rerender } = render(<Harness upper={{ muted: true }} item={clip()} />)
    expect(videoOf(container).muted).toBe(true)
    rerender(<Harness upper={{ muted: false }} item={clip()} />)
    expect(videoOf(container).muted).toBe(false)
  })

  it('the track volume multiplies the clip’s, as the export does', () => {
    const { container } = render(<Harness upper={{ volume: 0.5 }} item={clip({ volume: 0.8 })} />)
    expect(videoOf(container).volume).toBeCloseTo(0.4)
  })

  it('a boost past 1 plays at full volume, the most a <video> can give', () => {
    const { container } = render(<Harness upper={{ volume: 2 }} item={clip({ volume: 1 })} />)
    expect(videoOf(container).volume).toBe(1)
  })

  it('the player’s own mute (a silent host, like a hover preview) silences it too', () => {
    const { container } = render(<Harness item={clip()} muted />)
    expect(videoOf(container).muted).toBe(true)
  })
})

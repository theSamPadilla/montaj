/// <reference types="vitest/globals" />
/**
 * §308 P3 layering parity, the editor half. One shared project
 * (`timeline-core/test/layering-parity.project.json`) is stacked here by the
 * REAL preview layer, and by sample_frame and the export in
 * `render/test/layering-parity.integration.test.mjs`. Both halves check the
 * same `expectTop`, so the preview, the samples and the export agree on what
 * is on top at every layer boundary.
 *
 * The editor's stack, read off what it actually renders: the tracks come from
 * `enabledTrackItems` (the canonical order, every video-holding track first),
 * split the way the playback hooks split them (`useEnginePlayback.ts`
 * `tracks0NonVideo`/`overlayTracks`/`isCanvasProject`), the base track's video
 * is the engine canvas at the bottom, and every other item is a DOM layer whose
 * z-index `OverlayItemsLayer` sets. The top item is the highest z-index, the
 * later one in the DOM on a tie.
 *
 * It also pins timeline-core's `trackLayerPositions` to the editor's own
 * partition, which it mirrors (timeline-model.ts `orderedTrackArray`).
 */
import { act, render, cleanup } from '@testing-library/react'
import { containsTime, trackLayerPositions } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { enabledTrackItems, trackItems } from '../../timeline/timeline-model'
import fixture from '../../../../../timeline-core/test/layering-parity.project.json'

afterEach(cleanup)
// jsdom has no media playback; the pip <video> only has to mount.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
})

const FIXTURE = fixture as unknown as {
  settings: EditorProject['settings']
  tracks: VisualItem[][]
  layerPositions: number[]
  expectTop: Array<[number, string]>
}
const project = { id: 'p', status: 'draft', settings: FIXTURE.settings, tracks: FIXTURE.tracks } as unknown as EditorProject

/** Every item's id by the element that draws it in the layer. */
function markerFor(container: HTMLElement, item: VisualItem): HTMLElement | null {
  if (item.type === 'image') return container.querySelector(`img[src="${item.src}"]`)
  if (item.type === 'video') return container.querySelector(`video[src="${item.src}"]`)
  return container.querySelector(`i[data-src="${item.src}"]`)
}

function zOf(el: HTMLElement): number {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.style?.zIndex) return Number(node.style.zIndex)
  }
  return 0
}

async function editorTopAt(t: number): Promise<string | undefined> {
  // The split the playback hooks make (useEnginePlayback.ts:256-258).
  const tracks = enabledTrackItems(project)
  const base = (tracks[0] ?? []).filter(c => c.type === 'video')
  const { container } = render(
    <OverlayItemsLayer
      project={project}
      currentTime={t}
      isPlaying={false}
      isCanvasProject={base.length === 0}
      overlayTracks={tracks.slice(1)}
      tracks0NonVideo={(tracks[0] ?? []).filter(c => c.type !== 'video')}
      renderScale={0.2}
      containerRef={{ current: null }}
      dragState={null}
      setDragState={() => {}}
      liveOffset={null}
      liveScale={null}
      liveRotation={null}
      snapGuides={{ x: false, y: false, left: false, right: false, top: false, bottom: false }}
      snapRotation={null}
      compileOverlay={async (src: string): Promise<OverlayFactory> => () => <i data-src={src} />}
      fileUrl={(p: string) => p}
    />,
  )
  // The overlay mounts once its (mocked) compile resolves.
  await act(async () => { await Promise.resolve() })
  const drawn = trackItems(project).flat()
    .filter(item => containsTime(item.start, item.end, t))
    .map(item => ({ item, el: markerFor(container, item) }))
    .filter((d): d is { item: VisualItem; el: HTMLElement } => d.el !== null)
  drawn.sort((a, b) => zOf(a.el) - zOf(b.el) || (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  cleanup()
  // Nothing above it: the base track's video, which the engine paints.
  return drawn[drawn.length - 1]?.item.id ?? base.find(c => containsTime(c.start, c.end, t))?.id
}

describe('layering parity: the editor preview', () => {
  it('timeline-core trackLayerPositions is the editor\'s own track order', () => {
    expect(trackLayerPositions(FIXTURE.tracks)).toEqual(FIXTURE.layerPositions)
    // enabledTrackItems hands the tracks out in canonical order: track i of the
    // JSON lands at its layer position.
    const canonical = enabledTrackItems(project).map(items => items[0]?.id)
    FIXTURE.tracks.forEach((items, i) => expect(canonical[FIXTURE.layerPositions[i]]).toBe(items[0].id))
  })

  it.each(FIXTURE.expectTop)('at %ss the preview draws %s on top', async (t, id) => {
    expect(await editorTopAt(t)).toBe(id)
  })
})

/// <reference types="vitest/globals" />
import React from 'react'
import { render } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'

// A project echo (an external save: a note, an agent's write) replaces the project with freshly
// parsed objects, so an overlay item's `props` is a new object with the same content. The host's
// factory keys an overlay's module instance on the props object it is handed (the app's preview
// makes a new instance per object), so CustomOverlay hands the same resolved props object for the
// same content: an echo neither re-evaluates the overlay nor drops the state it bound at mount.
const seen: Array<Record<string, unknown>> = []
const factory: OverlayFactory = (frame, _fps, _dur, props) => {
  seen.push(props)
  return <span>{frame}</span>
}
const project = {
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]],
} as unknown as EditorProject
const snap = { x: false, y: false, left: false, right: false, top: false, bottom: false }
const fileUrl = (p: string) => p // stable, as the host's adapter is
const compileOverlay = async () => factory

function layer(frameNo: number, props: Record<string, unknown>) {
  const item = { id: 'o1', type: 'overlay', src: 'o.jsx', start: 0, end: 10, props } as unknown as VisualItem
  return (
    <OverlayItemsLayer
      project={project} currentTime={frameNo / 30} isPlaying={false} isCanvasProject={false}
      overlayTracks={[[item]]} tracks0NonVideo={[]} renderScale={0.2} selectedOverlayId={undefined}
      onOverlayChange={vi.fn()} onEditOverlay={vi.fn()} containerRef={{ current: document.createElement('div') }}
      dragState={null} setDragState={vi.fn()} liveOffset={null} liveScale={null} liveRotation={null}
      snapGuides={snap} snapRotation={null} compileOverlay={compileOverlay} fileUrl={fileUrl}
    />
  )
}

it('an echo of the same props hands the factory the same props object; an edit hands a new one', async () => {
  seen.length = 0
  const { rerender, findByText } = render(layer(1, { phase: 'fall', n: [1, 2] }))
  await findByText('1')
  rerender(layer(2, { phase: 'fall', n: [1, 2] })) // the echo: new objects, same content
  await findByText('2')
  rerender(layer(3, { phase: 'climb', n: [1, 2] })) // a real edit
  await findByText('3')
  const at = (f: number) => seen[seen.length - 1 - (3 - f)]
  expect(at(2)).toBe(at(1))
  expect(at(3)).not.toBe(at(2))
  expect(at(3)).toEqual({ phase: 'climb', n: [1, 2] })
})

/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import type { VisualItem } from '../../schema'
import { createPlaybackClock } from '../../video/playback-clock'
import { toggleCropKeyframeAt, CROP_PROPS } from '../../video/keyframeOps'
import { CropKeyframeNav } from '../CropKeyframeNav'

const still = { id: 'i', type: 'image', src: 'p.jpg', start: 10, end: 14 } as VisualItem

describe('CropKeyframeNav (PV55)', () => {
  it('empty diamond with no crop keyframe; a click keys all four at the playhead', () => {
    const onChange = vi.fn()
    render(<CropKeyframeNav item={still} clock={createPlaybackClock(11)} onChange={onChange} />)
    const diamond = screen.getByRole('button', { name: 'Add Crop keyframe at playhead' })
    expect(diamond.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(diamond)
    const next = onChange.mock.calls[0][0] as VisualItem
    for (const p of CROP_PROPS) expect(next.keyframes?.find(k => k.prop === p)?.points.map(pt => pt.t)).toEqual([1])
  })
  it('filled when a crop keyframe sits at the playhead; a click removes that one', () => {
    const onChange = vi.fn()
    const keyed = toggleCropKeyframeAt(still, 1)
    render(<CropKeyframeNav item={keyed} clock={createPlaybackClock(11)} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Crop keyframe at playhead' }))
    expect((onChange.mock.calls[0][0] as VisualItem).keyframes).toBeUndefined()
  })
  it('the arrows seek to the neighbouring crop keyframes, in timeline time', () => {
    const onSeek = vi.fn()
    const keyed = toggleCropKeyframeAt(toggleCropKeyframeAt(still, 0), 3)
    render(<CropKeyframeNav item={keyed} clock={createPlaybackClock(11)} onChange={vi.fn()} onSeek={onSeek} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous Crop keyframe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next Crop keyframe' }))
    expect(onSeek.mock.calls.map(c => c[0])).toEqual([10, 13])
  })
})

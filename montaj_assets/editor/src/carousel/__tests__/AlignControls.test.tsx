// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { AlignControls, alignedPosition, alignedPositions, distributedPositions } from '../AlignControls'

const BOX = { x: 100, y: 200, w: 400, h: 100, rotation: 0 }

describe('alignedPosition', () => {
  it('puts an unrotated box on each edge and center of a 1080 x 1350 slide', () => {
    expect(alignedPosition(BOX, 'left', 1080, 1350)).toEqual({ x: 0 })
    expect(alignedPosition(BOX, 'center', 1080, 1350)).toEqual({ x: 340 })
    expect(alignedPosition(BOX, 'right', 1080, 1350)).toEqual({ x: 680 })
    expect(alignedPosition(BOX, 'top', 1080, 1350)).toEqual({ y: 0 })
    expect(alignedPosition(BOX, 'middle', 1080, 1350)).toEqual({ y: 625 })
    expect(alignedPosition(BOX, 'bottom', 1080, 1350)).toEqual({ y: 1250 })
  })

  it('a box turned 90 degrees aligns by what it covers: its corners touch the edge', () => {
    const turned = { ...BOX, rotation: 90 }
    // It covers 100 wide and 400 tall around its center, so the left edge
    // puts the center at 50, and x (the unrotated frame's left) at 50 - 200.
    expect(alignedPosition(turned, 'left', 1080, 1350)).toEqual({ x: -150 })
    expect(alignedPosition(turned, 'top', 1080, 1350)).toEqual({ y: 150 })
    // The center ignores rotation.
    expect(alignedPosition(turned, 'center', 1080, 1350)).toEqual({ x: 340 })
  })
})

describe('AlignControls', () => {
  it('six buttons; each sends only the coordinate it moves', () => {
    const onChange = vi.fn()
    render(<AlignControls element={BOX} width={1080} height={1350} onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Align to slide' })
    expect(group.querySelectorAll('button')).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'Align right' }))
    fireEvent.click(screen.getByRole('button', { name: 'Align bottom' }))
    expect(onChange.mock.calls).toEqual([[{ x: 680 }], [{ y: 1250 }]])
  })
})

describe('alignedPositions', () => {
  const A = { x: 100, y: 100, w: 200, h: 100, rotation: 0 } // covers 100..300 x 100..200
  const B = { x: 500, y: 400, w: 100, h: 300, rotation: 0 } // covers 500..600 x 400..700

  it('one box aligns to the slide, exactly as alignedPosition does', () => {
    for (const to of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) {
      expect(alignedPositions([BOX], to, 1080, 1350)).toEqual([alignedPosition(BOX, to, 1080, 1350)])
    }
  })

  it('two or more align to the box the selection covers, not the slide', () => {
    expect(alignedPositions([A, B], 'left', 1080, 1350)).toEqual([{ x: 100 }, { x: 100 }])
    expect(alignedPositions([A, B], 'right', 1080, 1350)).toEqual([{ x: 400 }, { x: 500 }])
    // Union 100..600: center 350.
    expect(alignedPositions([A, B], 'center', 1080, 1350)).toEqual([{ x: 250 }, { x: 300 }])
    expect(alignedPositions([A, B], 'top', 1080, 1350)).toEqual([{ y: 100 }, { y: 100 }])
    expect(alignedPositions([A, B], 'bottom', 1080, 1350)).toEqual([{ y: 600 }, { y: 400 }])
    // Union 100..700: middle 400.
    expect(alignedPositions([A, B], 'middle', 1080, 1350)).toEqual([{ y: 350 }, { y: 250 }])
  })

  it('a rotated member counts by the box it covers, for the union and for its own edge', () => {
    // 400 x 100 turned 90 degrees around its center (300, 250): covers 250..350 x 50..450.
    const turned = { x: 100, y: 200, w: 400, h: 100, rotation: 90 }
    const C = { x: 600, y: 300, w: 100, h: 100, rotation: 0 } // covers 600..700 x 300..400
    // Union left 250 (from the turned box), top 50: the turned box already sits on both.
    expect(alignedPositions([turned, C], 'left', 1080, 1350)).toEqual([{ x: 100 }, { x: 250 }])
    expect(alignedPositions([turned, C], 'top', 1080, 1350)).toEqual([{ y: 200 }, { y: 50 }])
    // Right 700: the turned box's covered right edge (center + 50) lands there.
    expect(alignedPositions([turned, C], 'right', 1080, 1350)).toEqual([{ x: 450 }, { x: 600 }])
  })
})

describe('AlignControls with several elements', () => {
  it('is labelled Align, and each button sends one patch per element by id', () => {
    const onChange = vi.fn()
    const elements = [
      { id: 'a', x: 100, y: 100, w: 200, h: 100, rotation: 0 },
      { id: 'b', x: 500, y: 400, w: 100, h: 300, rotation: 0 },
    ]
    render(<AlignControls elements={elements} width={1080} height={1350} onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Align' })
    expect(group.querySelectorAll('button')).toHaveLength(6)
    expect(screen.queryByRole('group', { name: 'Align to slide' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Align left' }))
    fireEvent.click(screen.getByRole('button', { name: 'Align bottom' }))
    expect(onChange.mock.calls).toEqual([
      [[{ id: 'a', x: 100 }, { id: 'b', x: 100 }]],
      [[{ id: 'a', y: 600 }, { id: 'b', y: 400 }]],
    ])
  })
})

describe('distributedPositions', () => {
  // Three boxes along x: covers 0..100, 150..250 (a 100 wide one), 600..800.
  const A = { x: 0, y: 0, w: 100, h: 50, rotation: 0 }
  const B = { x: 150, y: 70, w: 100, h: 50, rotation: 0 }
  const C = { x: 600, y: 140, w: 200, h: 50, rotation: 0 }

  it('no gap: equal gaps between neighbours, the first stays and the last ends where the selection ended', () => {
    // Sizes 100 + 100 + 200 = 400 inside 0..800, so two gaps of 200.
    expect(distributedPositions([A, B, C], 'horizontal')).toEqual([{ x: 0 }, { x: 300 }, { x: 600 }])
  })

  it('a gap sets exactly that space between neighbours, keeping the first in place', () => {
    expect(distributedPositions([A, B, C], 'horizontal', 20)).toEqual([{ x: 0 }, { x: 120 }, { x: 240 }])
    expect(distributedPositions([A, B, C], 'horizontal', 0)).toEqual([{ x: 0 }, { x: 100 }, { x: 200 }])
    // Negative: they overlap by 10.
    expect(distributedPositions([A, B, C], 'horizontal', -10)).toEqual([{ x: 0 }, { x: 90 }, { x: 180 }])
  })

  it('vertical works on y with the heights', () => {
    // Heights 50 each inside 0..190: two gaps of 20, which they already have.
    expect(distributedPositions([A, B, C], 'vertical')).toEqual([{ y: 0 }, { y: 70 }, { y: 140 }])
    expect(distributedPositions([A, B, C], 'vertical', 10)).toEqual([{ y: 0 }, { y: 60 }, { y: 120 }])
  })

  it('takes the boxes in order of position, whatever order they are given in; one patch per box, in the order given', () => {
    expect(distributedPositions([C, A, B], 'horizontal')).toEqual([{ x: 600 }, { x: 0 }, { x: 300 }])
  })

  it('a rotated box counts by the box it covers: its covered edges are spaced, its frame moves to suit', () => {
    // 400 x 100 turned 90 degrees around its center (500) covers 100 wide x 400 tall: x 450..550.
    const turned = { x: 300, y: 0, w: 400, h: 100, rotation: 90 }
    const P = { x: 0, y: 0, w: 100, h: 100, rotation: 0 }   // covers 0..100
    const Q = { x: 200, y: 0, w: 100, h: 100, rotation: 0 } // covers 200..300
    // A gap of 175: Q covers 275..375, the turned box covers 550..650 (center 600, frame x 400).
    expect(distributedPositions([P, Q, turned], 'horizontal', 175)).toEqual([{ x: 0 }, { x: 275 }, { x: 400 }])
    // Even: three 100 wide boxes inside 0..550 leave two gaps of 125, so Q covers 225..325 and the turned box 450..550 (frame x 300).
    expect(distributedPositions([P, Q, turned], 'horizontal')).toEqual([{ x: 0 }, { x: 225 }, { x: 300 }])
  })

  it('fewer than three boxes are left where they are', () => {
    expect(distributedPositions([A, B], 'horizontal')).toEqual([{ x: 0 }, { x: 150 }])
    expect(distributedPositions([A], 'vertical', 5)).toEqual([{ y: 0 }])
  })
})

describe('AlignControls Distribute', () => {
  const three = [
    { id: 'a', x: 0, y: 0, w: 100, h: 50, rotation: 0 },
    { id: 'b', x: 150, y: 70, w: 100, h: 50, rotation: 0 },
    { id: 'c', x: 600, y: 140, w: 200, h: 50, rotation: 0 },
  ]

  it('with three or more: two buttons and a Gap field; a blank Gap spreads evenly, a number sets the gap, one onChange each', () => {
    const onChange = vi.fn()
    render(<AlignControls elements={three} width={1080} height={1350} onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Distribute' })
    expect(group.querySelectorAll('button')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Distribute horizontally' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Gap' }), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Distribute vertically' }))
    fireEvent.click(screen.getByRole('button', { name: 'Distribute horizontally' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Gap' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Distribute horizontally' }))
    expect(onChange.mock.calls).toEqual([
      [[{ id: 'a', x: 0 }, { id: 'b', x: 300 }, { id: 'c', x: 600 }]],
      [[{ id: 'a', y: 0 }, { id: 'b', y: 70 }, { id: 'c', y: 140 }]],
      [[{ id: 'a', x: 0 }, { id: 'b', x: 120 }, { id: 'c', x: 240 }]],
      [[{ id: 'a', x: 0 }, { id: 'b', x: 300 }, { id: 'c', x: 600 }]],
    ])
  })

  it('with two selected the buttons and the field are disabled and nothing is sent; one element has no Distribute row', () => {
    const onChange = vi.fn()
    const { unmount } = render(<AlignControls elements={three.slice(0, 2)} width={1080} height={1350} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Distribute vertically' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Gap' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Distribute horizontally' }))
    expect(onChange).not.toHaveBeenCalled()
    unmount()
    render(<AlignControls element={three[0]} width={1080} height={1350} onChange={onChange} />)
    expect(screen.queryByRole('group', { name: 'Distribute' })).toBeNull()
  })
})

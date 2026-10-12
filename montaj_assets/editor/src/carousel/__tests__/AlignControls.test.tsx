// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { AlignControls, alignedPosition, alignedPositions } from '../AlignControls'

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

// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { AlignControls, alignedPosition } from '../AlignControls'

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

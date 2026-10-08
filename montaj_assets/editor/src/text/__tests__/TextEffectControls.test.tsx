// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { presetColor, readEffect, TextEffectControls } from '../TextEffectControls'
import type { OverlayElement } from '../../types'

function makeOverlay(props: Record<string, unknown> = {}): OverlayElement {
  return {
    id: 'el-1',
    type: 'overlay',
    frame: 0,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    rotation: 0,
    overlay: { template: 'static-text.jsx', props },
  }
}

const STATIC_TEXT = { text: 'Hi', color: '#ffeeaa', effect: 'none', effectColor: '#000000', effectStrength: '60', fit: 'false' }

function renderControls(props: Record<string, unknown>, update = vi.fn().mockResolvedValue(undefined)) {
  render(<TextEffectControls slideId="s1" element={makeOverlay(props)} updateOverlayProp={update} />)
  return update
}

describe('TextEffectControls', () => {
  it('renders nothing for an overlay whose template takes no effect or fit', () => {
    const { container } = render(
      <TextEffectControls slideId="s1" element={makeOverlay({ text: 'Hi', color: '#fff' })} updateOverlayProp={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the four presets with the current one checked, and no color or strength on None', () => {
    renderControls(STATIC_TEXT)
    const radios = screen.getAllByRole('radio').map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked')])
    expect(radios).toEqual([['None', 'true'], ['Shadow', 'false'], ['Outline', 'false'], ['Glow', 'false']])
    expect(screen.queryByLabelText('Effect strength')).toBeNull()
    expect(screen.queryByLabelText('Effect color')).toBeNull()
  })

  it('one click sets the effect and its starting color: black for a shadow, the text color for a glow', () => {
    const update = renderControls(STATIC_TEXT)
    fireEvent.click(screen.getByRole('radio', { name: 'Shadow' }))
    expect(update.mock.calls).toEqual([
      ['s1', 'el-1', 'effect', 'shadow'],
      ['s1', 'el-1', 'effectColor', '#000000'],
    ])
    update.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: 'Glow' }))
    expect(update.mock.calls).toEqual([
      ['s1', 'el-1', 'effect', 'glow'],
      ['s1', 'el-1', 'effectColor', '#ffeeaa'],
    ])
  })

  it('None writes only the effect, and the current preset writes nothing', () => {
    const update = renderControls({ ...STATIC_TEXT, effect: 'outline' })
    fireEvent.click(screen.getByRole('radio', { name: 'Outline' }))
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(update.mock.calls).toEqual([['s1', 'el-1', 'effect', 'none']])
  })

  it('the strength previews while dragging and writes once, as a string, on release', () => {
    const update = renderControls({ ...STATIC_TEXT, effect: 'shadow' })
    const slider = screen.getByLabelText('Effect strength')
    fireEvent.change(slider, { target: { value: '30' } })
    fireEvent.change(slider, { target: { value: '25' } })
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    expect(update.mock.calls).toEqual([['s1', 'el-1', 'effectStrength', '25']])
  })

  it('Fit to box writes "true" and "false"', () => {
    const update = renderControls(STATIC_TEXT)
    const fit = screen.getByRole('switch', { name: 'Fit text to the box' })
    expect(fit).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(fit)
    expect(update).toHaveBeenLastCalledWith('s1', 'el-1', 'fit', 'true')
  })

  it('reads an unknown effect as None and a non-hex text color as a white glow', () => {
    expect(readEffect(makeOverlay({ effect: 'sparkle' }))).toBe('none')
    expect(presetColor('glow', 'red')).toBe('#ffffff')
    expect(presetColor('outline', '#123456')).toBe('#000000')
  })
})

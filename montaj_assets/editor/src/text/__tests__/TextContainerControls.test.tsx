// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { TextContainerControls, supportsContainer } from '../TextContainerControls'
import { CONTAINER_TEXT_PROPS, STANDARD_TEXT_PROPS } from '../../overlays/contract'
import type { OverlayElement } from '../../types'

const SHIPPED = '/x/render/templates/overlays/static-text/static-text.jsx'

function makeOverlay(props: Record<string, unknown> = {}, template = SHIPPED): OverlayElement {
  return {
    id: 'el-1', type: 'overlay', frame: 0, x: 0, y: 0, w: 200, h: 100, rotation: 0,
    overlay: { template, props },
  }
}

function renderControls(el: OverlayElement, update = vi.fn().mockResolvedValue(undefined)) {
  render(<TextContainerControls slideId="s1" element={el} updateOverlayProp={update} />)
  return update
}

function typeAndBlur(name: string, value: string) {
  const input = screen.getByLabelText(name)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('TextContainerControls', () => {
  it('keeps the container props out of the required contract', () => {
    for (const k of CONTAINER_TEXT_PROPS) expect(STANDARD_TEXT_PROPS.has(k)).toBe(false)
  })

  it('renders nothing for a custom overlay that declares none', () => {
    const el = makeOverlay({ text: 'Hi', color: '#fff' }, '/p/custom.jsx')
    expect(supportsContainer(el)).toBe(false)
    const { container } = render(<TextContainerControls slideId="s1" element={el} updateOverlayProp={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows for the shipped static-text', () => {
    renderControls(makeOverlay({ text: 'Hi' }))
    expect(screen.getByLabelText('Padding X')).toBeTruthy()
    expect(screen.getByLabelText('Border color')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Hug text' })).toBeTruthy()
  })

  it('shows for a custom overlay that already has a container prop', () => {
    renderControls(makeOverlay({ text: 'Hi', radius: '12' }, '/p/custom.jsx'))
    expect((screen.getByLabelText('Radius') as HTMLInputElement).value).toBe('12')
  })

  it('writes numbers as strings on commit', () => {
    const update = renderControls(makeOverlay({ text: 'Hi' }))
    typeAndBlur('Radius', '999')
    typeAndBlur('Padding X', '24')
    typeAndBlur('Letter spacing', '0.05')
    expect(update.mock.calls).toEqual([
      ['s1', 'el-1', 'radius', '999'],
      ['s1', 'el-1', 'padX', '24'],
      ['s1', 'el-1', 'letterSpacing', '0.05'],
    ])
  })

  it('hug toggles on and off', () => {
    const update = renderControls(makeOverlay({ text: 'Hi' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Hug text' }))
    expect(update).toHaveBeenLastCalledWith('s1', 'el-1', 'hug', 'true')
  })

  it('hug on switches off by clearing the prop', () => {
    const update = renderControls(makeOverlay({ text: 'Hi', hug: 'true' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Hug text' }))
    expect(update).toHaveBeenLastCalledWith('s1', 'el-1', 'hug', '')
  })
})

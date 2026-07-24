/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import OverlayPropsModal from '../OverlayPropsModal'

const props = { homeName: 'Colombia', homeScore: 2, accent: '#FCD116', players: [{ n: 1 }] }

test('renders a field per primitive prop and commits merged props', () => {
  const onSave = vi.fn()
  render(<OverlayPropsModal itemProps={props} onSave={onSave} onClose={() => {}} />)

  const name = screen.getByLabelText('homeName')
  fireEvent.change(name, { target: { value: 'Argentina' } })
  const score = screen.getByLabelText('homeScore')
  fireEvent.change(score, { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))

  expect(onSave).toHaveBeenCalledWith({
    homeName: 'Argentina',
    homeScore: 3,            // number kind round-trips as number
    accent: '#FCD116',
    players: [{ n: 1 }],     // non-primitive prop preserved untouched
  })
})

test('escape closes without saving', () => {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<OverlayPropsModal itemProps={props} onSave={onSave} onClose={onClose} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
})

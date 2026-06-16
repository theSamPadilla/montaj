import { render, screen } from '@testing-library/react'
import { ProbeComponent } from '../ProbeComponent'

describe('ProbeComponent', () => {
  it('renders the probe element', () => {
    render(<ProbeComponent />)
    expect(screen.getByTestId('probe')).toBeInTheDocument()
  })
})

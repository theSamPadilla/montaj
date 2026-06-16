import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

function Smoke() {
  return <div>ok</div>
}

describe('smoke', () => {
  it('renders a trivial component', () => {
    render(<Smoke />)
    expect(screen.getByText('ok')).toBeInTheDocument()
  })
})

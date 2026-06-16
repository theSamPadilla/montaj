/**
 * Proof that Vite can consume raw .tsx exports from a file: dependency.
 * If this test compiles and passes, ship-source is confirmed for @bycrux/editor.
 */
import { render, screen } from '@testing-library/react'
import { ProbeComponent } from '@bycrux/editor'

describe('@bycrux/editor raw TSX consumption', () => {
  it('imports and renders ProbeComponent from the file: package', () => {
    render(<ProbeComponent />)
    expect(screen.getByTestId('probe')).toBeInTheDocument()
  })
})

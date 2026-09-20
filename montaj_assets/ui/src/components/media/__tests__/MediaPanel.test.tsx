import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MediaPanel from '../MediaPanel'

function baseProps(overrides: Partial<React.ComponentProps<typeof MediaPanel>> = {}) {
  return {
    footageLabel: 'B-Roll',
    footage: <div>footage body</div>,
    assets: <div>assets body</div>,
    ...overrides,
  }
}

describe('MediaPanel', () => {
  it('renders only Footage and Assets tabs when no audio node is given', () => {
    render(<MediaPanel {...baseProps()} />)
    expect(screen.getByRole('button', { name: 'B-Roll' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assets' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Broll Audio' })).not.toBeInTheDocument()
  })

  it('renders the third tab between Footage and Assets when an audio node is provided', () => {
    render(<MediaPanel {...baseProps({ audio: <div>audio body</div> })} />)
    const tabs = screen.getAllByRole('button').map(b => b.textContent)
    expect(tabs).toEqual(['B-Roll', 'Broll Audio', 'Assets'])
  })

  it('honors a custom audioLabel', () => {
    render(<MediaPanel {...baseProps({ audio: <div />, audioLabel: 'Voiceover' })} />)
    expect(screen.getByRole('button', { name: 'Voiceover' })).toBeInTheDocument()
  })

  it('labels the audio tab "Audio" when the caller passes that label', () => {
    render(<MediaPanel {...baseProps({ audio: <div />, audioLabel: 'Audio' })} />)
    const tabs = screen.getAllByRole('button').map(b => b.textContent)
    expect(tabs).toEqual(['B-Roll', 'Audio', 'Assets'])
  })

  it('shows the footage body first, then switches to the audio body on click', () => {
    render(<MediaPanel {...baseProps({ audio: <div>audio body</div> })} />)
    expect(screen.getByText('footage body')).toBeInTheDocument()
    expect(screen.queryByText('audio body')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Broll Audio' }))
    expect(screen.getByText('audio body')).toBeInTheDocument()
    expect(screen.queryByText('footage body')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Assets' }))
    expect(screen.getByText('assets body')).toBeInTheDocument()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BrollUploadFields from '../BrollUploadFields'

const noop = () => {}

const base = {
  clips: [], setClips: noop,
  assets: [], setAssets: noop,
  voiceover: [], setVoiceover: noop,
}

describe('BrollUploadFields', () => {
  it('renders three distinct intake zones', () => {
    render(<BrollUploadFields {...base} />)
    expect(screen.getByText(/footage/i)).toBeInTheDocument()
    expect(screen.getByText(/assets/i)).toBeInTheDocument()
    expect(screen.getByText(/voiceover/i)).toBeInTheDocument()
  })

  it('states plainly that only the voiceover audio is used', () => {
    render(<BrollUploadFields {...base} />)
    expect(screen.getByText(/only the audio is used/i)).toBeInTheDocument()
  })

  it('shows every selected voiceover filename', () => {
    render(<BrollUploadFields {...base}
      voiceover={[{ name: 'take1.mov', path: '/a/take1.mov' },
                  { name: 'take2.mov', path: '/a/take2.mov' }]} />)
    expect(screen.getByText('take1.mov')).toBeInTheDocument()
    expect(screen.getByText('take2.mov')).toBeInTheDocument()
  })

  it('removes only the take whose remove control was clicked', () => {
    const setVoiceover = vi.fn()
    render(<BrollUploadFields {...base} setVoiceover={setVoiceover}
      voiceover={[{ name: 'take1.mov', path: '/a/take1.mov' },
                  { name: 'take2.mov', path: '/a/take2.mov' }]} />)
    fireEvent.click(screen.getAllByLabelText(/remove take/i)[0])
    expect(setVoiceover).toHaveBeenCalledWith([{ name: 'take2.mov', path: '/a/take2.mov' }])
  })

  it('renders no filenames when no takes are selected', () => {
    render(<BrollUploadFields {...base} voiceover={[]} />)
    expect(screen.queryByLabelText(/remove take/i)).not.toBeInTheDocument()
  })
})

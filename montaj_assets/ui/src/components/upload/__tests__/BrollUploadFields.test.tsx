import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrollUploadFields from '../BrollUploadFields'

const noop = () => {}

const baseProps = {
  clips: [], setClips: noop,
  assets: [], setAssets: noop,
  voiceover: null, setVoiceover: noop,
}

describe('BrollUploadFields', () => {
  it('renders three distinct intake zones', () => {
    render(<BrollUploadFields {...baseProps} />)
    expect(screen.getByText(/footage/i)).toBeInTheDocument()
    expect(screen.getByText(/assets/i)).toBeInTheDocument()
    expect(screen.getByText(/voiceover/i)).toBeInTheDocument()
  })

  it('states plainly that only the voiceover audio is used', () => {
    render(<BrollUploadFields {...baseProps} />)
    expect(screen.getByText(/only the audio is used/i)).toBeInTheDocument()
  })

  it('shows the selected voiceover filename', () => {
    render(<BrollUploadFields {...baseProps} voiceover={{ name: 'narration.wav', path: '/tmp/narration.wav' }} />)
    expect(screen.getByText('narration.wav')).toBeInTheDocument()
  })

  it('lets the voiceover be cleared', async () => {
    const setVoiceover = vi.fn()
    render(<BrollUploadFields {...baseProps}
      voiceover={{ name: 'narration.wav', path: '/tmp/narration.wav' }}
      setVoiceover={setVoiceover} />)
    screen.getByRole('button', { name: /remove voiceover/i }).click()
    expect(setVoiceover).toHaveBeenCalledWith(null)
  })
})

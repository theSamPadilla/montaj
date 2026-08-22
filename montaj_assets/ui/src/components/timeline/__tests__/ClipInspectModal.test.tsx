import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import type { Project } from '@/lib/types/schema'
import ClipInspectModal from '../ClipInspectModal'

// The clip modal also renders a "Clip audio" card with its own volume
// <input type="range">, so every speed assertion is scoped to the "Clip
// speed" card's container to avoid ambiguous role queries. "Clip speed" is
// SpeedControl's own header label two levels below the card: label span ->
// SpeedControl's header row -> SpeedControl's root -> the card the modal
// wraps it in (which also holds the Save button).
function speedCard() {
  return screen.getByText('Clip speed').closest('div')!.parentElement!.parentElement as HTMLElement
}

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '1',
    id: 'proj-1',
    name: 'Test project',
    workflow: 'clean_cut',
    status: 'draft',
    editingPrompt: '',
    settings: { resolution: [1920, 1080] },
    assets: [],
    tracks: [],
    ...overrides,
  } as unknown as Project
}

function twoClipProject(overrides: { clip1Speed?: number } = {}): Project {
  return baseProject({
    tracks: [
      {
        id: 'trk-0',
        items: [
          { id: 'clip-1', type: 'video', src: '/a.mp4', start: 0, end: 4, speed: overrides.clip1Speed },
          { id: 'clip-2', type: 'video', src: '/b.mp4', start: 4, end: 8 },
        ],
      },
    ],
  } as unknown as Partial<Project>)
}

function renderModal(project: Project, opts: { rippleMode?: boolean } = {}) {
  const onProjectChange = vi.fn()
  const onSave = vi.fn(async () => {})
  const rippleMode = opts.rippleMode ?? false
  render(
    <ClipInspectModal
      project={project}
      target={{ kind: 'clip', id: 'clip-1' }}
      onClose={() => {}}
      onProjectChange={onProjectChange}
      onSave={onSave}
      rippleMode={rippleMode}
    />,
  )
  return { onProjectChange, onSave }
}

describe('ClipInspectModal — clip speed', () => {
  it('renders the speed section reflecting the clip current speed', () => {
    const project = twoClipProject({ clip1Speed: 2 })
    renderModal(project)

    const card = speedCard()
    const slider = within(card).getByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('2')
    expect(within(card).getByText('2.00×')).toBeInTheDocument()
    // The matching preset chip reads as the active one.
    expect(within(card).getByRole('button', { name: '2×' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('defaults to 1x when the clip has no speed set', () => {
    const project = twoClipProject()
    renderModal(project)

    const card = speedCard()
    const slider = within(card).getByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('1')
    expect(within(card).getByText('1.00×')).toBeInTheDocument()
  })

  it('clicking a preset chip sets the pending value, and Save persists it (2x halves the span)', async () => {
    const project = twoClipProject()
    const { onProjectChange, onSave } = renderModal(project)

    fireEvent.click(within(speedCard()).getByRole('button', { name: '2×' }))
    expect(within(speedCard()).getByRole('slider')).toHaveValue('2')
    fireEvent.click(within(speedCard()).getByRole('button', { name: /save speed/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    const next = onProjectChange.mock.calls[0][0] as Project
    const clip1 = next.tracks![0].items.find(c => c.id === 'clip-1')!
    expect(clip1.speed).toBe(2)
    expect(clip1.start).toBe(0)
    expect(clip1.end).toBe(2)
    expect(onSave).toHaveBeenCalledWith(next)
  })

  it('closes the gap on the following clip when ripple mode is on', async () => {
    const project = twoClipProject()
    const { onProjectChange, onSave } = renderModal(project, { rippleMode: true })

    fireEvent.click(within(speedCard()).getByRole('button', { name: '2×' }))
    fireEvent.click(within(speedCard()).getByRole('button', { name: /save speed/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const next = onProjectChange.mock.calls[0][0] as Project
    const clip2 = next.tracks![0].items.find(c => c.id === 'clip-2')!
    // clip-1 shrinks from [0,4] to [0,2]; ripple pulls clip-2 up to start at 2.
    expect(clip2.start).toBe(2)
  })

  it('leaves the gap on the following clip when ripple mode is off', async () => {
    const project = twoClipProject()
    const { onProjectChange, onSave } = renderModal(project, { rippleMode: false })

    fireEvent.click(within(speedCard()).getByRole('button', { name: '2×' }))
    fireEvent.click(within(speedCard()).getByRole('button', { name: /save speed/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const next = onProjectChange.mock.calls[0][0] as Project
    const clip2 = next.tracks![0].items.find(c => c.id === 'clip-2')!
    // No ripple: clip-2 stays put, leaving a gap where clip-1 used to reach.
    expect(clip2.start).toBe(4)
  })

  it('disables Save speed until the value changes', () => {
    const project = twoClipProject()
    renderModal(project)

    const card = speedCard()
    expect(within(card).getByRole('button', { name: /save speed/i })).toBeDisabled()
    fireEvent.click(within(card).getByRole('button', { name: '2×' }))
    expect(within(card).getByRole('button', { name: /save speed/i })).not.toBeDisabled()
  })
})

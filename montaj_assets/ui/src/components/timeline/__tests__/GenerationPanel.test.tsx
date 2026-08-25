import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Project } from '@/lib/types/schema'
import GenerationPanel from '../GenerationPanel'

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

function aiVideoProject(overrides: { generation?: Record<string, unknown> | null } = {}): Project {
  const generation =
    overrides.generation === null
      ? undefined
      : {
          sceneId: 'scene-1',
          prompt: 'A dog runs through a field',
          provider: 'kling',
          model: 'kling-v3-omni',
          duration: 5,
          refImages: ['ref-1'],
          ...overrides.generation,
        }
  return baseProject({
    projectType: 'ai_video',
    storyboard: {
      imageRefs: [{ id: 'ref-1', label: 'Hero shot', refImages: [], source: 'upload', status: 'ready' }],
      styleRefs: [],
      scenes: [{ id: 'scene-1', prompt: 'Scene pre-composition prompt', duration: 5, refImages: [] }],
    },
    tracks: [
      {
        id: 'trk-0',
        items: [{ id: 'clip-1', type: 'video', src: '/a.mp4', start: 0, end: 5, generation }],
      },
    ],
  } as unknown as Partial<Project>)
}

function renderPanel(project: Project, clipId = 'clip-1') {
  const onProjectChange = vi.fn()
  const onSave = vi.fn(async () => {})
  const { container } = render(
    <GenerationPanel project={project} clipId={clipId} onProjectChange={onProjectChange} onSave={onSave} />,
  )
  return { onProjectChange, onSave, container }
}

describe('GenerationPanel', () => {
  it('renders nothing when the project is not ai_video', () => {
    const project = baseProject({
      tracks: [
        {
          id: 'trk-0',
          items: [{ id: 'clip-1', type: 'video', src: '/a.mp4', start: 0, end: 5, generation: { prompt: 'x' } }],
        },
      ],
    } as unknown as Partial<Project>)
    const { container } = renderPanel(project)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the clip has no generation', () => {
    const project = aiVideoProject({ generation: null })
    const { container } = renderPanel(project)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the frozen provenance for an ai_video clip with a generation', () => {
    const project = aiVideoProject()
    renderPanel(project)

    expect(screen.getByText('A dog runs through a field')).toBeInTheDocument()
    expect(screen.getByText('scene-1')).toBeInTheDocument()
    expect(screen.getByText('kling-v3-omni')).toBeInTheDocument()
  })

  it('entering regen mode shows the form seeded from the generation', () => {
    const project = aiVideoProject()
    renderPanel(project)

    fireEvent.click(screen.getByRole('button', { name: /regenerate this clip/i }))

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveValue('A dog runs through a field')
    // Default generation model is kling-v3-omni, so duration is the free-form
    // number input (not the 5s/10s chip pair, which only kling-video-o1 gets).
    expect(screen.getByRole('spinbutton', { name: /duration/i })).toHaveValue(5)
    expect(screen.getByRole('combobox', { name: /model/i })).toHaveValue('kling-v3-omni')
  })

  it('constrains duration to 5 or 10 when kling-video-o1 is selected', () => {
    const project = aiVideoProject()
    renderPanel(project)

    fireEvent.click(screen.getByRole('button', { name: /regenerate this clip/i }))
    fireEvent.change(screen.getByRole('combobox', { name: /model/i }), { target: { value: 'kling-video-o1' } })

    // Duration switches from the free-form number input to the 5s/10s chip pair.
    expect(screen.getByRole('button', { name: '5s' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '10s' })).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })

  it('queues exactly one correctly-shaped RegenQueueEntry and calls onSave then onProjectChange', async () => {
    const project = aiVideoProject()
    const { onProjectChange, onSave } = renderPanel(project)

    fireEvent.click(screen.getByRole('button', { name: /regenerate this clip/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), { target: { value: 'A cat runs through a field' } })
    fireEvent.click(screen.getByRole('button', { name: /queue regeneration/i }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onProjectChange).toHaveBeenCalledTimes(1)

    const saveOrder = onSave.mock.invocationCallOrder[0]
    const changeOrder = onProjectChange.mock.invocationCallOrder[0]
    expect(saveOrder).toBeLessThan(changeOrder)

    const next = onProjectChange.mock.calls[0][0] as Project
    expect(next.regenQueue).toHaveLength(1)
    const entry = next.regenQueue![0]
    expect(entry).toMatchObject({
      clipId: 'clip-1',
      mode: 'full',
      subrange: null,
      prompt: 'A cat runs through a field',
      refImages: ['ref-1'],
      duration: 5,
      useFirstFrame: false,
      useLastFrame: false,
      model: 'kling-v3-omni',
    })
    expect(entry.id).toEqual(expect.any(String))
    expect(entry.requestedAt).toEqual(expect.any(String))
    expect(onSave).toHaveBeenCalledWith(next)
  })

  it('renders no volume, mute, or speed control — those belong to the editor now', () => {
    const project = aiVideoProject()
    renderPanel(project)

    expect(screen.queryByText(/volume/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/mute/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/speed/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('GenerationPanel — must re-seed when the selected clip changes', () => {
  /** Two AI clips with DIFFERENT generation content, so a stale form is obvious. */
  function twoClipProject(): Project {
    const mk = (id: string, prompt: string, model: string) => ({
      id, type: 'video', src: `/${id}.mp4`, start: 0, end: 5,
      generation: { sceneId: 'scene-1', prompt, provider: 'kling', model, duration: 5, refImages: [] },
    })
    return baseProject({
      projectType: 'ai_video',
      storyboard: {
        imageRefs: [], styleRefs: [],
        scenes: [{ id: 'scene-1', prompt: 'Scene prompt', duration: 5, refImages: [] }],
      },
      tracks: [{ id: 'trk-0', items: [
        mk('clip-A', 'A dog runs through a field', 'kling-v3-omni'),
        mk('clip-B', 'A city street at night', 'kling-video-o1'),
      ] }],
    } as unknown as Partial<Project>)
  }

  // THE REGRESSION THIS PINS: the panel seeds its regen form in `useState`
  // initializers, which run once per MOUNT. Rendered without a key, switching
  // between two video clips reconciles the component IN PLACE, so the form
  // keeps the PREVIOUS clip's prompt/model while `clipId` points at the new
  // one — queueing a regeneration that spends credits on the wrong content.
  // The retired ClipInspectModal never hit this because it remounted on every
  // double-click. `key={clipId}` at the call site is what restores that.
  it('re-seeds the form when keyed by clipId (the fix), instead of keeping the old clip content', () => {
    const project = twoClipProject()
    const props = { project, onProjectChange: vi.fn(), onSave: vi.fn(async () => {}) }

    const { rerender } = render(<GenerationPanel key="clip-A" clipId="clip-A" {...props} />)
    expect(screen.getByText('A dog runs through a field')).toBeTruthy()

    // Same position in the tree, different key -> React remounts, so the
    // initializers re-run against clip B.
    rerender(<GenerationPanel key="clip-B" clipId="clip-B" {...props} />)
    expect(screen.getByText('A city street at night')).toBeTruthy()
    expect(screen.queryByText('A dog runs through a field')).toBeNull()
  })

  it('WITHOUT a key the form goes stale — documenting exactly why the key is load-bearing', () => {
    const project = twoClipProject()
    const props = { project, onProjectChange: vi.fn(), onSave: vi.fn(async () => {}) }

    const { rerender } = render(<GenerationPanel clipId="clip-A" {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Regenerate this clip/i }))
    const field = screen.getByRole('textbox', { name: /prompt/i }) as HTMLTextAreaElement
    expect(field.value).toBe('A dog runs through a field')

    // No key: same element type at the same position, so state survives and
    // the form still shows clip A while clipId is now clip B.
    rerender(<GenerationPanel clipId="clip-B" {...props} />)
    expect((screen.getByRole('textbox', { name: /prompt/i }) as HTMLTextAreaElement).value)
      .toBe('A dog runs through a field')
  })
})

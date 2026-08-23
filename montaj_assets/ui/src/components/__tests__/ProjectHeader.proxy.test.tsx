import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Project } from '@/lib/types/schema'

const { generateProxies } = vi.hoisted(() => ({
  generateProxies: vi.fn(async () => ({ scheduled: 1, alreadyFresh: 0 })),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getProject:      vi.fn(),
    saveProject:     vi.fn(),
    deleteProject:   vi.fn(),
    generateProxies,
  },
}))

import ProjectHeader from '../ProjectHeader'

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

function renderHeader(project: Project) {
  return render(
    <MemoryRouter>
      <ProjectHeader project={project} onProjectChange={() => {}} />
    </MemoryRouter>,
  )
}

beforeEach(() => generateProxies.mockClear())

describe('ProjectHeader — proxy migration chip', () => {
  it('shows the chip when a video item lacks proxySrc', () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 5 }] }],
    })
    renderHeader(project)
    expect(screen.getByText('Generate previews')).toBeInTheDocument()
  })

  it('hides the chip when every video item already has a proxySrc', () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/a.mp4', proxySrc: '/a_proxy.mp4', start: 0, end: 5 }] }],
    })
    renderHeader(project)
    expect(screen.queryByText('Generate previews')).not.toBeInTheDocument()
  })

  it('hides the chip when settings.proxy is explicitly false', () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 5 }] }],
      settings: { resolution: [1920, 1080], proxy: false } as unknown as Project['settings'],
    })
    renderHeader(project)
    expect(screen.queryByText('Generate previews')).not.toBeInTheDocument()
  })

  it('hides the chip for a project with no video items', () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'image', src: '/a.png', start: 0, end: 5 }] }],
    })
    renderHeader(project)
    expect(screen.queryByText('Generate previews')).not.toBeInTheDocument()
  })

  it('opens the modal when the chip is clicked', () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 5 }] }],
    })
    renderHeader(project)
    fireEvent.click(screen.getByText('Generate previews'))
    expect(screen.getByText('Generate editing previews')).toBeInTheDocument()
  })

  it('calls api.generateProxies when "Generate now" is clicked', async () => {
    const project = baseProject({
      tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/a.mp4', start: 0, end: 5 }] }],
    })
    renderHeader(project)
    fireEvent.click(screen.getByText('Generate previews'))
    fireEvent.click(screen.getByText('Generate now'))
    await waitFor(() => expect(generateProxies).toHaveBeenCalledWith('proj-1'))
  })
})

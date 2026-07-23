import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { Project } from '@/lib/types/schema'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// EditorPage builds a real montajAdapter that wraps `api.*`. Stub the api surface
// the assembled package CarouselEditor touches on mount (getInfo / overlay lists /
// getProject). useProjectStream is a no-op here; useIsMobile forces the desktop
// path so the package CarouselEditor (not the mobile preview) renders.

const carouselProject: Project = {
  version: '1',
  id: 'proj-carousel-1',
  name: 'Carousel Test',
  workflow: 'carousel',
  status: 'draft',
  editingPrompt: '',
  projectType: 'carousel',
  settings: { resolution: [1080, 1080] },
  assets: [],
  slides: [
    { id: 'slide-0', base_color: '#ffffff', elements: [] },
  ],
} as unknown as Project

vi.mock('@/lib/api', () => ({
  api: {
    getProject: vi.fn(async () => carouselProject),
    saveProject: vi.fn(async () => {}),
    getInfo: vi.fn(async () => ({ skill_path: '', root_skill_path: 'skills/carousel', style_profile_skill_path: '' })),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    listProfileOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    reservePath: vi.fn(async () => ({ path: '/p.png' })),
    runStep: vi.fn(async () => ({ path: '/p.png' })),
    runStepAsync: vi.fn(async () => ({ path: '/p.png' })),
    renderProject: vi.fn(async () => () => {}),
  },
  fileUrl: (p: string) => `/api/files?path=${encodeURIComponent(p)}`,
}))

vi.mock('@/lib/sse', () => ({
  useProjectStream: vi.fn(),
}))

vi.mock('@/lib/useIsMobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
}))

import EditorPage from '../EditorPage'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // ResizeObserver / EventSource aren't in jsdom.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = class {
    close() {}
  }
})
afterEach(() => vi.restoreAllMocks())

describe('EditorPage — carousel project', () => {
  it('renders the package CarouselEditor with the AssetsPanel slot', async () => {
    const { getByText, getByTitle } = render(
      <MemoryRouter
        initialEntries={[{ pathname: '/editor/proj-carousel-1', state: { project: carouselProject } }]}
      >
        <Routes>
          <Route path="/editor/:id" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    // Stable package-owned element: the Render button title.
    await waitFor(() => getByTitle('Render all slides as PNGs'))
    // The host-supplied AssetsPanel slot is mounted (its "Assets" header).
    expect(getByText('Assets')).toBeInTheDocument()
  })
})

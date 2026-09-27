import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import type { EditorAdapter, Project, ImageElement } from '../../types'
import RenderModal from '../RenderModal'

// The Export dialog portals to document.body, outside the editor root. A host
// whose page text is dark (the desktop app's `text-gray-900`) must not leak
// that colour into the dialog: the portal root sets the editor's own text
// colour, and every control carries an explicit themed colour.

afterEach(cleanup)

const HOST_DARK_TEXT = 'rgb(17, 24, 39)'
let prevColor = ''
beforeEach(() => { prevColor = document.body.style.color; document.body.style.color = HOST_DARK_TEXT })
afterEach(() => { document.body.style.color = prevColor })

function adapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: vi.fn(async function* () {}),
    renderAsync: vi.fn(async () => ({ status: 'running' })),
    getRenderStatus: vi.fn(async () => ({ status: 'running' as const, phase: 'rendering' as const })),
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => `/files?path=${p}`,
  } as unknown as EditorAdapter<Project>
}

function renderExport() {
  return render(
    <RenderModal
      adapter={adapter()}
      projectId="vid-1"
      onClose={vi.fn()}
      preRenderOptions={{
        isHdr: false,
        keeps: [{ start: 0, end: 12 }],
        resolution: { value: [1080, 1920], available: [[720, 1280], [1080, 1920]], set: vi.fn() },
      }}
    />,
  )
}

const THEMED_TEXT = /(^|\s)text-\[(var\(--editor-text\)|color-mix\(in_srgb,var\(--editor-text\)_\d+%,transparent\))\]/

describe('Export dialog in a dark-text host', () => {
  it('the portal root sets the editor text colour', () => {
    renderExport()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const root = cancel.closest('.fixed')
    expect(root).not.toBeNull()
    expect(root!.className).toMatch(/(^|\s)text-\[var\(--editor-text\)\](\s|$)/)
  })

  it('Cancel has a non-empty label and an explicit themed text colour', () => {
    renderExport()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel.textContent?.trim()).toBe('Cancel')
    expect(cancel.className).toMatch(THEMED_TEXT)
  })

  it('every resolution tile, 720p included, shows its dims in a themed colour', () => {
    renderExport()
    const group = screen.getByRole('radiogroup', { name: 'Resolution' })
    const tile720 = within(group).getByRole('radio', { name: /720p/ })
    const dims720 = within(tile720).getByText('720 × 1280')
    expect(dims720.className).toMatch(THEMED_TEXT)
    const tile1080 = within(group).getByRole('radio', { name: /1080p/ })
    expect(within(tile1080).getByText('1080 × 1920').className).toMatch(THEMED_TEXT)
  })

  it('the selected tile uses the editor accent, not a hard-coded violet', () => {
    renderExport()
    const group = screen.getByRole('radiogroup', { name: 'Resolution' })
    const active = within(group).getByRole('radio', { checked: true })
    expect(active.className).toContain('border-[var(--editor-accent)]')
    expect(active.className).not.toMatch(/violet|indigo/)
  })
})

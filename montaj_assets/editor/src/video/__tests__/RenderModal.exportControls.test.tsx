import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import type { EditorAdapter, Project, ImageElement } from '../../types'
import type { VisualTrack, VisualItem } from '../../schema'
import RenderModal from '../RenderModal'
import { availableResolutionTiers, availableFpsTiers } from '../export-limits'

afterEach(cleanup)

// ── Export dialog — resolution + fps tier pickers ──────────────────────────────
// RenderModal.tsx renders these as two radiogroups ("Resolution" / "Frame rate")
// between "Save to" and the HDR-only "Format" block, only when the host supplies
// the corresponding `preRenderOptions.resolution` / `.fps` control. Copied
// factories from RenderModal.options.test.tsx — that file does not export them.

function baseAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: vi.fn(async function* () {}),
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => `/files?path=${p}`,
  } as unknown as EditorAdapter<Project>
}

/** An adapter on the poll transport (renderAsync + getRenderStatus). */
function pollAdapter(): EditorAdapter<Project> {
  const a = baseAdapter()
  a.renderAsync = vi.fn(async () => ({ status: 'running' }))
  a.getRenderStatus = vi.fn(async () => ({ status: 'running' as const, phase: 'rendering' as const }))
  return a
}

const KEEPS = [{ start: 0, end: 12 }]

// Minimal project factory + helpers, for composing preRenderOptions.resolution
// from the real export-limits functions (same shape as export-limits.test.ts).
function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

let nextId = 0
function videoClip(over: Partial<VisualItem> = {}): VisualItem {
  nextId += 1
  return { id: `v${nextId}`, type: 'video', start: 0, end: 5, ...over }
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

const resGroup = () => screen.getByRole('radiogroup', { name: 'Resolution' })
const fpsGroup = () => screen.getByRole('radiogroup', { name: 'Frame rate' })

describe('RenderModal — Resolution radiogroup', () => {
  it('renders when preRenderOptions.resolution is present, with the active tile matching value', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available: [[720, 1280], [1080, 1920]], set: vi.fn() },
        }}
      />,
    )

    const radios = within(resGroup()).getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const active = radios.find(r => r.getAttribute('aria-checked') === 'true')
    expect(active).toBeTruthy()
    expect(within(active!).getByText('1080p (HD)')).toBeTruthy()
  })

  it('is absent from the DOM when preRenderOptions.resolution is absent', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS }}
      />,
    )

    expect(screen.queryByRole('radiogroup', { name: 'Resolution' })).toBeNull()
  })

  it('flags only the MAX available tier as recommended', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: {
            value: [1080, 1920],
            available: [[720, 1280], [1080, 1920], [2160, 3840]],
            set: vi.fn(),
          },
        }}
      />,
    )

    const radios = within(resGroup()).getAllByRole('radio')
    radios.forEach(radio => {
      const hasBadge = within(radio).queryByText(/recommended/i) !== null
      const is2160 = within(radio).queryByText('2160p (4K)') !== null
      expect(hasBadge).toBe(is2160)
    })
  })

  it('does not offer 1440p or 2160p for a 1080p-source-only project', () => {
    const project = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 1080, sourceHeight: 1920 })]),
    })
    const available = availableResolutionTiers(project)

    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available, set: vi.fn() },
        }}
      />,
    )

    expect(within(resGroup()).queryByText(/1440p/)).toBeNull()
    expect(within(resGroup()).queryByText(/2160p/)).toBeNull()
  })

  it('offers up to 2160p for a 4K-source project, with 2160p recommended and 1080p not', () => {
    const project = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 2160, sourceHeight: 3840 })]),
    })
    const available = availableResolutionTiers(project)

    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available, set: vi.fn() },
        }}
      />,
    )

    const radios = within(resGroup()).getAllByRole('radio')
    const tile2160 = radios.find(r => within(r).queryByText('2160p (4K)') !== null)
    const tile1080 = radios.find(r => within(r).queryByText('1080p (HD)') !== null)
    expect(tile2160).toBeTruthy()
    expect(tile1080).toBeTruthy()
    expect(within(tile2160!).queryByText(/recommended/i)).toBeTruthy()
    expect(within(tile1080!).queryByText(/recommended/i)).toBeNull()
  })

  it('calls set with the clicked tier, never the current value', () => {
    const set = vi.fn()
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available: [[720, 1280], [1080, 1920]], set },
        }}
      />,
    )

    const radios = within(resGroup()).getAllByRole('radio')
    const tile720 = radios.find(r => within(r).queryByText('720p') !== null)!
    fireEvent.click(tile720)

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith([720, 1280])
    expect(set).not.toHaveBeenCalledWith([1080, 1920])
  })

  it('renders a single button for a single-tier available list', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: false,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available: [[1080, 1920]], set: vi.fn() },
        }}
      />,
    )

    expect(within(resGroup()).getAllByRole('radio')).toHaveLength(1)
  })

  it('reflects an updated resolution.value as the active tile on re-render', () => {
    const set = vi.fn()
    const adapter = pollAdapter()
    const available: Array<[number, number]> = [[720, 1280], [1080, 1920]]

    const { rerender } = render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, resolution: { value: [1080, 1920], available, set } }}
      />,
    )

    let active = within(resGroup()).getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')!
    expect(within(active).getByText('1080p (HD)')).toBeTruthy()

    rerender(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, resolution: { value: [720, 1280], available, set } }}
      />,
    )

    active = within(resGroup()).getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')!
    expect(within(active).getByText('720p')).toBeTruthy()
  })
})

describe('RenderModal — Frame rate radiogroup', () => {
  it('renders when preRenderOptions.fps is present, with the active tile matching value', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, fps: { value: 30, available: [24, 30], set: vi.fn() } }}
      />,
    )

    const radios = within(fpsGroup()).getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const active = radios.find(r => r.getAttribute('aria-checked') === 'true')
    expect(active).toBeTruthy()
    expect(within(active!).getByText('30 fps')).toBeTruthy()
  })

  it('is absent from the DOM when preRenderOptions.fps is absent', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS }}
      />,
    )

    expect(screen.queryByRole('radiogroup', { name: 'Frame rate' })).toBeNull()
  })

  it('calls set with the clicked fps tier', () => {
    const set = vi.fn()
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, fps: { value: 30, available: [24, 30], set } }}
      />,
    )

    const radios = within(fpsGroup()).getAllByRole('radio')
    const tile24 = radios.find(r => within(r).queryByText('24 fps') !== null)!
    fireEvent.click(tile24)

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(24)
  })

  it('composes a full fps tier set (up to 60) for a 60fps project via availableFpsTiers', () => {
    const project = makeProject({ settings: { resolution: [1080, 1920], fps: 60 } })
    const available = availableFpsTiers(project)
    expect(available).toEqual([24, 30, 60])

    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, fps: { value: 60, available, set: vi.fn() } }}
      />,
    )

    expect(within(fpsGroup()).getAllByRole('radio')).toHaveLength(3)
  })
})

describe('RenderModal — export controls DOM order', () => {
  it('orders Name, Resolution, Frame rate, then Format (HDR) top to bottom', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{
          isHdr: true,
          keeps: KEEPS,
          resolution: { value: [1080, 1920], available: [[720, 1280], [1080, 1920]], set: vi.fn() },
          fps: { value: 30, available: [24, 30], set: vi.fn() },
        }}
      />,
    )

    const text = document.body.textContent ?? ''
    const iName = text.indexOf('Name')
    const iResolution = text.indexOf('Resolution')
    const iFrameRate = text.indexOf('Frame rate')
    const iFormat = text.indexOf('Format')

    expect(iName).toBeGreaterThanOrEqual(0)
    expect(iResolution).toBeGreaterThan(iName)
    expect(iFrameRate).toBeGreaterThan(iResolution)
    expect(iFormat).toBeGreaterThan(iFrameRate)
  })
})

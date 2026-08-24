/// <reference types="vite/client" />
/**
 * CaptionListPanel — the Bold toggle and the manual generate/regenerate
 * trigger (including its empty state).
 *
 * Sits in `__tests__/` alongside `CaptionListPanel.font.test.tsx` rather than
 * beside the component, and does not modify or import from the sibling
 * `../CaptionListPanel.test.tsx` — its own render helpers and fixtures mirror
 * that file's shape independently, per the same convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { Project } from '../../types'
import type { Captions, CaptionSegment } from '../../schema'
import type { PlaybackClock } from '../playback-clock'
import CaptionListPanel, { type CaptionListPanelProps } from '../CaptionListPanel'

// The "Caption style" subsection's expanded/collapsed state persists to
// localStorage (usePersistentState) — clear it between tests or an earlier
// `expandStyle()` leaks in and TOGGLES the section shut instead of open.
beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

Element.prototype.scrollIntoView = vi.fn()

const SEGS: CaptionSegment[] = [
  { id: 'cap-0', text: 'hello world', start: 0, end: 2 },
  { id: 'cap-1', text: 'goodbye now', start: 2, end: 4 },
]

function makeClock(): PlaybackClock {
  return { get: () => 0, set: vi.fn(), subscribe: () => () => {} }
}

function renderPanel(opts: {
  captions?: Captions | undefined
  withRegenerate?: boolean
  captionsGenerating?: boolean
} = {}) {
  // `'captions' in opts`, not a destructured default: a destructured default
  // also kicks in for an explicitly-passed `captions: undefined`, which is
  // exactly the "no captionTrack at all" case several tests below need to
  // construct on purpose.
  const captions = 'captions' in opts ? opts.captions : { style: 'pop', fontsize: 46, segments: SEGS }
  const { withRegenerate = true, captionsGenerating } = opts

  const project = { id: 'p1', captions } as unknown as Project
  const onCaptionEdit = vi.fn()
  const onProjectChange = vi.fn()
  const onRegenerateCaptions = withRegenerate ? vi.fn() : undefined

  const view = render(
    <CaptionListPanel
      captionTrack={project.captions}
      project={project}
      currentTime={0}
      selectedIds={[]}
      onSelectCaption={vi.fn()}
      onCaptionSegmentChange={vi.fn()}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onCaptionSegmentDelete={vi.fn()}
      onRegenerateCaptions={onRegenerateCaptions}
      captionsGenerating={captionsGenerating}
      fps={30}
      clock={makeClock()}
      editFocusId={null}
    />,
  )
  return { ...view, project, onCaptionEdit, onProjectChange, onRegenerateCaptions }
}

function expandStyle() {
  fireEvent.click(screen.getByLabelText('Caption style controls'))
}

describe('CaptionListPanel Bold toggle', () => {
  it('reads as pressed when fontWeight is absent', () => {
    renderPanel({ captions: { style: 'pop', fontsize: 46, segments: SEGS } })
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking while pressed commits fontWeight: 400', () => {
    const { onCaptionEdit } = renderPanel({ captions: { style: 'pop', fontsize: 46, segments: SEGS } })
    expandStyle()
    fireEvent.click(screen.getByLabelText('Bold'))

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.fontWeight).toBe(400)
  })

  // THE assertion this toggle exists for: turning bold back on has to DELETE
  // the key, not write a flat 700 back — a single shared weight would flatten
  // all seven caption styles onto one look. A lazy `fontWeight: undefined`
  // write would pass a `toBeUndefined()` check but still leave the key IN the
  // object (and JSON.stringify would only drop it later, silently, on the
  // trip to the server) — so this checks key ABSENCE directly.
  it('clicking while off (fontWeight: 400) commits captions with no fontWeight key at all', () => {
    const { onCaptionEdit } = renderPanel({ captions: { style: 'pop', fontsize: 46, segments: SEGS, fontWeight: 400 } })
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByLabelText('Bold'))

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    const captions = onCaptionEdit.mock.calls[0][0].captions
    expect('fontWeight' in captions).toBe(false)
  })
})

describe('CaptionListPanel generate/regenerate trigger', () => {
  it('with no captions and a host that supports generation, shows the empty state and its button fires onRegenerateCaptions', () => {
    const { onRegenerateCaptions } = renderPanel({ captions: undefined, withRegenerate: true })

    const btn = screen.getByRole('button', { name: 'Generate captions' })
    fireEvent.click(btn)
    expect(onRegenerateCaptions).toHaveBeenCalledTimes(1)
  })

  it('with captions present, the trigger reads "Regenerate captions"', () => {
    renderPanel({ captions: { style: 'pop', fontsize: 46, segments: SEGS } })
    expect(screen.getByRole('button', { name: 'Regenerate captions' })).toBeTruthy()
  })

  it('with no captions and a host that does NOT support generation, shows explanatory text and no button', () => {
    // A captions object with zero segments (not `undefined`) — the panel's
    // own "nothing to show and nothing to offer" guard hides the WHOLE panel
    // when both captionTrack and onRegenerateCaptions are absent, which is a
    // different (already-covered) case from this one: an existing project
    // that has a captions track but happens to have no rows left, on a host
    // (Hub/LP) with no generation capability at all.
    renderPanel({ captions: { style: 'pop', fontsize: 46, segments: [] }, withRegenerate: false })

    expect(screen.getByText(/no captions yet/i)).toBeTruthy()
    // Scoped to the empty-state body, not the whole panel: the "Caption
    // style controls" disclosure toggle is itself a `<button>` in the header
    // and is unrelated to the generate/regenerate trigger this test covers.
    const list = screen.getByRole('list', { name: 'Caption segments' })
    expect(within(list).queryByRole('button')).toBeNull()
  })

  it('disables the trigger while a job is running', () => {
    renderPanel({ captions: { style: 'pop', fontsize: 46, segments: SEGS }, captionsGenerating: true })
    expect(screen.getByRole('button', { name: 'Regenerate captions' })).toBeDisabled()
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { CaptionEvent, CaptionProfileDefaults, EditorAdapter, ImageElement, Project } from '../../types'
import type { Captions } from '../../schema'
import CaptionRegenModal from '../CaptionRegenModal'

afterEach(() => cleanup())

const doneCaptions: Captions = {
  style: 'pop',
  segments: [{ text: 'hola', start: 0, end: 1, words: [] }],
}

function makeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: async function* () {},
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => p,
    generateCaptions: async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'log', message: 'transcribing audio…' }
      yield { type: 'done', captions: doneCaptions }
    },
  } as unknown as EditorAdapter<Project>
}

describe('CaptionRegenModal', () => {
  it('streams a log line and calls onDone with the final captions', async () => {
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(
      <CaptionRegenModal
        adapter={makeAdapter()}
        projectId="vid-1"
        existingRowCount={1}
        onDone={onDone}
        onClose={onClose}
      />,
    )

    await waitFor(() => expect(screen.getByText(/transcribing audio/i)).toBeTruthy())
    // Second argument is the profile defaults the host resolved — `null` on
    // this adapter, which implements no `getCaptionProfileDefaults`.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(doneCaptions, null))
  })

  it('shows an error message verbatim on error', async () => {
    const errorAdapter = makeAdapter()
    errorAdapter.generateCaptions = async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'error', message: 'multi_source' }
    }
    render(
      <CaptionRegenModal
        adapter={errorAdapter}
        projectId="vid-1"
        existingRowCount={1}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('multi_source')).toBeTruthy())
  })

  it('warns how many rows will be discarded when the project has more than one', async () => {
    render(
      <CaptionRegenModal
        adapter={makeAdapter()}
        projectId="vid-1"
        existingRowCount={3}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/replace all 3 caption rows with a single new row/i)).toBeTruthy())
  })

  it('shows no discard warning for a single-row (or empty) project', async () => {
    render(
      <CaptionRegenModal
        adapter={makeAdapter()}
        projectId="vid-1"
        existingRowCount={1}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/transcribing audio/i)).toBeTruthy())
    expect(screen.queryByText(/caption rows/i)).toBeNull()
  })
})

// ── Profile-seeded caption defaults ──────────────────────────────────────────
//
// `adapter.getCaptionProfileDefaults` is an OPTIONAL host seam: this package
// owns no notion of what a profile is beyond `Project.profile`'s bare name, so
// a host that can resolve one answers, and a host that cannot omits the method
// entirely. Every assertion below therefore comes in a pair — the seam present
// and the seam absent — because the absent case is the one every existing host
// (Hub, Los Parceros, the OSS `serve` UI) is in today, and it must keep
// producing the byte-identical call it produced before this seam existed.

/** Adapter whose `generateCaptions` is a spy, so the opts argument is readable. */
function makeSpyAdapter() {
  const adapter = makeAdapter()
  const generateCaptions = vi.fn(async function* (): AsyncIterable<CaptionEvent> {
    yield { type: 'done', captions: doneCaptions }
  })
  adapter.generateCaptions = generateCaptions
  return { adapter, generateCaptions }
}

const PROFILE_DEFAULTS: CaptionProfileDefaults = {
  style: 'karaoke',
  fontFamily: '"Inter", system-ui, sans-serif',
  color: '#112233',
}

describe('CaptionRegenModal — profile-seeded caption defaults', () => {
  it('seeds the generation style from the defaults the host resolves for the project profile', async () => {
    const { adapter, generateCaptions } = makeSpyAdapter()
    const getCaptionProfileDefaults = vi.fn(async () => PROFILE_DEFAULTS)
    adapter.getCaptionProfileDefaults = getCaptionProfileDefaults

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        profile="sam"
        existingRowCount={1}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(generateCaptions).toHaveBeenCalledWith('vid-1', { style: 'karaoke' }))
    expect(getCaptionProfileDefaults).toHaveBeenCalledWith('sam')
  })

  it('hands the resolved defaults to onDone alongside the fresh captions', async () => {
    // The host merges font/color onto the track at its own apply seam; the
    // modal resolves the profile ONCE and passes what it got, so the host
    // never repeats the round trip (and can never race a second answer).
    const { adapter } = makeSpyAdapter()
    adapter.getCaptionProfileDefaults = vi.fn(async () => PROFILE_DEFAULTS)
    const onDone = vi.fn()

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        profile="sam"
        existingRowCount={1}
        onDone={onDone}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(doneCaptions, PROFILE_DEFAULTS))
  })

  it('passes no opts at all when the host implements no caption-defaults seam', async () => {
    // Today's behaviour for every existing host, pinned: a bare one-argument
    // call, not `(id, undefined)` and not `(id, {})`.
    const { adapter, generateCaptions } = makeSpyAdapter()
    const onDone = vi.fn()

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        profile="sam"
        existingRowCount={1}
        onDone={onDone}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(generateCaptions).toHaveBeenCalledWith('vid-1')
    expect(onDone).toHaveBeenCalledWith(doneCaptions, null)
  })

  it('never asks for defaults when the project has no profile', async () => {
    const { adapter, generateCaptions } = makeSpyAdapter()
    const getCaptionProfileDefaults = vi.fn(async () => PROFILE_DEFAULTS)
    adapter.getCaptionProfileDefaults = getCaptionProfileDefaults

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        existingRowCount={1}
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(generateCaptions).toHaveBeenCalledWith('vid-1'))
    expect(getCaptionProfileDefaults).not.toHaveBeenCalled()
  })

  it('still generates when the caption-defaults seam rejects', async () => {
    // Seeding is a convenience. A profile lookup that 500s must never be the
    // reason a user cannot regenerate their captions.
    const { adapter, generateCaptions } = makeSpyAdapter()
    adapter.getCaptionProfileDefaults = vi.fn(async () => { throw new Error('boom') })
    const onDone = vi.fn()

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        profile="sam"
        existingRowCount={1}
        onDone={onDone}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(generateCaptions).toHaveBeenCalledWith('vid-1'))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(doneCaptions, null))
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('passes no style when the profile resolves without one', async () => {
    // A profile that sets only a font and a color must not send `style:
    // undefined` — the host route reads presence, not value.
    const { adapter, generateCaptions } = makeSpyAdapter()
    const fontOnly: CaptionProfileDefaults = { fontFamily: '"Inter", system-ui, sans-serif' }
    adapter.getCaptionProfileDefaults = vi.fn(async () => fontOnly)
    const onDone = vi.fn()

    render(
      <CaptionRegenModal
        adapter={adapter}
        projectId="vid-1"
        profile="sam"
        existingRowCount={1}
        onDone={onDone}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(generateCaptions).toHaveBeenCalledWith('vid-1'))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(doneCaptions, fontOnly))
  })
})

/// <reference types="vitest/globals" />
import { useState, type ReactNode } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { AudioTrack, VisualItem } from '../../../schema'
import ClipPropertiesPanel, { type ClipSelection } from '../ClipPropertiesPanel'

// The panel now persists its active clip tab to localStorage (see
// ClipPropertiesPanel's CLIP_PANEL_TAB_STORAGE_KEY) — clear it between tests
// so one test's tab choice can't leak into the next, same pattern as
// LeftPanelTabs' own test file.
beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

/** Clicks a clip-panel tab button by its accessible name (e.g. "Volume",
 *  "Speed", "Crop", "Generate", "Transform"). */
function openClipTab(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

function clipItem(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'c1',
    type: 'video',
    src: 'clip.mp4',
    start: 0,
    end: 10,
    inPoint: 100,
    outPoint: 110,
    ...over,
  }
}

function audioTrack(over: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'a1',
    src: '/media/voiceover-final.mp3',
    start: 0,
    end: 10,
    ...over,
  }
}

function makeCallbacks() {
  return {
    onPreviewClip: vi.fn(),
    onCommitClip: vi.fn(),
    onChangeClip: vi.fn(),
    onPreviewAudio: vi.fn(),
    onCommitAudio: vi.fn(),
    onChangeAudio: vi.fn(),
  }
}

type Callbacks = ReturnType<typeof makeCallbacks>

type ClipTabExtras = { transformSlot?: ReactNode; onOpenCrop?: () => void; generationSlot?: ReactNode }

function makeElement(selection: ClipSelection, cbs: Callbacks, extra: ClipTabExtras = {}) {
  return (
    <ClipPropertiesPanel
      selection={selection}
      onPreviewClip={cbs.onPreviewClip}
      onCommitClip={cbs.onCommitClip}
      onChangeClip={cbs.onChangeClip}
      onPreviewAudio={cbs.onPreviewAudio}
      onCommitAudio={cbs.onCommitAudio}
      onChangeAudio={cbs.onChangeAudio}
      {...extra}
    />
  )
}

function renderPanel(selection: ClipSelection, extra: ClipTabExtras = {}) {
  const cbs = makeCallbacks()
  const utils = render(makeElement(selection, cbs, extra))
  return {
    ...utils,
    ...cbs,
    /** Re-render the SAME mounted panel with a new selection, keeping the
     *  same callback spies. Used to simulate the host re-rendering from
     *  outside (e.g. an unrelated field committing elsewhere) while the
     *  operator is mid-keystroke on a field this panel owns. */
    rerenderWith: (nextSelection: ClipSelection) => utils.rerender(makeElement(nextSelection, cbs, extra)),
  }
}

/** Opens a nested sub-group (Fades / Ducking) by clicking its collapsible
 *  header. Both start collapsed. */
function openSection(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
}

/**
 * A real host feeds a previewed item straight back into the tree (its own
 * state update re-renders the panel with the new `item` before the operator
 * releases the pointer) — that's what keeps a controlled `<input>` showing
 * what was just dragged to. A bare mock spy does not, so `SpeedControl`'s
 * `onPointerUp` (which reads the slider's OWN current DOM value) would see
 * React's controlled-input revert instead of the dragged-to value. This tiny
 * stateful wrapper stands in for that host feedback loop for the tests that
 * exercise the speed gesture end-to-end.
 */
function ClipHarness({ initialItem, spies }: { initialItem: VisualItem; spies: Callbacks }) {
  const [item, setItem] = useState(initialItem)
  return (
    <ClipPropertiesPanel
      selection={{ kind: 'clip', item }}
      onPreviewClip={next => { spies.onPreviewClip(next); setItem(next) }}
      onCommitClip={spies.onCommitClip}
      onChangeClip={next => { spies.onChangeClip(next); setItem(next) }}
      onPreviewAudio={spies.onPreviewAudio}
      onCommitAudio={spies.onCommitAudio}
      onChangeAudio={spies.onChangeAudio}
    />
  )
}

describe('ClipPropertiesPanel — empty state', () => {
  it('shows the empty-state message when nothing is selected', () => {
    renderPanel(null)
    expect(screen.getByText('Select a clip to edit its properties.')).toBeTruthy()
  })
})

describe('ClipPropertiesPanel — clip selection', () => {
  it('renders the current volume, mute, and speed values', () => {
    renderPanel({ kind: 'clip', item: clipItem({ volume: 1.5, muted: true, speed: 2 }) })

    // No transformSlot offered by this fixture, so Speed — the first tab
    // this video selection actually offers — is the default active tab.
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('2')

    openClipTab('Volume')
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('1.5')
    expect(screen.getByRole('switch', { name: 'Mute clip' })).toHaveAttribute('aria-checked', 'true')
  })

  it('defaults volume/muted/speed the same way the modal does (1 / false / 1) when unset', () => {
    renderPanel({ kind: 'clip', item: clipItem() })

    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('1')

    openClipTab('Volume')
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('1')
    expect(screen.getByRole('switch', { name: 'Mute clip' })).toHaveAttribute('aria-checked', 'false')
  })

  it('volume: previews on every drag step and commits once, writing item.volume', () => {
    const { onPreviewClip, onCommitClip } = renderPanel({ kind: 'clip', item: clipItem({ volume: 1 }) })
    openClipTab('Volume')
    const slider = screen.getByRole('slider', { name: 'Volume' })

    fireEvent.change(slider, { target: { value: '1.5' } })
    expect(onPreviewClip).toHaveBeenCalledTimes(1)
    expect(onPreviewClip.mock.calls[0][0]).toMatchObject({ id: 'c1', volume: 1.5 })
    expect(onCommitClip).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider)
    expect(onCommitClip).toHaveBeenCalledTimes(1)
  })

  it('mute: fires exactly one discrete onChangeClip, no preview/commit', () => {
    const { onPreviewClip, onCommitClip, onChangeClip } = renderPanel({ kind: 'clip', item: clipItem({ muted: false }) })
    openClipTab('Volume')

    fireEvent.click(screen.getByRole('switch', { name: 'Mute clip' }))

    expect(onChangeClip).toHaveBeenCalledTimes(1)
    expect(onChangeClip.mock.calls[0][0]).toMatchObject({ id: 'c1', muted: true })
    expect(onPreviewClip).not.toHaveBeenCalled()
    expect(onCommitClip).not.toHaveBeenCalled()
  })

  it('speed: dragging previews only the number (duration untouched); commit resolves the real duration change through setClipSpeed', () => {
    // Same fixture cuts.test.ts's own `setClipSpeed` suite uses, so the
    // expected `end` below is directly comparable to that suite's numbers.
    const item = clipItem({ start: 0, end: 10, inPoint: 100, outPoint: 110, speed: 1 })
    const spies = makeCallbacks()
    render(<ClipHarness initialItem={item} spies={spies} />)
    const slider = screen.getByRole('slider', { name: 'Speed' })

    fireEvent.change(slider, { target: { value: '2' } })
    expect(spies.onPreviewClip).toHaveBeenCalledTimes(1)
    // Mid-drag: the field shows 2x, but nothing has resized yet.
    expect(spies.onPreviewClip.mock.calls[0][0]).toMatchObject({ speed: 2, end: 10 })
    expect(spies.onCommitClip).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider)
    expect(spies.onCommitClip).toHaveBeenCalledTimes(1)

    // The commit path previews the setClipSpeed-resolved item (correct end)
    // immediately before signaling commit — this IS "goes through setClipSpeed".
    const resolved = spies.onPreviewClip.mock.calls[spies.onPreviewClip.mock.calls.length - 1][0]
    expect(resolved).toMatchObject({ speed: 2, end: 5, inPoint: 100, outPoint: 110 })
  })

  it('speed: a preset chip previews then immediately commits the resolved duration', () => {
    const item = clipItem({ start: 0, end: 10, inPoint: 100, outPoint: 110, speed: 1 })
    const spies = makeCallbacks()
    render(<ClipHarness initialItem={item} spies={spies} />)

    fireEvent.click(screen.getByRole('button', { name: '4×' }))

    expect(spies.onCommitClip).toHaveBeenCalledTimes(1)
    const resolved = spies.onPreviewClip.mock.calls[spies.onPreviewClip.mock.calls.length - 1][0]
    expect(resolved).toMatchObject({ speed: 4, end: 2.5 }) // 10 / 4
  })
})

describe('ClipPropertiesPanel — generation slot', () => {
  it('renders the host-injected slot in the Generate tab when provided', () => {
    renderPanel({ kind: 'clip', item: clipItem() }, { generationSlot: <div data-testid="gen-slot">Regenerate</div> })
    openClipTab('Generate')
    expect(screen.getByTestId('gen-slot')).toBeTruthy()
  })

  it('offers no Generate tab, and renders nothing in its place, when absent', () => {
    renderPanel({ kind: 'clip', item: clipItem() })
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
    expect(screen.queryByTestId('gen-slot')).toBeNull()
  })
})

describe('ClipPropertiesPanel — audio selection', () => {
  it('renders every field with its current value, including the nested Fades and Ducking groups once opened', () => {
    renderPanel({
      kind: 'audio',
      track: audioTrack({
        label: 'VO',
        volume: 1.4,
        muted: true,
        fadeIn: 0.5,
        fadeOut: 0.8,
        ducking: { enabled: true, depth: -9, attack: 0.2, release: 0.6 },
        inPoint: 2,
        outPoint: 8,
      }),
    })

    expect(screen.getByLabelText('Track label')).toHaveValue('VO')
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('1.4')
    expect(screen.getByRole('switch', { name: 'Mute track' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('In point')).toHaveValue(2)
    expect(screen.getByLabelText('Out point')).toHaveValue(8)

    openSection('Fades')
    expect(screen.getByLabelText('Fade in')).toHaveValue(0.5)
    expect(screen.getByLabelText('Fade out')).toHaveValue(0.8)

    openSection('Ducking')
    expect(screen.getByRole('switch', { name: 'Enable ducking' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Depth')).toHaveValue(-9)
    expect(screen.getByLabelText('Attack')).toHaveValue(0.2)
    expect(screen.getByLabelText('Release')).toHaveValue(0.6)
  })

  it('label: previews on every keystroke and commits on blur, writing track.label', () => {
    const { onPreviewAudio, onCommitAudio } = renderPanel({ kind: 'audio', track: audioTrack({ label: 'Old' }) })
    const input = screen.getByLabelText('Track label')

    fireEvent.change(input, { target: { value: 'New name' } })
    expect(onPreviewAudio).toHaveBeenCalledWith(expect.objectContaining({ label: 'New name' }))
    expect(onCommitAudio).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCommitAudio).toHaveBeenCalledTimes(1)
  })

  it('label falls back to the source basename when unset', () => {
    renderPanel({ kind: 'audio', track: audioTrack({ label: undefined, src: '/media/voice/final-track.mp3' }) })
    expect(screen.getByLabelText('Track label')).toHaveValue('final-track.mp3')
  })

  it('label falls back to the source basename on commit if cleared to blank', () => {
    const { onPreviewAudio, onCommitAudio } = renderPanel({
      kind: 'audio',
      track: audioTrack({ label: 'Old', src: '/x/y/clip.wav' }),
    })
    const input = screen.getByLabelText('Track label')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    expect(onCommitAudio).toHaveBeenCalledTimes(1)
    const resolved = onPreviewAudio.mock.calls[onPreviewAudio.mock.calls.length - 1][0]
    expect(resolved.label).toBe('clip.wav')
  })

  it('volume: previews on every drag step and commits once, writing track.volume', () => {
    const { onPreviewAudio, onCommitAudio } = renderPanel({ kind: 'audio', track: audioTrack({ volume: 1 }) })
    const slider = screen.getByRole('slider', { name: 'Volume' })

    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(onPreviewAudio.mock.calls[0][0]).toMatchObject({ id: 'a1', volume: 0.5 })
    expect(onCommitAudio).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider)
    expect(onCommitAudio).toHaveBeenCalledTimes(1)
  })

  it('mute: fires exactly one discrete onChangeAudio', () => {
    const { onPreviewAudio, onCommitAudio, onChangeAudio } = renderPanel({ kind: 'audio', track: audioTrack({ muted: false }) })

    fireEvent.click(screen.getByRole('switch', { name: 'Mute track' }))

    expect(onChangeAudio).toHaveBeenCalledTimes(1)
    expect(onChangeAudio.mock.calls[0][0]).toMatchObject({ id: 'a1', muted: true })
    expect(onPreviewAudio).not.toHaveBeenCalled()
    expect(onCommitAudio).not.toHaveBeenCalled()
  })

  it('fades: fade in and fade out each write their own field, preview then commit on blur', () => {
    const { onPreviewAudio, onCommitAudio } = renderPanel({ kind: 'audio', track: audioTrack({ fadeIn: 0, fadeOut: 0 }) })
    openSection('Fades')

    const fadeIn = screen.getByLabelText('Fade in')
    fireEvent.change(fadeIn, { target: { value: '1.25' } })
    expect(onPreviewAudio.mock.calls[0][0]).toMatchObject({ fadeIn: 1.25, fadeOut: 0 })
    fireEvent.blur(fadeIn)
    expect(onCommitAudio).toHaveBeenCalledTimes(1)

    const fadeOut = screen.getByLabelText('Fade out')
    fireEvent.change(fadeOut, { target: { value: '2' } })
    const lastPreview = onPreviewAudio.mock.calls[onPreviewAudio.mock.calls.length - 1][0]
    expect(lastPreview).toMatchObject({ fadeOut: 2 })
    fireEvent.blur(fadeOut)
    expect(onCommitAudio).toHaveBeenCalledTimes(2)
  })

  it('fade in stepper: fires exactly one discrete onChangeAudio through clampAudioPatch, no preview/commit', () => {
    // The largest new adoption site for the stepper contract, and the only
    // one routing through `clampAudioPatch` (see AudioSection's comment on
    // why the fade rows' own `Math.max(0, v)` is redundant with it). A
    // stepper click is a DISCRETE edit — one final change, one undo entry —
    // never a preview/commit pair.
    const { onPreviewAudio, onCommitAudio, onChangeAudio } = renderPanel({ kind: 'audio', track: audioTrack({ fadeIn: 0 }) })
    openSection('Fades')

    fireEvent.click(screen.getByRole('button', { name: 'Increase Fade in' }))

    expect(onChangeAudio).toHaveBeenCalledTimes(1)
    expect(onChangeAudio.mock.calls[0][0]).toMatchObject({ fadeIn: 0.1 })
    expect(onPreviewAudio).not.toHaveBeenCalled()
    expect(onCommitAudio).not.toHaveBeenCalled()
  })

  it('trim: in point and out point each write their own field', () => {
    const { onPreviewAudio, onCommitAudio } = renderPanel({ kind: 'audio', track: audioTrack({ inPoint: 0, outPoint: 10 }) })

    const inPoint = screen.getByLabelText('In point')
    fireEvent.change(inPoint, { target: { value: '3' } })
    expect(onPreviewAudio.mock.calls[0][0]).toMatchObject({ inPoint: 3, outPoint: 10 })
    fireEvent.blur(inPoint)

    const outPoint = screen.getByLabelText('Out point')
    fireEvent.change(outPoint, { target: { value: '9' } })
    const lastPreview = onPreviewAudio.mock.calls[onPreviewAudio.mock.calls.length - 1][0]
    expect(lastPreview).toMatchObject({ outPoint: 9 })
    fireEvent.blur(outPoint)

    expect(onCommitAudio).toHaveBeenCalledTimes(2)
  })

  describe('ducking', () => {
    it('numeric fields are disabled until ducking is enabled', () => {
      renderPanel({ kind: 'audio', track: audioTrack({ ducking: undefined }) })
      openSection('Ducking')

      expect(screen.getByLabelText('Depth')).toBeDisabled()
      expect(screen.getByLabelText('Attack')).toBeDisabled()
      expect(screen.getByLabelText('Release')).toBeDisabled()
    })

    it('enabling seeds the documented defaults (-12 / 0.3 / 0.5) rather than a half-empty object', () => {
      const { onChangeAudio } = renderPanel({ kind: 'audio', track: audioTrack({ ducking: undefined }) })
      openSection('Ducking')

      fireEvent.click(screen.getByRole('switch', { name: 'Enable ducking' }))

      expect(onChangeAudio).toHaveBeenCalledTimes(1)
      expect(onChangeAudio.mock.calls[0][0]).toMatchObject({
        ducking: { enabled: true, depth: -12, attack: 0.3, release: 0.5 },
      })
    })

    it('disabling keeps the tuned depth/attack/release so re-enabling restores them', () => {
      const { onChangeAudio } = renderPanel({
        kind: 'audio',
        track: audioTrack({ ducking: { enabled: true, depth: -20, attack: 0.9, release: 1.2 } }),
      })
      openSection('Ducking')

      fireEvent.click(screen.getByRole('switch', { name: 'Enable ducking' }))

      expect(onChangeAudio.mock.calls[0][0]).toMatchObject({
        ducking: { enabled: false, depth: -20, attack: 0.9, release: 1.2 },
      })
    })

    it('depth/attack/release write the nested track.ducking object, preview then commit on blur', () => {
      const { onPreviewAudio, onCommitAudio } = renderPanel({
        kind: 'audio',
        track: audioTrack({ ducking: { enabled: true, depth: -12, attack: 0.3, release: 0.5 } }),
      })
      openSection('Ducking')

      const depth = screen.getByLabelText('Depth')
      fireEvent.change(depth, { target: { value: '-6' } })
      expect(onPreviewAudio.mock.calls[0][0]).toMatchObject({
        ducking: { enabled: true, depth: -6, attack: 0.3, release: 0.5 },
      })
      fireEvent.blur(depth)
      expect(onCommitAudio).toHaveBeenCalledTimes(1)
    })
  })

  it('has no delete control anywhere in the panel (deliberate — see the AudioSection doc comment)', () => {
    renderPanel({ kind: 'audio', track: audioTrack() })
    openSection('Fades')
    openSection('Ducking')

    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByText(/delete/i)).toBeNull()
  })
})

describe('ClipPropertiesPanel — mid-typed value survives an unrelated re-render', () => {
  it('a text field (Track label) keeps its draft when the panel re-renders with an unrelated change', () => {
    const track = audioTrack({ label: 'Original' })
    const { rerenderWith } = renderPanel({ kind: 'audio', track })
    const input = screen.getByLabelText('Track label')

    fireEvent.change(input, { target: { value: 'Ne' } }) // mid-typing "Ne" of "New name"
    expect(input).toHaveValue('Ne')

    // The host re-renders the panel — e.g. an unrelated volume preview
    // committed elsewhere — while the operator is still mid-edit.
    rerenderWith({ kind: 'audio', track: { ...track, volume: 1.9 } })
    expect(input).toHaveValue('Ne')

    fireEvent.change(input, { target: { value: 'New name' } })
    expect(input).toHaveValue('New name')
  })

  it('a number field (Fade in) keeps its draft when the panel re-renders with an unrelated change', () => {
    const track = audioTrack({ fadeIn: 0 })
    const { rerenderWith } = renderPanel({ kind: 'audio', track })
    openSection('Fades')
    const input = screen.getByLabelText('Fade in')

    fireEvent.change(input, { target: { value: '1' } }) // mid-typing "1" of "1.5"
    expect(input).toHaveValue(1)

    rerenderWith({ kind: 'audio', track: { ...track, volume: 1.9 } })
    expect(input).toHaveValue(1)

    fireEvent.change(input, { target: { value: '1.5' } })
    expect(input).toHaveValue(1.5)
  })
})

describe('ClipPropertiesPanel — speed is video-only', () => {
  it('hides the Speed control for a non-video clip', () => {
    // `setClipSpeed` early-returns for a non-video item, so a Speed slider on
    // an image would be a control that silently does nothing. The modal this
    // panel replaces gated the same way.
    const image = { id: 'i1', type: 'image', src: 'p.png', start: 0, end: 4 } as VisualItem
    render(
      <ClipPropertiesPanel
        selection={{ kind: 'clip', item: image }}
        onPreviewClip={vi.fn()}
        onCommitClip={vi.fn()}
        onChangeClip={vi.fn()}
        onPreviewAudio={vi.fn()}
        onCommitAudio={vi.fn()}
        onChangeAudio={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Speed' })).toBeNull()
    expect(screen.queryByLabelText('Speed')).toBeNull()
    // The video-agnostic controls are still there, on the Volume tab (the
    // only tab this image selection offers besides Transform, so it's also
    // the default active tab here).
    openClipTab('Volume')
    expect(screen.getByLabelText('Mute clip')).toBeTruthy()
  })
})

describe('ClipPropertiesPanel — clip tabs', () => {
  it('defaults to the Transform tab, showing transformSlot content on first render', () => {
    renderPanel({ kind: 'clip', item: clipItem() }, { transformSlot: <div data-testid="transform-slot">Transform body</div> })

    expect(screen.getByTestId('transform-slot')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Transform' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('an image clip offers no Speed, Crop, or Generate tabs', () => {
    // Crop/Generate are gated on the CALLER supplying onOpenCrop/
    // generationSlot at all (the host encodes the "images don't generate or
    // crop" rule) — this fixture mirrors a host that, for an image, simply
    // doesn't offer those slots.
    renderPanel({ kind: 'clip', item: clipItem({ type: 'image' }) }, { transformSlot: <div>T</div> })

    expect(screen.getByRole('button', { name: 'Transform' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Volume' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Speed' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Crop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
  })

  it('a main-track video with both slots offers all five tabs, in order', () => {
    renderPanel(
      { kind: 'clip', item: clipItem({ type: 'video' }) },
      { transformSlot: <div>T</div>, onOpenCrop: vi.fn(), generationSlot: <div>G</div> },
    )

    const names = screen.getAllByRole('button').map(b => b.textContent)
    expect(names).toEqual(['Transform', 'Speed', 'Volume', 'Crop', 'Generate'])
  })

  it('renders no Crop tab when onOpenCrop is omitted', () => {
    renderPanel({ kind: 'clip', item: clipItem() }, { transformSlot: <div>T</div> })
    expect(screen.queryByRole('button', { name: 'Crop' })).toBeNull()
  })

  it("clicking the Crop tab's button calls onOpenCrop", () => {
    const onOpenCrop = vi.fn()
    renderPanel({ kind: 'clip', item: clipItem() }, { transformSlot: <div>T</div>, onOpenCrop })

    openClipTab('Crop')
    fireEvent.click(screen.getByRole('button', { name: 'Open crop tool' }))
    expect(onOpenCrop).toHaveBeenCalledTimes(1)
  })

  function StatefulSlot() {
    const [value, setValue] = useState('')
    return <input aria-label="Gen prompt" value={value} onChange={e => setValue(e.target.value)} />
  }

  it("switching tabs away from Generate and back preserves the generation slot's internal state", () => {
    renderPanel(
      { kind: 'clip', item: clipItem() },
      { transformSlot: <div>T</div>, generationSlot: <StatefulSlot /> },
    )

    openClipTab('Generate')
    fireEvent.change(screen.getByLabelText('Gen prompt'), { target: { value: 'a sunset over water' } })
    expect(screen.getByLabelText('Gen prompt')).toHaveValue('a sunset over water')

    // Switch away, then back. If the Generate tab body were unmounted on
    // switch-away (a plain conditional render instead of lazy-mount-then-
    // keep-mounted), StatefulSlot's `useState('')` initializer would re-run
    // on remount and this value would be lost.
    openClipTab('Volume')
    openClipTab('Generate')
    expect(screen.getByLabelText('Gen prompt')).toHaveValue('a sunset over water')
  })

  it('falls back to Transform when the persisted tab id is not in the current tab set', () => {
    // Simulates the operator having 'generate' active on a different clip,
    // then selecting one whose host doesn't offer a generationSlot.
    window.localStorage.setItem('montaj.editor.clipPanelTab', JSON.stringify('generate'))
    renderPanel({ kind: 'clip', item: clipItem() }, { transformSlot: <div data-testid="transform-slot">T</div> })

    expect(screen.getByTestId('transform-slot')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Transform' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('ClipPropertiesPanel — audio timeline position (modal parity)', () => {
  it('renders Start and End and writes them as plain values', () => {
    const track = { id: 'a1', src: '/m/bed.mp3', start: 2, end: 30, sourceDuration: 30 } as AudioTrack
    const onPreviewAudio = vi.fn()
    render(
      <ClipPropertiesPanel
        selection={{ kind: 'audio', track }}
        onPreviewClip={vi.fn()}
        onCommitClip={vi.fn()}
        onChangeClip={vi.fn()}
        onPreviewAudio={onPreviewAudio}
        onCommitAudio={vi.fn()}
        onChangeAudio={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Start')).toHaveValue(2)
    expect(screen.getByLabelText('End')).toHaveValue(30)

    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '5' } })
    expect(onPreviewAudio).toHaveBeenLastCalledWith(expect.objectContaining({ start: 5 }))

    fireEvent.change(screen.getByLabelText('End'), { target: { value: '25' } })
    expect(onPreviewAudio).toHaveBeenLastCalledWith(expect.objectContaining({ end: 25 }))
  })
})

describe('ClipPropertiesPanel — audio validation (parity with the retired modal)', () => {
  function audioTrack(over: Partial<AudioTrack> = {}): AudioTrack {
    return { id: 'a1', src: '/m/bed.mp3', start: 2, end: 30, sourceDuration: 40, ...over } as AudioTrack
  }
  function renderAudio(track: AudioTrack) {
    const onPreviewAudio = vi.fn()
    render(
      <ClipPropertiesPanel
        selection={{ kind: 'audio', track }}
        onPreviewClip={vi.fn()} onCommitClip={vi.fn()} onChangeClip={vi.fn()}
        onPreviewAudio={onPreviewAudio} onCommitAudio={vi.fn()} onChangeAudio={vi.fn()}
      />,
    )
    return { onPreviewAudio }
  }
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as AudioTrack

  it('never lets End land at or before Start (a negative-duration track)', () => {
    const { onPreviewAudio } = renderAudio(audioTrack())
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '1' } }) // before start=2
    expect(last(onPreviewAudio).end).toBeGreaterThan(2)
  })

  it('never lets Start land at or after End', () => {
    const { onPreviewAudio } = renderAudio(audioTrack())
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '99' } })
    expect(last(onPreviewAudio).start).toBeLessThan(30)
  })

  it('clamps Out point to the source duration', () => {
    const { onPreviewAudio } = renderAudio(audioTrack())
    fireEvent.change(screen.getByLabelText('Out point'), { target: { value: '999' } })
    expect(last(onPreviewAudio).outPoint).toBe(40)
  })

  it('never lets In point cross Out point', () => {
    const { onPreviewAudio } = renderAudio(audioTrack({ outPoint: 10 }))
    fireEvent.change(screen.getByLabelText('In point'), { target: { value: '25' } })
    expect(last(onPreviewAudio).inPoint).toBeLessThanOrEqual(10)
  })

  it('caps a fade at the modal\'s 5s ceiling rather than leaving it unbounded', () => {
    const { onPreviewAudio } = renderAudio(audioTrack())
    fireEvent.click(screen.getByRole('button', { name: 'Fades' })) // open the group
    fireEvent.change(screen.getByLabelText('Fade in'), { target: { value: '999' } })
    expect(last(onPreviewAudio).fadeIn).toBe(5)
  })
})

/// <reference types="vite/client" />
/**
 * CaptionListPanel — the text-styling block inside the "Caption style"
 * subsection (font family, case, letter spacing, line height, alignment, and
 * the live specimen).
 *
 * Sits in `__tests__/` while the panel's other tests sit beside the component
 * (`../CaptionListPanel.test.tsx`); the render helpers and fixtures below
 * mirror that file's shape rather than importing from it, so neither test file
 * can silently change the other's setup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Project } from '../../types'
import type { Captions, CaptionSegment } from '../../schema'
import type { PlaybackClock } from '../playback-clock'
import CaptionListPanel from '../CaptionListPanel'

// The panel's active sub-tab persists to localStorage (usePersistentState).
// Clear it, then seed 'captions' for consistency with the sibling suites;
// every test here flips to the Format tab via `expandStyle()` anyway, since
// the font and text-styling controls live there now (moved off the retired
// "Style" tab, which split into "Styles" — a preset gallery, see
// CaptionStyleGallery.test.tsx — and "Format" — these fine controls).
//
// No local ResizeObserver stub: the specimen strip observes its own width and
// jsdom has no ResizeObserver, but src/test-setup.ts now installs a no-op one
// globally. That also means these tests run the specimen's "measurement never
// happens" floor-clamp path, which is why the size assertions below read the
// reported figure rather than a computed px.
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
})
afterEach(() => cleanup())

Element.prototype.scrollIntoView = vi.fn()

// The exact strings FONT_OPTIONS carries for these two entries
// (src/text/FontPicker.tsx). Hard-coded rather than imported: the whole point
// of the one-patch assertion below is that the persisted `fontFamily` and
// `googleFonts` are the REAL pair a template needs, so reading them back out
// of the same table the component reads would make the test agree with itself.
const BALOO_2_VALUE = '"Baloo 2", system-ui, sans-serif'
const BALOO_2_SPEC = 'Baloo+2:wght@400;500;600;700;800'
const SYSTEM_VALUE = 'system-ui, -apple-system, "Helvetica Neue", sans-serif'

const SEGS: CaptionSegment[] = [
  {
    id: 'cap-0',
    text: 'hello world',
    start: 0,
    end: 2,
    words: [
      { word: 'hello', start: 0, end: 1 },
      { word: 'world', start: 1, end: 2 },
    ],
  },
  { id: 'cap-1', text: 'goodbye now', start: 2, end: 4 },
]

function makeClock(): PlaybackClock {
  return { get: () => 0, set: vi.fn(), subscribe: () => () => {} }
}

function renderPanel(extra: Partial<Captions> = {}, currentTime = 0, selectedIds: string[] = []) {
  const project = {
    id: 'p1',
    captions: { style: 'pop', fontsize: 46, segments: SEGS, ...extra },
  } as unknown as Project
  const onCaptionEdit = vi.fn()
  const onProjectChange = vi.fn()

  const view = render(
    <CaptionListPanel
      captionTrack={project.captions}
      project={project}
      currentTime={currentTime}
      selectedIds={selectedIds}
      onSelectCaption={vi.fn()}
      onCaptionSegmentChange={vi.fn()}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onCaptionSegmentDelete={vi.fn()}
      fps={30}
      clock={makeClock()}
      editFocusId={null}
    />,
  )
  return { ...view, project, onCaptionEdit, onProjectChange }
}

function expandStyle() {
  // Font/text-styling controls moved from a collapse toggle, then from a
  // single "Style" tab, onto the "Format" tab; these suites seed 'captions',
  // so this click flips there.
  fireEvent.click(screen.getByRole('button', { name: 'Format' }))
}

function pickFont(label: string) {
  fireEvent.click(screen.getByLabelText('Font family'))
  fireEvent.click(screen.getByRole('option', { name: label }))
}

describe('CaptionListPanel font family', () => {
  // THE assertion this whole control exists for. A family whose font file is
  // never fetched renders as the fallback face in BOTH the editor preview and
  // the export — silently, with no error anywhere — so `fontFamily` and
  // `googleFonts` have to travel together. And in ONE patch, not two: two
  // commits would stack two undo entries and could interleave with another
  // edit landing between them, leaving the pair split. A test that checked
  // only `fontFamily` would pass with the feature fully broken.
  it('writes fontFamily AND googleFonts in a single commit', () => {
    const { onCaptionEdit, onProjectChange } = renderPanel()
    expandStyle()
    pickFont('Baloo 2')

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    const captions = onCaptionEdit.mock.calls[0][0].captions
    expect(captions.fontFamily).toBe(BALOO_2_VALUE)
    expect(captions.googleFonts).toEqual([BALOO_2_SPEC])
    // A font pick is a settled choice, not a drag — no live-preview channel.
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  // The System option is the one entry with no `spec`. `[]` is the correct
  // write, not "leave googleFonts alone": a previously picked family's spec
  // would otherwise linger in the project and keep being fetched for a
  // typeface nothing renders in any more.
  it('picking System writes an explicitly empty googleFonts, clearing the previous family spec', () => {
    const { onCaptionEdit } = renderPanel({ fontFamily: BALOO_2_VALUE, googleFonts: [BALOO_2_SPEC] })
    expandStyle()
    pickFont('System')

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    const captions = onCaptionEdit.mock.calls[0][0].captions
    expect(captions.fontFamily).toBe(SYSTEM_VALUE)
    expect(captions.googleFonts).toEqual([])
  })

  it('the picker reflects the family already stored on the track', () => {
    renderPanel({ fontFamily: BALOO_2_VALUE })
    expandStyle()
    expect(screen.getByLabelText('Font family').textContent).toContain('Baloo 2')
  })
})

describe('CaptionListPanel bold toggle', () => {
  it('reads on when fontWeight is absent', () => {
    renderPanel()
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'true')
  })

  it('reads off for the explicit off value 400', () => {
    renderPanel({ fontWeight: 400 })
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'false')
  })

  it('reads on for a numeric weight of 600 or more', () => {
    renderPanel({ fontWeight: 700 })
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'true')
  })

  // schema.ts's `fontWeight` is `number | string`, and CSS accepts the
  // string keywords 'bold'/'bolder' as legal font-weight values.
  // `Number('bold')` is `NaN`, which used to fail the `>= 600` check and show
  // Bold OFF for a project that actually renders bold.
  it.each(['bold', 'bolder', 'Bold'])('reads on for the CSS keyword %s', (kw) => {
    renderPanel({ fontWeight: kw })
    expandStyle()
    expect(screen.getByLabelText('Bold')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('CaptionListPanel text case', () => {
  it.each([
    ['Uppercase', 'uppercase'],
    ['Lowercase', 'lowercase'],
    ['Capitalize', 'capitalize'],
  ])('%s writes captions.textTransform = %s', (label, value) => {
    const { onCaptionEdit } = renderPanel()
    expandStyle()
    fireEvent.click(screen.getByLabelText(label))
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.textTransform).toBe(value)
  })

  // 'none', not an absent key: the patch is spread over the saved captions, so
  // dropping the field would leave the stored 'uppercase' in place and the
  // button would appear to do nothing.
  it('clicking the ACTIVE case again clears it to none', () => {
    const { onCaptionEdit } = renderPanel({ textTransform: 'uppercase' })
    expandStyle()
    const btn = screen.getByLabelText('Uppercase')
    expect(btn).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(btn)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.textTransform).toBe('none')
  })

  it('only the stored case reads as pressed', () => {
    renderPanel({ textTransform: 'lowercase' })
    expandStyle()
    expect(screen.getByLabelText('Lowercase')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Uppercase')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Capitalize')).toHaveAttribute('aria-pressed', 'false')
  })

  // `outline` renders all-caps by default (its stencil look) even with no
  // stored textTransform at all — the chip has to seed from that default the
  // same way the Bold toggle seeds from an absent fontWeight, or it lies
  // about the caption's actual on-screen case.
  it("a fresh outline caption (no stored textTransform) seeds the Uppercase chip pressed from the style's default", () => {
    renderPanel({ style: 'outline' })
    expandStyle()
    expect(screen.getByLabelText('Uppercase')).toHaveAttribute('aria-pressed', 'true')
  })

  // An explicit 'none' (written when the operator turns a case back off, see
  // the test above) is not "absent" — it must NOT fall back to the style
  // default.
  it('an explicit "none" on outline overrides the style default — no chip reads pressed', () => {
    renderPanel({ style: 'outline', textTransform: 'none' })
    expandStyle()
    expect(screen.getByLabelText('Uppercase')).toHaveAttribute('aria-pressed', 'false')
  })

  it('a style with no default case (pop) reads no case pressed when textTransform is absent', () => {
    renderPanel({ style: 'pop' })
    expandStyle()
    expect(screen.getByLabelText('Uppercase')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Lowercase')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Capitalize')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('CaptionListPanel alignment', () => {
  it.each([
    ['Align left', 'left'],
    ['Align center', 'center'],
    ['Align right', 'right'],
  ])('%s writes captions.textAlign = %s', (label, value) => {
    const { onCaptionEdit } = renderPanel()
    expandStyle()
    fireEvent.click(screen.getByLabelText(label))
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.textAlign).toBe(value)
  })

  it('reflects the stored alignment as pressed', () => {
    renderPanel({ textAlign: 'right' })
    expandStyle()
    expect(screen.getByLabelText('Align right')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Align left')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('CaptionListPanel letter spacing and line height steppers', () => {
  // The stored shapes differ on purpose and are what the caption templates
  // read: letter-spacing is a CSS length (unitless is invalid and the template
  // falls back), line-height is a unitless multiple of the font size. The
  // operator types a bare number for both — the `em` is appended here, the
  // same contract FontSizePicker has with `px`.
  it('letter spacing previews live as an em string and commits once on blur', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandStyle()
    const input = screen.getByLabelText('Caption letter spacing')

    fireEvent.change(input, { target: { value: '0.05' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.letterSpacing).toBe('0.05em')
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.letterSpacing).toBe('0.05em')
    // The commit did not also fire another live preview.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  it('letter spacing accepts negatives and shows a stored value without its unit', () => {
    const { onCaptionEdit } = renderPanel({ letterSpacing: '-0.02em' })
    expandStyle()
    const input = screen.getByLabelText('Caption letter spacing')
    expect(input).toHaveValue(-0.02)

    fireEvent.change(input, { target: { value: '-0.06' } })
    fireEvent.blur(input)
    expect(onCaptionEdit.mock.calls[0][0].captions.letterSpacing).toBe('-0.06em')
  })

  it('line height previews live as a unitless NUMBER and commits once on blur', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandStyle()
    const input = screen.getByLabelText('Caption line height')

    fireEvent.change(input, { target: { value: '1.4' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.lineHeight).toBe(1.4)
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    const committed = onCaptionEdit.mock.calls[0][0].captions.lineHeight
    expect(committed).toBe(1.4)
    expect(typeof committed).toBe('number')
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  // min/max on a number input are a spinner hint only — a typed or pasted
  // value sails straight past them — so the clamp lives on the write path.
  it('clamps a typed value to the control range', () => {
    const { onProjectChange } = renderPanel()
    expandStyle()
    fireEvent.change(screen.getByLabelText('Caption line height'), { target: { value: '9' } })
    expect(onProjectChange.mock.calls[0][0].captions.lineHeight).toBe(2.5)
  })

  // Focusing a field and leaving it untouched must not write anything: that
  // would be a pointless PUT and an undo entry for a no-op.
  it('a blur with no edit commits nothing', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel({ lineHeight: 1.2 })
    expandStyle()
    const input = screen.getByLabelText('Caption line height')
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCaptionEdit).not.toHaveBeenCalled()
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  // Both fields read BLANK on a fresh caption track even though the template
  // renders a real, non-default value — the placeholder is what makes the
  // field honest about what's actually on screen, without writing that
  // default into the project as an explicit value.
  it("the letter-spacing field reports the active style's own default as a placeholder, not a stored value", () => {
    renderPanel() // default renderPanel style is 'pop': letterSpacing defaults to -0.02em
    expandStyle()
    const input = screen.getByLabelText('Caption letter spacing') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input).toHaveAttribute('placeholder', '-0.02')
  })

  it("the line-height field reports the active style's own default as a placeholder, not a stored value", () => {
    renderPanel({ style: 'clean' }) // clean's lineHeight default is 1.3
    expandStyle()
    const input = screen.getByLabelText('Caption line height') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input).toHaveAttribute('placeholder', '1.3')
  })

  it('an explicit stored value is shown as the value, not overridden by the placeholder', () => {
    renderPanel({ letterSpacing: '0.08em' })
    expandStyle()
    const input = screen.getByLabelText('Caption letter spacing') as HTMLInputElement
    expect(input.value).toBe('0.08')
    // The placeholder is still there for when the value is cleared — it just
    // isn't what's shown while a real value is present.
    expect(input).toHaveAttribute('placeholder', '-0.02')
  })

  it('a style with no line-height default (karaoke) shows an empty placeholder', () => {
    renderPanel({ style: 'karaoke' })
    expandStyle()
    expect(screen.getByLabelText('Caption line height')).toHaveAttribute('placeholder', '')
  })
})

describe('CaptionListPanel specimen', () => {
  it('renders the word under the playhead', () => {
    renderPanel({}, 0.5)
    expandStyle()
    expect(screen.getByTestId('caption-specimen-word').textContent).toBe('hello')
  })

  it('follows the playhead to the next word', () => {
    renderPanel({}, 1.5)
    expandStyle()
    expect(screen.getByTestId('caption-specimen-word').textContent).toBe('world')
  })

  // The specimen is fed the panel's LIVE fontsize state, not
  // `captionTrack.fontsize`, so it tracks a slider drag rather than jumping
  // only once the drag commits. The rendered size is floor-clamped in jsdom
  // (no layout, so the measured width stays 0), which is why this checks the
  // reported figure rather than the computed px.
  it('tracks the fontsize slider live, before the drag is committed', () => {
    renderPanel()
    expandStyle()
    const specimen = screen.getByTestId('caption-specimen')
    expect(specimen.textContent).toContain('46px')

    fireEvent.change(screen.getByLabelText('Caption font size'), { target: { value: '80' } })
    expect(specimen.textContent).toContain('80px')
  })
})

/// <reference types="vitest/globals" />
/**
 * CaptionSpecimen tests. jsdom never lays anything out, so ResizeObserver
 * never fires on its own — a no-op stub (mirrors VideoEditor.test.tsx) is
 * installed before every render, which also exercises the "measurement
 * never happens" floor-clamp path: the specimen word must still render at a
 * legible size when `measuredWidth` stays 0 forever.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { Captions } from '../../schema'
import CaptionSpecimen from '../CaptionSpecimen'

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => cleanup())

const BALOO_2 = '"Baloo 2", system-ui, sans-serif'

function captions(over: Partial<Captions> = {}): Captions {
  return {
    style: 'word-by-word',
    fontsize: 46,
    segments: [
      {
        id: 'seg-1',
        text: 'hello world',
        start: 0,
        end: 2,
        words: [
          { word: 'hello', start: 0, end: 1 },
          { word: 'world', start: 1, end: 2 },
        ],
      },
    ],
    ...over,
  }
}

describe('CaptionSpecimen — active word', () => {
  it('renders the word under the playhead', () => {
    const { getByTestId } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} />,
    )
    expect(getByTestId('caption-specimen-word').textContent).toBe('hello')
  })

  it('carries fontFamily, textTransform and letterSpacing on the word element', () => {
    const { getByTestId } = render(
      <CaptionSpecimen
        captions={captions()}
        currentTime={0.5}
        fontSize={46}
        fontFamily={BALOO_2}
        textTransform="uppercase"
        letterSpacing="0.02em"
      />,
    )
    const word = getByTestId('caption-specimen-word')
    expect(word.style.fontFamily).toBe(BALOO_2)
    expect(word.style.textTransform).toBe('uppercase')
    expect(word.style.letterSpacing).toBe('0.02em')
  })

  it('carries fontWeight on the word element', () => {
    const { getByTestId } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} fontWeight={400} />,
    )
    expect(getByTestId('caption-specimen-word').style.fontWeight).toBe('400')
  })

  // An absent fontWeight/fontFamily must resolve to the ACTIVE STYLE's own
  // default, not render blank / the editor UI's own font — that's the whole
  // point of captionStyleDefaults.ts. Two styles with different weights
  // (subtitle 600 vs outline 900) prove the resolution is keyed off the
  // right style, not a single hardcoded fallback.
  it('resolves an absent fontWeight to the active style\'s own default', () => {
    const { getByTestId, rerender } = render(
      <CaptionSpecimen captions={captions({ style: 'subtitle' })} currentTime={0.5} fontSize={46} />,
    )
    expect(getByTestId('caption-specimen-word').style.fontWeight).toBe('600')

    rerender(<CaptionSpecimen captions={captions({ style: 'outline' })} currentTime={0.5} fontSize={46} />)
    expect(getByTestId('caption-specimen-word').style.fontWeight).toBe('900')
  })

  it('resolves an absent fontFamily to the active style\'s own default', () => {
    const { getByTestId, rerender } = render(
      <CaptionSpecimen captions={captions({ style: 'clean' })} currentTime={0.5} fontSize={46} />,
    )
    expect(getByTestId('caption-specimen-word').style.fontFamily).toBe('"Figtree", system-ui, sans-serif')

    rerender(<CaptionSpecimen captions={captions({ style: 'outline' })} currentTime={0.5} fontSize={46} />)
    expect(getByTestId('caption-specimen-word').style.fontFamily).toBe('system-ui, -apple-system, sans-serif')
  })

  // An EXPLICIT fontWeight always wins over the style default, e.g. the Bold
  // toggle's "off" state (a stored 400) on a style that would otherwise
  // default to 900.
  it('an explicit fontWeight overrides the style default', () => {
    const { getByTestId } = render(
      <CaptionSpecimen captions={captions({ style: 'outline' })} currentTime={0.5} fontSize={46} fontWeight={400} />,
    )
    expect(getByTestId('caption-specimen-word').style.fontWeight).toBe('400')
  })

  it('does not set textTransform/letterSpacing when they are not passed', () => {
    const { getByTestId } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} />,
    )
    const word = getByTestId('caption-specimen-word')
    expect(word.style.textTransform).toBe('')
    expect(word.style.letterSpacing).toBe('')
  })

  it('renders the word at a legible size even though jsdom never measures a width', () => {
    const { getByTestId } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} />,
    )
    const px = parseFloat(getByTestId('caption-specimen-word').style.fontSize)
    expect(px).toBeGreaterThanOrEqual(11)
  })
})

describe('CaptionSpecimen — family label', () => {
  it('resolves a recognized family via findFontOption', () => {
    const { getByText } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} fontFamily={BALOO_2} />,
    )
    expect(getByText('Baloo 2')).toBeTruthy()
  })

  it('shows Default when fontFamily is unset', () => {
    const { getByText } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} />,
    )
    expect(getByText('Default')).toBeTruthy()
  })

  it('shows Custom for an unrecognized family', () => {
    const { getByText } = render(
      <CaptionSpecimen
        captions={captions()}
        currentTime={0.5}
        fontSize={46}
        fontFamily='"Some Unlisted Font", sans-serif'
      />,
    )
    expect(getByText('Custom')).toBeTruthy()
  })
})

describe('CaptionSpecimen — size label', () => {
  it('shows the real caption render size, not the scaled-down on-screen size', () => {
    const { getByText } = render(
      <CaptionSpecimen captions={captions()} currentTime={0.5} fontSize={46} />,
    )
    expect(getByText('46px')).toBeTruthy()
  })
})

describe('CaptionSpecimen — no active word', () => {
  it('shows the empty-state line, not a placeholder glyph, when the playhead is outside every segment and nothing is selected', () => {
    const { getByTestId, queryByText } = render(
      <CaptionSpecimen captions={captions()} currentTime={10} fontSize={46} />,
    )
    expect(getByTestId('caption-specimen-word').textContent).toBe(
      'Move the playhead over a caption to preview it',
    )
    expect(queryByText('Aa')).toBeNull()
  })

  it('still shows the family and size labels in the empty state', () => {
    const { getByText } = render(
      <CaptionSpecimen captions={captions()} currentTime={10} fontSize={46} fontFamily={BALOO_2} />,
    )
    expect(getByText('Baloo 2')).toBeTruthy()
    expect(getByText('46px')).toBeTruthy()
  })
})

describe('CaptionSpecimen — selected-segment fallback', () => {
  it('shows the selected segment\'s first word, plus a "not live" tag, when the playhead is outside every segment', () => {
    const { getByTestId, getByText } = render(
      <CaptionSpecimen
        captions={captions()}
        currentTime={10}
        selectedSegmentId="seg-1"
        fontSize={46}
      />,
    )
    expect(getByTestId('caption-specimen-word').textContent).toBe('hello')
    expect(getByText('Selected caption')).toBeTruthy()
  })

  it('does not show the fallback tag when the word is live under the playhead', () => {
    const { queryByText } = render(
      <CaptionSpecimen
        captions={captions()}
        currentTime={0.5}
        selectedSegmentId="seg-1"
        fontSize={46}
      />,
    )
    expect(queryByText('Selected caption')).toBeNull()
  })
})

// CaptionPreview.fonts.test.tsx
//
// `captions.googleFonts` is a render-time hint that render.js hands to
// bundleComponent, which injects the Google Fonts stylesheet into the Puppeteer
// page. Now that `captions.fontFamily` is a real prop every caption template
// honours, the editor has to fetch that same stylesheet or the preview paints a
// fallback face while the export paints the real one. These tests pin the
// injection.
//
// NOTE ON THE MODULE-LEVEL CACHE: ensureGoogleFontsLoaded (lib/google-fonts.ts)
// keeps a module-level Set of already-injected URLs, so a second positive case
// reusing the SAME family in this file would inject nothing and assert on the
// first case's <link>. If you add one, give it a distinct family rather than
// resetting modules — the cache is the behaviour under test in production, and
// distinct families keep it intact.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import CaptionPreview from '../CaptionPreview'
import type { Captions } from '../../../schema'
import type { OverlayFactory } from '../../../types'

/** Every Google Fonts stylesheet currently in the document. */
function fontLinks(): HTMLLinkElement[] {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ).filter((l) => l.href.includes('fonts.googleapis.com'))
}

beforeEach(() => {
  // jsdom has no ResizeObserver. A no-op stub is enough here: `scale` stays
  // null, so no template content is ever painted — which is the point. The
  // font effect runs unconditionally in the component body, independent of
  // template compilation, so this suite needs none of the jsdom layout stubs
  // captionPositioning.test.tsx sets up (Range.getBoundingClientRect et al).
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const compileOverlay = vi.fn(
  async (): Promise<OverlayFactory> => () => null,
)

describe('CaptionPreview — Google Fonts injection', () => {
  it('injects the caption track\'s googleFonts stylesheet into document.head', async () => {
    const track: Captions = {
      style: 'clean',
      googleFonts: ['Baloo+2:wght@700'],
      segments: [{ id: 'cap-0', text: 'hello', start: 0, end: 2 }],
    }

    render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={compileOverlay}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
      />,
    )

    await waitFor(() => {
      expect(fontLinks().some((l) => l.href.includes('family=Baloo+2:wght@700'))).toBe(true)
    })
  })

  it('adds no stylesheet for a track with no googleFonts', async () => {
    // The <link> from the case above is still in document.head (jsdom's
    // document is per-file and RTL's cleanup only removes its own container),
    // so assert on the delta rather than on an empty head.
    const before = fontLinks().map((l) => l.href)

    const track: Captions = {
      style: 'clean',
      segments: [{ id: 'cap-0', text: 'hello', start: 0, end: 2 }],
    }

    render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={compileOverlay}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
      />,
    )

    await waitFor(() => expect(compileOverlay).toHaveBeenCalled())
    expect(fontLinks().map((l) => l.href)).toEqual(before)
  })
})

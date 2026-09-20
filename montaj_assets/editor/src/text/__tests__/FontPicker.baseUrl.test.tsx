import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FontFamilyPicker, FONT_OPTIONS, setFontsBaseUrl } from '../FontPicker'

// FontFamilyPicker's own `ensureGoogleFontsLoaded` is private to FontPicker.tsx
// (unrelated to, and independent from, `lib/google-fonts.ts`'s loader of the
// same name — see that file's header comment). It has no exported entry point,
// so we drive it the way the app does: mount the component, whose first-mount
// useEffect calls it.
function mountPicker() {
  return render(<FontFamilyPicker value="" onChange={() => {}} />)
}

function injectedHrefs(): string[] {
  return Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href,
  )
}

/** Every Google family the picker previews, as the labels a vendored family
 *  list would spell. Derived from FONT_OPTIONS rather than hardcoded, so
 *  adding a family to the picker cannot leave this test asserting a stale set. */
const PICKER_FAMILIES = FONT_OPTIONS.filter((f) => f.isGoogleFont).map((f) => f.label)

beforeEach(() => {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  setFontsBaseUrl(undefined)
  vi.restoreAllMocks()
})

describe('FontFamilyPicker google fonts base URL', () => {
  // Must run before any other test in this file sets a base: the injection
  // guard is keyed on the computed URL, and the default URL can only be
  // observed as "not yet injected" once per module lifetime.
  it('unset produces exactly the default per-family googleapis URL (byte-identical to pre-base behaviour)', () => {
    mountPicker()
    const hrefs = injectedHrefs()
    expect(hrefs).toEqual([
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto:wght@400;700&family=Open+Sans:wght@400;700&family=Lato:wght@400;700&family=Montserrat:wght@400;700&family=Poppins:wght@400;700&family=Raleway:wght@400;700&family=Nunito:wght@400;700&family=Work+Sans:wght@400;700&family=DM+Sans:wght@400;700&family=Rubik:wght@400;700&family=Oswald:wght@400;700&family=Bebas+Neue:wght@400;700&family=Playfair+Display:wght@400;700&family=Merriweather:wght@400;700&family=Source+Serif+4:wght@400;700&family=JetBrains+Mono:wght@400;700&family=Baloo+2:wght@400;500;600;700;800&family=Fredoka:wght@300;400;500;600;700&family=Sniglet:wght@400;800&display=swap',
    ])
  })

  it('a base whose family list covers the picker produces <base>/fonts.css ONLY — zero egress', () => {
    setFontsBaseUrl('https://example.com/fonts/editor', PICKER_FAMILIES)
    mountPicker()
    expect(injectedHrefs()).toEqual(['https://example.com/fonts/editor/fonts.css'])
  })

  it('setting a base after a prior injection still injects — a stale guard must not suppress it', () => {
    // Bases unique to this test so it doesn't depend on injection history left
    // by the tests above (module state, not DOM state, outlives a test — the
    // beforeEach above only clears document.head).
    setFontsBaseUrl('https://example.com/fonts/one', PICKER_FAMILIES)
    mountPicker()
    expect(injectedHrefs()).toEqual(['https://example.com/fonts/one/fonts.css'])

    setFontsBaseUrl('https://example.com/fonts/two', PICKER_FAMILIES)
    mountPicker()
    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(2)
    expect(hrefs).toContain('https://example.com/fonts/two/fonts.css')
  })

  // The picker's families ARE the vendored set's reason for existing, so in a
  // correctly configured app this never fires. It is guarded because the day a
  // family is added to FONT_OPTIONS and not yet vendored, the alternative is a
  // picker preview silently showing a system fallback — the exact rot a
  // declared family list exists to catch.
  it('a family the vendored list omits falls through to Google, alongside the vendored sheet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const partial = PICKER_FAMILIES.filter((f) => f !== 'Sniglet')
    setFontsBaseUrl('https://example.com/fonts/partial', partial)
    mountPicker()

    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(2)
    expect(hrefs[0]).toBe('https://example.com/fonts/partial/fonts.css')
    expect(hrefs[1]).toBe('https://fonts.googleapis.com/css2?family=Sniglet:wght@400;800&display=swap')
    expect(warn.mock.calls[0][0]).toContain('Sniglet')
  })

  it('a base with no family list links nothing vendored and emits exactly the default googleapis URL', async () => {
    // A fresh module instance, because the URL this produces IS the default
    // URL — every picker family falls through — and the module-level dedupe
    // would (correctly) suppress it after the first test above already
    // injected it. Asserting against the live module would therefore pass
    // vacuously, on an empty list.
    vi.resetModules()
    const fresh = await import('../FontPicker')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    fresh.setFontsBaseUrl('https://example.com/fonts/nolist')
    render(<fresh.FontFamilyPicker value="" onChange={() => {}} />)

    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toContain('fonts.googleapis.com')
    expect(hrefs[0]).not.toContain('fonts.css')
    // Every picker family is in it — nothing was withheld on the strength of
    // a base we were given no family list for.
    for (const label of PICKER_FAMILIES) expect(hrefs[0]).toContain(`family=${label.replace(/ /g, '+')}`)
    expect(warn.mock.calls[0][0]).toContain('treating NOTHING as vendored')

    fresh.setFontsBaseUrl(undefined)
  })
})

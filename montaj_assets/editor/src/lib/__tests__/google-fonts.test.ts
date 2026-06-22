import { describe, it, expect, beforeEach } from 'vitest'
import { ensureGoogleFontsLoaded } from '../google-fonts'

// Each test injects fonts that have not been requested by any prior test so the
// module-level dedupe Set never short-circuits the <link> append we assert on.
function injectedHrefs(): string[] {
  return Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href,
  )
}

beforeEach(() => {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())
})

describe('ensureGoogleFontsLoaded', () => {
  it('accepts a proper string[] and appends one <link> with each family', () => {
    ensureGoogleFontsLoaded(['Syne:wght@800', 'Inter:wght@400'])
    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toContain('family=Syne:wght@800')
    expect(hrefs[0]).toContain('family=Inter:wght@400')
  })

  it('does NOT throw and loads family=Anton when given a bare string "Anton"', () => {
    // Regression: a non-empty string used to pass the `.length` guard and then
    // `.map` threw "n.map is not a function", breaking the overlay layer.
    expect(() => ensureGoogleFontsLoaded('Anton' as unknown as string[])).not.toThrow()
    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toContain('family=Anton')
  })

  it('splits a comma-separated string into multiple families', () => {
    ensureGoogleFontsLoaded('Anton,Inter:wght@400' as unknown as string[])
    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toContain('family=Anton')
    expect(hrefs[0]).toContain('family=Inter:wght@400')
  })

  it('is a no-op for empty string, undefined, and []', () => {
    ensureGoogleFontsLoaded('' as unknown as string[])
    ensureGoogleFontsLoaded(undefined)
    ensureGoogleFontsLoaded([])
    expect(injectedHrefs()).toHaveLength(0)
  })

  it('trims whitespace and drops empty entries from a comma string', () => {
    ensureGoogleFontsLoaded(' Anton , , Inter ' as unknown as string[])
    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toContain('family=Anton')
    expect(hrefs[0]).toContain('family=Inter')
  })
})

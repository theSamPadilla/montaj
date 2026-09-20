import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ensureGoogleFontsLoaded, setFontsBaseUrl, vendoredFamiliesDigest } from '../google-fonts'
import { fontFamilyKey, familiesDigest, partitionFontSpecs, vendoredFaceIndex, vendoredKeySet } from '../font-families'

// Each test injects fonts that have not been requested by any prior test so the
// module-level dedupe Set never short-circuits the <link> append we assert on.
function injectedHrefs(): string[] {
  return Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href,
  )
}

beforeEach(() => {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())
  // The setters log a line per call; individual tests that assert on logging
  // install their own spies.
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setFontsBaseUrl(undefined)
  vi.restoreAllMocks()
})

// A base per test. The injected-URL Set is module state that outlives a single
// test (only document.head is reset in beforeEach), so two tests producing the
// same URL would see the second one suppressed — and it would pass for the
// wrong reason. Keep every base, and every unvendored family, unique.
const B = (name: string) => `https://example.com/fonts/${name}`

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

// The loader is FULLY SYNCHRONOUS and must stay that way. It is called from
// effects and has to decide the partition before it can act, so the vendored
// family list is passed into the setter by the host rather than fetched here:
// a pending fetch would leave the loader with no good move — it cannot block,
// guessing is silently wrong, and re-injecting once the answer lands leaves
// two competing stylesheets with the stale one never pruned.
describe('setFontsBaseUrl', () => {
  it('unset produces exactly the default per-family googleapis URL', () => {
    ensureGoogleFontsLoaded(['Syne:wght@800'])
    expect(injectedHrefs()).toEqual(['https://fonts.googleapis.com/css2?family=Syne:wght@800&display=swap'])
  })

  it('never fetches — there is no network call anywhere in this loader', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      setFontsBaseUrl(B('no-fetch'), ['Karla'])
      ensureGoogleFontsLoaded(['Karla:wght@800'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a vendored family produces <base>/fonts.css ONLY — no googleapis link, no preconnect, no egress', () => {
    const base = B('all-vendored')
    setFontsBaseUrl(base, ['Syne', 'Inter'])
    ensureGoogleFontsLoaded(['Syne:wght@800'])
    expect(injectedHrefs()).toEqual([`${base}/fonts.css`])
  })

  it('setting a base after a prior injection still injects — a stale guard must not suppress it', () => {
    ensureGoogleFontsLoaded(['Zilla:wght@800'])
    expect(injectedHrefs()).toHaveLength(1)

    const base = B('another-base')
    setFontsBaseUrl(base, ['Zilla'])
    ensureGoogleFontsLoaded(['Zilla:wght@800'])

    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(2)
    expect(hrefs).toContain(`${base}/fonts.css`)
  })

  it('logs the vendored set digest once per setter call', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const base = B('digest-logged')
    setFontsBaseUrl(base, ['Inter', 'Baloo 2'])
    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0][0]).toContain(vendoredFamiliesDigest())
    expect(info.mock.calls[0][0]).toContain('2 families')
  })

  it('vendoredFamiliesDigest is empty with no base, and stable across equivalent spellings', () => {
    expect(vendoredFamiliesDigest()).toBe('')
    setFontsBaseUrl(B('digest-a'), ['Baloo 2', 'Inter'])
    const a = vendoredFamiliesDigest()
    // Same set, different order and spelling — the digest sorts and normalises.
    setFontsBaseUrl(B('digest-b'), ['inter', 'Baloo+2'])
    expect(vendoredFamiliesDigest()).toBe(a)
    expect(a).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// The partition (L1 fall-through)
// ---------------------------------------------------------------------------
//
// The vendored stylesheet declares the editor's twenty picker families and
// nothing else, but `googleFonts` comes out of project data and
// skills/write-overlay documents arbitrary Google families as first-class —
// its own worked example is `["Anton", "Playfair+Display:ital@1"]`, and Anton
// is not a picker family. Linking the vendored sheet and dropping the
// requested entries renders those in a fallback face with nothing on screen
// to say so, which is what this partition exists to stop.
//
// Every assertion here has a twin on the render side
// (`montaj_assets/render/test/fonts-fallthrough.test.mjs`). The two sides MUST
// partition identically: a family loaded locally while editing and from
// Google at export time — or vice versa — is the caption-shifts-between-
// preview-and-export bug the Syne case study documents.
describe('ensureGoogleFontsLoaded: unvendored families fall through to Google', () => {
  it('an unvendored family gets a googleapis link alongside the vendored stylesheet', () => {
    const base = B('mix-basic')
    setFontsBaseUrl(base, ['Inter', 'Baloo 2'])
    ensureGoogleFontsLoaded(['Inter:wght@400', 'Anton', 'Syne:wght@800'])
    expect(injectedHrefs()).toEqual([
      `${base}/fonts.css`,
      'https://fonts.googleapis.com/css2?family=Anton&family=Syne:wght@800&display=swap',
    ])
  })

  it('a MIX splits: vendored families stay local, unvendored ones go to Google, and neither list leaks into the other', () => {
    const base = B('mixed')
    setFontsBaseUrl(base, ['Baloo 2', 'Playfair Display', 'Inter'])
    ensureGoogleFontsLoaded(['Baloo+2:wght@400;500', 'Bitter', 'Playfair+Display:ital@1'])

    const hrefs = injectedHrefs()
    expect(hrefs).toHaveLength(2)
    expect(hrefs[0]).toBe(`${base}/fonts.css`)
    // Only Bitter crosses to Google. Baloo 2 and Playfair Display are vendored,
    // so their specs must NOT appear in the googleapis URL — a regression that
    // fell everything through would still look right and would silently
    // restore the egress this feature removes.
    expect(hrefs[1]).toBe('https://fonts.googleapis.com/css2?family=Bitter&display=swap')
    expect(hrefs[1]).not.toContain('Baloo')
    expect(hrefs[1]).not.toContain('Playfair')
  })

  it('all-unvendored does not link the vendored stylesheet at all — it would serve nothing', () => {
    const base = B('all-unvendored')
    setFontsBaseUrl(base, ['Inter', 'Baloo 2'])
    ensureGoogleFontsLoaded(['Amiri', 'Cabin:wght@400'])
    expect(injectedHrefs()).toEqual([
      'https://fonts.googleapis.com/css2?family=Amiri&family=Cabin:wght@400&display=swap',
    ])
  })

  it('logs which families were fetched from Google, and not the ones that were not', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = B('logged')
    setFontsBaseUrl(base, ['Inter'])
    ensureGoogleFontsLoaded(['Inter:wght@400', 'Cantata+One'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('Cantata+One')
    expect(warn.mock.calls[0][0]).toContain('fonts.googleapis.com')
    expect(warn.mock.calls[0][0]).not.toContain('Inter')
  })

  it('does not re-log per overlay', () => {
    const base = B('repeat')
    setFontsBaseUrl(base, ['Inter'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ensureGoogleFontsLoaded(['Eczar'])
    ensureGoogleFontsLoaded(['Eczar'])
    expect(warn).toHaveBeenCalledOnce()
    expect(injectedHrefs()).toHaveLength(1)
  })

  it('the defensive string coercion still holds with a base set', () => {
    const base = B('coercion')
    setFontsBaseUrl(base, ['Inter'])
    // A bare string used to throw "n.map is not a function" and surface as
    // "overlay error: <file>.jsx", taking the whole overlay layer with it.
    expect(() => ensureGoogleFontsLoaded('Dosis,Inter:wght@400' as unknown as string[])).not.toThrow()
    expect(injectedHrefs()).toEqual([
      `${base}/fonts.css`,
      'https://fonts.googleapis.com/css2?family=Dosis&display=swap',
    ])
  })
})

// THE FAILURE MODE, and it is deliberate in this direction.
//
// A base with no family list means NOTHING is vendored: no vendored <link>,
// every family from Google. The tempting opposite — assume the sheet covers
// what was asked for — is the SILENT-wrong option: an unvendored family would
// get no stylesheet at all and preview as a system fallback, while the render
// (reading its manifest off local disk, where it cannot fail independently)
// fetched that same family from Google and got it right. Preview and export
// would disagree with nothing on screen to say so — the Syne bug exactly.
// This way is loud-wrong: glyphs correct, both sides agreeing, cost is egress,
// and egress is the one failure the logging already detects.
describe('setFontsBaseUrl: a base with no family list', () => {
  for (const [label, families] of [
    ['omitted', undefined],
    ['empty', []],
    ['not an array', 'Inter'],
    ['all non-strings', [7, null]],
  ] as [string, unknown][]) {
    it(`${label}: nothing is vendored, the stylesheet is not linked, everything goes to Google`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const base = B(`nolist-${label.replace(/\s/g, '-')}`)
      setFontsBaseUrl(base, families as string[] | undefined)
      ensureGoogleFontsLoaded([`Q${label.replace(/\s/g, '')}`, 'Inter:wght@400'])

      const hrefs = injectedHrefs()
      expect(hrefs).toHaveLength(1)
      expect(hrefs[0]).toContain('fonts.googleapis.com')
      expect(hrefs[0]).toContain('family=Inter:wght@400')
      expect(hrefs[0]).not.toContain('fonts.css')
      expect(warn.mock.calls[0][0]).toContain('treating NOTHING as vendored')
    })
  }
})

// ---------------------------------------------------------------------------
// The shared partition primitives
// ---------------------------------------------------------------------------
describe('fontFamilyKey: a spec normalises to the family name fonts.css declares', () => {
  for (const [spec, key] of [
    ['Baloo+2:wght@400;500', 'baloo 2'],
    ['Playfair+Display:ital@1', 'playfair display'],
    ['Anton', 'anton'],
    ['Source+Serif+4:wght@400;700', 'source serif 4'],
    ['Inter:wght@400;600;700;800', 'inter'],
    ['Playfair Display', 'playfair display'],   // a literal space, not '+'
    ['  Anton  ', 'anton'],
    ['DM+SANS', 'dm sans'],                     // CSS family matching is case-insensitive
  ]) {
    it(`${JSON.stringify(spec)} → ${JSON.stringify(key)}`, () => {
      expect(fontFamilyKey(spec)).toBe(key)
    })
  }
})

describe('partitionFontSpecs', () => {
  it('preserves the caller order within each side', () => {
    const keys = vendoredKeySet(['Inter', 'Baloo 2'])
    expect(partitionFontSpecs(['Anton', 'Inter:wght@400', 'Syne', 'Baloo+2'], keys)).toEqual({
      vendored: ['Inter:wght@400', 'Baloo+2'],
      fellThrough: ['Anton', 'Syne'],
    })
  })

  it('an empty vendored set falls everything through', () => {
    expect(partitionFontSpecs(['Anton', 'Inter'], new Set())).toEqual({
      vendored: [],
      fellThrough: ['Anton', 'Inter'],
    })
  })

  it('drops non-string list entries rather than coercing them into families', () => {
    // String(7) would otherwise become a "family" named "7".
    expect(vendoredKeySet(['Inter', 7, null, 'Baloo 2'] as unknown[])).toEqual(
      new Set(['inter', 'baloo 2']),
    )
  })
})

// THE CROSS-LANGUAGE GATE. The renderers carry this same algorithm in plain
// JS; a textual parity test cannot span TypeScript and JavaScript, so both
// suites pin the SAME literal digest for the SAME family list instead. If this
// value and the one in `montaj_assets/render/test/fonts-fallthrough.test.mjs`
// ever disagree, the editor and the renderers are fingerprinting differently
// and the digest stops being able to prove they agree — which is the only job
// it has. Change one, change the other, and only ever deliberately.
describe('familiesDigest', () => {
  const PRODUCTION_20 = [
    'Baloo 2', 'Bebas Neue', 'DM Sans', 'Fredoka', 'Inter', 'JetBrains Mono', 'Lato',
    'Merriweather', 'Montserrat', 'Nunito', 'Open Sans', 'Oswald', 'Playfair Display',
    'Poppins', 'Raleway', 'Roboto', 'Rubik', 'Sniglet', 'Source Serif 4', 'Work Sans',
  ]

  // The faces those twenty actually resolve to, as `families.json` records
  // them. Bebas Neue is the one family whose `faces` and `requested` differ:
  // it publishes no 700, so we asked for one and received only the 400.
  const W: Record<string, number[]> = {
    'Baloo 2': [400, 500, 600, 700, 800], Fredoka: [300, 400, 500, 600, 700], Sniglet: [400, 800],
  }
  const faces: Record<string, { normal: number[] }> = {}
  const requested: Record<string, { normal: number[] }> = {}
  for (const f of PRODUCTION_20) {
    requested[f] = { normal: W[f] ?? [400, 700] }
    faces[f] = { normal: f === 'Bebas Neue' ? [400] : (W[f] ?? [400, 700]) }
  }
  const INDEX = vendoredFaceIndex(faces, requested)

  it('the shipped manifest has the digest the render suite also pins', () => {
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20), INDEX)).toBe('1fcf41c1')
  })

  // Unchanged from before faces existed, which is the point: a manifest
  // carrying no face information still digests exactly as an older renderer
  // would, so the two stay comparable.
  it('a manifest with no face information keeps its original digest', () => {
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20))).toBe('63d7e733')
  })

  // The reason the digest had to grow: same twenty family NAMES, one weight
  // fewer. A families-only fingerprint reports a match here, which is exactly
  // the silent drift it exists to make loud.
  it('dropping a single WEIGHT moves the digest, though every family name is unchanged', () => {
    const thinner = vendoredFaceIndex(
      { ...faces, Inter: { normal: [400] } },
      { ...requested, Inter: { normal: [400] } },
    )
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20), thinner)).toBe('7b42f0b4')
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20), thinner))
      .not.toBe(familiesDigest(vendoredKeySet(PRODUCTION_20), INDEX))
  })

  it('gaining an ITALIC face moves the digest — the style axis is in the input too', () => {
    const italic = vendoredFaceIndex(
      { ...faces, 'Playfair Display': { normal: [400, 700], italic: [400] } },
      requested,
    )
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20), italic))
      .not.toBe(familiesDigest(vendoredKeySet(PRODUCTION_20), INDEX))
  })

  it('is order- and spelling-independent, and changes when the set changes', () => {
    const a = familiesDigest(vendoredKeySet(['Inter', 'Baloo 2']))
    expect(familiesDigest(vendoredKeySet(['Baloo+2', 'inter']))).toBe(a)
    expect(familiesDigest(vendoredKeySet(['Inter']))).not.toBe(a)
  })

  it('is eight hex characters', () => {
    expect(familiesDigest(vendoredKeySet(PRODUCTION_20))).toMatch(/^[0-9a-f]{8}$/)
  })
})

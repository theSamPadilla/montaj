import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ensureGoogleFontsLoaded, setFontsBaseUrl } from '../google-fonts'
import { requiredFaces, specFacesAvailable, vendoredFaceIndex } from '../font-families'

// THE FACE-LEVEL PARTITION (L1).
//
// The vendored set is family + STYLE + WEIGHT, not family. `fonts.css` carries
// only the faces the vendoring pass actually received — every face is
// `font-style: normal`, and the weights are only the ones it asked for. A
// family-level partition therefore gets two shapes silently wrong:
//
//   Playfair+Display:ital@1  — family vendored, no italic face exists, so the
//                              browser synthesises an oblique from the upright.
//   Inter:wght@300           — family vendored, no 300 face exists, so the
//                              browser synthesises a light weight from the 400.
//
// Neither produces a failed request or a console error, and both change what
// the user sees. `skills/write-overlay/SKILL.md` uses the first as its own
// documented example.
//
// Every assertion here has a twin on the render side
// (`montaj_assets/render/test/fonts-fallthrough.test.mjs`). The two sides MUST
// partition identically — a caption laid out in one face while editing and
// another at export is the Syne bug that case study documents.

const N = (weight: number) => ({ style: 'normal', weight })
const I = (weight: number) => ({ style: 'italic', weight })

describe('requiredFaces: a spec resolves to the faces it asks Google for', () => {
  for (const [spec, want] of [
    // No axis list — Google serves the family default, which is normal 400.
    ['Anton', [N(400)]],
    ['Playfair Display', [N(400)]],
    ['Inter:wght@400;700', [N(400), N(700)]],
    ['Inter:wght@300', [N(300)]],
    ['Playfair+Display:ital@1', [I(400)]],
    ['Playfair+Display:ital@0', [N(400)]],
    // The axes are named in one list and their values in another, positionally.
    ['Playfair+Display:ital,wght@1,700', [I(700)]],
    ['Playfair+Display:ital,wght@0,400;1,700', [N(400), I(700)]],
    ['Baloo+2:wght@400;500;600;700;800', [N(400), N(500), N(600), N(700), N(800)]],
  ] as [string, ReturnType<typeof N>[]][]) {
    it(`${spec} → ${JSON.stringify(want)}`, () => {
      expect(requiredFaces(spec)).toEqual(want)
    })
  }

  // `null` means "I cannot parse this confidently" and the caller must fall
  // through. Fetching a font we happen to have costs one request; silently
  // dropping one we lack costs the author a wrong face in a finished export.
  for (const spec of [
    'Inter:',                  // a colon with no axis list
    'Inter:wght',              // an axis with no '@'
    'Inter:wght@',             // an '@' with no value
    'Inter:wght@400;',         // a trailing ';' leaves an empty tuple
    'Inter:wght@100..900',     // a variable RANGE is not a face
    'Inter:ital@0..1',
    'Inter:opsz@14',           // an axis we do not model
    'Inter:slnt@-10',
    'Inter:GRAD@150',
    'Inter:wght,opsz@400,14',  // one modelled axis, one not
    'Inter:wght,wght@400,700', // a duplicated axis
    'Inter:ital,wght@1',       // arity mismatch: two axes, one value
    'Inter:wght@400@700',      // two '@'
    'Inter:ital@2',            // ital is 0 or 1, nothing else
    'Inter:wght@0',            // out of range
    'Inter:wght@abc',
    'Inter:@400',              // an empty axis name
  ]) {
    it(`${spec} → null, so the caller falls through`, () => {
      expect(requiredFaces(spec)).toBeNull()
    })
  }
})

describe('vendoredFaceIndex: `faces` and `requested` together say what is available', () => {
  it('merges both maps — a weight in either one counts as available', () => {
    // Bebas Neue publishes no 700, so we asked for it and got only the 400.
    // Falling through would fetch a stylesheet that omits it identically.
    const index = vendoredFaceIndex(
      { 'Bebas Neue': { normal: [400] } },
      { 'Bebas Neue': { normal: [400, 700] } },
    )!
    expect(specFacesAvailable('Bebas+Neue:wght@400;700', index)).toBe(true)
    expect(specFacesAvailable('Bebas+Neue:wght@500', index)).toBe(false)
  })

  it('distinguishes NO face information from face information covering nothing', () => {
    // Nothing supplied at all: the partition has nothing to refine against and
    // must stay at family level, which the loader signals with `undefined`.
    expect(vendoredFaceIndex(undefined, undefined)).toBeUndefined()
    // An empty map IS information: it says nothing is available.
    const empty = vendoredFaceIndex({}, undefined)
    expect(empty).toBeInstanceOf(Map)
    expect(specFacesAvailable('Inter', empty!)).toBe(false)
  })

  it('normalises family keys the way the family list does', () => {
    const index = vendoredFaceIndex({ 'Open+Sans': { normal: [400] } })!
    expect(specFacesAvailable('Open+Sans', index)).toBe(true)
    expect(specFacesAvailable('OPEN SANS', index)).toBe(true)
  })

  it('skips malformed entries rather than throwing inside a font load', () => {
    const index = vendoredFaceIndex({
      Inter: { normal: [400, 'x' as unknown as number, null as unknown as number] },
      Bad: null as unknown as { normal: number[] },
      Worse: { normal: 'nope' as unknown as number[] },
    })!
    expect(specFacesAvailable('Inter', index)).toBe(true)
    expect(specFacesAvailable('Bad', index)).toBe(false)
    expect(specFacesAvailable('Worse', index)).toBe(false)
  })

  it('a family with no index entry is not covered', () => {
    const index = vendoredFaceIndex({ Inter: { normal: [400] } })!
    expect(specFacesAvailable('Anton', index)).toBe(false)
  })

  it('a spec it cannot parse is not covered, however complete the index', () => {
    const index = vendoredFaceIndex({ Inter: { normal: [100, 200, 300, 400, 700, 900] } })!
    expect(specFacesAvailable('Inter:wght@100..900', index)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Through the loader
// ---------------------------------------------------------------------------

function injectedHrefs(): string[] {
  return Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href,
  )
}

// The injected-URL Set is module state that outlives a single test, so every
// base and every unvendored family below must be unique or a later test is
// served a suppressed <link> and passes for the wrong reason.
const B = (name: string) => `https://example.com/faces/${name}`

const REAL = {
  faces: {
    'Playfair Display': { normal: [400, 700] },
    Inter: { normal: [400, 700] },
    'Bebas Neue': { normal: [400] },
  },
  requested: {
    'Playfair Display': { normal: [400, 700] },
    Inter: { normal: [400, 700] },
    'Bebas Neue': { normal: [400, 700] },
  },
}
const FAMILIES = ['Playfair Display', 'Inter', 'Bebas Neue']

beforeEach(() => {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setFontsBaseUrl(undefined)
  vi.restoreAllMocks()
})

describe('ensureGoogleFontsLoaded: the face refinement', () => {
  for (const [spec, vendored, why] of [
    ['Playfair+Display:ital@1', false, 'no italic face is vendored'],
    ['Playfair+Display:ital,wght@1,700', false, 'italic 700 is not on disk either'],
    ['Playfair+Display:ital@0', true, 'ital@0 is normal 400, which IS on disk'],
    ['Inter:wght@300', false, '300 was never vendored'],
    ['Inter:wght@400;700', true, 'both weights are on disk'],
    ['Bebas+Neue:wght@400;700', true, 'Google publishes no 700, so asking again cannot help'],
    ['Bebas+Neue:wght@500', false, '500 was neither vendored nor asked for'],
  ] as [string, boolean, string][]) {
    it(`${spec} is ${vendored ? 'served locally' : 'fetched from Google'} — ${why}`, () => {
      const base = B(spec.replace(/\W/g, ''))
      setFontsBaseUrl(base, FAMILIES, REAL)
      ensureGoogleFontsLoaded([spec])
      const hrefs = injectedHrefs()
      if (vendored) {
        expect(hrefs).toEqual([`${base}/fonts.css`])
      } else {
        expect(hrefs).toEqual([`https://fonts.googleapis.com/css2?family=${spec}&display=swap`])
      }
    })
  }

  it('a partially vendored spec falls through WHOLE, exactly as the author wrote it', () => {
    // Splitting would mean synthesising a new spec string, and a spec is the
    // author's — ours to honour or pass on untouched, never to rewrite.
    const base = B('partial')
    setFontsBaseUrl(base, FAMILIES, REAL)
    ensureGoogleFontsLoaded(['Inter:wght@400;300'])
    expect(injectedHrefs()).toEqual([
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;300&display=swap',
    ])
  })

  it('a MIX puts each spec on exactly one side, by face and not by family', () => {
    const base = B('mix')
    setFontsBaseUrl(base, FAMILIES, REAL)
    // Same family on both sides: the 700 is vendored, the italic is not.
    //
    // The italic spec here is spelled `ital,wght@1,400` rather than `ital@1`
    // — the same FACE, a different URL. `__injectedFontUrls` dedupes on the
    // full URL and is module state outliving a single test, so reusing the
    // spelling an earlier case already injected would suppress this <link>
    // and the assertion would fail for a reason that has nothing to do with
    // the partition.
    ensureGoogleFontsLoaded(['Playfair+Display:wght@700', 'Playfair+Display:ital,wght@1,400'])
    const hrefs = injectedHrefs()
    expect(hrefs).toEqual([
      `${base}/fonts.css`,
      'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,400&display=swap',
    ])
  })

  it('omitting face data leaves the partition at family level', () => {
    // A manifest vendored before the refinement existed carries no face
    // information. That is a real shape, and it must degrade to the previous
    // behaviour rather than treating every face as missing.
    const base = B('nofaces')
    setFontsBaseUrl(base, FAMILIES)
    ensureGoogleFontsLoaded(['Playfair+Display:ital@1'])
    expect(injectedHrefs()).toEqual([`${base}/fonts.css`])
  })

  it('faces cannot promote a family the list does not declare', () => {
    const base = B('narrowing')
    setFontsBaseUrl(base, ['Inter'], { faces: { Inter: { normal: [400] }, Zilch: { normal: [400] } } })
    ensureGoogleFontsLoaded(['Zilch'])
    expect(injectedHrefs()).toEqual(['https://fonts.googleapis.com/css2?family=Zilch&display=swap'])
  })

  it('names the fallen-through spec in the warning, and not the vendored one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const base = B('logged')
    setFontsBaseUrl(base, FAMILIES, REAL)
    ensureGoogleFontsLoaded(['Inter:wght@400', 'Quire:ital@1'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('Quire:ital@1')
    expect(warn.mock.calls[0][0]).not.toContain('Inter')
  })
})

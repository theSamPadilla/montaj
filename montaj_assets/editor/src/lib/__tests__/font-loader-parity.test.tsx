import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FontFamilyPicker, setFontsBaseUrl as setPickerBase } from '../../text/FontPicker'
import { ensureGoogleFontsLoaded, setFontsBaseUrl as setOverlayBase } from '../google-fonts'

// ---------------------------------------------------------------------------
// TWO LOADERS, ONE PARTITION
// ---------------------------------------------------------------------------
//
// This package ships two independent Google Fonts loaders — `lib/google-fonts`
// (captions, overlays, the timeline/overlay preview) and `text/FontPicker`
// (the picker's own preview list). They keep separate bases and separate
// injection state on purpose. They must NOT keep separate opinions about which
// families a vendored stylesheet covers: one loader serving a family locally
// while the other fetches it from Google is a caption in one face in the
// picker and another on the canvas, with nothing on screen to explain it.
//
// The render package pins its two duplicated copies as identical SOURCE TEXT,
// because its two renderers are separate CLI entry points that cannot import
// each other. These two can import, and do — both partition through
// `lib/font-families`. Textual parity would therefore be a test that cannot
// fail. So this pins the property that actually matters instead: given the
// same family list, the two loaders put the same families on the same side.
//
// Driving them is asymmetric because their inputs are: the overlay loader
// takes the specs it is asked for, while the picker always requests its own
// fixed FONT_OPTIONS set. So feed the picker's specs to the overlay loader and
// compare what each one emits.

function injectedHrefs(): string[] {
  return Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map(
    (l) => (l as HTMLLinkElement).href,
  )
}

/** The googleapis URL a loader emitted, reduced to its `family=` specs. */
function googleSpecs(hrefs: string[]): string[] {
  const url = hrefs.find((h) => h.includes('fonts.googleapis.com'))
  if (!url) return []
  return [...url.matchAll(/family=([^&]+)/g)].map((m) => decodeURIComponent(m[1]))
}

/** Whether a loader linked the vendored stylesheet. */
const linkedVendored = (hrefs: string[]) => hrefs.some((h) => h.endsWith('/fonts.css'))

// The picker's own spec list, read out of the module rather than restated, so
// a change to FONT_OPTIONS cannot leave this comparing a stale set.
async function pickerSpecs(): Promise<string[]> {
  const { FONT_OPTIONS } = await import('../../text/FontPicker')
  return FONT_OPTIONS.filter((f) => f.isGoogleFont).map(
    (f) => f.spec ?? `${f.label.replace(/ /g, '+')}:wght@400;700`,
  )
}

beforeEach(() => {
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  setPickerBase(undefined)
  setOverlayBase(undefined)
  vi.restoreAllMocks()
})

// Each case uses a base unique to itself: both loaders dedupe on the URLs they
// have already injected, and that state outlives a test, so a repeated base
// would make a loader look silent when it had merely already spoken.
describe('the picker loader and the overlay loader partition identically', () => {
  const CASES: [string, (all: string[]) => string[]][] = [
    ['every picker family vendored', (all) => all.map(familyOf)],
    ['none vendored', () => []],
    ['one family missing from the vendored list', (all) => all.slice(1).map(familyOf)],
    ['half vendored', (all) => all.slice(0, 10).map(familyOf)],
    ['vendored list spelled Google-style, with +', (all) => all.map((s) => s.split(':')[0])],
    ['vendored list in a different case', (all) => all.map((s) => familyOf(s).toUpperCase())],
  ]

  function familyOf(spec: string) {
    return spec.split(':')[0].replace(/\+/g, ' ')
  }

  for (const [label, listFor] of CASES) {
    it(label, async () => {
      const specs = await pickerSpecs()
      const families = listFor(specs)
      const base = `https://example.com/fonts/parity-${label.replace(/[^a-z]+/gi, '-')}`

      setPickerBase(base, families)
      render(<FontFamilyPicker value="" onChange={() => {}} />)
      const picker = injectedHrefs()

      document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())

      setOverlayBase(base, families)
      ensureGoogleFontsLoaded(specs)
      const overlay = injectedHrefs()

      expect(googleSpecs(overlay)).toEqual(googleSpecs(picker))
      expect(linkedVendored(overlay)).toBe(linkedVendored(picker))
    })
  }

  it('and a host that sets only ONE of the two setters still leaves the other on Google', () => {
    // Not a defect to fix here — it is the documented contract on
    // `src/index.ts` — but it is the mistake a host will actually make, so
    // pin that it stays visible rather than silently half-working.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPickerBase('https://example.com/fonts/only-picker', ['Inter'])
    // The overlay loader was never pointed anywhere, so it has no base at all.
    ensureGoogleFontsLoaded(['Inter:wght@400'])
    const hrefs = injectedHrefs()
    expect(hrefs.some((h) => h.includes('fonts.googleapis.com'))).toBe(true)
    // ...and the picker's own setter said out loud what it was given.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('treating NOTHING as vendored')
  })
})

// ---------------------------------------------------------------------------
// ...AND THEY AGREE AT FACE LEVEL TOO
// ---------------------------------------------------------------------------
//
// The partition is family-level AND face-level: a spec is vendored only when
// its family is declared and every face it requires is available. That second
// half is the one that can disagree quietly, because both loaders can name the
// same family while resolving different weights of it — and the picker is the
// loader that requests `Bebas+Neue:wght@400;700`, the one shipped spec whose
// answer depends on the `requested` map rather than on what is on disk.
//
// This is the TS half's parity mechanism. It is behavioural on purpose: both
// loaders import `lib/font-families`, so there is no second copy to compare
// textually and such a test could not fail. What can still diverge is how each
// loader WIRES that shared code — which argument it passes, and whether it
// passes the face index at all — and only running both can catch that.
describe('the two loaders agree on the FACE partition, not just the family one', () => {
  function familyOf(spec: string) {
    return spec.split(':')[0].replace(/\+/g, ' ')
  }

  /** The faces the picker's own specs resolve to, with `broken` letting a case
   *  remove something and check both loaders react the same way. */
  function faceDataFor(specs: string[], broken?: (f: Record<string, { normal: number[] }>) => void) {
    const faces: Record<string, { normal: number[] }> = {}
    const requested: Record<string, { normal: number[] }> = {}
    for (const spec of specs) {
      const family = familyOf(spec)
      const axes = spec.split(':')[1]
      const weights = axes ? axes.slice('wght@'.length).split(';').map(Number) : [400]
      requested[family] = { normal: weights }
      // Bebas Neue publishes no 700, so it received only the 400 it asked for.
      faces[family] = { normal: family === 'Bebas Neue' ? [400] : weights }
    }
    broken?.(faces)
    return { faces, requested }
  }

  type Faces = Record<string, { normal: number[] }>
  const CASES: [string, (specs: string[]) => { faces: Faces; requested?: Faces }][] = [
    // Every picker spec satisfied — including Bebas Neue, and only because
    // `requested` says Google was asked for the 700 and declined.
    ['the real shipped manifest', (s) => faceDataFor(s)],
    // Drop `requested` and Bebas Neue's missing 700 sends that spec to Google.
    // Both loaders must send it, or neither.
    ['faces only, no requested — Bebas Neue crosses to Google', (s) => ({ faces: faceDataFor(s).faces })],
    // A weight removed from a family every picker spec asks for at 700.
    ['a weight missing from Inter', (s) => faceDataFor(s, (f) => { f.Inter = { normal: [400] } })],
    // Face information that covers nothing at all.
    ['an empty faces map', () => ({ faces: {} })],
  ]

  for (const [label, dataFor] of CASES) {
    it(label, async () => {
      const specs = await pickerSpecs()
      const families = specs.map(familyOf)
      const faceData = dataFor(specs)
      const base = `https://example.com/fonts/faceparity-${label.replace(/[^a-z]+/gi, '-')}`

      setPickerBase(base, families, faceData)
      render(<FontFamilyPicker value="" onChange={() => {}} />)
      const picker = injectedHrefs()

      document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())

      setOverlayBase(base, families, faceData)
      ensureGoogleFontsLoaded(specs)
      const overlay = injectedHrefs()

      expect(googleSpecs(overlay)).toEqual(googleSpecs(picker))
      expect(linkedVendored(overlay)).toBe(linkedVendored(picker))
    })
  }

  // The property the whole feature is for, asserted on the real shape: with
  // the shipped manifest neither loader touches Google at all.
  it('with the shipped manifest, NEITHER loader reaches Google', async () => {
    const specs = await pickerSpecs()
    const families = specs.map(familyOf)
    const faceData = faceDataFor(specs)
    const base = 'https://example.com/fonts/faceparity-zero-egress'

    setPickerBase(base, families, faceData)
    render(<FontFamilyPicker value="" onChange={() => {}} />)
    expect(googleSpecs(injectedHrefs())).toEqual([])
    expect(linkedVendored(injectedHrefs())).toBe(true)

    document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove())

    setOverlayBase(base, families, faceData)
    ensureGoogleFontsLoaded(specs)
    expect(googleSpecs(injectedHrefs())).toEqual([])
    expect(linkedVendored(injectedHrefs())).toBe(true)
  })

  // Both loaders log the same digest for the same manifest — the value that
  // pins the TS↔JS seam. If one passed the face index and the other did not,
  // the two lines would differ and this is where it would show.
  it('both setters log the same digest for the same manifest', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const specs = await pickerSpecs()
    const families = specs.map(familyOf)
    const faceData = faceDataFor(specs)

    setPickerBase('https://example.com/fonts/digest-picker', families, faceData)
    setOverlayBase('https://example.com/fonts/digest-overlay', families, faceData)

    const digests = info.mock.calls
      .map((c) => String(c[0]).match(/vendored set ([0-9a-f]{8})/)?.[1])
      .filter(Boolean)
    expect(digests).toHaveLength(2)
    expect(digests[0]).toBe(digests[1])
    // The same literal the render suite pins, so a divergence between the two
    // languages surfaces here as well as there.
    expect(digests[0]).toBe('1fcf41c1')
  })
})

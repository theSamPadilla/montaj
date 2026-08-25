import { describe, expect, it } from 'vitest'
import { FONT_OPTIONS, findFontOption } from '../FontPicker'

describe('FONT_OPTIONS', () => {
  it('gives every Google font a non-empty spec, and no non-Google font a spec', () => {
    for (const opt of FONT_OPTIONS) {
      if (opt.isGoogleFont) {
        expect(opt.spec, `${opt.label} should have a spec`).toBeTruthy()
      } else {
        expect(opt.spec, `${opt.label} should not have a spec`).toBeUndefined()
      }
    }
  })

  it('includes the rounded/display group: Baloo 2, Fredoka, Sniglet', () => {
    const labels = FONT_OPTIONS.map((f) => f.label)
    expect(labels).toContain('Baloo 2')
    expect(labels).toContain('Fredoka')
    expect(labels).toContain('Sniglet')
  })

  it('resolves Baloo 2 via findFontOption by its CSS value', () => {
    const resolved = findFontOption('"Baloo 2", system-ui, sans-serif')
    expect(resolved?.label).toBe('Baloo 2')
  })

  it('does not request weight 700 for Sniglet, which only publishes 400 and 800', () => {
    const sniglet = FONT_OPTIONS.find((f) => f.label === 'Sniglet')
    expect(sniglet?.spec).toBeTruthy()
    const weights = sniglet!.spec!.split('wght@')[1]?.split(';') ?? []
    expect(weights).not.toContain('700')
    expect(weights).toContain('400')
    expect(weights).toContain('800')
  })

  it('has no literal spaces in any spec (URL-safe as a css2 family param)', () => {
    for (const opt of FONT_OPTIONS) {
      if (opt.spec) {
        expect(opt.spec.includes(' '), `${opt.label} spec "${opt.spec}" contains a space`).toBe(false)
      }
    }
  })
})

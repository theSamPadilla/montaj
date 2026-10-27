import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __resetFontFilesForTests, ensureFontFilesLoaded, loadFontFace } from '../font-files'

// §587 r3: a font file of the person's own is loaded with FontFace from the
// URL the host serves it at, once per family and URL.

const added: Array<{ family: string; source: string }> = []
class FakeFontFace {
  family: string
  source: string
  constructor(family: string, source: string) { this.family = family; this.source = source }
  load() { return Promise.resolve(this) }
}

beforeEach(() => {
  __resetFontFilesForTests()
  added.length = 0
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (f: FakeFontFace) => { added.push({ family: f.family, source: f.source }) } },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete (document as unknown as { fonts?: unknown }).fonts
})

describe('font-files', () => {
  it('loads a face once per family and URL', async () => {
    await loadFontFace('Brand Sans', '/api/files?path=%2Fa.ttf')
    await loadFontFace('Brand Sans', '/api/files?path=%2Fa.ttf')
    expect(added).toEqual([{ family: 'Brand Sans', source: 'url("/api/files?path=%2Fa.ttf")' }])
  })

  it('resolves each element file through the host and skips malformed entries', async () => {
    ensureFontFilesLoaded(
      [{ family: 'Brand Sans', src: 'fonts/a.ttf' }, { family: '', src: 'x.ttf' }, { nope: 1 } as never, { family: 'Acme', src: '/b.otf' }],
      (src) => `/files/${src}`,
    )
    await Promise.resolve()
    expect(added.map((a) => a.family)).toEqual(['Brand Sans', 'Acme'])
    expect(added[0].source).toBe('url("/files/fonts/a.ttf")')
  })

  it('does nothing without FontFace (a non-browser host) and with no files', () => {
    vi.stubGlobal('FontFace', undefined)
    expect(() => ensureFontFilesLoaded([{ family: 'A', src: 'a.ttf' }], (s) => s)).not.toThrow()
    expect(() => ensureFontFilesLoaded(undefined, (s) => s)).not.toThrow()
    expect(added).toEqual([])
  })

  it('a failed load is forgotten, so a later call tries again', async () => {
    let fail = true
    vi.stubGlobal('FontFace', class extends FakeFontFace { load() { return fail ? Promise.reject(new Error('bad')) : Promise.resolve(this) } })
    await loadFontFace('A', '/a.ttf').catch(() => {})
    expect(added).toEqual([])
    fail = false
    await loadFontFace('A', '/a.ttf')
    expect(added).toHaveLength(1)
  })
})

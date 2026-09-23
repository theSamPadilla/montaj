import { describe, it, expect, vi } from 'vitest'
import type { EditorAdapter, Project } from '../../types'
import type { Captions } from '../../schema'
import { mergeCaptionProfileDefaults, resolveCaptionProfileDefaults } from '../captionProfileDefaults'

// A freshly transcribed track as the host routes actually return one: a bare
// `{ style, segments }` with no text styling at all (montaj's own
// `steps/caption/caption.py` builds exactly this shape). Every field the
// profile can seed is therefore absent here, which is the whole reason seeding
// is worth doing.
const FRESH: Captions = {
  style: 'pop',
  segments: [{ text: 'hola', start: 0, end: 1, words: [] }],
}

function adapterWith(
  getCaptionProfileDefaults?: EditorAdapter<Project>['getCaptionProfileDefaults'],
): EditorAdapter<Project> {
  return { getCaptionProfileDefaults } as unknown as EditorAdapter<Project>
}

describe('mergeCaptionProfileDefaults', () => {
  it('fills the fields the server left unset', () => {
    const merged = mergeCaptionProfileDefaults(FRESH, {
      fontFamily: '"Inter", system-ui, sans-serif',
      color: '#112233',
    })
    expect(merged.fontFamily).toBe('"Inter", system-ui, sans-serif')
    expect(merged.color).toBe('#112233')
    expect(merged.segments).toBe(FRESH.segments)
    expect(merged.style).toBe('pop')
  })

  it('never overwrites a color the server response already set', () => {
    // The route returns a bare track today. If it ever starts carrying a
    // color, that value is authored downstream of the profile and wins.
    const withColor: Captions = { ...FRESH, color: '#ff0000' }
    const merged = mergeCaptionProfileDefaults(withColor, { color: '#112233' })
    expect(merged.color).toBe('#ff0000')
  })

  it('never overwrites a fontFamily the server response already set', () => {
    const withFont: Captions = { ...FRESH, fontFamily: '"Figtree", system-ui, sans-serif' }
    const merged = mergeCaptionProfileDefaults(withFont, {
      fontFamily: '"Inter", system-ui, sans-serif',
      googleFonts: ['Inter:wght@700'],
    })
    expect(merged.fontFamily).toBe('"Figtree", system-ui, sans-serif')
    expect(merged.googleFonts).toBeUndefined()
  })

  it('carries googleFonts along with a seeded fontFamily', () => {
    // `fontFamily` and `googleFonts` travel together (see the `Captions` doc
    // comment): a family whose file is not also fetched renders as the
    // fallback face, in the preview AND the export. Seeding one without the
    // other is the silent half-failure this pair exists to avoid.
    const merged = mergeCaptionProfileDefaults(FRESH, {
      fontFamily: '"Inter", system-ui, sans-serif',
      googleFonts: ['Inter:wght@700'],
    })
    expect(merged.googleFonts).toEqual(['Inter:wght@700'])
  })

  it('does not inject googleFonts when the family was not seeded', () => {
    const withFont: Captions = { ...FRESH, fontFamily: '"Figtree", system-ui, sans-serif' }
    const merged = mergeCaptionProfileDefaults(withFont, { googleFonts: ['Inter:wght@700'] })
    expect(merged.googleFonts).toBeUndefined()
  })

  it('returns the very same object when there is nothing to seed', () => {
    // Reference identity, not deep equality: the caller feeds the result
    // straight to `applyExternal`, and a fresh object there is a state change
    // the editor has to reconcile for no reason.
    expect(mergeCaptionProfileDefaults(FRESH, null)).toBe(FRESH)
    expect(mergeCaptionProfileDefaults(FRESH, undefined)).toBe(FRESH)
    expect(mergeCaptionProfileDefaults(FRESH, {})).toBe(FRESH)
    expect(mergeCaptionProfileDefaults(FRESH, { style: 'karaoke' })).toBe(FRESH)
  })

  it('never writes the profile style onto the track', () => {
    // `style` seeds the GENERATION request, not the returned track: the host
    // reports the style it actually transcribed with, and that report wins.
    const merged = mergeCaptionProfileDefaults(FRESH, { style: 'karaoke', color: '#112233' })
    expect(merged.style).toBe('pop')
  })

  it('treats an empty-string default as nothing to seed', () => {
    // A host backed by a nullable column can hand back `''` for "unset".
    expect(mergeCaptionProfileDefaults(FRESH, { fontFamily: '', color: '' })).toBe(FRESH)
  })
})

describe('resolveCaptionProfileDefaults', () => {
  it('returns null when the host implements no seam', async () => {
    expect(await resolveCaptionProfileDefaults(adapterWith(), 'sam')).toBeNull()
  })

  it('returns null when the project has no profile', async () => {
    const seam = vi.fn(async () => ({ color: '#112233' }))
    expect(await resolveCaptionProfileDefaults(adapterWith(seam), undefined)).toBeNull()
    expect(await resolveCaptionProfileDefaults(adapterWith(seam), '')).toBeNull()
    expect(seam).not.toHaveBeenCalled()
  })

  it('returns null rather than throwing when the seam rejects', async () => {
    const seam = vi.fn(async () => { throw new Error('boom') })
    await expect(resolveCaptionProfileDefaults(adapterWith(seam), 'sam')).resolves.toBeNull()
  })

  it('returns null rather than throwing when the seam throws synchronously', async () => {
    const seam = vi.fn(() => { throw new Error('boom') }) as unknown as EditorAdapter<Project>['getCaptionProfileDefaults']
    await expect(resolveCaptionProfileDefaults(adapterWith(seam), 'sam')).resolves.toBeNull()
  })

  it('passes the profile name through and returns what the host answered', async () => {
    const answer = { style: 'karaoke', color: '#112233' }
    const seam = vi.fn(async () => answer)
    expect(await resolveCaptionProfileDefaults(adapterWith(seam), 'sam')).toBe(answer)
    expect(seam).toHaveBeenCalledWith('sam')
  })
})

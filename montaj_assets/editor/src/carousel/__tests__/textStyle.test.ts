import { describe, it, expect } from 'vitest'
import type { OverlayElement } from '../../types'
import { applyTextStyle, isTextOverlay, pickTextStyle, TEXT_STYLE_PROPS } from '../textStyle'

function text(props: Record<string, unknown>, extra: Partial<OverlayElement> = {}): OverlayElement {
  return { id: 'e', type: 'overlay', overlay: { template: 't.jsx', props }, frame: 0, x: 0, y: 0, w: 10, h: 10, rotation: 0, ...extra }
}

describe('textStyle', () => {
  it('lists the standard props but the text, plus the effect trio', () => {
    expect([...TEXT_STYLE_PROPS].sort()).toEqual([
      'bgColor', 'color', 'effect', 'effectColor', 'effectStrength', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'textAlign', 'textTransform',
    ])
  })

  it('knows a text overlay by its string text prop', () => {
    expect(isTextOverlay(text({ text: 'Hi' }))).toBe(true)
    expect(isTextOverlay(text({ color: 'red' }))).toBe(false)
    expect(isTextOverlay({ id: 'i', type: 'image', src: 'a.png', x: 0, y: 0, w: 1, h: 1, rotation: 0 })).toBe(false)
  })

  it('picks the style props it has, with googleFonts, and never the text', () => {
    const style = pickTextStyle(text({ text: 'Hi', color: 'red', fontFamily: 'Syne', effect: 'shadow', other: 1 }, { googleFonts: ['Syne:wght@800'] }))
    expect(style).toEqual({ props: { color: 'red', fontFamily: 'Syne', effect: 'shadow' }, googleFonts: ['Syne:wght@800'] })
    expect(pickTextStyle(text({ text: 'Hi', color: 'red' }))).toEqual({ props: { color: 'red' } })
  })

  it('writes only the keys the target has, and keeps its text', () => {
    const style = { props: { color: 'red', fontSize: 40, effect: 'shadow' } }
    const target = text({ text: 'Keep', color: 'blue', fontSize: '10' })
    const out = applyTextStyle(target, style)
    expect(out.overlay.props).toEqual({ text: 'Keep', color: 'red', fontSize: 40 })
    expect(out).not.toBe(target)
    expect(target.overlay.props.color).toBe('blue')
  })

  it('carries googleFonts with fontFamily, and only then', () => {
    const style = { props: { fontFamily: 'Syne' }, googleFonts: ['Syne:wght@800'] }
    expect(applyTextStyle(text({ text: 'a', fontFamily: 'Inter' }), style).googleFonts).toEqual(['Syne:wght@800'])
    expect(applyTextStyle(text({ text: 'a', color: 'x' }), style).googleFonts).toBeUndefined()
    expect('googleFonts' in applyTextStyle(text({ text: 'a', fontFamily: 'Syne' }, { googleFonts: ['Old'] }), { props: { fontFamily: 'Syne' } })).toBe(false)
  })

  it('carries fontFiles with fontFamily, as googleFonts (§587 r3)', () => {
    const files = [{ family: 'Brand Sans', src: '/p/brand.ttf' }]
    const picked = pickTextStyle(text({ text: 'a', fontFamily: '"Brand Sans"' }, { fontFiles: files }))
    expect(picked.fontFiles).toEqual(files)
    expect(applyTextStyle(text({ text: 'a', fontFamily: 'Inter' }), picked).fontFiles).toEqual(files)
    expect(applyTextStyle(text({ text: 'a', color: 'x' }), picked).fontFiles).toBeUndefined()
    expect('fontFiles' in applyTextStyle(text({ text: 'a', fontFamily: 'Inter' }, { fontFiles: files }), { props: { fontFamily: 'Inter' } })).toBe(false)
  })

  it('returns the same element when nothing would change', () => {
    const target = text({ text: 'a', color: 'red' })
    expect(applyTextStyle(target, { props: { color: 'red', effect: 'x' } })).toBe(target)
  })
})

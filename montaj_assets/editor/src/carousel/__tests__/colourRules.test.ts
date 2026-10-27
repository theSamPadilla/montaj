import { describe, it, expect } from 'vitest'
import type { CarouselElement } from '../../types'
import { elementColourTarget, resolveColourQuery, shapeKind } from '../colours'
import { namedColour } from '../colourNames'
import { dominantColours } from '../photoColours'

// §587 R9: the swatch's target, the search field's names, the photo palette.

const overlay = (template: string, props: Record<string, unknown>) =>
  ({ id: 'o', type: 'overlay', x: 0, y: 0, w: 10, h: 10, rotation: 0, overlay: { template, props } }) as unknown as CarouselElement

describe('elementColourTarget', () => {
  it('text: the text colour, with transparency', () => {
    expect(elementColourTarget(overlay('/t/text.jsx', { text: 'Hi', color: '#ABC' }))).toEqual({ key: 'color', label: 'Text color', alpha: true, value: '#aabbcc' })
  })
  it('shape: the fill; a fill that draws nothing gives the stroke', () => {
    const t = '/o/shape-rect/shape-rect.jsx'
    expect(elementColourTarget(overlay(t, { fill: '#bdbdbd', stroke: '#111111' }))?.key).toBe('fill')
    for (const fill of ['none', 'transparent', '', '#bdbdbd00']) {
      expect(elementColourTarget(overlay(t, { fill, stroke: '#336699' }))).toMatchObject({ key: 'stroke', value: '#336699' })
    }
  })
  it('line and frame: the stroke; an image or a graphic: none', () => {
    expect(elementColourTarget(overlay('/o/line-arrow/line-arrow.jsx', { stroke: '#aa0000' }))?.key).toBe('stroke')
    expect(elementColourTarget(overlay('/o/frame-border/frame-border.jsx', { stroke: '#00aa00' }))?.key).toBe('stroke')
    expect(elementColourTarget(overlay('/o/badge.jsx', { accent: '#ff0000' }))).toBeNull()
    expect(elementColourTarget({ id: 'i', type: 'image', src: 'a.png', x: 0, y: 0, w: 1, h: 1, rotation: 0 } as CarouselElement)).toBeNull()
  })
  it('shapeKind reads the template file name', () => {
    expect(shapeKind('/rt/templates/overlays/shape-ellipse/shape-ellipse.jsx')).toBe('shape')
    expect(shapeKind('/x/my-shape-rect.jsx')).toBeNull()
  })
})

describe('resolveColourQuery', () => {
  it('takes a CSS name in any case and spacing, or a hex with or without #', () => {
    expect(resolveColourQuery('blue', namedColour)).toBe('#0000ff')
    expect(resolveColourQuery('  Light Blue ', namedColour)).toBe('#add8e6')
    expect(resolveColourQuery('#00B4D8', namedColour)).toBe('#00b4d8')
    expect(resolveColourQuery('00b4d8', namedColour)).toBe('#00b4d8')
    expect(resolveColourQuery('nope', namedColour)).toBeNull()
    expect(resolveColourQuery('', namedColour)).toBeNull()
  })
})

describe('dominantColours', () => {
  const px = (rgb: [number, number, number], n: number, a = 255) => Array.from({ length: n }, () => [...rgb, a]).flat()
  it('most common first, near colours merged, transparent pixels ignored', () => {
    const data = [
      ...px([200, 30, 30], 50),
      ...px([205, 32, 28], 10), // same as the red
      ...px([20, 20, 220], 30),
      ...px([0, 255, 0], 80, 0), // transparent
    ]
    const out = dominantColours(data, 6)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/^#c[89a-f]/)
    expect(out[1]).toBe('#1414dc')
  })
  it('caps the count', () => {
    const data = [...px([0, 0, 0], 5), ...px([255, 255, 255], 4), ...px([255, 0, 0], 3), ...px([0, 0, 255], 2)]
    expect(dominantColours(data, 2)).toEqual(['#000000', '#ffffff'])
  })
})

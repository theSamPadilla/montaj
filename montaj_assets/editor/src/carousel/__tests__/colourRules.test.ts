import { describe, it, expect } from 'vitest'
import type { CarouselElement, Slide } from '../../types'
import { collectColours, elementColourTarget, replaceColour, resolveColourQuery, shapeKind } from '../colours'
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
    const t = '/rt/render/templates/overlays/shape-rect/shape-rect.jsx'
    expect(elementColourTarget(overlay(t, { fill: '#bdbdbd', stroke: '#111111' }))?.key).toBe('fill')
    for (const fill of ['none', 'transparent', '', '#bdbdbd00']) {
      expect(elementColourTarget(overlay(t, { fill, stroke: '#336699' }))).toMatchObject({ key: 'stroke', value: '#336699' })
    }
  })
  it('line and frame: the stroke; an image or a graphic: none', () => {
    expect(elementColourTarget(overlay('/rt/render/templates/overlays/line-arrow/line-arrow.jsx', { stroke: '#aa0000' }))?.key).toBe('stroke')
    expect(elementColourTarget(overlay('/rt/render/templates/overlays/frame-border/frame-border.jsx', { stroke: '#00aa00' }))?.key).toBe('stroke')
    expect(elementColourTarget(overlay('/o/badge.jsx', { accent: '#ff0000' }))).toBeNull()
    expect(elementColourTarget({ id: 'i', type: 'image', src: 'a.png', x: 0, y: 0, w: 1, h: 1, rotation: 0 } as CarouselElement)).toBeNull()
  })
  it('a shape\'s fill and stroke, a line\'s and a frame\'s stroke take transparency, and keep an 8-digit value', () => {
    const t = '/rt/render/templates/overlays/shape-rect/shape-rect.jsx'
    expect(elementColourTarget(overlay(t, { fill: '#bdbdbd80', stroke: '#111111' }))).toEqual({ key: 'fill', label: 'Fill color', alpha: true, value: '#bdbdbd80' })
    expect(elementColourTarget(overlay(t, { fill: 'none', stroke: '#33669980' }))).toEqual({ key: 'stroke', label: 'Stroke color', alpha: true, value: '#33669980' })
    expect(elementColourTarget(overlay('/rt/render/templates/overlays/line-arrow/line-arrow.jsx', { stroke: '#aa0000' }))?.alpha).toBe(true)
    expect(elementColourTarget(overlay('/rt/render/templates/overlays/frame-border/frame-border.jsx', { stroke: '#00aa00' }))?.alpha).toBe(true)
  })
  it('shapeKind reads the template file name', () => {
    expect(shapeKind('/rt/render/templates/overlays/shape-ellipse/shape-ellipse.jsx')).toBe('shape')
    expect(shapeKind('/x/my-shape-rect.jsx')).toBeNull()
  })
  it('shapeKind: a project overlay named like a shipped one gets no swatch', () => {
    expect(shapeKind('/proj/overlays/callout-stat.jsx')).toBeNull()
    expect(shapeKind('/proj/overlays/line-chart.jsx')).toBeNull()
    expect(shapeKind('/proj/overlays/callout-stat/callout-stat.jsx')).toBeNull()
    expect(shapeKind('/Users/a/render/templates/overlays/callout-box/callout-box.jsx')).toBe('shape')
    expect(elementColourTarget(overlay('/proj/overlays/callout-stat.jsx', { fill: '#ff0000' }))).toBeNull()
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

describe('run colours in the colour list and Change on every slide', () => {
  const TEXT = 'templates/overlays/static-text/static-text.jsx'
  const runs = JSON.stringify([{ t: 'Make it ' }, { t: 'red', c: '#FF0000', b: 1 }, { t: ' and ' }, { t: 'blue', c: '#0000ff' }])
  const text = (id: string, extra: Record<string, unknown> = {}, locked = false) =>
    ({ ...overlay(TEXT, { text: 'Make it red and blue', color: '#111111', runs, ...extra }), id, ...(locked ? { locked: true } : {}) }) as CarouselElement
  const slides = (els: CarouselElement[]): Slide[] => [{ id: 's', base_color: '#ffffff', elements: els }]
  const props = (s: Slide[], i = 0) => (s[0].elements[i] as Extract<CarouselElement, { type: 'overlay' }>).overlay.props

  it('the list counts each run\'s colour', () => {
    const list = collectColours(slides([text('a'), text('b', { runs: JSON.stringify([{ t: 'Make it red and blue', c: '#ff0000' }]) })]))
    // Two text colours, two red runs, one background, one blue run.
    expect(list).toEqual(['#111111', '#ff0000', '#ffffff', '#0000ff'])
  })

  it('runs that do not spell the text are not counted', () => {
    expect(collectColours(slides([text('a', { text: 'Something else' })]))).not.toContain('#ff0000')
  })

  it('a replace rewrites matching run colours in the same element write, keeping the text', () => {
    const next = replaceColour(slides([text('a')]), '#ff0000', '#00ff0080')
    const p = props(next)
    expect(p.text).toBe('Make it red and blue')
    expect(JSON.parse(p.runs as string)).toEqual([{ t: 'Make it ' }, { t: 'red', c: '#00ff0080', b: 1 }, { t: ' and ' }, { t: 'blue', c: '#0000ff' }])
    expect(p.color).toBe('#111111')
  })

  it('a locked element\'s runs stay, and a colour no run uses changes nothing', () => {
    const locked = slides([text('a', {}, true)])
    expect(replaceColour(locked, '#ff0000', '#00ff00')).toBe(locked)
    const plain = slides([text('a')])
    expect(replaceColour(plain, '#123456', '#00ff00')).toBe(plain)
  })
})

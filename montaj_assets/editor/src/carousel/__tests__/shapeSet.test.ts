import { describe, it, expect } from 'vitest'
import type { CarouselElement, GlobalOverlay } from '../../types'
import { elementColourTarget, shapeKind } from '../colours'
import { strokeStateOf } from '../stroke'
import { ELEMENT_CATEGORIES, elementCategory, newOverlayBox, orderElements } from '../overlayElement'

// §587 round 2, F-I: the fuller set of shipped shapes. Every shipped template
// with a category is read from its real sidecar, and must declare the props
// the element toolbar's swatch and Stroke popover work from, with the same
// defaults the toolbar assumes when a prop was never saved.

interface Sidecar { description: string; category?: string; aspect?: number; props: GlobalOverlay['props'] }
const FILES = import.meta.glob('../../../../render/templates/overlays/*/*.json', { eager: true, import: 'default' }) as Record<string, Sidecar>
// `<name>/<name>.json` only: a folder's other JSON is not its sidecar.
const SIDECARS: Record<string, Sidecar> = Object.fromEntries(
  Object.entries(FILES).flatMap(([p, s]) => {
    const [dir, file] = p.split('/').slice(-2)
    return file === `${dir}.json` ? [[dir, s]] : []
  }),
)
const ELEMENTS = Object.entries(SIDECARS).filter(([, s]) => (ELEMENT_CATEGORIES as readonly string[]).includes(s.category ?? ''))

const NEW: Record<string, string[]> = {
  shape: [
    'shape-heart', 'shape-diamond', 'shape-hexagon', 'shape-octagon', 'shape-pill', 'shape-semicircle', 'shape-ring',
    'shape-plus', 'shape-cross', 'shape-x', 'shape-check', 'shape-blob-1', 'shape-blob-2', 'shape-blob-3', 'shape-blob-4',
  ],
  arrow: ['arrow-double', 'arrow-curved', 'arrow-chevron'],
  line: ['line-dot-ends', 'line-bar-ends'],
  callout: ['callout-speech-round', 'callout-speech-rect', 'callout-box', 'callout-thought'],
}

const path = (name: string) => `/Users/someone/montaj/render/templates/overlays/${name}/${name}.jsx`
const elementOf = (name: string, s: Sidecar) => ({
  id: name, type: 'overlay', x: 0, y: 0, w: 100, h: 100, rotation: 0,
  overlay: { template: path(name), props: Object.fromEntries(s.props.filter((p) => p.default !== undefined).map((p) => [p.name, p.default])) },
}) as unknown as CarouselElement
const prop = (s: Sidecar, name: string) => s.props.find((p) => p.name === name)

describe('the shipped shape set (§587 F-I)', () => {
  it('the Elements categories, in panel order', () => {
    expect([...ELEMENT_CATEGORIES]).toEqual(['shape', 'arrow', 'line', 'frame', 'callout'])
  })

  it('every new template exists, in its category, with a short plain label', () => {
    for (const [category, names] of Object.entries(NEW)) {
      for (const name of names) {
        const s = SIDECARS[name]
        expect(s, name).toBeTruthy()
        expect(s.category, name).toBe(category)
        expect(s.description.length, name).toBeGreaterThan(0)
        expect(s.description.length, name).toBeLessThanOrEqual(16)
        expect(s.description, name).not.toMatch(/[—–]/)
      }
    }
    // The block arrow moved to Arrows; the arrow line stays a line.
    expect(SIDECARS['shape-arrow'].category).toBe('arrow')
    expect(SIDECARS['line-arrow'].category).toBe('line')
  })

  it('labels are unique, so a tile and a layer row name one template', () => {
    const labels = ELEMENTS.map(([, s]) => s.description)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('every element template declares the props the toolbar reads, with the defaults it assumes', () => {
    expect(ELEMENTS.length).toBeGreaterThanOrEqual(13 + 24)
    for (const [name, s] of ELEMENTS) {
      const el = elementOf(name, s)
      const state = strokeStateOf(el)
      expect(state, `${name}: the Stroke popover`).not.toBeNull()
      expect(shapeKind(path(name)), `${name}: the swatch kind`).not.toBeNull()
      expect(elementColourTarget(el), `${name}: the swatch`).not.toBeNull()
      // A template never saved with a prop draws its sidecar default; the toolbar must read the same.
      const bare = { ...el, overlay: { ...(el as { overlay: object }).overlay, props: {} } } as unknown as CarouselElement
      const assumed = strokeStateOf(bare)!
      expect(prop(s, 'stroke')?.format, `${name}.stroke`).toBe('color')
      expect(prop(s, 'strokeWidth')?.type, `${name}.strokeWidth`).toBe('int')
      expect(assumed.width, `${name}: strokeWidth default`).toBe(prop(s, 'strokeWidth')?.default)
      expect(prop(s, 'strokeStyle')?.enum, `${name}.strokeStyle`).toEqual(['solid', 'long-dash', 'short-dash', 'dotted'])
      expect(assumed.style, `${name}: strokeStyle default`).toBe(prop(s, 'strokeStyle')?.default)
      if (assumed.roundKey) {
        expect(prop(s, assumed.roundKey)?.type, `${name}.${assumed.roundKey}`).toBe('bool')
        expect(assumed.round, `${name}: ${assumed.roundKey} default`).toBe(prop(s, assumed.roundKey)?.default)
      } else {
        expect(prop(s, 'roundJoins'), `${name}: roundJoins the toolbar never shows`).toBeUndefined()
        expect(prop(s, 'roundCaps'), `${name}: roundCaps the toolbar never shows`).toBeUndefined()
      }
      if (s.category === 'line') {
        expect(assumed.kind, name).toBe('line')
        expect(assumed.roundKey, name).toBe('roundCaps')
        expect(prop(s, 'arrowhead')?.enum, `${name}.arrowhead`).toEqual(['none', 'end', 'start', 'both'])
        expect(assumed.arrowhead, `${name}: arrowhead default`).toBe(prop(s, 'arrowhead')?.default)
      } else {
        expect(assumed.kind, name).toBe('shape')
        expect(prop(s, 'roundCaps'), name).toBeUndefined()
      }
      // A filled kind's swatch is its fill.
      if (s.category !== 'line' && s.category !== 'frame') {
        expect(prop(s, 'fill')?.format, `${name}.fill`).toBe('color')
        expect(elementColourTarget(el)?.key, name).toBe('fill')
      } else {
        expect(elementColourTarget(el)?.key, name).toBe('stroke')
      }
      for (const p of s.props) {
        if (typeof p.default === 'number') expect(p.type, `${name}.${p.name}`).toBe('int')
        if (p.enum) expect(p.enum, `${name}.${p.name}`).toContain(p.default)
      }
    }
  })

  it('the stroke rule skips a project overlay named like a shipped one', () => {
    const mk = (template: string) => ({ id: 'p', type: 'overlay', x: 0, y: 0, w: 1, h: 1, rotation: 0, overlay: { template, props: {} } }) as unknown as CarouselElement
    expect(strokeStateOf(mk('/proj/overlays/callout-box.jsx'))).toBeNull()
    expect(strokeStateOf(mk('/proj/overlays/line-straight/line-straight.jsx'))).toBeNull()
    expect(strokeStateOf(mk(path('callout-box')))).not.toBeNull()
  })

  it('Polygon defaults to a count no other tile has (not 6 or 8)', () => {
    const d = prop(SIDECARS['shape-polygon'], 'points')?.default
    expect(d).not.toBe(6)
    expect(d).not.toBe(8)
    expect(d).toBe(5)
  })

  it('a ring declares its thickness; a capped line its cap', () => {
    expect(prop(SIDECARS['shape-ring'], 'thickness')).toMatchObject({ type: 'int', default: 30 })
    expect(prop(SIDECARS['line-dot-ends'], 'cap')).toMatchObject({ default: 'dot', enum: ['dot', 'circle', 'square', 'bar'] })
    expect(prop(SIDECARS['line-bar-ends'], 'cap')).toMatchObject({ default: 'bar', enum: ['dot', 'circle', 'square', 'bar'] })
  })

  it('a new template is added in a box of its own shape: a pill twice as wide as tall, an arrow or a callout like a shape', () => {
    const res = [1080, 1350] as const
    const pill = { category: 'shape', aspect: SIDECARS['shape-pill'].aspect }
    expect(pill.aspect).toBe(2)
    expect(newOverlayBox(pill, res)).toEqual({ w: 432, h: 216 })
    expect(newOverlayBox({ category: 'arrow' }, res)).toEqual({ w: 432, h: 432 })
    expect(newOverlayBox({ category: 'callout' }, res)).toEqual({ w: 432, h: 432 })
    expect(newOverlayBox({ category: 'shape', aspect: 0.5 }, res)).toEqual({ w: 216, h: 432 })
    // a line or a frame keeps its own box
    expect(newOverlayBox({ category: 'line', aspect: 4 }, res)).toEqual({ w: 648, h: 54 })
    expect(elementCategory({ category: 'callout' })).toBe('callout')
  })

  it('the panel shows the basics first, the blobs last, whatever order the listing gives', () => {
    const o = (name: string) => ({ name }) as GlobalOverlay
    const names = orderElements(['shape-blob-1', 'shape-x', 'shape-heart', 'shape-ellipse', 'shape-rect', 'shape-zzz'].map(o)).map((x) => x.name)
    expect(names).toEqual(['shape-rect', 'shape-ellipse', 'shape-heart', 'shape-x', 'shape-blob-1', 'shape-zzz'])
  })
})

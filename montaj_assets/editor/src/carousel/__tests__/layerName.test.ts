import { describe, it, expect } from 'vitest'
import type { CarouselElement } from '../../types'
import { layerName, overlayName } from '../LayersPanel'

function overlay(template: string): CarouselElement {
  return { id: 'o1', type: 'overlay', overlay: { template, props: {} }, frame: 0, x: 0, y: 0, w: 10, h: 10, rotation: 0 }
}

describe('layerName', () => {
  it('names an overlay by its file name, never its path', () => {
    expect(layerName(overlay('/Users/someone/Montaj/2026-10-24-wisdom/overlays/step-card.jsx'))).toBe('step-card')
    expect(layerName(overlay('C:\\Users\\someone\\Montaj\\p\\overlays\\badge.tsx'))).toBe('badge')
    expect(layerName(overlay('overlays/plain'))).toBe('plain')
  })

  it("keeps a shipped template's tile label when there is one", () => {
    expect(layerName(overlay('/x/shapes/circle.jsx'), () => 'Circle')).toBe('Circle')
    expect(layerName(overlay('/x/overlays/mine.jsx'), () => undefined)).toBe('mine')
  })

  it('falls back to Element for an empty template', () => {
    expect(layerName(overlay(''))).toBe('Element')
  })
})

describe('overlayName', () => {
  it('drops the folders and a script extension only', () => {
    expect(overlayName('/a/b/title.card.jsx')).toBe('title.card')
    expect(overlayName('/a/b/notes.md')).toBe('notes.md')
  })
})

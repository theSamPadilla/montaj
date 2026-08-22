/// <reference types="vitest/globals" />
/**
 * What a timeline block calls itself. The old label was the bare `type`, which
 * meant a project with twenty overlays showed the word "overlay" twenty times —
 * the block you wanted could only be found by clicking through them.
 */
import { describe, it, expect } from 'vitest'
import { visualItemLabel } from '../timeline-model'
import type { VisualItem } from '../../../schema'

function overlay(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'o', type: 'overlay', start: 0, end: 1, ...over }
}

describe('visualItemLabel', () => {
  it('names an overlay by its component, so two kinds are told apart at a glance', () => {
    expect(visualItemLabel(overlay({ src: '/p/overlays/photo_hero.jsx' }))).toBe('photo_hero')
  })

  it('appends the text of the first line, which is what is actually on screen', () => {
    const item = overlay({
      src: '/p/overlays/text_line.jsx',
      props: { lines: [{ text: 'we still need them', accent: 'need' }, { text: 'second' }] },
    })
    expect(visualItemLabel(item)).toBe('text_line · we still need them')
  })

  it('falls back through the other copy-carrying props', () => {
    const src = '/p/overlays/photo_hero.jsx'
    expect(visualItemLabel(overlay({ src, props: { caption: 'ex-googler' } }))).toBe('photo_hero · ex-googler')
    expect(visualItemLabel(overlay({ src, props: { title: 'A Title' } }))).toBe('photo_hero · A Title')
  })

  it('keeps the kind alone when the overlay has no copy of its own', () => {
    const item = overlay({ src: '/p/overlays/cold_open.jsx', props: { img1: '/a.jpg', img2: '/b.png' } })
    expect(visualItemLabel(item)).toBe('cold_open')
  })

  it('truncates long copy rather than letting it run the width of the clip', () => {
    const item = overlay({
      src: '/p/overlays/text_line.jsx',
      props: { text: 'a sentence far longer than any timeline block can show' },
    })
    const label = visualItemLabel(item)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThanOrEqual('text_line · '.length + 28)
  })

  it('ignores blank and non-string copy instead of labelling an empty suffix', () => {
    const src = '/p/overlays/text_line.jsx'
    expect(visualItemLabel(overlay({ src, props: { caption: '   ' } }))).toBe('text_line')
    expect(visualItemLabel(overlay({ src, props: { caption: 42 } }))).toBe('text_line')
    expect(visualItemLabel(overlay({ src, props: { lines: [] } }))).toBe('text_line')
    expect(visualItemLabel(overlay({ src, props: { lines: [{ accent: 'x' }] } }))).toBe('text_line')
  })

  it('gives video clips no label — the track rail names the row, the filmstrip names the shot', () => {
    expect(visualItemLabel({ id: 'c', type: 'video', src: '/p/IMG_9401.MOV', start: 0, end: 1 })).toBe('')
  })

  it('names an image by its file', () => {
    expect(visualItemLabel({ id: 'i', type: 'image', src: '/p/assets/robot_dog.png', start: 0, end: 1 })).toBe('robot_dog')
  })

  it('degrades to something printable when there is no src at all', () => {
    expect(visualItemLabel(overlay())).toBe('overlay')
    expect(visualItemLabel({ id: 'i', type: 'image', start: 0, end: 1 })).toBe('image')
  })
})

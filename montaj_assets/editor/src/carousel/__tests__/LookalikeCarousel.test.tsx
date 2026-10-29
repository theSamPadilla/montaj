import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error the template is plain JSX outside the editor's typed sources
import StaticText from '../../../../render/templates/overlays/static-text/static-text.jsx'
import { runsOf, runsPatch, baseTextStyle, spliceRuns, setOverlayPropsIn } from '../../text/runs'
import type { Slide } from '../../types'
import fixture from './fixtures/lookalike-carousel.json'

// §621 task E: a 1080x1350 dark-blue slide with a serif title (one italic gold
// word) and three pills, drawn through the shipped static-text and checked by SSR.

const slides = fixture.slides as unknown as Slide[]
const propsOf = (s: Slide[], id: string) =>
  (s[0].elements.find((e) => e.id === id) as unknown as { overlay: { props: Record<string, string> } }).overlay.props

const html = (id: string) => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<StaticText {...propsOf(slides, id)} />)
  return container
}
const pillOf = (id: string) => html(id).querySelector('p')!.parentElement as HTMLElement

describe('lookalike carousel (static-text, SSR)', () => {
  it('has a dark base and four elements', () => {
    expect(slides[0].base_color).toBe('#0b1f4d')
    expect(slides[0].elements).toHaveLength(4)
  })

  it('title: serif, white, 120px, "beginners" italic gold, text equals joined runs', () => {
    const props = propsOf(slides, 'title')
    const runs = runsOf(props)
    expect(runs.map((r) => r.t).join('')).toBe(props.text)
    const root = html('title')
    const p = root.querySelector('p') as HTMLElement
    expect(p.style.fontFamily).toContain('Georgia')
    expect(p.style.fontFamily).toContain('serif')
    expect(p.style.color).toBe('rgb(255, 255, 255)')
    expect(p.style.fontSize).toBe('120px')
    const span = Array.from(p.querySelectorAll('span')).find((s) => s.textContent === 'beginners') as HTMLElement
    expect(span).toBeTruthy()
    expect(span.style.fontStyle).toBe('italic')
    expect(span.style.color).toBe('rgb(246, 227, 161)')
    expect(p.textContent).toBe(props.text)
  })

  it.each([
    ['pill-pink', 'rgb(255, 194, 226)'],
    ['pill-yellow', 'rgb(253, 234, 168)'],
  ])('%s: hug pill carries background, radius, padding, letter-spacing, uppercase, bold', (id, bg) => {
    const pill = pillOf(id)
    expect(pill.style.background).toBe(bg)
    expect(pill.style.borderRadius).toBe('999px')
    expect(pill.style.padding).toBe('14px 28px')
    const p = pill.querySelector('p') as HTMLElement
    expect(p.style.letterSpacing).toBe('0.08em')
    expect(p.style.textTransform).toBe('uppercase')
    expect(p.style.fontWeight).toBe('700')
    expect(pill.parentElement!.style.background).toBe('transparent')
  })

  it('arrow pill: transparent fill, white 3px border, radius, wide padding', () => {
    const pill = pillOf('pill-arrow')
    expect(pill.style.background).toBe('transparent')
    expect(pill.style.border).toBe('3px solid rgb(255, 255, 255)')
    expect(pill.style.borderRadius).toBe('999px')
    expect(pill.style.padding).toContain('60px')
    expect(pill.textContent).toBe('→')
  })

  it('hug pills sit flush: no outer padding, so pills at the same x share a left edge', () => {
    const pink = propsOf(slides, 'pill-pink')
    const yellow = propsOf(slides, 'pill-yellow')
    const els = fixture.slides[0].elements as unknown as Array<{ id: string; x: number }>
    expect(els.find((e) => e.id === 'pill-pink')!.x).toBe(els.find((e) => e.id === 'pill-yellow')!.x)
    expect(pink.textAlign).toBe(yellow.textAlign)
    for (const id of ['pill-pink', 'pill-yellow']) {
      expect(pillOf(id).parentElement!.style.padding).toMatch(/^0(px)?$/)
    }
  })

  describe('a text edit keeps container props', () => {
    // The edit goes through the real write path (runsPatch -> setOverlayPropsIn)
    // and the result is drawn again: a dropped container prop changes the markup.
    it.each(['pill-pink', 'pill-yellow', 'pill-arrow', 'title'])('%s', (id) => {
      const before = propsOf(slides, id)
      const text = before.text
      const runs = spliceRuns(runsOf(before), 0, 0, 'X')
      const patch = runsPatch(before, 'X' + text, runs, baseTextStyle(before))
      const next = setOverlayPropsIn(slides, 'slide-0', id, patch)
      const after = propsOf(next, id)
      expect(after.text).toBe('X' + text)
      for (const k of Object.keys(before)) {
        if (!['text', 'runs'].includes(k)) expect(after[k]).toBe(before[k])
      }
      // Same container markup either side of the edit, bar the text itself.
      const shell = (props: Record<string, string>) => {
        const d = document.createElement('div')
        d.innerHTML = renderToStaticMarkup(<StaticText {...props} />)
        d.querySelectorAll('p').forEach((p) => (p.innerHTML = ''))
        return d.innerHTML
      }
      expect(shell(after)).toBe(shell(before))
      expect(shell(after)).toBe(shell({ ...before, text: 'X' + text }))
      expect(shell(after)).not.toBe(shell({ text: 'X' + text }))
      const edited = document.createElement('div')
      edited.innerHTML = renderToStaticMarkup(<StaticText {...after} />)
      expect(edited.textContent).toBe('X' + text)
    })

    it('title: italic gold word survives an insert before it', () => {
      const before = propsOf(slides, 'title')
      const patch = runsPatch(before, 'Hey ' + before.text, spliceRuns(runsOf(before), 0, 0, 'Hey '), baseTextStyle(before))
      const after = propsOf(setOverlayPropsIn(slides, 'slide-0', 'title', patch), 'title')
      const run = runsOf(after).find((r) => r.t === 'beginners')
      expect(run).toMatchObject({ i: 1, c: '#f6e3a1' })
    })
  })
})

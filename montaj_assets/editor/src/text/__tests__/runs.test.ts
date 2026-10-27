/// <reference types="vitest/globals" />
import {
  baseTextStyle,
  decodeRuns,
  diffEdit,
  encodeRuns,
  liftShared,
  mergeRuns,
  normalizeRuns,
  rangeStyle,
  rebaseRuns,
  runsPatch,
  spliceRuns,
  styleRange,
  styleWholeText,
  type Run,
} from '../runs'

const PLAIN = { bold: false, italic: false, underline: false, color: '#111111' }

describe('runs: encode and decode', () => {
  it('round-trips a styled run list', () => {
    const runs: Run[] = [{ t: 'Make it ' }, { t: 'red', c: '#ff0000', b: 1 }, { t: '!', u: 1 }]
    const raw = encodeRuns(runs)
    expect(raw).toBe('[{"t":"Make it "},{"t":"red","c":"#ff0000","b":1},{"t":"!","u":1}]')
    expect(decodeRuns(raw, 'Make it red!')).toEqual(runs)
  })

  it('encodes runs without any style as empty: the element is plain text', () => {
    expect(encodeRuns([{ t: 'Hello' }])).toBe('')
    expect(encodeRuns([])).toBe('')
  })

  it('is ignored when it does not spell `text` (an edit that changed text only)', () => {
    expect(decodeRuns('[{"t":"Hello","b":1}]', 'Hello there')).toBeNull()
  })

  it('is ignored when malformed', () => {
    for (const raw of ['', 'nope', '{}', '[1]', '[{"c":"#ff0000"}]', '[{"t":5}]', 5, null, undefined]) {
      expect(decodeRuns(raw, 'Hello')).toBeNull()
    }
  })

  it('drops a bad colour or flag, keeps the rest, lower-cases colours and merges', () => {
    const raw = JSON.stringify([{ t: 'He', c: 'red', b: 2 }, { t: 'll', i: 1, x: 9 }, { t: 'o', i: 1, c: '#FF0000' }, { t: '' }])
    expect(decodeRuns(raw, 'Hello')).toEqual([{ t: 'He' }, { t: 'll', i: 1 }, { t: 'o', c: '#ff0000', i: 1 }])
  })

  it('keeps 0 flags: a word set back to regular inside a bold element', () => {
    expect(decodeRuns('[{"t":"a"},{"t":"b","b":0}]', 'ab')).toEqual([{ t: 'a' }, { t: 'b', b: 0 }])
  })
})

describe('runs: collapse', () => {
  it('merges adjacent runs with the same style and drops empty ones', () => {
    expect(mergeRuns([{ t: 'a', b: 1 }, { t: '' }, { t: 'b', b: 1 }, { t: 'c' }, { t: 'd' }])).toEqual([{ t: 'ab', b: 1 }, { t: 'cd' }])
  })

  it('drops a style the element already has', () => {
    const base = { bold: true, italic: false, underline: false, color: '#ff0000' }
    expect(normalizeRuns([{ t: 'a', b: 1, c: '#FF0000' }, { t: 'b', b: 0 }, { t: 'c', i: 0 }], base))
      .toEqual([{ t: 'a' }, { t: 'b', b: 0 }, { t: 'c' }])
  })
})

describe('runs: edits keep styles aligned', () => {
  const runs: Run[] = [{ t: 'ab' }, { t: 'cd', b: 1 }, { t: 'ef' }]

  it('an insertion inside a run takes that run\'s style', () => {
    expect(spliceRuns(runs, 3, 3, 'X')).toEqual([{ t: 'ab' }, { t: 'cXd', b: 1 }, { t: 'ef' }])
  })

  it('an insertion at a boundary takes the style of the char before', () => {
    expect(spliceRuns(runs, 4, 4, 'X')).toEqual([{ t: 'ab' }, { t: 'cdX', b: 1 }, { t: 'ef' }])
    expect(spliceRuns(runs, 2, 2, 'X')).toEqual([{ t: 'abX' }, { t: 'cd', b: 1 }, { t: 'ef' }])
  })

  it('an insertion at the start takes the first char\'s style', () => {
    expect(spliceRuns([{ t: 'ab', c: '#ff0000' }, { t: 'c' }], 0, 0, 'X')).toEqual([{ t: 'Xab', c: '#ff0000' }, { t: 'c' }])
  })

  it('typing over a selection takes the style of its first char', () => {
    expect(spliceRuns(runs, 2, 4, 'XY')).toEqual([{ t: 'ab' }, { t: 'XY', b: 1 }, { t: 'ef' }])
  })

  it('a deletion shrinks runs and collapses the ones it empties', () => {
    expect(spliceRuns(runs, 1, 5, '')).toEqual([{ t: 'af' }])
    expect(spliceRuns(runs, 3, 4, '')).toEqual([{ t: 'ab' }, { t: 'c', b: 1 }, { t: 'ef' }])
  })

  it('a paste across a boundary replaces the range in one style', () => {
    expect(spliceRuns(runs, 1, 3, 'pasted\ntext')).toEqual([{ t: 'apasted\ntext' }, { t: 'd', b: 1 }, { t: 'ef' }])
  })

  it('an edit to an empty text starts one plain run', () => {
    expect(spliceRuns([], 0, 0, 'Hi')).toEqual([{ t: 'Hi' }])
  })
})

describe('runs: diffEdit places the change at the caret', () => {
  it('typing a letter that repeats its neighbour lands where the caret is', () => {
    expect(diffEdit('aa', 'aaa', 2)).toEqual({ start: 1, end: 1, insert: 'a' })
  })
  it('a delete', () => {
    expect(diffEdit('abc', 'ac', 1)).toEqual({ start: 1, end: 2, insert: '' })
  })
  it('a replacement', () => {
    expect(diffEdit('hello world', 'hello there', 11)).toEqual({ start: 6, end: 11, insert: 'there' })
  })
  it('no change', () => {
    expect(diffEdit('same', 'same', 2)).toEqual({ start: 2, end: 2, insert: '' })
  })
})

describe('runs: styling a range', () => {
  it('bolds only the range, splitting runs at its ends', () => {
    expect(styleRange([{ t: 'Make it red' }], 8, 11, { b: 1 })).toEqual([{ t: 'Make it ' }, { t: 'red', b: 1 }])
  })

  it('a null clears a style; adjacent runs collapse again', () => {
    expect(styleRange([{ t: 'ab' }, { t: 'cd', c: '#ff0000' }], 2, 4, { c: null })).toEqual([{ t: 'abcd' }])
  })

  it('reads a range\'s style: bold only when every char is', () => {
    const runs: Run[] = [{ t: 'ab' }, { t: 'cd', b: 1, c: '#ff0000' }]
    expect(rangeStyle(runs, 2, 4, PLAIN)).toEqual({ bold: true, italic: false, underline: false, color: '#ff0000' })
    expect(rangeStyle(runs, 1, 4, PLAIN)).toEqual({ bold: false, italic: false, underline: false, color: '#111111' })
    expect(rangeStyle(runs, 2, 4, { ...PLAIN, italic: true }).italic).toBe(true)
  })
})

describe('runs: the whole element', () => {
  it('reads the element\'s own style', () => {
    expect(baseTextStyle({ fontWeight: '700', fontStyle: 'italic', color: '#FF0000' })).toEqual({ bold: true, italic: true, underline: false, color: '#ff0000' })
    expect(baseTextStyle({})).toEqual(PLAIN)
  })

  it('bold with no selection writes fontWeight and clears each run\'s bold', () => {
    const props = { text: 'ab', fontWeight: '400', runs: '[{"t":"a","b":1,"c":"#ff0000"},{"t":"b"}]' }
    expect(styleWholeText(props, { b: 1 })).toEqual({ fontWeight: '700', runs: '[{"t":"a","c":"#ff0000"},{"t":"b"}]' })
  })

  it('a colour with no selection writes color and removes runs left with no style', () => {
    const props = { text: 'ab', color: '#111111', runs: '[{"t":"a","c":"#ff0000"},{"t":"b"}]' }
    expect(styleWholeText(props, { c: '#00ff00' })).toEqual({ color: '#00ff00', runs: undefined })
  })

  it('underline with no selection underlines every run (there is no element prop for it)', () => {
    expect(styleWholeText({ text: 'ab' }, { u: 1 })).toEqual({ runs: '[{"t":"ab","u":1}]' })
    expect(styleWholeText({ text: 'ab', runs: '[{"t":"ab","u":1}]' }, { u: 0 })).toEqual({ runs: undefined })
  })

  it('a plain element without runs gets only its prop', () => {
    expect(styleWholeText({ text: 'ab', fontStyle: 'normal' }, { i: 1 })).toEqual({ fontStyle: 'italic' })
  })
})

describe('runs: an edit\'s writes', () => {
  const base = { bold: false, italic: false, underline: false, color: '#111111' }
  const props = { text: 'Make it red', fontWeight: '400', color: '#111111' }

  it('a styled word: the runs, the element untouched', () => {
    expect(runsPatch(props, 'Make it red', [{ t: 'Make it ' }, { t: 'red', b: 1 }], base))
      .toEqual({ text: 'Make it red', runs: '[{"t":"Make it "},{"t":"red","b":1}]' })
  })

  it('a style every char has moves onto the element', () => {
    expect(runsPatch(props, 'Make it red', [{ t: 'Make it red', b: 1, c: '#ff0000' }], base))
      .toEqual({ text: 'Make it red', fontWeight: '700', color: '#ff0000' })
  })

  it('plain text with no runs writes the text alone', () => {
    expect(runsPatch(props, 'Hello', [{ t: 'Hello' }], base)).toEqual({ text: 'Hello' })
  })

  it('runs written against the style the edit last wrote stay right after the element changed', () => {
    // Bold was moved onto the element by an earlier write of this edit (so the
    // editor passes that as its base); now one word is regular again.
    const now = { ...props, fontWeight: '700' }
    expect(runsPatch(now, 'ab', [{ t: 'a' }, { t: 'b', b: 0 }], { ...base, bold: true }))
      .toEqual({ text: 'ab', runs: '[{"t":"a"},{"t":"b","b":0}]' })
  })

  it('a plain commit writes only the text when the live style changed during the edit (the AI saved it)', () => {
    const live = { ...props, text: 'Make it red', fontWeight: '700', color: '#0000ff' }
    expect(runsPatch(live, 'Make it red!', [{ t: 'Make it red!' }], base)).toEqual({ text: 'Make it red!' })
  })

  it('a styled word with a changed live style: only the word\'s own style is written, the rest follows the element', () => {
    const live = { ...props, fontWeight: '700', color: '#0000ff' }
    expect(runsPatch(live, 'Make it red', [{ t: 'Make it ' }, { t: 'red', c: '#ff0000' }], base))
      .toEqual({ text: 'Make it red', runs: '[{"t":"Make it "},{"t":"red","c":"#ff0000"}]' })
  })

  it('a style the edit gave every char still moves onto the element, over a changed live style', () => {
    const live = { ...props, color: '#0000ff' }
    expect(runsPatch(live, 'ab', [{ t: 'ab', b: 1 }], base)).toEqual({ text: 'ab', fontWeight: '700' })
  })

  it('liftShared moves a style every char has onto the base, the runs relative to it', () => {
    expect(liftShared([{ t: 'ab', b: 1, c: '#ff0000' }], base)).toEqual({ base: { ...base, bold: true, color: '#ff0000' }, runs: [{ t: 'ab' }] })
    expect(liftShared([{ t: 'a', b: 1 }, { t: 'b' }], base)).toEqual({ base, runs: [{ t: 'a', b: 1 }, { t: 'b' }] })
  })

  it('rebaseRuns re-expresses runs against another base, keeping what each char shows', () => {
    expect(rebaseRuns([{ t: 'a', b: 1 }, { t: 'b' }], base, { ...base, bold: true })).toEqual([{ t: 'a' }, { t: 'b', b: 0 }])
    expect(rebaseRuns([{ t: 'ab' }], base, base)).toEqual([{ t: 'ab' }])
  })

  it('removes runs the edit left with no style', () => {
    expect(runsPatch({ ...props, runs: '[{"t":"ab","u":1}]', text: 'ab' }, 'ab', [{ t: 'ab' }], base)).toEqual({ text: 'ab', runs: undefined })
  })
})

describe('runs: surrogate pairs (an emoji) are never split', () => {
  const E = '\u{1F600}' // two UTF-16 units

  it('decode ignores runs whose boundary splits a pair', () => {
    expect(decodeRuns(JSON.stringify([{ t: 'a' + E[0] }, { t: E[1], c: '#ff0000' }]), 'a' + E)).toBeNull()
    expect(decodeRuns(JSON.stringify([{ t: 'a' }, { t: E, c: '#ff0000' }]), 'a' + E)).toEqual([{ t: 'a' }, { t: E, c: '#ff0000' }])
  })

  it('styleRange snaps a range that ends or starts inside a pair to the whole emoji', () => {
    const runs: Run[] = [{ t: 'a' + E + 'b' }]
    expect(styleRange(runs, 0, 2, { b: 1 })).toEqual([{ t: 'a' + E, b: 1 }, { t: 'b' }])
    expect(styleRange(runs, 2, 4, { b: 1 })).toEqual([{ t: 'a' }, { t: E + 'b', b: 1 }])
  })

  it('spliceRuns never leaves a pair in two styles, and never moves the edit (the text is what the DOM holds)', () => {
    // Runs handed in split (not through decode): the result joins the pair in its high half's style.
    const out = spliceRuns([{ t: 'a' + E[0], c: '#ff0000' }, { t: E[1] + 'b' }], 4, 4, 'X')
    expect(out).toEqual([{ t: 'a' + E, c: '#ff0000' }, { t: 'bX' }])
    // An edit that replaces one half of a pair keeps its text exactly.
    expect(spliceRuns([{ t: 'a', c: '#ff0000' }, { t: E }], 1, 2, '\uD801').map((r) => r.t).join('')).toBe('a\uD801' + E[1])
  })
})

describe('runs: colours', () => {
  it('keeps an element colour that is not hex, so a word set to #111111 is not dropped', () => {
    expect(baseTextStyle({ color: 'white' }).color).toBe('white')
    expect(baseTextStyle({ color: ' rgb(1, 2, 3) ' }).color).toBe('rgb(1, 2, 3)')
    const base = baseTextStyle({ color: 'white' })
    expect(normalizeRuns([{ t: 'a', c: '#111111' }, { t: 'b' }], base)).toEqual([{ t: 'a', c: '#111111' }, { t: 'b' }])
  })

  it('styleRange ignores a colour that is not hex', () => {
    expect(styleRange([{ t: 'ab' }], 0, 1, { c: 'red' })).toEqual([{ t: 'ab' }])
    expect(styleRange([{ t: 'ab' }], 0, 1, { c: 'url(x)', b: 1 })).toEqual([{ t: 'a', b: 1 }, { t: 'b' }])
    expect(styleRange([{ t: 'ab' }], 0, 1, { c: '#FF0000' })).toEqual([{ t: 'a', c: '#ff0000' }, { t: 'b' }])
  })
})

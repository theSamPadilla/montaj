// Styled runs on a text overlay (§587 round 3): one word or range in its own
// colour, bold, italic or underline.
//
// Stored in the overlay's `runs` prop, beside `text`, as a JSON array string:
//   [{"t":"Make it "},{"t":"red","c":"#ff0000","b":1}]
// `t` is the run's text; `c` a hex colour; `b`, `i`, `u` are 1 (on) or 0 (off),
// absent meaning the element's own style. `text` stays the plain concatenation,
// so a reader that knows nothing of runs still works, and runs that do not
// spell `text` exactly (an edit that changed `text` alone) are ignored. The
// static-text template reads the same shape (its own copy of the decoder).

import type { CarouselElement, OverlayElement, Slide } from '../types'
import { shippedTemplateKey } from '../carousel/shippedTemplate'
import { isBold } from './TextFormattingToolbar'

export interface RunStyle {
  c?: string
  b?: 0 | 1
  i?: 0 | 1
  u?: 0 | 1
}
export interface Run extends RunStyle {
  t: string
}
/** A style change: a value sets it, null clears it (back to the element's). */
export type RunPatch = { c?: string | null; b?: 0 | 1 | null; i?: 0 | 1 | null; u?: 0 | 1 | null }

/** The element's own style, which a run's absent fields take. */
export interface BaseTextStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
}

/** Whether the element's template draws runs: the shipped static-text, or an element that already has them. */
export function supportsRuns(el: OverlayElement): boolean {
  return shippedTemplateKey(el.overlay.template) === 'templates/overlays/static-text/static-text.jsx' || typeof el.overlay.props.runs === 'string'
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FLAGS = ['b', 'i', 'u'] as const
const KEYS = ['c', ...FLAGS] as const

function cleanStyle(s: RunStyle): RunStyle {
  const out: RunStyle = {}
  if (s.c !== undefined) out.c = s.c
  for (const k of FLAGS) if (s[k] !== undefined) out[k] = s[k]
  return out
}

const sameStyle = (a: RunStyle, b: RunStyle) => KEYS.every((k) => a[k] === b[k])

// UTF-16 surrogate halves: an emoji is two units, and no run boundary may fall between them.
const isHigh = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff }
const isLow = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff }
/** Whether index `i` of `s` falls between the two halves of a pair. */
const splitsPair = (s: string, i: number) => i > 0 && i < s.length && isHigh(s, i - 1) && isLow(s, i)

/** Whether `c` is a colour a run may carry (hex only). */
const isRunColour = (c: unknown): c is string => typeof c === 'string' && HEX.test(c)

/** Drops empty runs and joins neighbours that look the same. */
export function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (!r.t) continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, r)) last.t += r.t
    else out.push({ t: r.t, ...cleanStyle(r) })
  }
  return out
}

/** The runs in `raw` when they are well formed and spell `text`; null otherwise. */
export function decodeRuns(raw: unknown, text: unknown): Run[] | null {
  if (typeof raw !== 'string' || raw === '' || typeof text !== 'string') return null
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const runs: Run[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof (item as Run).t !== 'string') return null
    const src = item as Record<string, unknown>
    const run: Run = { t: src.t as string }
    if (typeof src.c === 'string' && HEX.test(src.c)) run.c = src.c.toLowerCase()
    for (const k of FLAGS) if (src[k] === 0 || src[k] === 1) run[k] = src[k] as 0 | 1
    runs.push(run)
  }
  if (runs.map((r) => r.t).join('') !== text) return null
  // A boundary between an emoji's two halves would draw each half alone.
  let at = 0
  for (const r of runs.slice(0, -1)) {
    at += r.t.length
    if (splitsPair(text, at)) return null
  }
  return mergeRuns(runs)
}

/** The `runs` prop for `runs`: empty when no run has a style of its own. */
export function encodeRuns(runs: readonly Run[] | null): string {
  const merged = mergeRuns(runs ?? [])
  if (!merged.some((r) => KEYS.some((k) => r[k] !== undefined))) return ''
  return JSON.stringify(merged.map((r) => ({ t: r.t, ...cleanStyle(r) })))
}

/** The element's text as runs: its own when valid, else one plain run. */
export function runsOf(props: Record<string, unknown>): Run[] {
  const text = typeof props.text === 'string' ? props.text : ''
  return decodeRuns(props.runs, text) ?? (text ? [{ t: text }] : [])
}

/**
 * The element's own style, from its props. A colour that is not hex (`white`,
 * `rgb(...)`) is kept as written, so a run in any hex colour, the default one
 * included, still differs from it.
 */
export function baseTextStyle(props: Record<string, unknown>): BaseTextStyle {
  const raw = typeof props.color === 'string' ? props.color.trim() : ''
  const color = raw === '' ? '#111111' : HEX.test(raw) ? raw.toLowerCase() : raw
  return { bold: isBold(props.fontWeight), italic: props.fontStyle === 'italic', underline: false, color }
}

/** `runs` without the styles the element already has, merged. */
export function normalizeRuns(runs: readonly Run[], base: BaseTextStyle): Run[] {
  return mergeRuns(runs.map((r) => {
    const out: Run = { t: r.t, ...cleanStyle(r) }
    if (out.c !== undefined && out.c.toLowerCase() === base.color.toLowerCase()) delete out.c
    if (out.b !== undefined && (out.b === 1) === base.bold) delete out.b
    if (out.i !== undefined && (out.i === 1) === base.italic) delete out.i
    if (out.u !== undefined && (out.u === 1) === base.underline) delete out.u
    return out
  }))
}

// One style per UTF-16 unit, and back: every edit below is a splice on these.
function explode(runs: readonly Run[]): { text: string; styles: RunStyle[] } {
  const styles: RunStyle[] = []
  for (const r of runs) {
    const s = cleanStyle(r)
    for (let i = 0; i < r.t.length; i++) styles.push(s)
  }
  return { text: runs.map((r) => r.t).join(''), styles }
}

function implode(text: string, styles: readonly RunStyle[]): Run[] {
  const runs: Run[] = []
  // A pair's low half always takes its high half's style.
  for (let i = 0; i < text.length; i++) runs.push({ t: text[i], ...(splitsPair(text, i) ? styles[i - 1] : styles[i]) })
  return mergeRuns(runs)
}

/**
 * `runs` with [start, end) replaced by `insert`. The inserted text takes the
 * style of the char before it (the first char's at the start); typed over a
 * selection, the style of the selection's first char.
 */
export function spliceRuns(runs: readonly Run[], start: number, end: number, insert: string): Run[] {
  const { text, styles } = explode(runs)
  const at = start < end ? styles[start] : start > 0 ? styles[start - 1] : styles[0]
  const style = at ?? {}
  return implode(
    text.slice(0, start) + insert + text.slice(end),
    [...styles.slice(0, start), ...Array<RunStyle>(insert.length).fill(style), ...styles.slice(end)],
  )
}

/** `patch` without what a run cannot carry: a colour that is not hex, a flag that is not 0 or 1. */
export function cleanPatch(patch: RunPatch): RunPatch {
  const out: RunPatch = {}
  if ('c' in patch && (patch.c === null || isRunColour(patch.c))) out.c = patch.c === null ? null : patch.c.toLowerCase()
  for (const k of FLAGS) if (k in patch && (patch[k] === null || patch[k] === 0 || patch[k] === 1)) out[k] = patch[k]
  return out
}

function patchStyle(s: RunStyle, patch: RunPatch): RunStyle {
  const out: RunStyle = { ...s }
  for (const k of KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v === null || v === undefined) delete out[k]
    else (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** `runs` with `patch` applied to [start, end), widened to whole emoji. */
export function styleRange(runs: readonly Run[], start: number, end: number, patch: RunPatch): Run[] {
  const { text, styles } = explode(runs)
  const clean = cleanPatch(patch)
  const from = splitsPair(text, start) ? start - 1 : start
  const to = splitsPair(text, end) ? end + 1 : end
  return implode(text, styles.map((s, i) => (i >= from && i < to ? patchStyle(s, clean) : s)))
}

/** What [start, end) shows: bold, italic or underline only when every char is; its first char's colour. */
export function rangeStyle(runs: readonly Run[], start: number, end: number, base: BaseTextStyle): BaseTextStyle {
  const { styles } = explode(runs)
  const picked = styles.slice(start, Math.max(start + 1, end))
  const on = (k: 'b' | 'i' | 'u', own: boolean) => picked.length > 0 && picked.every((s) => (s[k] === undefined ? own : s[k] === 1))
  return {
    bold: on('b', base.bold),
    italic: on('i', base.italic),
    underline: on('u', base.underline),
    color: picked[0]?.c ?? base.color,
  }
}

/**
 * The one splice that turns `before` into `after`, placed so it ends at
 * `caret` (the caret after the edit) when the text alone is ambiguous: typing
 * an "a" between two others is an insert where it was typed.
 */
export function diffEdit(before: string, after: string, caret?: number): { start: number; end: number; insert: string } {
  const maxSuffix = Math.min(before.length, after.length, caret === undefined ? Infinity : after.length - caret)
  let s = 0
  while (s < maxSuffix && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  const maxPrefix = Math.min(before.length - s, after.length - s)
  let p = 0
  while (p < maxPrefix && before[p] === after[p]) p++
  return { start: p, end: before.length - s, insert: after.slice(p, after.length - s) }
}

/**
 * The prop writes for styling the whole element (no selection): bold, italic
 * and colour write the element's own prop and clear that style from every run;
 * underline, which has no element prop, is set on every run. `runs: undefined`
 * removes the prop. A plain element's write has no `runs` key.
 */
export function styleWholeText(props: Record<string, unknown>, patch: RunPatch): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if ('b' in patch) out.fontWeight = patch.b ? '700' : '400'
  if ('i' in patch) out.fontStyle = patch.i ? 'italic' : 'normal'
  if (typeof patch.c === 'string') out.color = patch.c
  const text = typeof props.text === 'string' ? props.text : ''
  const own = decodeRuns(props.runs, text)
  if (!own && !('u' in patch)) return out
  const clear: RunPatch = {}
  if ('b' in patch) clear.b = null
  if ('i' in patch) clear.i = null
  if ('c' in patch) clear.c = null
  if ('u' in patch) clear.u = patch.u ? 1 : null
  const base = baseTextStyle({ ...props, ...out })
  const next = encodeRuns(normalizeRuns(styleRange(own ?? (text ? [{ t: text }] : []), 0, text.length, clear), base))
  if (next !== '') out.runs = next
  else if (props.runs !== undefined) out.runs = undefined
  return out
}

// What each char shows, every key filled in from `base`.
function shownStyles(runs: readonly Run[], base: BaseTextStyle): Required<RunStyle>[] {
  const flag = (v: 0 | 1 | undefined, own: boolean): 0 | 1 => (v === undefined ? (own ? 1 : 0) : v)
  return explode(runs).styles.map((s) => ({
    c: (s.c ?? base.color).toLowerCase(),
    b: flag(s.b, base.bold),
    i: flag(s.i, base.italic),
    u: flag(s.u, base.underline),
  }))
}

/** `runs` (relative to `from`) relative to `to` instead: every char shows what it showed. */
export function rebaseRuns(runs: readonly Run[], from: BaseTextStyle, to: BaseTextStyle): Run[] {
  const text = runs.map((r) => r.t).join('')
  return normalizeRuns(implode(text, shownStyles(runs, from)), to)
}

/**
 * A bold, italic or colour every char shows and `base` does not, moved onto
 * the base (select all, Bold: the element's `fontWeight`); the runs relative
 * to the new base. Underline stays on the runs: the element has no prop for it.
 */
export function liftShared(runs: readonly Run[], base: BaseTextStyle): { base: BaseTextStyle; runs: Run[] } {
  const shown = shownStyles(runs, base)
  const first = shown[0]
  const next = { ...base }
  if (first) {
    const shared = (k: 'b' | 'i' | 'c') => shown.every((s) => s[k] === first[k])
    if (shared('b')) next.bold = first.b === 1
    if (shared('i')) next.italic = first.i === 1
    if (shared('c') && first.c !== base.color.toLowerCase()) next.color = first.c
  }
  return { base: next, runs: rebaseRuns(runs, base, next) }
}

/**
 * The prop writes for an edit's text and runs, `runs` relative to `base` (the
 * element's style as the edit last wrote it, or as it was when the edit
 * began). A style the edit gave every char moves onto the element; every
 * other key stays as the live element has it, so a colour or weight saved
 * while the person typed (by their AI) is not put back. `runs: undefined`
 * removes the prop.
 */
export function runsPatch(props: Record<string, unknown>, text: string, runs: readonly Run[], base: BaseTextStyle): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { text }
  const lifted = liftShared(runs, base)
  const live = baseTextStyle(props)
  const target = { ...live }
  if (lifted.base.bold !== base.bold) {
    if (lifted.base.bold !== live.bold) out.fontWeight = lifted.base.bold ? '700' : '400'
    target.bold = lifted.base.bold
  }
  if (lifted.base.italic !== base.italic) {
    if (lifted.base.italic !== live.italic) out.fontStyle = lifted.base.italic ? 'italic' : 'normal'
    target.italic = lifted.base.italic
  }
  if (lifted.base.color !== base.color) {
    if (lifted.base.color !== live.color.toLowerCase()) out.color = lifted.base.color
    target.color = lifted.base.color
  }
  // The runs carry only their own overrides; what they leave out is the live element's.
  const enc = encodeRuns(normalizeRuns(lifted.runs, target))
  if (enc !== '') out.runs = enc
  else if (props.runs !== undefined) out.runs = undefined
  return out
}

/** `slides` with `patch` written to one unlocked overlay's props (`undefined` removes a prop); the same array when nothing changes. */
export function setOverlayPropsIn(slides: Slide[], slideId: string, elementId: string, patch: Record<string, string | undefined>): Slide[] {
  let changed = false
  const next = slides.map((slide): Slide => {
    if (slide.id !== slideId) return slide
    const elements = slide.elements.map((el): CarouselElement => {
      if (el.id !== elementId || el.type !== 'overlay' || el.locked === true) return el
      const props = { ...el.overlay.props }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          if (!(k in props)) continue
          delete props[k]
        } else if (props[k] === v) continue
        else props[k] = v
        changed = true
      }
      return changed ? { ...el, overlay: { ...el.overlay, props } } : el
    })
    return changed ? { ...slide, elements } : slide
  })
  return changed ? next : slides
}

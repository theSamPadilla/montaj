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

/** The element's own style, from its props. */
export function baseTextStyle(props: Record<string, unknown>): BaseTextStyle {
  const color = typeof props.color === 'string' && HEX.test(props.color.trim()) ? props.color.trim().toLowerCase() : '#111111'
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
  for (let i = 0; i < text.length; i++) runs.push({ t: text[i], ...styles[i] })
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

/** `runs` with `patch` applied to [start, end). */
export function styleRange(runs: readonly Run[], start: number, end: number, patch: RunPatch): Run[] {
  const { text, styles } = explode(runs)
  return implode(text, styles.map((s, i) => (i >= start && i < end ? patchStyle(s, patch) : s)))
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

/**
 * The prop writes for an edit's text and runs (`runs` relative to `base`, the
 * element's style when the edit began). A style every char shares moves onto
 * the element (select all, Bold: `fontWeight`), so runs carry only what
 * differs. `runs: undefined` removes the prop.
 */
export function runsPatch(props: Record<string, unknown>, text: string, runs: readonly Run[], base: BaseTextStyle): Record<string, string | undefined> {
  const { styles } = explode(runs)
  const flag = (v: 0 | 1 | undefined, own: boolean): 0 | 1 => (v === undefined ? (own ? 1 : 0) : v)
  const shown = styles.map((s): RunStyle => ({
    c: (s.c ?? base.color).toLowerCase(),
    b: flag(s.b, base.bold),
    i: flag(s.i, base.italic),
    u: flag(s.u, base.underline),
  }))
  const out: Record<string, string | undefined> = { text }
  const target = baseTextStyle(props)
  const first = shown[0]
  const shared = (k: keyof RunStyle) => !!first && shown.every((s) => s[k] === first[k])
  if (shared('b')) {
    const on = first.b === 1
    if (on !== target.bold) out.fontWeight = on ? '700' : '400'
    target.bold = on
  }
  if (shared('i')) {
    const on = first.i === 1
    if (on !== target.italic) out.fontStyle = on ? 'italic' : 'normal'
    target.italic = on
  }
  if (shared('c') && first.c !== target.color) {
    out.color = first.c
    target.color = first.c!
  }
  const enc = encodeRuns(normalizeRuns(implode(text, shown), target))
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

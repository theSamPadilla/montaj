/**
 * Per-style default values for the caption text-styling fields — the ones
 * each of the seven JSX caption templates applies via its own destructuring
 * default (`fontWeight = 700`, etc.) whenever the corresponding `Captions`
 * field is absent from the project.
 *
 * DELIBERATE DUPLICATION, the same shape as the `seg.lane ?? 0` duplication
 * documented at the top of every template's `activeSegments` (see e.g.
 * clean.jsx): the templates live in `montaj_assets/render/templates/
 * captions/*.jsx`, compiled standalone for the browser/Puppeteer render
 * path, and can import nothing but `montaj/render` — not this editor
 * package, and not each other. The editor still needs these same numbers to
 * show what an ABSENT field will actually render as — CaptionSpecimen's
 * weight/family preview, and CaptionListPanel's steppers/case chips
 * reporting the effective value instead of a blank one — and there is no
 * module either side can import, so the values are copied here by hand.
 *
 * Whoever changes a template's own default MUST change the matching entry
 * here too, in the same commit. Verified against the actual `function Xxx({
 * ... })` destructuring defaults in:
 *   clean.jsx, karaoke.jsx, subtitle.jsx, pop.jsx, word-by-word.jsx,
 *   highlight-box.jsx, outline.jsx
 * (all under montaj_assets/render/templates/captions/).
 */
import type { Captions, CaptionTextTransform } from '../schema'

type Style = Captions['style']

/** `Captions.fontWeight`'s default per style (CSS `font-weight`). */
export const CAPTION_STYLE_FONT_WEIGHT: Record<Style, number> = {
  clean: 700,
  karaoke: 700,
  subtitle: 600,
  pop: 800,
  'word-by-word': 800,
  'highlight-box': 900,
  outline: 900,
}

/** `Captions.fontFamily`'s default per style. Six of the seven templates
 *  share the plain system-sans stack as their parameter default; only
 *  `clean` names a specific face (Figtree) as its designed look. */
export const CAPTION_STYLE_FONT_FAMILY: Record<Style, string> = {
  clean: '"Figtree", system-ui, sans-serif',
  karaoke: 'system-ui, -apple-system, sans-serif',
  subtitle: 'system-ui, -apple-system, sans-serif',
  pop: 'system-ui, -apple-system, sans-serif',
  'word-by-word': 'system-ui, -apple-system, sans-serif',
  'highlight-box': 'system-ui, -apple-system, sans-serif',
  outline: 'system-ui, -apple-system, sans-serif',
}

/** `Captions.letterSpacing`'s default per style. A style absent from this
 *  table has no default at all — `karaoke`, `subtitle`, `highlight-box`, and
 *  `outline` all destructure `letterSpacing` with no `= ...`, so an unset
 *  field renders with the browser's normal spacing on those four. */
export const CAPTION_STYLE_LETTER_SPACING: Partial<Record<Style, string>> = {
  clean: '0.01em',
  pop: '-0.02em',
  'word-by-word': '-0.02em',
}

/** `Captions.lineHeight`'s default per style.
 *
 *  `highlight-box` and `outline` are a special case: their template has NO
 *  parameter-level default (a bare `lineHeight` destructure) — the value
 *  below only takes effect through an inline `lineHeight ?? 1.25` /
 *  `lineHeight ?? 1.15` at the WORDS-branch call site in `renderSegment`. A
 *  segment with no `words` array (the no-timestamps fallback branch) renders
 *  with no line-height at all, whether or not this field is set. `clean` and
 *  `subtitle` are plain parameter defaults and apply unconditionally.
 *  `karaoke`, `pop`, and `word-by-word` have no default in any branch. */
export const CAPTION_STYLE_LINE_HEIGHT: Partial<Record<Style, number>> = {
  clean: 1.3,
  subtitle: 1.4,
  'highlight-box': 1.25,
  outline: 1.15,
}

/** `Captions.textAlign`'s default per style — every template centers text by
 *  default, with no exceptions. */
export const CAPTION_STYLE_TEXT_ALIGN: Record<Style, string> = {
  clean: 'center',
  karaoke: 'center',
  subtitle: 'center',
  pop: 'center',
  'word-by-word': 'center',
  'highlight-box': 'center',
  outline: 'center',
}

/** `Captions.textTransform`'s default per style. Only `outline` has one — its
 *  all-caps stencil look — and, like its `lineHeight` default above, it only
 *  takes effect on the WORDS branch (`textTransform ?? 'uppercase'` at the
 *  `renderSegment` call site); the no-timestamps fallback branch renders the
 *  segment text as-is, never uppercased. Every other style has no default in
 *  any branch. */
export const CAPTION_STYLE_TEXT_TRANSFORM: Partial<Record<Style, CaptionTextTransform>> = {
  outline: 'uppercase',
}

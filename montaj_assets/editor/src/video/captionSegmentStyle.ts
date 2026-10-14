/**
 * Text styling per caption, and where a Format-tab edit lands.
 *
 * The track (`project.captions`) carries the styling every caption inherits.
 * A segment may carry the same fields as its own override. Precedence, the
 * same in the editor preview and the export because both hand the segments to
 * the same templates: the segment's value, else the track's, else the style's
 * own default. A segment with no override fields renders exactly as before.
 *
 * Where an edit lands follows the rule every caption edit follows:
 *  - "Apply to all" on: every caption. The value goes on the track, and that
 *    field's override is removed from every segment, so all of them show it.
 *  - Off, with captions selected: exactly those captions, as overrides.
 *  - Off, nothing selected: the track, which is what every caption without
 *    its own override shows; captions with an override keep it.
 *
 * Text, timing and words are never styling and never go through here.
 */
import type { CaptionSegment, Captions } from '../schema'

/** The track's styling fields a Format-tab control can write, in the track's
 *  own key names (`fontsize` is the track's legacy lowercase key). */
export const CAPTION_STYLE_FIELDS = [
  'color', 'fontsize', 'fontFamily', 'googleFonts', 'fontWeight', 'textTransform', 'textAlign',
  'letterSpacing', 'lineHeight', 'accentColor', 'highlightColor', 'activeColor', 'backgroundColor',
  'plateOpacity', 'platePadding', 'plateRadius',
] as const
export type CaptionStyleField = typeof CAPTION_STYLE_FIELDS[number]
export type CaptionStylePatch = Partial<Pick<Captions, CaptionStyleField>>

/** The segment's key for a track styling field. Only the font size differs:
 *  the templates read `fontSize`, and the track's `fontsize` predates that. */
export function segmentStyleKey(field: CaptionStyleField): keyof CaptionSegment {
  return field === 'fontsize' ? 'fontSize' : field
}

export type CaptionStyleScope =
  | { kind: 'all' }
  | { kind: 'track' }
  | { kind: 'segments'; ids: readonly string[] }

/** Where a Format-tab edit lands, from "Apply to all" and the selected
 *  caption ids (see the file header). */
export function captionStyleScope(applyToAll: boolean, selectedCaptionIds: readonly string[]): CaptionStyleScope {
  if (applyToAll) return { kind: 'all' }
  if (selectedCaptionIds.length > 0) return { kind: 'segments', ids: selectedCaptionIds }
  return { kind: 'track' }
}

/**
 * The captions with `patch` applied at `scope`. A key whose value is
 * `undefined` is REMOVED at that scope (the Bold toggle turns bold back on by
 * removing `fontWeight`). Pure: returns new objects, and a segment the edit
 * does not touch is returned as is.
 */
export function applyCaptionStyle(captions: Captions, patch: CaptionStylePatch, scope: CaptionStyleScope): Captions {
  const fields = (Object.keys(patch) as CaptionStyleField[]).filter(f => (CAPTION_STYLE_FIELDS as readonly string[]).includes(f))
  if (fields.length === 0) return captions

  if (scope.kind === 'segments') {
    const ids = new Set(scope.ids)
    return {
      ...captions,
      segments: captions.segments.map(s => {
        if (!s.id || !ids.has(s.id)) return s
        const next: Record<string, unknown> = { ...s }
        for (const f of fields) {
          const k = segmentStyleKey(f)
          if (patch[f] === undefined) delete next[k]
          else next[k] = patch[f]
        }
        return next as unknown as CaptionSegment
      }),
    }
  }

  const track: Record<string, unknown> = { ...captions }
  for (const f of fields) {
    if (patch[f] === undefined) delete track[f]
    else track[f] = patch[f]
  }
  if (scope.kind === 'track') return track as unknown as Captions

  // All: drop this field's override from every segment that has one.
  const keys = fields.map(segmentStyleKey)
  track.segments = captions.segments.map(s => {
    if (!keys.some(k => s[k] !== undefined)) return s
    const next: Record<string, unknown> = { ...s }
    for (const k of keys) delete next[k]
    return next as unknown as CaptionSegment
  })
  return track as unknown as Captions
}

/** The value of `field` in force for `seg` before the style's own default:
 *  the segment's override, else the track's. */
export function captionStyleValue<F extends CaptionStyleField>(
  captions: Captions,
  seg: CaptionSegment | undefined,
  field: F,
): Captions[F] | undefined {
  const own = seg ? (seg[segmentStyleKey(field)] as Captions[F] | undefined) : undefined
  return own !== undefined ? own : captions[field]
}

// A registered axis tag (ital, wght, ...) or a custom one (GRAD), as the
// render side's google-fonts.js reads them.
const AXIS_TAG = /^(?:[a-z]{4}|[A-Z]{4})(?:@|$)/

/** A bare-string googleFonts value as specs. A comma also sits inside one
 *  spec ("Playfair+Display:ital,wght@1,700"), so a piece joins the spec
 *  before it while that spec is still in its axis list or its values. The
 *  same rule as `splitSpecs` in render/google-fonts.js, which the export uses. */
function splitFontSpecs(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(',')) {
    const piece = raw.trim()
    const prev = out.length ? out[out.length - 1] : ''
    const colon = prev.indexOf(':')
    const at = colon < 0 ? -1 : prev.indexOf('@', colon)
    const continues = colon >= 0 && (at < 0 ? AXIS_TAG.test(piece) : /^[0-9.]/.test(piece))
    if (continues) out[out.length - 1] += `,${piece}`
    else if (piece) out.push(piece)
  }
  return out
}

/** Every Google Fonts spec the captions need: the track's, then each
 *  segment's, deduplicated. A persisted project can carry a bare string. */
export function captionGoogleFonts(captions: Pick<Captions, 'googleFonts' | 'segments'>): string[] {
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string')
      : typeof v === 'string' ? splitFontSpecs(v)
      : []
  const out = asList(captions.googleFonts)
  for (const s of captions.segments ?? []) out.push(...asList(s.googleFonts))
  return [...new Set(out)]
}

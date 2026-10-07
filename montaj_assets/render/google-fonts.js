// google-fonts.js: what a `googleFonts` value is, however it arrives (§140).
//
// An agent passes sample_overlay's google_fonts as a list, a JSON-array string
// or a comma list, and project.json carries a list whose entries an author
// typed. Every shape becomes the same list of Google Fonts CSS2 specs here
// ("Anton", "DM+Sans:wght@700", "Playfair+Display:ital,wght@0,400;1,700"), and
// an entry that cannot be a Google family is dropped and named, never sent.
// Measured from a real call: `["DM+Serif+Display", "DM+Sans:wght@700"]` split
// on commas put brackets and quotes in the stylesheet URL, Google answered 400
// with an HTML page, and the refused stylesheet failed the step.
//
// `fontLoadFailure` is the other half: a family Google still refuses, or a
// font the network cannot fetch, is a console error the page reports, and the
// renderers record it as a warning instead of failing the overlay. The overlay
// then draws with its CSS fallback font.

// A family is letters, digits and spaces (sent as '+'), as Google names them.
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9+-]*$/
// The axis part is kept verbatim when it is URL-safe: Google decides whether
// it is valid (and a refusal is only a warning), and the vendored partition
// sends a spec it cannot parse to Google rather than guessing at it. Safe is
// what Google's grammar uses: tags, numbers, '-', '..' ranges, ',' ';' '@'.
const SAFE_AXES = /^[A-Za-z0-9,;@.-]*$/
// For splitting a comma list only: registered axes are four lowercase
// letters (ital, wght, wdth, slnt, opsz), custom ones four capitals (GRAD).
const AXIS_TAG = /^(?:[a-z]{4}|[A-Z]{4})(?:@|$)/
// Quotes, brackets and whitespace an agent or a JSON fragment leaves around a name.
const WRAPPING = /^[\s"'`[\]]+|[\s"'`[\]]+$/g

/** One spec, cleaned: trimmed, de-quoted, spaces as '+'. An axis part that
 *  is not URL-safe is dropped and the family kept (it loads its default
 *  face); a family that cannot be a Google family is null. */
export function cleanFontSpec(raw) {
  if (typeof raw !== 'string') return null
  const spec = raw.replace(WRAPPING, '')
  const colon = spec.indexOf(':')
  const family = (colon < 0 ? spec : spec.slice(0, colon)).trim().replace(/\s+/g, '+')
  if (!FAMILY.test(family)) return null
  if (colon < 0) return family
  const axes = spec.slice(colon + 1).trim()
  return SAFE_AXES.test(axes) ? `${family}:${axes}` : family
}

// Split a comma list into specs. A comma also sits inside a spec, between
// axis tags ("ital,wght") and between values ("0,400"), so a piece joins the
// spec before it while that spec is still in its axis list or its values.
function splitSpecs(text) {
  const out = []
  for (const piece of text.split(',')) {
    const prev = out.length ? out[out.length - 1].replace(WRAPPING, '') : ''
    const colon = prev.indexOf(':')
    const at = colon < 0 ? -1 : prev.indexOf('@', colon)
    const next = piece.replace(WRAPPING, '')
    const continues = colon >= 0 && (at < 0 ? AXIS_TAG.test(next) : /^[0-9.]/.test(next))
    if (continues) out[out.length - 1] += `,${piece}`
    else out.push(piece)
  }
  return out
}

/** A googleFonts value of any shape -> `{ fonts, dropped }`: the specs to
 *  load, in order and once each, and the entries that cannot be one. */
export function parseGoogleFonts(input) {
  const fonts = []
  const dropped = []
  const add = (raw) => {
    const spec = cleanFontSpec(raw)
    if (spec === null) {
      if (typeof raw === 'string' ? raw.replace(WRAPPING, '') !== '' : raw != null) dropped.push(typeof raw === 'string' ? raw.trim() : String(raw))
      return
    }
    if (!fonts.includes(spec)) fonts.push(spec)
  }
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value !== 'string') { if (value != null) dropped.push(String(value)); return }
    const text = value.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) { parsed.forEach(add); return }
      } catch { /* not JSON after all: read it as a comma list */ }
    }
    splitSpecs(text).forEach(add)
  }
  visit(input)
  return { fonts, dropped }
}

/** The family a console line says failed to load from Google Fonts, 'a font
 *  file' when it was a font file itself, or null when the line is about
 *  anything else (which a renderer still treats as a page error). */
export function fontLoadFailure({ type, text, url } = {}) {
  if (type !== 'error' || typeof text !== 'string') return null
  const refused = /Refused to apply style from '(https:\/\/fonts\.googleapis\.com\/[^']*)'/.exec(text)
  const failed = !refused && /Failed to load resource/.test(text) && /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url || '') ? url : null
  const href = refused ? refused[1] : failed
  if (!href) return null
  const family = /[?&]family=([^&]*)/.exec(href)
  return family ? family[1] : 'a font file'
}

/** The warning a renderer prints for the families that did not load. */
export function fontFailureWarning(families) {
  return `[montaj] fonts: could not load ${[...families].join(', ')} from Google Fonts; the overlay used its fallback font.`
}

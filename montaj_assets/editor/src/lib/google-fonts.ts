// Shared Google Fonts loader.
//
// Injects a Google Fonts stylesheet <link> for the declared family specs so the
// editor's preview/render uses the same glyphs and metrics the renderer
// (bundle.js) fetches. Used by both the video overlay layer and the carousel
// overlay render path. Resilient by design: a font-load failure must never
// break the render (we only append a <link>; the browser handles the fetch).
import {
  familiesDigest,
  partitionFontSpecs,
  reportUnvendoredFonts,
  reportVendoredSet,
  vendoredFaceIndex,
  vendoredKeySet,
} from './font-families'
import type { FaceIndex, FaceMap } from './font-families'

// Track Google Fonts URLs already injected so we don't add the same <link>
// twice when multiple overlays declare overlapping fonts. Keyed by the full
// stylesheet URL — the same URL never produces a duplicate fetch from
// Chromium regardless, but the duplicate <link> tags would still clutter
// document.head across long editing sessions.
//
// Keying on the full URL (rather than e.g. the family list) also means a
// setFontsBaseUrl() call transparently invalidates this cache: the base is
// part of the URL, so switching it produces a URL this Set has never seen
// and the new <link> is injected regardless of what was injected before.
const __injectedFontUrls = new Set<string>()

// Unset (OSS default): ensureGoogleFontsLoaded builds a per-family
// fonts.googleapis.com/css2 URL, exactly as before. Set: it links
// `${base}/fonts.css` for the families `vendoredFamilies` declares and falls
// through to fonts.googleapis.com for the rest.
//
// This setter is private to this module; FontPicker.tsx's own loader has its
// own, separate setter. The two loaders keep separate injection state by
// design — but they share the partition itself (`lib/font-families.ts`), so
// they cannot disagree about which families a base covers.
let fontsBaseUrl: string | undefined
let vendoredFamilies = new Set<string>()
// `undefined` means "no face information was supplied", which leaves the
// partition at family level. An EMPTY index is different: it says the host
// supplied face data that covers nothing, so nothing is vendored.
let vendoredFaces: FaceIndex | undefined

/**
 * Point the loader at a vendored stylesheet.
 *
 * @param url      Base URL holding `fonts.css`, or undefined for the OSS
 *                 default (everything from fonts.googleapis.com).
 * @param families The families that stylesheet declares, spelled as its
 *                 `font-family` rules spell them.
 * @param faceData The manifest's `faces` and `requested` maps, which say
 *                 WHICH FACES of each family are actually available. The
 *                 family list alone cannot answer that, and getting it wrong
 *                 is silent: `Playfair+Display:ital@1` names a vendored
 *                 family whose italic does not exist, so the browser
 *                 synthesises an oblique and nothing reports a problem.
 *                 Omitting it leaves the partition at family level and keeps
 *                 that hazard — the host should always pass it.
 *
 * **The family list is passed IN, never fetched here.** The host reads its
 * `families.json` once at app init and hands both values over. That keeps this
 * loader fully synchronous, which it has to be: `ensureGoogleFontsLoaded` is
 * called from effects and must decide the partition before it can act. A fetch
 * inside it would create a "manifest has not arrived yet" state with no good
 * exit — it cannot block (it is sync), guessing is silently wrong, and
 * re-injecting once the answer lands leaves two competing stylesheets on the
 * page with the stale one never pruned.
 *
 * Omitting `families`, or passing an empty list, means NOTHING is treated as
 * vendored: the vendored stylesheet is not linked and every requested family
 * comes from Google. See `reportVendoredSet` for why that direction, and not
 * the tempting opposite.
 */
export function setFontsBaseUrl(
  url: string | undefined,
  families?: readonly string[],
  faceData?: { faces?: FaceMap; requested?: FaceMap },
): void {
  fontsBaseUrl = url
  vendoredFamilies = vendoredKeySet(families)
  vendoredFaces = faceData ? vendoredFaceIndex(faceData.faces, faceData.requested) : undefined
  if (url) reportVendoredSet(url, vendoredFamilies, vendoredFaces)
}

/** The digest of the family list currently in force, for a host that wants to
 *  compare it against the renderer's own logged digest without scraping the
 *  console. Empty string when no base is set. */
export function vendoredFamiliesDigest(): string {
  return fontsBaseUrl ? familiesDigest(vendoredFamilies, vendoredFaces) : ''
}

function googleFontsUrl(specs: string[]): string {
  return `https://fonts.googleapis.com/css2?${specs.map((f) => `family=${f}`).join('&')}&display=swap`
}

/** Append a stylesheet <link> unless this exact URL was already requested.
 *  Returns whether it was newly requested, so a caller can log once per
 *  distinct URL rather than once per overlay. The Set is updated before the
 *  `document` guard, matching the original loader: a server-side call still
 *  counts as "requested". */
function injectStylesheet(url: string): boolean {
  if (__injectedFontUrls.has(url)) return false
  __injectedFontUrls.add(url)
  if (typeof document === 'undefined') return false
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url
  document.head.appendChild(link)
  return true
}

export function ensureGoogleFontsLoaded(googleFonts: string[] | string | undefined): void {
  // Defensive coercion: persisted project items have occasionally stored the
  // `googleFonts` field as a bare string (e.g. "Anton") instead of the typed
  // string[] (["Anton"]). A non-empty string passes a naive `.length` guard and
  // then `.map` throws "n.map is not a function", which surfaces in the editor
  // as a cryptic "overlay error: <file>.jsx" and breaks the whole overlay layer.
  // Coerce a string into a family list (supporting comma-separated values) and
  // bail on anything that isn't a non-empty array.
  const families =
    typeof googleFonts === 'string'
      ? googleFonts.split(',').map((s) => s.trim()).filter(Boolean)
      : googleFonts
  if (!Array.isArray(families) || !families.length) return

  // Trailing slashes are stripped so `/fonts/editor` and `/fonts/editor/`
  // resolve identically. This mirrors `montaj_assets/render/bundle.js`'s
  // `vendoredFontsHref`, which applies the same `.replace(/\/+$/, '')` — and
  // that symmetry is the point, not tidiness. The render base and this one
  // are set by DIFFERENT mechanisms (an env var there, this setter here) and
  // must name the same stylesheet; if one tolerates a trailing slash and the
  // other emits `//fonts.css`, preview and render disagree about the URL for
  // a base a host reasonably considers the same.
  const base = fontsBaseUrl ? fontsBaseUrl.replace(/\/+$/, '') : ''

  // The vendored set covers the families the host declared — and only those.
  // It comes from the editor's picker list, while `googleFonts` comes out of
  // project data, and skills/write-overlay documents arbitrary Google families
  // as first-class (its own worked example names "Anton", which the picker does
  // not carry). Linking the vendored sheet and dropping the requested entries
  // would render those in a fallback face with nothing on screen to say so.
  //
  // With no base, `vendoredFamilies` is empty, everything falls through, and
  // the emitted URL is byte-identical to the pre-vendoring one — the format
  // bundle.js emits for the render pipeline, so preview and render fetch
  // identical CSS and therefore identical glyphs / metrics.
  const { vendored, fellThrough } = partitionFontSpecs(
    families,
    base ? vendoredFamilies : new Set(),
    base ? vendoredFaces : undefined,
  )
  if (vendored.length) injectStylesheet(`${base}/fonts.css`)
  if (!fellThrough.length) return
  // Log once per distinct URL rather than once per overlay — a project with
  // fifty overlays naming the same unvendored family should say so once.
  // `base &&`: with no base nothing has "fallen through" to report, that is
  // simply how the OSS default works.
  if (injectStylesheet(googleFontsUrl(fellThrough)) && base) reportUnvendoredFonts(fellThrough)
}

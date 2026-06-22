// Shared Google Fonts loader.
//
// Injects a Google Fonts stylesheet <link> for the declared family specs so the
// editor's preview/render uses the same glyphs and metrics the renderer
// (bundle.js) fetches. Used by both the video overlay layer and the carousel
// overlay render path. Resilient by design: a font-load failure must never
// break the render (we only append a <link>; the browser handles the fetch).

// Track Google Fonts URLs already injected so we don't add the same <link>
// twice when multiple overlays declare overlapping fonts. Keyed by the full
// stylesheet URL — the same URL never produces a duplicate fetch from
// Chromium regardless, but the duplicate <link> tags would still clutter
// document.head across long editing sessions.
const __injectedFontUrls = new Set<string>()

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
  // Match the format bundle.js uses for the render pipeline so preview and
  // render fetch identical CSS (and identical glyphs / metrics).
  const url = `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`
  if (__injectedFontUrls.has(url)) return
  __injectedFontUrls.add(url)
  if (typeof document === 'undefined') return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url
  document.head.appendChild(link)
}

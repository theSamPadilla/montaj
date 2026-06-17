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

export function ensureGoogleFontsLoaded(googleFonts: string[] | undefined): void {
  if (!googleFonts?.length) return
  // Match the format bundle.js uses for the render pipeline so preview and
  // render fetch identical CSS (and identical glyphs / metrics).
  const url = `https://fonts.googleapis.com/css2?${googleFonts.map((f) => `family=${f}`).join('&')}&display=swap`
  if (__injectedFontUrls.has(url)) return
  __injectedFontUrls.add(url)
  if (typeof document === 'undefined') return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url
  document.head.appendChild(link)
}

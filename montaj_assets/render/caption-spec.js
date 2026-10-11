/**
 * The caption track as a Puppeteer overlay: its template, its props and its
 * Google fonts, from a project's top-level `captions`. One copy, read by the
 * export (render.js, the `captions` segment) and by a sampled frame
 * (sample-frame.js), so the frame the user's AI looks at draws the captions the
 * export draws.
 */
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function captionTemplatePath(style) {
  const styleMap = {
    'word-by-word':  'word-by-word.jsx',
    'pop':           'pop.jsx',
    'karaoke':       'karaoke.jsx',
    'subtitle':      'subtitle.jsx',
    'highlight-box': 'highlight-box.jsx',
    'outline':       'outline.jsx',
    'clean':         'clean.jsx',
    'accent':        'accent.jsx',
  }
  const file = styleMap[style] ?? 'subtitle.jsx'
  return join(__dirname, 'templates', 'captions', file)
}

/**
 * `{ componentPath, props, googleFonts }` for the project's captions, or null
 * when it has none to draw (no segments and no style).
 */
export function captionOverlayFields(captions) {
  if (!(captions?.segments?.length > 0 || captions?.style)) return null
  // googleFonts is a spec-level field (consumed by bundleComponent), not a
  // prop on the caption component — pull it out before spreading the rest
  // into captionTheme.
  let { style: _captStyle, segments: _captSegs, googleFonts: captionFonts, ...captionTheme } = captions
  // Normalise the legacy lowercase `fontsize` key (used by the old ffmpeg
  // path / editor) to the camelCase `fontSize` prop the JSX templates
  // expect. Never send both.
  if (captionTheme.fontsize != null) {
    captionTheme.fontSize = captionTheme.fontsize
    delete captionTheme.fontsize
  }
  // The 'clean' style is built around Figtree — default its google font
  // when the caller hasn't specified one AND hasn't chosen their own font
  // family. Otherwise a project asking for e.g. Baloo 2 would also fetch
  // Figtree, and if the chosen family string is malformed the CSS cascade
  // would silently fall back to Figtree rather than to system-ui, which is
  // a confusing failure mode.
  if (captions.style === 'clean' && (captionFonts == null || captionFonts.length === 0) && captionTheme.fontFamily == null) {
    captionFonts = ['Figtree:wght@700']
  }
  if (captions.style === 'accent') {
    // PL41. Spaces are '+' (bundle.js:762-767 interpolates specs raw into the
    // googleapis URL). A persisted project can carry a bare string. The
    // editor's ACCENT_CAPTION_FONTS (captionStyleDefaults.ts) is the other
    // copy of this list; keep the two identical.
    const ACCENT_FONTS = ['Inter+Tight:wght@700', 'Playfair+Display:ital,wght@1,700', 'Caveat:wght@700']
    const given = Array.isArray(captionFonts) ? captionFonts : captionFonts ? [captionFonts] : []
    captionFonts = [...new Set([...given, ...ACCENT_FONTS])]
  }
  return {
    componentPath: captionTemplatePath(captions.style),
    props:         { segments: captions.segments || [], ...captionTheme },
    googleFonts:   captionFonts ?? [],
  }
}

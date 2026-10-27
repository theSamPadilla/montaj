// Font files of the person's own (§587 r3): an overlay element's `fontFiles`
// and the font menu's custom fonts, loaded with FontFace from the URL the host
// serves each file at. The carousel renderer declares the same files as
// `@font-face` rules (render-carousel.js), so the preview and the export draw
// one face. Resilient, as the Google Fonts loader is: a file that fails to
// load leaves the fallback face and never breaks the preview.
import type { FontFile } from '../schema'

// One load per family and URL. A failed load is dropped, so a later call (the
// file uploaded again, the server back) tries again.
const loads = new Map<string, Promise<void>>()

/** Load `family` from `url` into `document.fonts`, once. Resolves when the face is ready. */
export function loadFontFace(family: string, url: string): Promise<void> {
  const key = `${family}\u0000${url}`
  const known = loads.get(key)
  if (known) return known
  const Face = (globalThis as { FontFace?: typeof FontFace }).FontFace
  if (typeof document === 'undefined' || !document.fonts || typeof Face !== 'function') return Promise.resolve()
  const load = new Face(family, `url(${JSON.stringify(url)})`)
    .load()
    .then((face) => { document.fonts.add(face) })
  load.catch(() => { loads.delete(key) })
  loads.set(key, load)
  return load
}

/** Whether `f` is a usable font file entry: a non-empty family and src. */
export function isFontFile(f: unknown): f is FontFile {
  return !!f && typeof f === 'object'
    && typeof (f as FontFile).family === 'string' && (f as FontFile).family.trim() !== ''
    && typeof (f as FontFile).src === 'string' && (f as FontFile).src !== ''
}

/** Load each of an element's font files, its `src` turned into a URL by the host's `resolve`. */
export function ensureFontFilesLoaded(files: readonly FontFile[] | undefined, resolve: (src: string) => string): void {
  if (!Array.isArray(files)) return
  for (const f of files) {
    if (!isFontFile(f)) continue
    loadFontFace(f.family, resolve(f.src)).catch(() => { /* the fallback face stays */ })
  }
}

/** Test-only: forget every load. */
export function __resetFontFilesForTests(): void {
  loads.clear()
}

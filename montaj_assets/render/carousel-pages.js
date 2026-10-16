/**
 * carousel-pages.js — a carousel slide as a plain web page.
 *
 * `render-carousel.js --html-dir` calls these from its own slide loop, on the very page it screenshots, so a
 * slide's page is the slide as the PNG shows it. A slide does not animate, so its page is a still: the rendered
 * DOM with its styles, no scripts and no React. Files it names (images) are copied beside the pages and the URLs
 * rewritten to relative paths, so the folder opens anywhere. Fonts keep their Google Fonts link, as the render's
 * page has, and need the network the first time.
 */
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'

/** The page's DOM as a script-free document string. Runs in the browser page via `page.evaluate`. */
export function serializeSlideInPage() {
  const clone = document.documentElement.cloneNode(true)
  clone.querySelectorAll('script, link[rel="modulepreload"], meta[http-equiv="Content-Security-Policy"]').forEach((n) => n.remove())
  return '<!DOCTYPE html>\n' + clone.outerHTML
}

/** Copy every file:// URL in `html` into `<dir>/assets/` (once each) and point the html at the copies. */
export function relocateFileUrls(html, dir, copied, warnings, counter) {
  return html.replace(/file:\/\/\/[^"'\s)<>]+/g, (url) => {
    let path
    try { path = fileURLToPath(url.replace(/&amp;/g, '&')) } catch { return url }
    if (copied.has(path)) return copied.get(path)
    try {
      if (!statSync(path).isFile()) throw new Error('not a file')
    } catch {
      warnings.push(`a file a slide names is missing: ${basename(path)}`)
      return url
    }
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const name = `${String(++counter.n).padStart(2, '0')}-${basename(path)}`
    copyFileSync(path, join(dir, 'assets', name))
    copied.set(path, `assets/${name}`)
    return copied.get(path)
  })
}

/** Write one slide's page; returns its file name. */
export function writeSlidePage(html, dir, name, copied, warnings, counter) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.html`), relocateFileUrls(html, dir, copied, warnings, counter))
  return `${name}.html`
}

/** `index.html`: every slide in one page, swiped sideways (scroll-snap), each slide its own page in a frame. */
export function swipePage({ files, width, height, title = 'Carousel' }) {
  const frames = files.map((f, i) => `<section><iframe src="${f}" title="Slide ${i + 1}" loading="lazy" scrolling="no"></iframe></section>`).join('\n')
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
<style>
html, body { margin: 0; height: 100%; background: #111; }
main { display: flex; height: 100%; overflow-x: auto; scroll-snap-type: x mandatory; align-items: center; }
section { flex: 0 0 100%; scroll-snap-align: center; display: flex; justify-content: center; }
iframe { border: 0; background: #fff; width: min(100vw, calc(100vh * ${width} / ${height})); aspect-ratio: ${width} / ${height}; }
</style>
</head>
<body>
<main>
${frames}
</main>
</body>
</html>`
}

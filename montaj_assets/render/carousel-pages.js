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

/** The opener just before position `i` of `html` (skipping spaces), and the text that closes a URL it opens. */
function closerBefore(html, i) {
  let j = i
  while (j > 0 && (html[j - 1] === ' ' || html[j - 1] === '\t')) j--
  if (html.slice(0, j).endsWith('&quot;')) return '&quot;'
  if (html.slice(0, j).endsWith('&#39;')) return '&#39;'
  const c = html[j - 1]
  if (c === '"' || c === "'") return c
  if (c === '(') return ')'
  return null
}

/** The file a file:// URL names: the path as written (a name may hold spaces, U+202F or #), else percent-decoded. */
function pathOfFileUrl(url) {
  const raw = url.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  const literal = raw.slice('file://'.length)
  const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
  if (literal && isFile(literal)) return literal
  let decoded = literal
  try { decoded = fileURLToPath(raw.replace(/ /g, '%20').replace(/#/g, '%23')) } catch { /* a malformed escape: as written */ }
  if (isFile(decoded)) return decoded
  // a real fragment (an SVG sprite's #icon): the file before it
  const hash = decoded.lastIndexOf('#')
  return hash > 0 && isFile(decoded.slice(0, hash)) ? decoded.slice(0, hash) : decoded
}

/**
 * Copy every file:// URL in `html` into `<dir>/assets/` (once each) and point the html at the copies. A URL runs to
 * its own closing delimiter: the attribute's quote (or &quot; / &#39; inside a serialized style attribute), or the
 * paren of an unquoted url(...); only a URL with no opener stops at whitespace. (PL89: a macOS screenshot's name has
 * spaces and a U+202F, and a URL cut at the first space left the slide pointing at the user's disk.)
 */
export function relocateFileUrls(html, dir, copied, warnings, counter) {
  let out = ''
  let at = 0
  for (;;) {
    const i = html.indexOf('file:///', at)
    if (i < 0) break
    const closer = closerBefore(html, i)
    let end
    if (closer) {
      end = html.indexOf(closer, i)
      if (closer === ')') {
        // an unquoted url(...): the paren that closes it, never past the end of the declaration
        const stop = html.slice(i).search(/[;}"<>]/)
        if (stop >= 0 && (end < 0 || end > i + stop)) end = i + stop
      }
      if (end < 0) end = html.length
    } else {
      const m = html.slice(i).search(/[\s"'<>)]/)
      end = m < 0 ? html.length : i + m
    }
    const url = html.slice(i, end).replace(/\s+$/, '')
    out += html.slice(at, i) + relocateOne(url, dir, copied, warnings, counter)
    at = i + url.length
  }
  return out + html.slice(at)
}

function relocateOne(url, dir, copied, warnings, counter) {
  const path = pathOfFileUrl(url)
  const tail = url.replace(/&amp;/g, '&').endsWith(basename(path)) ? '' : (/#[^#/]*$/.exec(url) ?? [''])[0]
  if (copied.has(path)) return copied.get(path) + tail
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
  return copied.get(path) + tail
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

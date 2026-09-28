#!/usr/bin/env node
/**
 * capture-site.js — Capture a website for a brand/product film.
 *
 * CLI: node capture-site.js <url> <outDir>
 *
 * Writes to <outDir>:
 *   desktop.png    1440x900 viewport screenshot
 *   mobile.png     390x844 @2x viewport screenshot
 *   full.png       desktop full-page screenshot, capped at 6000px tall
 *   logos/         downloaded logo/icon candidates
 *   manifest.json  {url, title, screenshots, logos, palette, fonts}
 *
 * stdout: JSON {path} to manifest.json
 * exit 0 success, exit 1 failure
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const MAX_LOGO_BYTES = 5 * 1024 * 1024
const LOGO_FETCH_TIMEOUT_MS = 10000
const STYLE_WALK_LIMIT = 5000

// Same puppeteer.launch options as sample-frame.js (~line 286). No shared
// helper exists (renderer.js's launchBrowser is private) — the codebase
// copies these args at each call site.
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    // --disable-dev-shm-usage: use /tmp instead of the container's 64MB /dev/shm
    // (Docker default) so heavy renders don't crash Chromium on shm exhaustion.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 300000,
  })
}

/**
 * Navigate tolerating a slow/never-settling page: networkidle2 with a 30s cap.
 * A page that never reaches idle (streaming connections, analytics beacons,
 * long-poll) still gets captured from whatever loaded in 30s; any OTHER
 * navigation error (DNS failure, refused connection, invalid URL) still
 * throws.
 */
async function loadPage(page, u) {
  try {
    await page.goto(u, { waitUntil: 'networkidle2', timeout: 30000 })
  } catch (e) {
    if (e.name !== 'TimeoutError') throw e
  }
}

// content-type -> file extension for downloaded logo/icon candidates.
function extForContentType(ct) {
  const t = (ct || '').split(';')[0].trim().toLowerCase()
  if (t === 'image/svg+xml') return '.svg'
  if (t === 'image/png') return '.png'
  if (t === 'image/jpeg') return '.jpg'
  if (t === 'image/webp') return '.webp'
  if (t === 'image/x-icon' || t === 'image/vnd.microsoft.icon') return '.ico'
  return '.bin'
}

// file: reads have no Content-Type header — guess one from the extension so
// extForContentType() can still pick the right output extension.
const EXT_TO_TYPE = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
}

const [, , url, outDir] = process.argv
const isFileUrl = new URL(url).protocol === 'file:'
mkdirSync(join(outDir, 'logos'), { recursive: true })
const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await loadPage(page, url)
  await page.screenshot({ path: join(outDir, 'desktop.png') })
  const fullH = await page.evaluate(() => Math.max(1, Math.min(document.documentElement.scrollHeight, 6000)))
  await page.screenshot({ path: join(outDir, 'full.png'), clip: { x: 0, y: 0, width: 1440, height: fullH } })

  const found = await page.evaluate((styleWalkLimit) => {
    const hex = (c) => {
      const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
      if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
      return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
    }
    const counts = {}
    const bump = (h, role) => { if (!h) return; const k = h + '|' + role; counts[k] = (counts[k] || 0) + 1 }
    const fonts = new Set()
    const els = document.querySelectorAll('body, body *')
    for (let i = 0; i < els.length && i < styleWalkLimit; i++) {
      const el = els[i]
      const s = getComputedStyle(el)
      const role = el.matches('a, button, [role=button], .btn, .cta') ? 'accent' : null
      bump(hex(s.backgroundColor), role || 'background')
      bump(hex(s.color), role ? 'accent-text' : 'text')
      const fam = s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')
      if (fam) fonts.add(fam)
    }
    const logos = []
    for (const img of document.querySelectorAll('img, svg')) {
      const tag = [img.id, img.className?.baseVal ?? img.className, img.getAttribute('alt')].join(' ').toLowerCase()
      if (tag.includes('logo')) logos.push({ source: img.tagName.toLowerCase() === 'img' ? 'img' : 'svg',
        src: img.tagName.toLowerCase() === 'img' ? img.currentSrc || img.src : new XMLSerializer().serializeToString(img) })
    }
    for (const l of document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon], meta[property="og:image"]')) {
      logos.push({ source: l.tagName === 'META' ? 'og:image' : 'icon', src: l.href || l.content })
    }
    const palette = Object.entries(counts).map(([k, count]) => { const [hex, role] = k.split('|'); return { hex, role, count } })
      .sort((a, b) => b.count - a.count).slice(0, 12)
    return { title: document.title, palette, fonts: [...fonts].slice(0, 6), logos }
  }, STYLE_WALK_LIMIT)

  const logos = []
  for (const [i, l] of found.logos.slice(0, 8).entries()) {
    try {
      if (l.source === 'svg') {
        // Inline <svg>: already have the serialized markup, no download needed.
        const name = `logo-${i}.svg`
        writeFileSync(join(outDir, 'logos', name), l.src)
        logos.push({ path: `logos/${name}`, source: l.source })
        continue
      }
      const src = l.src
      let buf, contentType
      if (/^https?:|^data:/i.test(src)) {
        const res = await fetch(src, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) })
        if (!res.ok) continue
        const ab = await res.arrayBuffer()
        if (ab.byteLength === 0 || ab.byteLength > MAX_LOGO_BYTES) continue
        buf = Buffer.from(ab)
        contentType = res.headers.get('content-type') || ''
      } else if (isFileUrl && src.startsWith('file:')) {
        // Only trust a file: logo reference when the captured page ITSELF is
        // file: — a live http(s) page has no business pointing at the local
        // filesystem, so that case falls through to skipped below.
        const filePath = fileURLToPath(src)
        buf = readFileSync(filePath)
        if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) continue
        contentType = EXT_TO_TYPE[extname(filePath).toLowerCase()] || ''
      } else {
        continue // unsupported scheme (or a file: src on a non-file: page)
      }
      const name = `logo-${i}${extForContentType(contentType)}`
      writeFileSync(join(outDir, 'logos', name), buf)
      logos.push({ path: `logos/${name}`, source: l.source })
    } catch { /* a logo that won't download is skipped, not fatal */ }
  }

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true })
  await loadPage(page, url)
  await page.screenshot({ path: join(outDir, 'mobile.png') })

  const manifest = { url, title: found.title, screenshots: { desktop: 'desktop.png', mobile: 'mobile.png', full: 'full.png' },
    logos, palette: found.palette, fonts: found.fonts }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  process.stdout.write(JSON.stringify({ path: join(outDir, 'manifest.json') }))
} finally {
  await browser.close()
}

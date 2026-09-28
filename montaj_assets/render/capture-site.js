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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

// Same puppeteer.launch options as sample-frame.js (~line 286). No shared
// helper exists (renderer.js's launchBrowser is private) — the codebase
// copies these args at each call site.
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    // --disable-dev-shm-usage: use /tmp instead of the container's 64MB /dev/shm
    // (Docker default) so heavy renders don't crash Chromium on shm exhaustion.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--allow-file-access-from-files'],
    protocolTimeout: 300000,
  })
}

const [, , url, outDir] = process.argv
mkdirSync(join(outDir, 'logos'), { recursive: true })
const browser = await launchBrowser()
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 })
await page.screenshot({ path: join(outDir, 'desktop.png') })
const fullH = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 6000))
await page.screenshot({ path: join(outDir, 'full.png'), clip: { x: 0, y: 0, width: 1440, height: fullH } })

const found = await page.evaluate(() => {
  const hex = (c) => {
    const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
    return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
  }
  const counts = {}
  const bump = (h, role) => { if (!h) return; const k = h + '|' + role; counts[k] = (counts[k] || 0) + 1 }
  const fonts = new Set()
  for (const el of document.querySelectorAll('body, body *')) {
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
})

const logos = []
for (const [i, l] of found.logos.slice(0, 8).entries()) {
  try {
    const name = `logo-${i}${l.source === 'svg' ? '.svg' : '.png'}`
    if (l.source === 'svg') writeFileSync(join(outDir, 'logos', name), l.src)
    else {
      const res = await page.evaluate(async (src) => {
        const r = await fetch(src); const b = new Uint8Array(await r.arrayBuffer()); return Array.from(b)
      }, l.src)
      writeFileSync(join(outDir, 'logos', name), Buffer.from(res))
    }
    logos.push({ path: `logos/${name}`, source: l.source })
  } catch { /* a logo that won't download is skipped, not fatal */ }
}

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true })
await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 })
await page.screenshot({ path: join(outDir, 'mobile.png') })
await browser.close()

const manifest = { url, title: found.title, screenshots: { desktop: 'desktop.png', mobile: 'mobile.png', full: 'full.png' },
  logos, palette: found.palette, fonts: found.fonts }
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
process.stdout.write(JSON.stringify({ path: join(outDir, 'manifest.json') }))

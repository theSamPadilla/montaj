// render/test/item-blur-preview-parity.test.mjs
//
// A clip's blur, preview against export, measured in a real Chromium.
//
// The editor preview draws a clip's blur as an SVG filter on the clip's media
// box (editor src/video/preview/itemBlur.tsx): the source cut to the
// picture's rect in the box (timeline-core pictureRectInBox; a flood over that
// rect, composited `in`, which keeps anything outside the picture, such as the
// engine canvas's black bars, out of the average: the filter region alone does
// not, measured), feGaussianBlur, feColorMatrix setting alpha to 1 (it works on
// unpremultiplied colour, so it divides by the blurred alpha), then feComposite
// `in` the cut source for its alpha; in sRGB; the sigma `blur` design pixels
// at the preview's scale. The export draws it with buildImageItemFilterParts'
// graph (item-blur.js), on the fitted picture before its contain pad.
//
// This page is that preview, transcribed (the editor's .tsx cannot load in
// node:test): a box the size of the design canvas at scale 1, a contain-fitted
// 16:9 picture in it, the same filter; once with a transparent letterbox (the
// <video> and <img> path) and once on black bars (the engine canvas, which
// paints opaque black around the picture). The export side is the real
// builder's graph run through ffmpeg. They must agree inside the picture, both
// keep the picture's edge rows opaque, and the pad stays black.
//
// The control is a plain blur (the feGaussianBlur alone): the picture's edge
// rows fade toward black, the dark edge this filter exists to avoid.
//
// Chromium here is the headless shell, which blurs in software (Skia raster);
// the app's GPU path approximates a large blur differently, by a few codes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'
import { pictureRectInBox, blurSigmaPx } from '@bycrux/timeline-core'
import { buildImageItemFilterParts } from '../encode-segment.js'
import { overlayPageLaunchOptions } from '../page-guard.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const W = 180          // the canvas (design 1080x1920 at 1/6)
const H = 320
const PW = 180         // the picture: 16:9, contain-fitted to the full width, no resampling
const PH = 100
const BLUR = 36        // design px: sigma 6 at 180 wide

function rgbOf(png) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(r.stdout.length, W * H * 3)
  return r.stdout
}

function previewHtml(pic, sigma, rect, { plain = false, bars = false } = {}) {
  const prims = plain
    ? `<feGaussianBlur stdDeviation="${sigma}"/>`
    : `<feFlood flood-color="#fff" x="${rect.x * W}" y="${rect.y * H}" width="${rect.w * W}" height="${rect.h * H}" result="r"/>`
      + '<feComposite in="SourceGraphic" in2="r" operator="in" result="p"/>'
      + `<feGaussianBlur in="p" stdDeviation="${sigma}" result="b"/>`
      + '<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="o"/>'
      + '<feComposite in="o" in2="p" operator="in"/>'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;background:#000;overflow:hidden}
#box{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;filter:url(#b)${bars ? ';background:#000' : ''}}
#box img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
</style></head><body>
<div id="box"><img src="${pic}">
<svg aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden">
<filter id="b" filterUnits="objectBoundingBox" x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" color-interpolation-filters="sRGB">
${prims}</filter></svg></div>
</body></html>`
}

test('preview SVG blur (Chromium) and export gblur agree on a contain-fitted picture; edges stay opaque', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-parity-'))
  let browser
  try {
    browser = await puppeteer.launch(overlayPageLaunchOptions({ disableWebSecurity: true }))
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    t.skip(`no Chromium to launch: ${e.message}`)
    return
  }
  try {
    const pic = join(dir, 'pic.png')
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${PW}x${PH}:r=1`, '-frames:v', '1',
      '-pix_fmt', 'rgb24', pic])
    assert.equal(g.status, 0, String(g.stderr))

    // ── Export: the real builder's chain for the item ───────────────────────
    // Its own chain, up to the box it hands the composite (the picture on its
    // transparent contain pad), read as RGB: the composite's 4:2:0 overlay
    // would add a chroma subsampling every export has, blurred or not.
    const item = { type: 'image', src: pic, start: 0, end: 1, fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, opacity: 1, blur: BLUR }
    const sigma = blurSigmaPx(item, W, H)
    assert.equal(sigma, 6)
    const { filterParts } = buildImageItemFilterParts(item, W, H, 0, '[canvas]', 1, 0)
    const chain = filterParts[0]
    assert.ok(chain.startsWith('[0:v]') && chain.endsWith('[img0]'), chain)
    assert.ok(chain.includes('gblur=sigma=6.0000'), chain)
    const exportPng = join(dir, 'export.png')
    const e = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', pic,
      '-filter_complex', chain, '-map', '[img0]', '-frames:v', '1', '-pix_fmt', 'rgb24', exportPng])
    assert.equal(e.status, 0, String(e.stderr))
    const exp = rgbOf(exportPng)

    // ── Preview: the same blur in Chromium ──────────────────────────────────
    // The page is the design canvas at renderScale W / 1080: the sigma on screen is BLUR * renderScale.
    const renderScale = W / 1080
    const rect = pictureRectInBox(W, H, PW, PH)
    const shoot = async (opts, name) => {
      const html = join(dir, `${name}.html`)
      writeFileSync(html, previewHtml(`file://${pic}`, BLUR * renderScale, rect, opts))
      const page = await browser.newPage()
      try {
        await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
        await page.goto(`file://${html}`, { waitUntil: 'load' })
        const png = join(dir, `${name}.png`)
        await page.screenshot({ path: png })
        return rgbOf(png)
      } finally { await page.close() }
    }
    const prev = await shoot({}, 'preview')
    const onBars = await shoot({ bars: true }, 'bars')
    const ctrl = await shoot({ plain: true }, 'control')

    const top = Math.round(rect.y * H)            // 110
    const bottom = Math.round((rect.y + rect.h) * H) - 1 // 209
    assert.equal(top, 110)
    assert.equal(bottom, 209)
    const at = (buf, x, y, c) => buf[(y * W + x) * 3 + c]
    const rowDiff = (a, b, y) => {
      let worst = 0
      for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(at(a, x, y, c) - at(b, x, y, c)))
      return worst
    }
    const rowMean = (buf, y) => {
      let s = 0
      for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) s += at(buf, x, y, c)
      return s / (W * 3)
    }

    // Inside the picture: within a few codes everywhere, edge rows included,
    // on a transparent letterbox and on black bars alike.
    for (const [label, shot] of [['transparent letterbox', prev], ['black bars', onBars]]) {
      let worst = 0
      let sum = 0
      for (let y = top; y <= bottom; y++) {
        worst = Math.max(worst, rowDiff(shot, exp, y))
        for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) sum += Math.abs(at(shot, x, y, c) - at(exp, x, y, c))
      }
      const mean = sum / ((bottom - top + 1) * W * 3)
      t.diagnostic(`${label}, inside the picture: worst ${worst} codes, mean ${mean.toFixed(2)}`)
      assert.ok(worst <= 12, `${label}: worst difference inside the picture ${worst} codes`)
      assert.ok(mean <= 2.5, `${label}: mean difference inside the picture ${mean.toFixed(2)} codes`)
      assert.ok(Math.abs(rowMean(shot, top) - rowMean(exp, top)) <= 2 && Math.abs(rowMean(shot, bottom) - rowMean(exp, bottom)) <= 2,
        `${label}: edge rows agree (top ${rowMean(shot, top).toFixed(1)} vs ${rowMean(exp, top).toFixed(1)})`)
      // Outside the picture: black in both (the filter region drops the bars, the frame is black under them).
      for (const y of [0, top - 2, bottom + 2, H - 1]) {
        assert.ok(rowMean(shot, y) < 1 && rowMean(exp, y) < 1, `${label}: row ${y} is black: ${rowMean(shot, y)}, export ${rowMean(exp, y)}`)
      }
    }

    // Control: a plain blur pulls the transparent letterbox in, and the
    // picture's edge rows darken a lot: the dark edge the filter avoids.
    assert.ok(rowMean(ctrl, top) < rowMean(prev, top) * 0.7,
      `a plain blur darkens the top row: ${rowMean(ctrl, top).toFixed(1)} vs ${rowMean(prev, top).toFixed(1)}`)
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Linear ──────────────────────────────────────────────────────────────────
//
// The preview's linear blur (itemBlur.tsx), transcribed: the media box cuts
// to the picture's rect (clip-path, axis-aligned, so the picture's edges stay
// hard); inside it a wrapper turned by +angle carries the blur, and inside
// that a wrapper turned back by -angle cuts the source to the picture's rect
// with a filter of its own (feFlood, composited `in`) and holds the media.
// Each filter runs in its element's own frame, so the turned wrapper's x is
// the blur's direction: feGaussianBlur with a sigma along x only,
// feColorMatrix (alpha 1, the renormalisation), and the cut source's alpha
// grown by a pixel (feMorphology) put back, so the turn's antialiased edge
// does not fade the picture's edge rows. Its region is the picture's rect as
// the turned wrapper sees it. The export is the real builder's graph
// (item-blur.js: turned, gblur along x, turned back).
//
// Measured (headless shell 127, software): within 13 codes, mean under 1.6,
// edge rows within 3, at 0, 30, 90 and 135 degrees, on a transparent
// letterbox and on black bars alike. Two things it took (each measured here
// against a true directional Gaussian): the cut in the media's own frame
// (cut in the turned frame by a clip-path, black bars bled into the edge
// rows: 106 codes), and the grown alpha (without it the edge rows came out
// 26 codes dark). The grow costs a pixel of the clip's own transparency (a
// hole shrinks by a screen pixel in the preview; the export keeps it exact).

const fmtN = (n) => String(Math.round(n * 10000) / 10000)

/** The turned wrapper's filter region, as fractions of its box (the media box). */
function linearRegion(rect, deg) {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const pts = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]]
    .map(([fx, fy]) => {
      // The picture's corner in px from the box centre, turned by -deg (into the wrapper's space).
      const x = (fx - 0.5) * W
      const y = (fy - 0.5) * H
      return [x * c + y * s + W / 2, -x * s + y * c + H / 2]
    })
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs) - 2
  const y0 = Math.min(...ys) - 2
  return { x: x0 / W, y: y0 / H, w: (Math.max(...xs) + 2 - x0) / W, h: (Math.max(...ys) + 2 - y0) / H }
}

function linearPreviewHtml(pic, sigma, rect, deg, { bars = false } = {}) {
  const inset = `${fmtN(rect.y * 100)}% ${fmtN((1 - rect.x - rect.w) * 100)}% ${fmtN((1 - rect.y - rect.h) * 100)}% ${fmtN(rect.x * 100)}%`
  const reg = linearRegion(rect, deg)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;background:#000;overflow:hidden}
#box{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;clip-path:inset(${inset})}
#turn{position:absolute;inset:0;transform:rotate(${deg}deg);filter:url(#l)}
#back{position:absolute;inset:0;transform:rotate(${-deg}deg);filter:url(#c)}
#media{position:absolute;inset:0${bars ? ';background:#000' : ''}}
#media img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
</style></head><body>
<div id="box"><div id="turn"><div id="back"><div id="media"><img src="${pic}"></div></div></div>
<svg aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden">
<filter id="c" filterUnits="objectBoundingBox" x="${fmtN(rect.x)}" y="${fmtN(rect.y)}" width="${fmtN(rect.w)}" height="${fmtN(rect.h)}" color-interpolation-filters="sRGB">
<feFlood flood-color="#fff" x="${fmtN(rect.x * W)}" y="${fmtN(rect.y * H)}" width="${fmtN(rect.w * W)}" height="${fmtN(rect.h * H)}" result="r"/>
<feComposite in="SourceGraphic" in2="r" operator="in"/></filter>
<filter id="l" filterUnits="objectBoundingBox" x="${fmtN(reg.x)}" y="${fmtN(reg.y)}" width="${fmtN(reg.w)}" height="${fmtN(reg.h)}" color-interpolation-filters="sRGB">
<feGaussianBlur in="SourceGraphic" stdDeviation="${fmtN(sigma)} 0" result="b"/>
<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="o"/>
<feMorphology in="SourceGraphic" operator="dilate" radius="1" result="a"/>
<feComposite in="o" in2="a" operator="in"/></filter></svg></div>
</body></html>`
}

test('preview SVG linear blur (Chromium) and export agree at 0, 30, 90 and 135 degrees; edges stay opaque', { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'blur-parity-lin-'))
  let browser
  try {
    browser = await puppeteer.launch(overlayPageLaunchOptions({ disableWebSecurity: true }))
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    t.skip(`no Chromium to launch: ${e.message}`)
    return
  }
  try {
    const pic = join(dir, 'pic.png')
    const g = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${PW}x${PH}:r=1`, '-frames:v', '1',
      '-pix_fmt', 'rgb24', pic])
    assert.equal(g.status, 0, String(g.stderr))
    const renderScale = W / 1080
    const rect = pictureRectInBox(W, H, PW, PH)
    const top = Math.round(rect.y * H)
    const bottom = Math.round((rect.y + rect.h) * H) - 1
    const at = (buf, x, y, c) => buf[(y * W + x) * 3 + c]
    const rowMean = (buf, y) => {
      let s = 0
      for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) s += at(buf, x, y, c)
      return s / (W * 3)
    }
    const shoot = async (html, name) => {
      const file = join(dir, `${name}.html`)
      writeFileSync(file, html)
      const page = await browser.newPage()
      try {
        await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
        await page.goto(`file://${file}`, { waitUntil: 'load' })
        const png = join(dir, `${name}.png`)
        await page.screenshot({ path: png })
        return rgbOf(png)
      } finally { await page.close() }
    }
    for (const deg of [0, 30, 90, 135]) {
      const item = { type: 'image', src: pic, start: 0, end: 1, fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, opacity: 1,
        blur: BLUR, blurType: 'linear', blurAngle: deg }
      const chain = buildImageItemFilterParts(item, W, H, 0, '[canvas]', 1, 0).filterParts[0]
      const exportPng = join(dir, `export-${deg}.png`)
      const e = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', pic, '-filter_complex', chain, '-map', '[img0]', '-frames:v', '1',
        '-pix_fmt', 'rgb24', exportPng])
      assert.equal(e.status, 0, String(e.stderr))
      const exp = rgbOf(exportPng)
      for (const bars of [false, true]) {
        const label = `${deg} degrees, ${bars ? 'black bars' : 'transparent letterbox'}`
        const shot = await shoot(linearPreviewHtml(`file://${pic}`, BLUR * renderScale, rect, deg, { bars }), `lin-${deg}-${bars}`)
        let worst = 0
        let sum = 0
        for (let y = top; y <= bottom; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
          const d = Math.abs(at(shot, x, y, c) - at(exp, x, y, c))
          worst = Math.max(worst, d)
          sum += d
        }
        const mean = sum / ((bottom - top + 1) * W * 3)
        const edges = [top, bottom].map((y) => `${rowMean(shot, y).toFixed(1)}/${rowMean(exp, y).toFixed(1)}`).join(', ')
        t.diagnostic(`${label}: worst ${worst} codes, mean ${mean.toFixed(2)}; edge rows preview/export ${edges}`)
        assert.ok(worst <= 15, `${label}: worst difference inside the picture ${worst} codes`)
        assert.ok(mean <= 2, `${label}: mean difference inside the picture ${mean.toFixed(2)} codes`)
        for (const y of [top, bottom]) {
          assert.ok(Math.abs(rowMean(shot, y) - rowMean(exp, y)) <= 3, `${label}: row ${y} ${rowMean(shot, y).toFixed(1)} vs ${rowMean(exp, y).toFixed(1)}`)
        }
        for (const y of [0, top - 2, bottom + 2, H - 1]) {
          assert.ok(rowMean(shot, y) < 1 && rowMean(exp, y) < 1, `${label}: row ${y} is black: ${rowMean(shot, y)}, export ${rowMean(exp, y)}`)
        }
      }
    }
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

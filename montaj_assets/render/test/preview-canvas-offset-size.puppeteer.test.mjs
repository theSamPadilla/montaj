// render/test/preview-canvas-offset-size.puppeteer.test.mjs
//
// The editor preview fits the 1080×1920 design canvas into its pane with an
// ancestor CSS `transform: scale(s)`. r3f's <Canvas> measures its container
// with react-use-measure, which by default reads getBoundingClientRect(): the
// POST-transform size. r3f then sizes the <canvas> (style and drawing buffer)
// to that shrunk rect, and the ancestor transform shrinks it a second time, so
// a 3D overlay drew as a small box in the top-left of the preview while
// exports (Puppeteer at 1080×1920, no transform) were full frame.
//
// r3f re-applies its measured size on EVERY render of <Canvas> (a layout
// effect with no deps calls root.configure({ size })), and the editor
// re-renders overlays every frame and every scrub. So a fix that corrects the
// size once (on mount, on resize) is undone by the next render. This test
// therefore re-renders the Canvas's parent several times before it measures.
//
// The page is the preview Canvas exactly as the editor gets it
// (makeCanvas('preview') from overlay-runtime/canvas-wrapper.js), bundled with
// the same React aliasing the overlay build uses, and loaded in a browser
// launched with the overlay-page options, so WebGL behaves as it does in
// renders.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer'
import { overlayPageLaunchOptions } from '../page-guard.js'

const RENDER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CANVAS_WRAPPER = join(RENDER_DIR, '..', 'overlay-runtime', 'canvas-wrapper.js')

const DESIGN = { width: 1080, height: 1920 }
const PREVIEW_SCALE = 0.25
const RERENDERS = 10

// The page: a design-sized container inside a scaled parent, holding the
// preview Canvas with a one-mesh scene authored the way overlays author it
// (frameloop="never"). window.__bump() re-renders the Canvas's parent.
const PAGE_ENTRY = `
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { makeCanvas } from ${JSON.stringify(CANVAS_WRAPPER)}

const Canvas = makeCanvas('preview')

function Box({ n }) {
  return h('mesh', { rotation: [0.4, 0.6 + n * 0.01, 0] },
    h('boxGeometry', { args: [1, 1, 1] }),
    h('meshBasicMaterial', { color: 'orange' }))
}

function App() {
  const [n, setN] = useState(0)
  window.__bump = () => flushSync(() => setN((x) => x + 1))
  window.__renders = n
  return h('div', {
    id: 'scaler',
    style: { transform: 'scale(${PREVIEW_SCALE})', transformOrigin: '0 0', width: ${DESIGN.width}, height: ${DESIGN.height} },
  },
    h('div', { id: 'container', style: { width: ${DESIGN.width}, height: ${DESIGN.height} } },
      h(Canvas, { frameloop: 'never' }, h(Box, { n }))))
}

createRoot(document.getElementById('root')).render(h(App))
`

async function buildPage(workDir) {
  await esbuild.build({
    stdin: { contents: PAGE_ENTRY, resolveDir: RENDER_DIR, sourcefile: 'preview-canvas-page.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: join(workDir, 'page.js'),
    // The overlay build's React aliasing (overlay-build.js): one React, from
    // render's node_modules, for both the page and r3f's reconciler.
    alias: {
      'react':            join(RENDER_DIR, 'node_modules', 'react'),
      'react-dom':        join(RENDER_DIR, 'node_modules', 'react-dom'),
      'react-dom/client': join(RENDER_DIR, 'node_modules', 'react-dom', 'client'),
    },
    nodePaths: [join(RENDER_DIR, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  const htmlPath = join(workDir, 'index.html')
  writeFileSync(htmlPath, '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;background:#123456;overflow:hidden}</style>'
    + '</head><body><div id="root"></div><script src="page.js"></script></body></html>')
  return htmlPath
}

// Everything measured in one place, in the page.
function measure() {
  const container = document.getElementById('container')
  const canvas = container && container.querySelector('canvas')
  if (!canvas) return null
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  const cr = container.getBoundingClientRect()
  const vr = canvas.getBoundingClientRect()
  return {
    renders: window.__renders,
    dpr: window.devicePixelRatio,
    container: { w: container.offsetWidth, h: container.offsetHeight },
    canvasLayout: { w: canvas.offsetWidth, h: canvas.offsetHeight },
    canvasAttr: { w: canvas.width, h: canvas.height },
    drawingBuffer: gl ? { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight } : null,
    containerRect: { w: cr.width, h: cr.height },
    canvasRect: { w: vr.width, h: vr.height },
  }
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  // Two frames plus a beat: long enough for r3f's layout effect, a
  // ResizeObserver callback and anything they schedule on the next frame.
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
}))

test('preview Canvas keeps the design size under a scaled ancestor across re-renders', { timeout: 120_000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'montaj-preview-canvas-size-test-'))
  const browser = await puppeteer.launch(overlayPageLaunchOptions({ disableWebSecurity: true }))
  try {
    const htmlPath = await buildPage(workDir)
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)))
    // A preview-pane-sized viewport on a Retina-like display.
    await page.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })

    // r3f creates its renderer once the container has been measured.
    await page.waitForFunction(() => {
      const c = document.querySelector('#container canvas')
      return !!(c && c.style.width)
    }, { timeout: 20_000 }).catch(() => {})
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`)

    const hasWebGL = await page.evaluate(() => {
      const c = document.querySelector('#container canvas')
      return !!(c && (c.getContext('webgl2') || c.getContext('webgl')))
    })
    assert.ok(hasWebGL, 'WebGL is unavailable in this headless browser; this test cannot measure the r3f canvas')

    await settle(page)
    const mounted = await page.evaluate(measure)

    // Re-render the Canvas's parent the way the editor does per frame.
    for (let i = 0; i < RERENDERS; i++) {
      await page.evaluate(() => window.__bump())
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
    }
    await settle(page)
    const m = await page.evaluate(measure)
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`)

    const report = `after mount ${JSON.stringify(mounted)}; after ${RERENDERS} re-renders ${JSON.stringify(m)}`
    // eslint-disable-next-line no-console
    console.log(report)

    assert.equal(m.renders, RERENDERS, `the parent should have re-rendered ${RERENDERS} times. ${report}`)
    assert.deepEqual(m.container, { w: DESIGN.width, h: DESIGN.height }, `harness: container offset size. ${report}`)
    assert.deepEqual(m.containerRect, { w: DESIGN.width * PREVIEW_SCALE, h: DESIGN.height * PREVIEW_SCALE },
      `harness: the scaled parent must shrink the container on screen. ${report}`)

    // Right after mount, before any re-render.
    assert.deepEqual(mounted.canvasLayout, mounted.container,
      `after mount, canvas layout size must equal the container's offset size. ${report}`)

    // The canvas fills its container in layout space, not the scaled rect.
    assert.deepEqual(m.canvasLayout, m.container,
      `canvas layout size must equal the container's offset size (${DESIGN.width}×${DESIGN.height}), `
      + `not the post-transform rect (${DESIGN.width * PREVIEW_SCALE}×${DESIGN.height * PREVIEW_SCALE}). ${report}`)
    // So on screen it covers exactly what the container covers.
    assert.deepEqual(m.canvasRect, m.containerRect, `canvas must cover the container on screen. ${report}`)
    // And the WebGL drawing buffer is sized for that layout size at the page's dpr.
    assert.deepEqual(
      { w: m.canvasAttr.w / m.dpr, h: m.canvasAttr.h / m.dpr }, m.container,
      `canvas width/height attributes over dpr must equal the container's offset size. ${report}`)
    assert.deepEqual(
      { w: m.drawingBuffer.w / m.dpr, h: m.drawingBuffer.h / m.dpr }, m.container,
      `WebGL drawing buffer over dpr must equal the container's offset size. ${report}`)
  } finally {
    await browser.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

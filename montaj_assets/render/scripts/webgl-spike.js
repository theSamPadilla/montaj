/**
 * webgl-spike.js — Decision gate for Three.js / r3f support in the overlay renderer.
 *
 * Launches Puppeteer with the SAME launch options the production overlay renderer
 * would use after Task 2's headless: 'new' switch, loads a page that creates a
 * WebGL context and draws a single triangle, then screenshots the result.
 *
 * Pass criteria:
 *   - canvas.getContext('webgl') returns a non-null context
 *   - The triangle draw call does not throw
 *   - The screenshot file exists and is non-trivial (> 1 KB)
 *
 * Exits 0 on pass, 1 on fail. See docs/plans/2026-05-24-three-js-render.md Task 1.
 */
import puppeteer from 'puppeteer'
import { writeFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const renderRoot = dirname(__dirname)

// Mirror renderer.js launch args exactly (plus the headless mode swap from Task 2).
const LAUNCH_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--allow-file-access-from-files'],
}

const SCREENSHOT_PATH = '/tmp/montaj-webgl-spike.png'

// Self-contained HTML page. Embeds a triangle draw via raw WebGL — intentionally
// not using Three.js. We only need to confirm getContext('webgl') works.
const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #111; }
  canvas { display: block; width: 800px; height: 600px; }
</style>
</head>
<body>
<canvas id="c" width="800" height="600"></canvas>
<script>
(function() {
  window.__webglOk = false
  window.__webglError = null
  window.__webglDetail = {}
  try {
    const canvas = document.getElementById('c')
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })
                ?? canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true })
    if (!gl) {
      window.__webglError = 'canvas.getContext(\\'webgl\\') returned null'
      return
    }
    window.__webglDetail.vendor   = gl.getParameter(gl.VENDOR)
    window.__webglDetail.renderer = gl.getParameter(gl.RENDERER)
    window.__webglDetail.version  = gl.getParameter(gl.VERSION)

    // Compile + link a minimal program
    const vs = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vs, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }')
    gl.compileShader(vs)
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      window.__webglError = 'vertex shader compile failed: ' + gl.getShaderInfoLog(vs)
      return
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fs, 'precision mediump float; void main() { gl_FragColor = vec4(0.23, 0.51, 0.96, 1.0); }')
    gl.compileShader(fs)
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      window.__webglError = 'fragment shader compile failed: ' + gl.getShaderInfoLog(fs)
      return
    }
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      window.__webglError = 'program link failed: ' + gl.getProgramInfoLog(program)
      return
    }
    gl.useProgram(program)

    // Big triangle covering most of the canvas
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.8, -0.8,
       0.8, -0.8,
       0.0,  0.8,
    ]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    gl.clearColor(0.07, 0.07, 0.07, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish()

    window.__webglOk = true
  } catch (e) {
    window.__webglError = 'threw: ' + (e && e.message ? e.message : String(e))
  }
})()
</script>
</body>
</html>`

async function main() {
  console.log('[webgl-spike] launching Puppeteer with headless: \'new\'...')
  const browser = await puppeteer.launch(LAUNCH_OPTS)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 })

    // Capture console + page errors so we don't silently miss WebGL warnings
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        pageErrors.push(`[${msg.type()}] ${msg.text()}`)
      }
    })

    await page.setContent(PAGE_HTML, { waitUntil: 'networkidle0' })

    const result = await page.evaluate(() => ({
      ok:    window.__webglOk,
      error: window.__webglError,
      detail: window.__webglDetail,
    }))

    if (!result.ok) {
      console.error('[webgl-spike] FAIL — WebGL did not initialise:')
      console.error('  error:', result.error)
      if (pageErrors.length) console.error('  page errors:', pageErrors)
      process.exit(1)
    }

    console.log('[webgl-spike] WebGL context created:')
    console.log('  vendor:  ', result.detail.vendor)
    console.log('  renderer:', result.detail.renderer)
    console.log('  version: ', result.detail.version)

    await page.screenshot({ path: SCREENSHOT_PATH })

    const st = statSync(SCREENSHOT_PATH)
    if (st.size < 1024) {
      console.error(`[webgl-spike] FAIL — screenshot too small (${st.size} bytes). Likely blank.`)
      process.exit(1)
    }

    console.log(`[webgl-spike] PASS — screenshot ${SCREENSHOT_PATH} (${st.size} bytes)`)
    console.log('[webgl-spike] Open the screenshot to visually confirm a blue triangle is present.')
    process.exit(0)
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error('[webgl-spike] FAIL — unexpected error:', err)
  process.exit(1)
})

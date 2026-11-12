// gpu-3d.js: a render with 3D first asks whether this machine can draw it, and one with no usable GPU stops before its
// first frame with a sentence for the user (no_3d_graphics), never an export that runs for hours or ends blank.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'
import { NO_3D_GRAPHICS, SOFTWARE_RENDERER, check3dGraphics, isNo3dGraphics, no3dGraphicsError, softwareAllowed } from '../gpu-3d.js'
import { overlayPageLaunchOptions } from '../page-guard.js'
import { renderAllSegments } from '../renderer.js'

const fakeBrowser = (answer) => ({
  async newPage() {
    if (answer instanceof Error) throw answer
    return { evaluate: async () => answer, close: async () => {} }
  },
})

test('the sentence is short, says what to do, and has no em dash', () => {
  assert.ok(NO_3D_GRAPHICS.length <= 110, NO_3D_GRAPHICS)
  assert.match(NO_3D_GRAPHICS, /graphics card|graphics driver/)
  assert.doesNotMatch(NO_3D_GRAPHICS, /—/)
})

test('no context at the stage\'s powerPreference, or a software renderer, cannot draw 3D', async () => {
  assert.deepEqual(await check3dGraphics(fakeBrowser({ context: null, renderer: null })), { ok: false, renderer: null, reason: 'no WebGL context at powerPreference high-performance' })
  for (const renderer of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
  ]) {
    const got = await check3dGraphics(fakeBrowser({ context: 'webgl2', renderer }))
    assert.equal(got.ok, false, renderer)
    assert.match(got.reason, /^software renderer: /)
  }
})

test('a GPU draws it; a check that cannot run never stops a render', async () => {
  for (const renderer of ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)']) {
    assert.equal(SOFTWARE_RENDERER.test(renderer), false, renderer)
    assert.equal((await check3dGraphics(fakeBrowser({ context: 'webgl2', renderer }))).ok, true, renderer)
  }
  assert.equal((await check3dGraphics(fakeBrowser(new Error('Target closed')))).ok, true)
})

test('the error carries its code and the sentence', () => {
  const err = no3dGraphicsError('software renderer: SwiftShader')
  assert.equal(err.message, NO_3D_GRAPHICS)
  assert.equal(isNo3dGraphics(err), true)
  assert.equal(isNo3dGraphics(new Error('x')), false)
})

const memory = { readAvailable: () => 30e9, totalBytes: 36e9 }
const seg = (scene3d) => ({
  id: scene3d ? 'sc' : 'txt', frameCount: 10, props: {}, outputPath: '/tmp/gpu-3d.webm', ...(scene3d ? { scene3d: true } : {}),
  boundary: { allows: () => true }, startSeconds: 0, endSeconds: 1, fps: 30,
})
function fakes() {
  const seen = { closed: 0, rendered: 0, checked: 0 }
  return {
    seen,
    launchWorker: async () => ({ browser: {}, close: async () => { seen.closed++ } }),
    renderJob: async (_w, job) => { seen.rendered++; return { webmPath: job.outputPath } },
  }
}

test('renderAllSegments: a render with 3D on a machine that cannot draw it stops before any chunk, browsers closed', async () => {
  const f = fakes()
  const check3dGraphics = async () => { f.seen.checked++; return { ok: false, renderer: 'SwiftShader', reason: 'software renderer: SwiftShader' } }
  await assert.rejects(
    renderAllSegments([seg(true)], { workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory, check3dGraphics }),
    (err) => isNo3dGraphics(err) && err.message === NO_3D_GRAPHICS && err.reason === 'software renderer: SwiftShader',
  )
  assert.equal(f.seen.checked, 1)
  assert.equal(f.seen.rendered, 0, 'no chunk starts')
  assert.ok(f.seen.closed >= 1, 'the browsers are closed')
})

test('MONTAJ_RENDER_SOFTWARE_3D=1, and only that, lets a machine with no GPU render 3D anyway', async () => {
  assert.equal(softwareAllowed({ MONTAJ_RENDER_SOFTWARE_3D: '1' }), true)
  for (const v of [undefined, '', '0', 'true']) assert.equal(softwareAllowed({ MONTAJ_RENDER_SOFTWARE_3D: v }), false, String(v))
  const prev = process.env.MONTAJ_RENDER_SOFTWARE_3D
  process.env.MONTAJ_RENDER_SOFTWARE_3D = '1'
  try {
    const f = fakes()
    await renderAllSegments([seg(true)], { workers: 1, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory, check3dGraphics: async () => ({ ok: false, reason: 'x' }) })
    assert.equal(f.seen.rendered, 1)
  } finally {
    if (prev === undefined) delete process.env.MONTAJ_RENDER_SOFTWARE_3D; else process.env.MONTAJ_RENDER_SOFTWARE_3D = prev
  }
})

test('renderAllSegments: a render with no 3D never asks; one with 3D on a GPU renders as before', async () => {
  const f = fakes()
  let asked = 0
  const check3dGraphics = async () => { asked++; return { ok: true, renderer: 'Apple M3', reason: null } }
  await renderAllSegments([seg(false)], { workers: 1, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory, check3dGraphics })
  assert.equal(asked, 0)
  await renderAllSegments([seg(true)], { workers: 1, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory, check3dGraphics })
  assert.equal(asked, 1)
  assert.equal(f.seen.rendered, 2)
})

test('this machine\'s Chrome, launched as a render worker is, can draw 3D (a GPU)', { timeout: 60_000 }, async (t) => {
  if (softwareAllowed()) return t.skip('MONTAJ_RENDER_SOFTWARE_3D: this machine has no GPU')
  const browser = await puppeteer.launch(overlayPageLaunchOptions({ disableWebSecurity: true }))
  try {
    const got = await check3dGraphics(browser)
    assert.equal(got.ok, true, `${got.reason}`)
    assert.ok(got.renderer && !SOFTWARE_RENDERER.test(got.renderer), got.renderer)
  } finally {
    await browser.close()
  }
})

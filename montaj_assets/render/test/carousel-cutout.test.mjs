// render/test/carousel-cutout.test.mjs
//
// §587 R3: a photo's Remove background result in the carousel export. The real
// remove_bg step cuts the person out of the fixture portrait, the cutout sits on
// a blue slide, and the exported PNG shows the slide's blue where the backdrop
// was and the person where they are. Needs the pinned RVM model
// (MONTAJ_TEST_RVM_MODEL) and a Python with the rvm extra (MONTAJ_TEST_PYTHON,
// default python3); skipped without the model. Launches the real headless
// browser through render-carousel.js, so it takes ~10-20 s.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..')
const SCRIPT = resolve(__dirname, '..', 'render-carousel.js')
const STEP = join(ROOT, 'steps', 'transform', 'remove_bg.py')
const PERSON = join(ROOT, 'tests', 'fixtures', 'remove_bg', 'person.jpg')
const MODEL = process.env.MONTAJ_TEST_RVM_MODEL
const PYTHON = process.env.MONTAJ_TEST_PYTHON || 'python3'

/** An 8-bit, non-interlaced RGB or RGBA PNG as { width, height, px(x, y) -> [r, g, b, a] }. */
function decodePng(buf) {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.equal(buf[24], 8, 'bit depth')
  const colourType = buf[25]
  assert.ok(colourType === 2 || colourType === 6, `colour type ${colourType}`)
  assert.equal(buf[28], 0, 'not interlaced')
  const bpp = colourType === 6 ? 4 : 3
  const parts = []
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + i] = v & 0xff
    }
  }
  return {
    width, height,
    px: (x, y) => {
      const o = y * stride + x * bpp
      return [out[o], out[o + 1], out[o + 2], bpp === 4 ? out[o + 3] : 255]
    },
  }
}

const near = (got, want, tol = 12) => want.every((v, i) => Math.abs(got[i] - v) <= tol)
const BLUE = [30, 144, 255]

test('a Remove background cutout shows the slide colour where the backdrop was', {
  timeout: 180_000,
  skip: MODEL ? false : 'MONTAJ_TEST_RVM_MODEL is unset; point it at the pinned RVM ONNX model',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-cutout-'))
  try {
    // The real step, the way the app runs it: a still in, a PNG with alpha out.
    const home = join(dir, 'home')
    const models = join(home, '.local', 'share', 'montaj', 'models', 'rvm')
    mkdirSync(models, { recursive: true })
    copyFileSync(MODEL, join(models, 'rvm_mobilenetv3_fp32.onnx'))
    const photo = join(dir, 'person.jpg')
    copyFileSync(PERSON, photo)
    const step = spawnSync(PYTHON, [STEP, '--input', photo], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 120_000 })
    assert.equal(step.status, 0, step.stderr)
    const { out, width, height } = JSON.parse(step.stdout)
    assert.deepEqual([width, height], [409, 512])
    const cutout = decodePng(readFileSync(out))
    assert.equal(cutout.px(20, 20)[3], 0, 'the backdrop is transparent')
    assert.equal(cutout.px(239, 119)[3], 255, 'the face is opaque')

    // The cutout at 2x on a blue slide: cutout px (x, y) lands on slide (X + 2x, Y + 2y).
    const X = 131
    const Y = 28
    const project = {
      projectType: 'carousel',
      settings: { resolution: [1080, 1080] },
      carousel: { aspect: 'square' },
      slides: [{
        id: 'cutout', base_color: '#1e90ff',
        elements: [{ id: 'person', type: 'image', src: out, x: X, y: Y, w: 818, h: 1024, rotation: 0 }],
      }],
    }
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const png = decodePng(readFileSync(join(dir, 'render', 'slide_01.png')))
    assert.equal(png.width, 1080)
    const slideAt = (x, y) => png.px(X + 2 * x, Y + 2 * y)

    // Where the photo's backdrop was, the slide's blue (the photo's own backdrop is a dark grey-blue).
    for (const [x, y] of [[20, 20], [380, 20], [20, 300], [390, 300]]) {
      assert.ok(near(slideAt(x, y), BLUE), `backdrop at cutout ${x},${y}: got ${slideAt(x, y)}, want ${BLUE}`)
    }
    // The person: the face and the orange suit, each the cutout's own colour and not the blue.
    for (const [x, y] of [[239, 119], [175, 350]]) {
      const want = cutout.px(x, y)
      assert.ok(near(slideAt(x, y), want, 24), `person at cutout ${x},${y}: got ${slideAt(x, y)}, want ${want}`)
      assert.ok(!near(slideAt(x, y), BLUE, 60), `person at cutout ${x},${y} is the slide blue`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// render/test/static-text-runs.test.mjs
//
// §587 round 3: a static-text element's `runs` (one word in its own colour,
// bold or underline) draw in the carousel export, and fit the box exactly as
// the plain text does. Runs that do not spell `text` are ignored. The PNGs are
// decoded and their pixels counted. Launches the real headless browser through
// render-carousel.js, so it takes ~10-20 s.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'render-carousel.js')
const TEMPLATE = resolve(__dirname, '..', 'templates', 'overlays', 'static-text', 'static-text.jsx')

/** An 8-bit, non-interlaced RGB or RGBA PNG as { width, height, px(x, y) -> [r, g, b] }. */
function decodePng(buf) {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colourType = buf[25]
  assert.equal(buf[24], 8, 'bit depth')
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
  return { width, height, px: (x, y) => Array.from(out.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)) }
}

/** Red, dark and inked pixel counts, and the ink's bounding box. */
function survey(png) {
  let red = 0
  let dark = 0
  const box = { left: Infinity, top: Infinity, right: -1, bottom: -1 }
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.px(x, y)
      if (r > 180 && g < 90 && b < 90) red++
      if (r < 90 && g < 90 && b < 90) dark++
      if (r < 200 || g < 200 || b < 200) {
        box.left = Math.min(box.left, x)
        box.top = Math.min(box.top, y)
        box.right = Math.max(box.right, x)
        box.bottom = Math.max(box.bottom, y)
      }
    }
  }
  return { red, dark, box }
}

const TEXT = 'ink ink ink RED'
const EMOJI_TEXT = 'ink ink ink \u{1F600}'
const BOX = { x: 90, y: 340, w: 900, h: 400 }
const slide = (id, extra) => ({
  id,
  base_color: '#ffffff',
  elements: [{
    id: `${id}-text`, type: 'overlay', ...BOX, rotation: 0, frame: 0,
    overlay: {
      template: TEMPLATE,
      // 400 px does not fit: the fit shrinks it, so the comparison covers fitting.
      props: { text: TEXT, fontSize: '400', fit: 'true', minFontSize: '24', color: '#000000', fontWeight: '400', textAlign: 'center', ...extra },
    },
  }],
})

test('static-text runs: the red word is red in the export, fits like the plain text, and stale runs or runs splitting an emoji are ignored', { timeout: 120_000 }, () => {
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [
      slide('red', { runs: JSON.stringify([{ t: 'ink ink ink ' }, { t: 'RED', c: '#ff0000' }]) }),
      slide('plain', {}),
      slide('stale', { runs: JSON.stringify([{ t: 'ink', c: '#ff0000' }]) }),
      slide('bold', { runs: JSON.stringify([{ t: 'ink ink ink ' }, { t: 'RED', c: '#ff0000', b: 1, u: 1 }]) }),
      // A boundary between an emoji's two halves: ignored, as the editor ignores it.
      slide('emoji', { text: EMOJI_TEXT }),
      slide('split', { text: EMOJI_TEXT, runs: JSON.stringify([{ t: EMOJI_TEXT.slice(0, -1), c: '#ff0000' }, { t: EMOJI_TEXT.slice(-1) }]) }),
    ],
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-static-text-runs-'))
  try {
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const file = (n) => readFileSync(join(dir, 'render', `slide_0${n}.png`))
    const [red, plain, , bold] = [1, 2, 3, 4].map((n) => survey(decodePng(file(n))))

    assert.ok(red.red > 500, `the red word is not red: ${red.red} red pixels`)
    assert.ok(red.dark > 500, `the rest is not black: ${red.dark} dark pixels`)
    assert.equal(plain.red, 0, 'the plain text has red in it')
    assert.deepEqual(red.box, plain.box, 'a colour run changed where the text fits')

    assert.ok(file(3).equals(file(2)), 'runs that do not spell the text must draw exactly as the plain text')
    assert.ok(file(6).equals(file(5)), 'runs that split an emoji must draw exactly as the plain text')

    assert.ok(bold.red > red.red * 1.15, `the bold, underlined word has no more ink: ${bold.red} vs ${red.red}`)
    assert.ok(bold.box.left >= BOX.x && bold.box.right < BOX.x + BOX.w && bold.box.top >= BOX.y && bold.box.bottom < BOX.y + BOX.h,
      `the bold run does not fit the box: ${JSON.stringify(bold.box)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

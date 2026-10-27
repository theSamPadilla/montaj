// render/test/carousel-custom-font.test.mjs
//
// §587 r3: a font file of the person's own (an overlay element's `fontFiles`)
// draws in the carousel export. Three slides set the same text in the same
// family name: one names the file relative to the project dir, one by its
// absolute path, one names no file and so draws the fallback face. The PNGs
// are decoded and the ink compared. The face is the Bebas Neue fixture (SIL
// OFL 1.1, fixtures/fonts/README.md) under a family name no system has.
// Launches the real headless browser through render-carousel.js (~10-20 s).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'render-carousel.js')
const TEXT_TPL = resolve(__dirname, '..', 'templates', 'overlays', 'static-text', 'static-text.jsx')
const FACE = resolve(__dirname, 'fixtures', 'fonts', 'bebas-neue-400-latin.woff2')
const FAMILY = 'Montaj Own Face Test'

/** The dark pixels of an 8-bit RGB(A) PNG, and a fingerprint of where they are. */
function ink(buf) {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bpp = buf[25] === 6 ? 4 : 3
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
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + i] = v & 0xff
    }
  }
  let dark = 0
  let minX = width, maxX = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (out[y * stride + x * bpp] < 128) {
        dark++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  return { dark, inkWidth: maxX - minX + 1 }
}

function textSlide(id, fontFiles) {
  return {
    id,
    base_color: '#ffffff',
    elements: [{
      id: `${id}-t`, type: 'overlay', x: 40, y: 380, w: 1000, h: 320, rotation: 0, frame: 0,
      overlay: { template: TEXT_TPL, props: { text: 'MONTAGE', fontFamily: `"${FAMILY}", serif`, fontSize: '200', color: '#000000', textAlign: 'left' } },
      ...(fontFiles ? { fontFiles } : {}),
    }],
  }
}

test('an element’s own font file draws in the carousel export, by a relative or an absolute path', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-own-font-'))
  try {
    copyFileSync(FACE, join(dir, 'own-face.woff2'))
    const project = {
      projectType: 'carousel',
      settings: { resolution: [1080, 1080] },
      carousel: { aspect: 'square' },
      slides: [
        textSlide('relative', [{ family: FAMILY, src: 'own-face.woff2' }]),
        textSlide('absolute', [{ family: FAMILY, src: FACE }]),
        textSlide('fallback'),
      ],
    }
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const [rel, abs, fallback] = ['01', '02', '03'].map((n) => ink(readFileSync(join(dir, 'render', `slide_${n}.png`))))
    assert.ok(fallback.dark > 0 && rel.dark > 0, 'text drew')
    // Bebas Neue is a condensed caps face: the word is far narrower than in the fallback serif.
    assert.ok(rel.inkWidth < fallback.inkWidth * 0.85, `own face width ${rel.inkWidth} vs fallback ${fallback.inkWidth}`)
    assert.deepEqual(abs, rel, 'the absolute path draws the same face')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

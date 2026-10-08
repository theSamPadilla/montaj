// render/test/carousel-pdf.test.mjs
//
// carousel-pdf.js: PNG buffers -> one PDF, one page per PNG. PNGs are built in
// the test with zlib; the PDF is read back with a small tokenizer that only
// knows what pngsToPdf writes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { pngsToPdf } from '../carousel-pdf.js'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// channels per colour type
const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Deterministic raw pixels, h rows of w*ch bytes. */
function rawPixels(w, h, ch, seed = 1) {
  const raw = Buffer.alloc(w * h * ch)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + seed * 17 + (i >> 3)) & 0xff
  return raw
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Apply filter `ft` to row `cur` given previous row `prev`, bpp bytes per pixel. */
function filterRow(ft, cur, prev, bpp) {
  const out = Buffer.alloc(cur.length)
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0
    const b = prev[i]
    const c = i >= bpp ? prev[i - bpp] : 0
    const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c)
    out[i] = (cur[i] - pred) & 0xff
  }
  return out
}

/** Build a PNG; row y uses filter y % 5. Returns { png, raw, idat }. */
function makePng(w, h, colorType, { bitDepth = 8, interlace = 0, split = 1, seed = 1 } = {}) {
  const ch = CH[colorType]
  const raw = rawPixels(w, h, ch, seed)
  const stride = w * ch
  const rows = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride)
    const ft = y % 5
    rows.push(Buffer.concat([Buffer.from([ft]), filterRow(ft, cur, prev, ch)]))
    prev = cur
  }
  const z = deflateSync(Buffer.concat(rows))
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace
  const cut = Math.max(1, Math.floor(z.length / split))
  const idats = []
  for (let o = 0; o < z.length; o += cut) idats.push(chunk('IDAT', z.subarray(o, o + cut)))
  const png = Buffer.concat([SIG, chunk('IHDR', ihdr), ...idats, chunk('IEND', Buffer.alloc(0))])
  return { png, raw, idat: z }
}

// ---- PDF reading -----------------------------------------------------------

function parsePdf(pdf) {
  const text = pdf.toString('latin1')
  assert.ok(text.startsWith('%PDF-1.4\n'), 'header')
  const sx = text.lastIndexOf('startxref')
  const xrefAt = Number(text.slice(sx + 9).trim().split('\n')[0])
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref')
  const lines = text.slice(xrefAt).split('\n')
  const [first, count] = lines[1].split(' ').map(Number)
  assert.equal(first, 0)
  const offsets = []
  for (let n = 0; n < count; n++) {
    const line = lines[2 + n]
    assert.equal(line.length, 19, 'xref entries are 20 bytes with the newline')
    offsets.push({ off: Number(line.slice(0, 10)), kind: line[17] })
  }
  const objs = new Map()
  for (let n = 1; n < count; n++) {
    const { off } = offsets[n]
    assert.ok(text.startsWith(`${n} 0 obj`, off), `xref offset of object ${n}`)
    const end = text.indexOf('endobj', off)
    let dict = text.slice(off, end)
    let stream = null
    const s = dict.indexOf('stream\n')
    if (s >= 0) {
      const len = Number(/\/Length (\d+)/.exec(dict)[1])
      stream = pdf.subarray(off + s + 7, off + s + 7 + len)
      assert.equal(text.slice(off + s + 7 + len, off + s + 7 + len + 10), '\nendstream')
      dict = dict.slice(0, s)
    }
    objs.set(n, { dict, stream })
  }
  const sizeAt = text.indexOf('/Size ', text.lastIndexOf('trailer'))
  assert.equal(Number(/\/Size (\d+)/.exec(text.slice(sizeAt))[1]), count, 'trailer /Size equals the xref entry count')
  const pages = [...objs.values()].filter(o => /\/Type \/Page\b(?!s)/.test(o.dict))
  const kids = /\/Kids \[([^\]]*)\]/.exec(text)[1].trim().split(/\s+R\s*/).filter(Boolean)
  assert.equal(kids.length, Number(/\/Count (\d+)/.exec(text)[1]), '/Kids length equals /Count')
  return { text, objs, pages }
}

function pageImage(parsed, page, key = '/Im0') {
  const ref = new RegExp(`${key} (\\d+) 0 R`).exec(page.dict)
  return parsed.objs.get(Number(ref[1]))
}

function idatOf(png) {
  const parts = []
  let p = 8
  while (p < png.length) {
    const len = png.readUInt32BE(p)
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  return Buffer.concat(parts)
}

// ---- tests -----------------------------------------------------------------

test('RGB: one page per PNG, MediaBox is the design size, IDAT passes through', () => {
  const a = makePng(20, 12, 2, { split: 3, seed: 1 })
  const b = makePng(20, 12, 2, { seed: 2 })
  const parsed = parsePdf(pngsToPdf([a.png, b.png], { pageWidth: 10, pageHeight: 6 }))
  assert.equal(parsed.pages.length, 2)
  for (const page of parsed.pages) assert.match(page.dict, /\/MediaBox \[0 0 10 6\]/)
  const imgA = pageImage(parsed, parsed.pages[0])
  const imgB = pageImage(parsed, parsed.pages[1])
  assert.ok(imgA.stream.equals(idatOf(a.png)), 'page 1 stream is the concatenated IDAT')
  assert.ok(imgB.stream.equals(idatOf(b.png)), 'page 2 stream is the IDAT')
  assert.match(imgA.dict, /\/Width 20/)
  assert.match(imgA.dict, /\/Height 12/)
  assert.match(imgA.dict, /\/ColorSpace \/DeviceRGB/)
  assert.match(imgA.dict, /\/Filter \/FlateDecode/)
  assert.match(imgA.dict, /\/Predictor 15/)
  assert.match(imgA.dict, /\/Colors 3/)
  assert.match(imgA.dict, /\/Columns 20/)
  // and the pass-through really decodes to the PNG's rows
  assert.equal(inflateSync(imgA.stream).length, 12 * (1 + 20 * 3))
})

test('RGBA: colour and alpha planes are unfiltered into image + SMask', () => {
  const { png, raw } = makePng(9, 11, 6) // rows use filters 0..4
  const parsed = parsePdf(pngsToPdf([png], { pageWidth: 9, pageHeight: 11 }))
  const img = pageImage(parsed, parsed.pages[0])
  assert.match(img.dict, /\/ColorSpace \/DeviceRGB/)
  assert.doesNotMatch(img.dict, /Predictor/)
  const sm = parsed.objs.get(Number(/\/SMask (\d+) 0 R/.exec(img.dict)[1]))
  assert.match(sm.dict, /\/ColorSpace \/DeviceGray/)
  const rgb = Buffer.alloc(9 * 11 * 3), alpha = Buffer.alloc(9 * 11)
  for (let i = 0; i < 9 * 11; i++) {
    raw.copy(rgb, i * 3, i * 4, i * 4 + 3)
    alpha[i] = raw[i * 4 + 3]
  }
  assert.ok(inflateSync(img.stream).equals(rgb))
  assert.ok(inflateSync(sm.stream).equals(alpha))
})

test('grey and grey+alpha are supported', () => {
  const g = makePng(7, 6, 0)
  const ga = makePng(7, 6, 4)
  const parsed = parsePdf(pngsToPdf([g.png, ga.png], { pageWidth: 7, pageHeight: 6 }))
  const imgG = pageImage(parsed, parsed.pages[0])
  assert.match(imgG.dict, /\/ColorSpace \/DeviceGray/)
  assert.ok(inflateSync(imgG.stream).equals(g.raw))
  const imgGA = pageImage(parsed, parsed.pages[1])
  const sm = parsed.objs.get(Number(/\/SMask (\d+) 0 R/.exec(imgGA.dict)[1]))
  const grey = Buffer.alloc(42), alpha = Buffer.alloc(42)
  for (let i = 0; i < 42; i++) { grey[i] = ga.raw[i * 2]; alpha[i] = ga.raw[i * 2 + 1] }
  assert.ok(inflateSync(imgGA.stream).equals(grey))
  assert.ok(inflateSync(sm.stream).equals(alpha))
})

test('the content stream draws the image to fill the page', () => {
  const parsed = parsePdf(pngsToPdf([makePng(4, 4, 2).png], { pageWidth: 1080, pageHeight: 1350 }))
  assert.match(parsed.text, /1080 0 0 1350 0 0 cm/)
  assert.match(parsed.text, /\/Im0 Do/)
})

test('a bad signature, 16-bit, palette or interlaced PNG throws naming the slide', () => {
  const ok = makePng(4, 4, 2).png
  const bad = Buffer.from(ok); bad[1] = 0
  assert.throws(() => pngsToPdf([ok, bad], { pageWidth: 1, pageHeight: 1 }), /slide 2.*signature/i)
  assert.throws(() => pngsToPdf([makePng(4, 4, 2, { bitDepth: 16 }).png], { pageWidth: 1, pageHeight: 1 }), /slide 1.*16/)
  assert.throws(() => pngsToPdf([makePng(4, 4, 2, { interlace: 1 }).png], { pageWidth: 1, pageHeight: 1 }), /slide 1.*interlace/i)
  const pal = makePng(4, 4, 2)
  const palPng = Buffer.from(pal.png); palPng[8 + 8 + 9] = 3 // colour type byte in IHDR
  assert.throws(() => pngsToPdf([palPng], { pageWidth: 1, pageHeight: 1 }), /slide 1.*colou?r type 3/i)
})

test('a truncated chunk throws instead of reading out of bounds', () => {
  const ok = makePng(4, 4, 2).png
  assert.throws(() => pngsToPdf([ok.subarray(0, ok.length - 20)], { pageWidth: 1, pageHeight: 1 }), /slide 1/)
})

test('zero PNGs throws instead of writing a 0-page PDF', () => {
  assert.throws(() => pngsToPdf([], { pageWidth: 1, pageHeight: 1 }), /no slides/)
})

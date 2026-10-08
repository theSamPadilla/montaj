/**
 * carousel-pdf.js — PNG buffers to one PDF, one page per PNG.
 *
 * Each page is the slide PNG itself, drawn to fill the page, so the PDF shows
 * exactly the pixels the PNG export holds. The page size is given in points
 * (the slide's design size) while the image keeps its full raster.
 *
 * 8-bit RGB, non-interlaced PNGs (what the renderer's screenshots are) pass
 * through untouched: the IDAT data is the image stream, decoded by PDF's own
 * PNG predictors. 8-bit RGBA, grey and grey+alpha are unfiltered and
 * re-deflated, with any alpha split into an /SMask. Palette, 16-bit and
 * interlaced PNGs throw.
 *
 * Pure: Node built-ins only, no browser.
 */
import { inflateSync, deflateSync } from 'zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS  = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** Parse a PNG into { width, height, colorType, idat } or throw naming the slide. */
function readPng(png, n) {
  const bad = (why) => new Error(`slide ${n}: ${why}`)
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw bad('not a PNG (bad signature)')
  }
  let ihdr = null
  let ended = false
  const idat = []
  let p = 8
  while (p < png.length && !ended) {
    if (p + 12 > png.length) throw bad('truncated PNG chunk')
    const len = png.readUInt32BE(p)
    if (p + 12 + len > png.length) throw bad('PNG chunk runs past the end of the file')
    const type = png.toString('latin1', p + 4, p + 8)
    const data = png.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      if (len !== 13) throw bad('malformed IHDR')
      ihdr = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      ended = true
    }
    p += 12 + len
  }
  if (!ihdr) throw bad('PNG has no IHDR')
  if (!idat.length) throw bad('PNG has no image data')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  if (ihdr[12] !== 0) throw bad('interlaced PNGs are not supported')
  if (!(colorType in CHANNELS)) throw bad(`PNG colour type ${colorType} is not supported`)
  if (bitDepth !== 8) throw bad(`${bitDepth}-bit PNGs are not supported`)
  return { width, height, colorType, idat: Buffer.concat(idat) }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Undo the PNG row filters; returns height * stride raw bytes. */
function unfilter(data, stride, height, bpp, n) {
  if (data.length < height * (stride + 1)) throw new Error(`slide ${n}: PNG image data is too short`)
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const ft = data[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[row + i - bpp] : 0
      const b = y > 0 ? out[row - stride + i] : 0
      const c = y > 0 && i >= bpp ? out[row - stride + i - bpp] : 0
      let pred
      switch (ft) {
        case 0: pred = 0; break
        case 1: pred = a; break
        case 2: pred = b; break
        case 3: pred = (a + b) >> 1; break
        case 4: pred = paeth(a, b, c); break
        default: throw new Error(`slide ${n}: unknown PNG row filter ${ft}`)
      }
      out[row + i] = (data[src + i] + pred) & 0xff
    }
  }
  return out
}

/** One image XObject's dictionary entries and stream, from a parsed PNG. */
function imageParts(png, n) {
  const { width, height, colorType, idat } = png
  if (colorType === 2) {
    return {
      dict: `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode `
        + `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${width} >>`,
      stream: idat,
      smask: null,
    }
  }
  const ch = CHANNELS[colorType]
  const raw = unfilter(inflateSync(idat), width * ch, height, ch, n)
  const hasAlpha = colorType === 4 || colorType === 6
  const colorCh = hasAlpha ? ch - 1 : ch
  let color = raw, alpha = null
  if (hasAlpha) {
    color = Buffer.alloc(width * height * colorCh)
    alpha = Buffer.alloc(width * height)
    for (let i = 0; i < width * height; i++) {
      raw.copy(color, i * colorCh, i * ch, i * ch + colorCh)
      alpha[i] = raw[i * ch + colorCh]
    }
  }
  const space = colorCh === 3 ? 'DeviceRGB' : 'DeviceGray'
  return {
    dict: `/ColorSpace /${space} /BitsPerComponent 8 /Filter /FlateDecode`,
    stream: deflateSync(color),
    smask: alpha && deflateSync(alpha),
  }
}

/**
 * @param {Buffer[]} pngs
 * @param {{pageWidth: number, pageHeight: number}} size page size in points
 * @returns {Buffer} the PDF
 */
export function pngsToPdf(pngs, { pageWidth, pageHeight }) {
  if (!pngs.length) throw new Error('no slides to put in a PDF')
  const objects = [] // objects[i] is object i + 1: { head, stream? }
  const add = (head, stream) => objects.push({ head, stream }) // returns the object number
  const next = () => objects.length + 1

  // 1 = catalog, 2 = pages; their bodies are filled once the page numbers are known.
  add('')
  add('')
  const pageRefs = []

  pngs.forEach((buf, i) => {
    const n = i + 1
    const png = readPng(buf, n)
    const img = imageParts(png, n)
    const pageNo = next(), contentNo = pageNo + 1, imageNo = pageNo + 2, smaskNo = pageNo + 3
    pageRefs.push(`${pageNo} 0 R`)
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] `
      + `/Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>`)
    add('<< ', Buffer.from(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`))
    add(`<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} ${img.dict}`
      + `${img.smask ? ` /SMask ${smaskNo} 0 R` : ''} `, img.stream)
    if (img.smask) {
      add(`<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} `
        + '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ', img.smask)
    }
  })

  objects[0].head = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1].head = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  let offset = parts[0].length
  const offsets = []
  const push = (b) => { parts.push(b); offset += b.length }
  objects.forEach(({ head, stream }, i) => {
    offsets.push(offset)
    if (stream) {
      push(Buffer.from(`${i + 1} 0 obj\n${head}/Length ${stream.length} >>\nstream\n`, 'latin1'))
      push(stream)
      push(Buffer.from('\nendstream\nendobj\n'))
    } else {
      push(Buffer.from(`${i + 1} 0 obj\n${head}\nendobj\n`, 'latin1'))
    }
  })
  const xrefAt = offset
  const entries = offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    'latin1',
  ))
  return Buffer.concat(parts)
}

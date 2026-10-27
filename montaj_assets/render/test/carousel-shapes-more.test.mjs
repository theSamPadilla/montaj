// render/test/carousel-shapes-more.test.mjs
//
// §587 round 2, F-I: the fuller set of shipped shapes draws in the export. One
// slide holds a heart, two rings of different thickness, a speech bubble, a
// curved arrow, a blob, a dot-ended and a bar-ended line, a hexagon with a
// dotted stroke and a checkmark; the PNG is decoded and sampled where each
// must (and must not) paint. Launches the real headless browser through
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
const TEMPLATES = process.env.SHAPES_TEMPLATES_DIR || resolve(__dirname, '..', 'templates', 'overlays')
const tpl = (name) => join(TEMPLATES, name, `${name}.jsx`)

/** An 8-bit, non-interlaced RGB or RGBA PNG as { width, height, px(x, y) -> [r, g, b] }. */
function decodePng(buf) {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colourType = buf[25]
  assert.equal(depth, 8, 'bit depth')
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

const near = (got, want, tol = 24) => got.every((v, i) => Math.abs(v - want[i]) <= tol)
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
const GREEN = [0, 170, 0]
const BLACK = [0, 0, 0]
const WHITE = [255, 255, 255]

// [template, box w, box h, inside point, outside point], each point in slide px.
const REST = [
  ['arrow-chevron', 240, 240, [220, 150], [60, 150]],
  ['arrow-double', 240, 120, [410, 90], [410, 40]],
  ['callout-box', 240, 160, [670, 90], [560, 185]],
  ['callout-speech-rect', 240, 192, [930, 100], [1030, 215]],
  ['callout-thought', 240, 192, [150, 360], [250, 470]],
  ['shape-diamond', 240, 240, [410, 410], [300, 300]],
  ['shape-octagon', 240, 240, [670, 410], [555, 295]],
  ['shape-pill', 240, 120, [930, 350], [815, 295]],
  ['shape-plus', 240, 240, [150, 670], [40, 560]],
  ['shape-cross', 240, 240, [410, 600], [300, 560]],
  ['shape-x', 240, 240, [670, 670], [670, 570]],
  ['shape-semicircle', 240, 120, [930, 640], [820, 560]],
  ['shape-blob-2', 240, 240, [150, 930], [35, 815]],
  ['shape-blob-3', 240, 240, [410, 930], [295, 815]],
  ['shape-blob-4', 240, 240, [670, 930], [555, 815]],
]

test('the new shapes, arrows, lines and callouts draw in the carousel export', { timeout: 120_000 }, () => {
  const el = (id, template, x, y, w, h, props) => ({ id, type: 'overlay', x, y, w, h, rotation: 0, frame: 59, overlay: { template: tpl(template), props } })
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [{
      id: 'more',
      base_color: '#ffffff',
      elements: [
        el('heart', 'shape-heart', 30, 30, 300, 300, { fill: '#ff0000', strokeWidth: 0 }),
        el('ring-thin', 'shape-ring', 390, 30, 300, 300, { fill: '#0000ff', strokeWidth: 0, thickness: 20 }),
        el('ring-thick', 'shape-ring', 750, 30, 300, 300, { fill: '#0000ff', strokeWidth: 0, thickness: 60 }),
        el('bubble', 'callout-speech-round', 30, 390, 300, 300, { fill: '#00aa00', strokeWidth: 0, tail: 'left' }),
        el('curved', 'arrow-curved', 390, 390, 300, 188, { fill: '#ff0000', strokeWidth: 0 }),
        el('blob', 'shape-blob-1', 750, 390, 300, 300, { fill: '#0000ff', strokeWidth: 0 }),
        el('dots', 'line-dot-ends', 30, 750, 300, 60, { stroke: '#000000', strokeWidth: 8, cap: 'dot', arrowhead: 'none' }),
        el('bars', 'line-bar-ends', 30, 870, 300, 60, { stroke: '#000000', strokeWidth: 8, cap: 'bar', arrowhead: 'none' }),
        el('hex', 'shape-hexagon', 390, 750, 300, 300, { fill: '#ffffff', stroke: '#000000', strokeWidth: 12, strokeStyle: 'dotted' }),
        el('check', 'shape-check', 750, 750, 300, 300, { fill: '#00aa00', strokeWidth: 0 }),
      ],
    }, {
      // The rest of the set, in a 4-wide grid of 240 px cells every 260 px (the second
      // slide: one inside and one outside point each, in the order below).
      id: 'rest',
      base_color: '#ffffff',
      elements: REST.map(([name, w, h], i) => el(name, name, 30 + (i % 4) * 260, 30 + Math.floor(i / 4) * 260, w, h, { fill: '#ff0000', strokeWidth: 0 })),
    }],
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-shapes-more-'))
  try {
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const png = decodePng(readFileSync(join(dir, 'render', 'slide_01.png')))
    if (process.env.SHAPES_KEEP_PNG) writeFileSync(process.env.SHAPES_KEEP_PNG, readFileSync(join(dir, 'render', 'slide_01.png')))
    const at = (x, y, want, what) => assert.ok(near(png.px(x, y), want), `${what} at ${x},${y}: got ${png.px(x, y)}, want ${want}`)

    // Heart: filled in the middle and in each lobe, the notch between the
    // lobes and the box's bottom corners empty.
    at(180, 180, RED, 'heart middle')
    at(105, 90, RED, 'heart left lobe')
    at(255, 90, RED, 'heart right lobe')
    at(180, 315, RED, 'heart, just above its tip')
    at(180, 60, WHITE, 'heart notch')
    at(36, 324, WHITE, 'heart box, bottom left')
    at(324, 324, WHITE, 'heart box, bottom right')

    // Rings, radius 150: thickness 20 is a 30 px band, 60 a 90 px band; the
    // middle is empty in both.
    at(540, 40, BLUE, 'thin ring band')
    at(540, 100, WHITE, 'inside the thin ring')
    at(540, 180, WHITE, 'thin ring middle')
    at(900, 40, BLUE, 'thick ring band')
    at(900, 100, BLUE, 'thick ring band, 80 px from the middle')
    at(900, 180, WHITE, 'thick ring middle')

    // Speech bubble: a round body over its tail at the bottom left.
    at(180, 510, GREEN, 'bubble body')
    at(92, 640, GREEN, 'bubble tail')
    at(320, 680, WHITE, 'bubble box, bottom right')
    at(250, 670, WHITE, 'under the bubble, right of its tail')

    // Curved arrow: a band over the top, empty under it.
    at(530, 408, RED, 'curved arrow, top of its band')
    at(408, 525, RED, 'curved arrow, its tail end')
    at(530, 500, WHITE, 'under the curved arrow')

    // Blob: filled in its middle, not in the box's corners.
    at(900, 540, BLUE, 'blob middle')
    at(755, 395, WHITE, 'blob box corner')

    // A dot-ended line: a dot wider than the 8 px line at each end.
    at(180, 780, BLACK, 'dot line')
    at(42, 770, BLACK, 'start dot, above the line')
    at(318, 770, BLACK, 'end dot, above the line')
    at(180, 770, WHITE, 'above the dot line')
    // A bar-ended line: a bar across each end.
    at(180, 900, BLACK, 'bar line')
    at(34, 888, BLACK, 'start bar, above the line')
    at(326, 888, BLACK, 'end bar, above the line')
    at(180, 888, WHITE, 'above the bar line')

    // Hexagon with a dotted 12 px stroke: round dots every 24 px along its top edge.
    at(492, 756, BLACK, 'hexagon, a dot')
    at(480, 756, WHITE, 'hexagon, between dots')
    at(516, 756, BLACK, 'hexagon, the next dot')
    at(504, 756, WHITE, 'hexagon, the next gap')
    at(540, 900, WHITE, 'hexagon middle (white fill)')

    // Checkmark: filled at its bend, empty above it and in the top left.
    at(862, 1000, GREEN, 'checkmark bend')
    at(900, 800, WHITE, 'checkmark, inside its V')
    at(756, 756, WHITE, 'checkmark box, top left')

    // The rest of the set: each template paints inside its outline and not outside it.
    const rest = decodePng(readFileSync(join(dir, 'render', 'slide_02.png')))
    for (const [name, , , inside, outside] of REST) {
      assert.ok(near(rest.px(...inside), RED), `${name}: inside at ${inside}, got ${rest.px(...inside)}`)
      assert.ok(near(rest.px(...outside), WHITE), `${name}: outside at ${outside}, got ${rest.px(...outside)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

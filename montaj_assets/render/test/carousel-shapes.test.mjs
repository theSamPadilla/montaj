// render/test/carousel-shapes.test.mjs
//
// §587: the shipped shape, line and frame overlays draw in the export. One
// slide holds a stroked rectangle, an ellipse and a dashed line; the PNG is
// decoded and sampled where each must (and must not) paint. Launches the real
// headless browser through render-carousel.js, so it takes ~10-20 s.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

test('numeric props of the shipped shapes, lines and frames are int, with a number default (the editor steps them)', () => {
  const NUMERIC = new Set(['strokeWidth', 'headLength', 'shaftWidth', 'points', 'cornerRadius', 'innerRadius', 'dash', 'gap', 'cornerLength', 'thickness'])
  let seen = 0
  for (const dir of readdirSync(TEMPLATES)) {
    if (!/^(shape|frame|arrow|callout)-/.test(dir) && !/^line-(arrow|dashed|straight|dot-ends|bar-ends)$/.test(dir)) continue
    const sidecar = JSON.parse(readFileSync(join(TEMPLATES, dir, `${dir}.json`), 'utf8'))
    for (const p of sidecar.props) {
      if (!NUMERIC.has(p.name)) continue
      seen++
      assert.equal(p.type, 'int', `${dir}.${p.name}`)
      assert.equal(typeof p.default, 'number', `${dir}.${p.name} default`)
    }
  }
  assert.ok(seen >= 55, `only ${seen} numeric props found`)
})

test('the shape, ellipse and dashed line templates draw in the carousel export', { timeout: 120_000 }, () => {
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [{
      id: 'shapes',
      base_color: '#ffffff',
      elements: [
        { id: 'rect', type: 'overlay', x: 100, y: 100, w: 300, h: 300, rotation: 0, frame: 59,
          overlay: { template: tpl('shape-rect'), props: { fill: '#ff0000', stroke: '#000000', strokeWidth: '20' } } },
        { id: 'ellipse', type: 'overlay', x: 600, y: 100, w: 300, h: 300, rotation: 0, frame: 59,
          overlay: { template: tpl('shape-ellipse'), props: { fill: '#0000ff', stroke: '#111111', strokeWidth: 0 } } },
        { id: 'line', type: 'overlay', x: 100, y: 700, w: 880, h: 54, rotation: 0, frame: 59,
          overlay: { template: tpl('line-dashed'), props: { stroke: '#00aa00', strokeWidth: 8, dash: 24, gap: 16, arrowhead: 'none' } } },
      ],
    }],
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-shapes-'))
  try {
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const png = decodePng(readFileSync(join(dir, 'render', 'slide_01.png')))
    assert.equal(png.width, 1080)
    const at = (x, y, want, what) => assert.ok(near(png.px(x, y), want), `${what} at ${x},${y}: got ${png.px(x, y)}, want ${want}`)

    // Rectangle: a 20 px stroke drawn inside the box, the fill inside that.
    at(110, 250, BLACK, 'rect stroke')
    at(250, 110, BLACK, 'rect stroke')
    at(130, 250, RED, 'rect fill')
    at(250, 250, RED, 'rect fill')
    at(90, 250, WHITE, 'outside the rect')

    // Ellipse: filled at the centre, not in the box's corners.
    at(750, 250, BLUE, 'ellipse fill')
    at(610, 110, WHITE, 'ellipse box corner')
    at(890, 390, WHITE, 'ellipse box corner')

    // Dashed line, at mid height: dashes of 24 px, gaps of 16 px from the box's left.
    const y = 727
    at(112, y, GREEN, 'first dash')
    at(132, y, WHITE, 'first gap')
    at(152, y, GREEN, 'second dash')
    at(112, 700 + 10, WHITE, 'above the 8 px line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stroke styles, round ends and joins, and a start arrowhead draw in the carousel export', { timeout: 120_000 }, () => {
  const el = (id, template, x, y, w, h, props) => ({ id, type: 'overlay', x, y, w, h, rotation: 0, frame: 59, overlay: { template: tpl(template), props } })
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [{
      id: 'strokes',
      base_color: '#ffffff',
      elements: [
        el('dotted', 'line-straight', 100, 100, 800, 40, { stroke: '#000000', strokeWidth: 10, arrowhead: 'none', strokeStyle: 'dotted' }),
        el('long', 'line-straight', 100, 200, 800, 40, { stroke: '#000000', strokeWidth: 10, arrowhead: 'none', strokeStyle: 'long-dash' }),
        el('round', 'line-straight', 100, 300, 800, 40, { stroke: '#000000', strokeWidth: 20, arrowhead: 'none', roundCaps: 'true' }),
        el('butt', 'line-straight', 100, 360, 800, 40, { stroke: '#000000', strokeWidth: 20, arrowhead: 'none', roundCaps: false }),
        el('head', 'line-arrow', 100, 400, 800, 60, { stroke: '#000000', strokeWidth: 8, arrowhead: 'start' }),
        el('rect-dash', 'shape-rect', 100, 600, 300, 300, { fill: '#ffffff', stroke: '#000000', strokeWidth: 10, strokeStyle: 'long-dash' }),
        el('rect-round', 'shape-rect', 600, 600, 300, 300, { fill: '#ffffff', stroke: '#000000', strokeWidth: 20, roundJoins: 'true' }),
      ],
    }],
  }
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-strokes-'))
  try {
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const r = spawnSync('node', [SCRIPT, '--project-json', join(dir, 'project.json'), '--out', join(dir, 'render'), '--scale', '1'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, r.stderr)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [])
    const png = decodePng(readFileSync(join(dir, 'render', 'slide_01.png')))
    const at = (x, y, want, what) => assert.ok(near(png.px(x, y), want), `${what} at ${x},${y}: got ${png.px(x, y)}, want ${want}`)

    // Dotted, 10 px: round dots 10 px across every 20 px, the first one inside the box.
    at(105, 120, BLACK, 'first dot')
    at(115, 120, WHITE, 'gap after the first dot')
    at(125, 120, BLACK, 'second dot')
    at(98, 120, WHITE, 'before the box')
    // Long dash, 10 px: dashes of 30 px, gaps of 20 px.
    at(115, 220, BLACK, 'first long dash')
    at(145, 220, WHITE, 'first long gap')
    at(165, 220, BLACK, 'second long dash')
    // Round end points: the end is a half disc inside the box, its corner empty; a butt end fills it.
    at(101, 320, BLACK, 'round end, middle')
    at(102, 312, WHITE, 'round end, corner')
    at(898, 312, WHITE, 'round end, other corner')
    at(102, 372, BLACK, 'butt end, corner')
    // A start arrowhead: wider than the 8 px line, near the start.
    at(112, 425, BLACK, 'start arrowhead')
    at(888, 425, WHITE, 'no end arrowhead')
    // A rectangle with a long-dash stroke: gaps along its edge.
    at(120, 605, BLACK, 'rect dash')
    at(145, 605, WHITE, 'rect dash gap')
    at(170, 605, BLACK, 'rect second dash')
    // Rounded corners on a 20 px stroke: the box's corner pixel is empty, the edge is not.
    at(602, 602, WHITE, 'round join corner')
    at(750, 605, BLACK, 'round join edge')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

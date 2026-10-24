// montaj_assets/render/test/slide-crop.test.mjs
//
// §562: a cropped image on a slide shows the region that was picked, on a box of
// any shape. The oversized image is placed by a translate, whose percentages are
// of the image's own size. It used to be placed by percentage margins, and a
// percentage margin-top resolves against the containing block's WIDTH, so on a
// box that is not square any crop with a top offset showed another region.
//
// Harness: esbuild with jsx 'automatic' as synced-chart.test.mjs loads a
// template; react-dom/server for markup. No browser.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(__dirname, '..', 'templates', 'slide.jsx')

let Slide
before(async () => {
  const result = await esbuild.build({
    entryPoints: [TEMPLATE],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    write: false,
    logLevel: 'silent',
  })
  const tmpPath = join(__dirname, '__tmp-slide-crop.mjs')
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    ;({ Slide } = await import(pathToFileURL(tmpPath).href))
  } finally {
    unlinkSync(tmpPath)
  }
})

const image = (over) => ({ id: 'img', type: 'image', src: 'a.png', x: 0, y: 0, w: 400, h: 200, rotation: 0, ...over })

/** The one slide's markup, with `element` on it. */
function markup(element) {
  return renderToStaticMarkup(React.createElement(Slide, {
    slide: { id: 's', base_color: '#000000', elements: [element] },
    width: 1080,
    height: 1350,
    overlayRegistry: {},
    resolveAsset: (p) => p,
  }))
}

/** The <img>'s style declarations, by property. */
function imgStyle(html) {
  const m = html.match(/<img[^>]*style="([^"]*)"/)
  assert.ok(m, html)
  return Object.fromEntries(m[1].split(';').filter(Boolean).map((d) => {
    const at = d.indexOf(':')
    return [d.slice(0, at), d.slice(at + 1)]
  }))
}

const pct = (v) => {
  assert.match(v, /^-?[\d.]+%$/, `not a percentage: ${v}`)
  return parseFloat(v) / 100
}

/**
 * The region of the source the box shows, in fractions of the source, worked
 * out the way CSS lays the image out: its width and height are percentages of
 * the box, a margin percentage is one of the box's WIDTH (either side), and a
 * translate percentage is one of the image's own size.
 */
function regionShown(style, box) {
  const imgW = pct(style.width) * box.w
  const imgH = pct(style.height) * box.h
  let left = 0
  let top = 0
  if (style['margin-left']) left += pct(style['margin-left']) * box.w
  if (style['margin-top']) top += pct(style['margin-top']) * box.w
  const t = /translate\(([^,]+),\s*([^)]+)\)/.exec(style.transform ?? '')
  if (t) {
    left += pct(t[1]) * imgW
    top += pct(t[2]) * imgH
  }
  return { x: -left / imgW, y: -top / imgH, w: box.w / imgW, h: box.h / imgH }
}

function assertRegion(actual, expected) {
  for (const k of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `${k}: ${actual[k]} != ${expected[k]}`)
  }
}

describe('slide.jsx: a cropped image shows the region picked (§562)', () => {
  test('a top offset on a 400 x 200 box: the image moves up a quarter of its own height, with no margins', () => {
    const style = imgStyle(markup(image({ crop: { x: 0, y: 0.25, w: 1, h: 0.5 } })))
    assert.equal(style.transform, 'translate(0%, -25%)')
    assert.equal(style['margin-top'], undefined)
    assert.equal(style['margin-left'], undefined)
    assert.equal(style.width, '100%')
    assert.equal(style.height, '200%')
    assert.equal(style['object-fit'], 'cover')
    assert.equal(style.display, 'block')
    assertRegion(regionShown(style, { w: 400, h: 200 }), { x: 0, y: 0.25, w: 1, h: 0.5 })
  })

  test('both offsets, on a tall box: each a share of the image\'s own size', () => {
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.3 }
    const style = imgStyle(markup(image({ w: 300, h: 500, crop })))
    assert.equal(style.transform, 'translate(-25%, -10%)')
    assert.equal(style['margin-top'], undefined)
    assertRegion(regionShown(style, { w: 300, h: 500 }), crop)
  })

  test('the crop wrapper keeps the box, its rotation and the clip', () => {
    const html = markup(image({ x: 10, y: 20, rotation: 15, crop: { x: 0, y: 0.25, w: 1, h: 0.5 } }))
    assert.match(html, /<div style="position:absolute;left:10px;top:20px;width:400px;height:200px;transform:rotate\(15deg\);transform-origin:center center;overflow:hidden">/)
  })

  test('an image with no crop is unchanged: contain, no translate', () => {
    const style = imgStyle(markup(image({})))
    assert.equal(style['object-fit'], 'contain')
    assert.equal(style.transform, 'rotate(0deg)')
  })
})

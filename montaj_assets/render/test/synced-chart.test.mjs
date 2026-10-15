// montaj_assets/render/test/synced-chart.test.mjs
//
// §257: the synced-chart system overlay, a line chart that draws itself in
// time with the video (templates/overlays/synced-chart/synced-chart.jsx).
//
//   1. Time: nothing of the line before its first point, the partial segment's
//      end on the way to the next point, the whole line held after the last,
//      and a fractional frame (motion blur) between its neighbours.
//   2. The props cleaning: unsorted points, non-finite ones, one point, a flat
//      line, the 2000-point cap, `values` spread over the item's length, and
//      `series` (at most 3 lines, a legend).
//   3. Parity: the editor preview's path (bundleOverlayForPreview, the module
//      run inside the preview wrapper) and the export's (the component with
//      frame, fps, duration and the props spread on it) give the same markup.
//   4. One Chrome check through sample_overlay: the tip moves right frame by
//      frame (skipped when Chrome is not installed, like the other
//      integration tests).
//
// Harness: esbuild with jsx 'automatic' as captions-font.test.mjs loads a
// template; react-dom/server for markup.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeOverlayGlobals } from 'montaj-overlay-runtime'
import { bundleOverlayForPreview, PREVIEW_GLOBAL_NAME } from '../preview-bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER = join(__dirname, '..')
const TEMPLATE = join(RENDER, 'templates', 'overlays', 'synced-chart', 'synced-chart.jsx')
const FPS = 30

let Chart
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
  const tmpPath = join(__dirname, '__tmp-synced-chart.mjs')
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    Chart = (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
})

/** The export's call: the component with frame, fps and duration and the props spread on it. */
const draw = (frame, props, duration = 120) => Chart({ frame, fps: FPS, duration, ...props })

/** Every element in a tree, depth first. */
function walk(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  walk(node.props?.children, out)
  return out
}
const byKeyPrefix = (tree, prefix) => walk(tree).filter(n => typeof n.key === 'string' && n.key.startsWith(prefix))
const linePath = (tree, i = 0) => byKeyPrefix(tree, `line-${i}`)[0] ?? null
const tipOf = (tree, i = 0) => {
  const c = byKeyPrefix(tree, `tip-${i}`)[0]
  return c ? { x: c.props.cx, y: c.props.cy } : null
}
/** A path's points, from its "M x y L x y ..." d. */
const pathPoints = (el) => [...el.props.d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(m => ({ x: +m[1], y: +m[2] }))

// A run: rises from t = 1 s to 2 s, then dips to 3 s.
const RUN = { points: [[1, 0], [2, 1], [3, 0.5]], showValue: 'false' }

describe('time: the line draws with the video', () => {
  test('before the first point only the axes show', () => {
    const tree = draw(15, RUN) // 0.5 s
    assert.equal(linePath(tree), null)
    assert.equal(tipOf(tree), null)
    assert.ok(byKeyPrefix(tree, 'ytick-').length === 3, 'the y ticks are drawn')
  })

  test('mid-segment the tip is the point on the way to the next one', () => {
    const full = pathPoints(linePath(draw(200, RUN)))
    assert.equal(full.length, 3)
    const tip = tipOf(draw(45, RUN)) // 1.5 s: halfway from t=1 to t=2
    assert.ok(Math.abs(tip.x - (full[0].x + full[1].x) / 2) < 0.02, `tip x ${tip.x}`)
    assert.ok(Math.abs(tip.y - (full[0].y + full[1].y) / 2) < 0.02, `tip y ${tip.y}`)
    assert.equal(pathPoints(linePath(draw(45, RUN))).length, 2)
  })

  test('at the last point and after it, the whole line holds', () => {
    const at = renderToStaticMarkup(draw(90, RUN))
    assert.equal(renderToStaticMarkup(draw(91, RUN)), at)
    assert.equal(renderToStaticMarkup(draw(400, RUN)), at)
  })

  test('a fractional frame (motion blur) lies between its neighbours', () => {
    const a = tipOf(draw(44, RUN)).x
    const mid = tipOf(draw(44.5, RUN)).x
    const b = tipOf(draw(45, RUN)).x
    assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`)
  })

  test('the axes hold still while the line draws', () => {
    const ticks = (tree) => byKeyPrefix(tree, 'ytick-').map(g => renderToStaticMarkup(g))
    assert.deepEqual(ticks(draw(31, RUN)), ticks(draw(85, RUN)))
  })
})

describe('the props cleaning', () => {
  test('unsorted points draw as sorted; a non-finite point is dropped', () => {
    const sorted = renderToStaticMarkup(draw(200, RUN))
    assert.equal(renderToStaticMarkup(draw(200, { ...RUN, points: [[3, 0.5], [1, 0], [2, 1]] })), sorted)
    assert.equal(renderToStaticMarkup(draw(200, { ...RUN, points: [[3, 0.5], [1, 0], ['x', 4], [2, null], [2, 1]] })), sorted)
    assert.equal(renderToStaticMarkup(draw(200, { ...RUN, points: JSON.stringify(RUN.points) })), sorted, 'a JSON string is read too')
  })

  test('one point draws as a dot, with no line', () => {
    const tree = draw(60, { points: [[1, 5]] })
    assert.equal(linePath(tree), null)
    assert.ok(tipOf(tree))
  })

  test('a flat line gets a padded range', () => {
    const tree = draw(200, { points: [[0, 3], [2, 3]] })
    const ys = pathPoints(linePath(tree)).map(p => p.y)
    const ticks = byKeyPrefix(tree, 'ytick-').map(g => walk(g).find(n => n.type === 'line').props.y1)
    assert.ok(Math.min(...ticks) < ys[0] && ys[0] < Math.max(...ticks), 'the line sits inside the range')
  })

  test('a line keeps at most 2000 points', () => {
    const many = Array.from({ length: 2500 }, (_, i) => [i / 100, Math.sin(i)])
    assert.equal(pathPoints(linePath(draw(100000, { points: many }))).length, 2000)
  })

  test('values spread evenly over the item\'s length', () => {
    // 60 frames at 30 fps is 2 s: 0 at 0 s, 1 at 1 s, 2 at 2 s.
    const timed = { points: [[0, 0], [1, 1], [2, 2]], showValue: 'false' }
    const spread = { values: '0, 1, 2', showValue: 'false' }
    for (const f of [0, 15, 30, 45, 60]) {
      assert.equal(renderToStaticMarkup(draw(f, spread, 60)), renderToStaticMarkup(draw(f, timed, 60)), `frame ${f}`)
    }
  })

  test('series: up to three lines with their own colours, and a legend', () => {
    const series = [
      { name: 'run', color: '#ff0000', points: [[0, 0], [2, 1]] },
      { name: 'baseline', color: '#00ff00', values: [0, 0.5] },
      { name: 'third', points: [[0, 1], [2, 0]] },
      { name: 'fourth', points: [[0, 2], [2, 2]] },
    ]
    const tree = draw(30, { series })
    assert.ok(linePath(tree, 0) && linePath(tree, 1) && linePath(tree, 2))
    assert.equal(linePath(tree, 3), null, 'a fourth line is not drawn')
    assert.equal(linePath(tree, 0).props.stroke, '#ff0000')
    assert.equal(linePath(tree, 2).props.stroke, '#a3a3a3', 'a line without a colour takes the next default')
    assert.equal(byKeyPrefix(tree, 'legend-').length, 3)
    assert.equal(byKeyPrefix(draw(30, RUN), 'legend-').length, 0, 'one line has no legend')
  })
})

describe('parity: the editor preview and the export draw the same markup', () => {
  // A copy of the preview wrapper (desktop/ui/src/lib/overlay-eval.ts, as preview-bundle.test.mjs copies it): the
  // bundle's module body run with the preview globals, then the default export called with frame, fps and duration
  // merged over the props.
  const GLOBALS = makeOverlayGlobals('preview')
  const NAMES = Object.keys(GLOBALS).filter(n => !['React', 'frame', 'fps', 'duration', 'props'].includes(n))
  let factory
  before(async () => {
    const { code } = await bundleOverlayForPreview(TEMPLATE)
    // eslint-disable-next-line no-new-func
    const fn = new Function('React', 'frame', 'fps', 'duration', 'props', ...NAMES,
      `"use strict";\n${code}\nvar __Component = ${PREVIEW_GLOBAL_NAME}.default;\nreturn __Component({ frame, fps, duration, ...props });`)
    factory = (frame, duration, props) => fn(React, frame, FPS, duration, props, ...NAMES.map(n => GLOBALS[n]))
  })

  const CASES = [
    ['one timed line', { ...RUN, showValue: 'true', title: 'Reward', xLabel: 'Steps', yLabel: 'Score', xFrom: '0', xTo: '1000000' }],
    ['values on a card', { values: [0.1, 0.4, 0.35, 0.8], bgColor: '#101010', lineColor: '#00b4d8' }],
    ['three series', { series: [{ name: 'a', points: [[0, 0], [3, 2]] }, { name: 'b', values: [1, 1.5] }, { name: 'c', points: [[1, 2], [4, 0]] }] }],
  ]
  for (const [label, props] of CASES) {
    test(label, () => {
      for (const frame of [0, 37, 75.5, 140]) {
        const exported = renderToStaticMarkup(React.createElement(Chart, { frame, fps: FPS, duration: 120, ...props }))
        assert.equal(renderToStaticMarkup(factory(frame, 120, props)), exported, `frame ${frame}`)
      }
    })
  }
})

// Chrome, through the same sample_overlay path the AI's sample_frame takes: the line drawn in magenta on a
// transparent page, the right-most magenta pixel is the tip, and it moves right as the frames go by.
const CHROME_OK = spawnSync(process.execPath, ['-e', "import('puppeteer').then(p => p.default.executablePath()).then(x => require('fs').accessSync(x)).catch(() => process.exit(1))"], { cwd: RENDER }).status === 0
describe('sample_overlay draws the line further along each frame', { skip: !CHROME_OK && 'no Chrome for puppeteer' }, () => {
  test('the tip moves right at 1 s, 2 s and 3 s', { timeout: 180_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'synced-chart-'))
    try {
      const props = { values: [0, 1, 0.5, 1], lineColor: '#ff00ff', axisColor: '#000000', showValue: 'false', fill: 'false', strokeWidth: '8' }
      const rightmost = (frame) => {
        const png = join(dir, `f${frame}.png`)
        const run = spawnSync(process.execPath, [
          join(RENDER, 'sample-frame.js'), '--mode', 'overlay', '--component', TEMPLATE, '--frame', String(frame),
          '--duration', '120', '--fps', String(FPS), '--width', '1080', '--height', '1080', '--props', JSON.stringify(props), '--out', png,
        ], { cwd: RENDER, encoding: 'utf8', env: { ...process.env, TMPDIR: dir } })
        assert.equal(run.status, 0, run.stderr)
        assert.ok(existsSync(png))
        const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 })
        assert.equal(raw.status, 0, String(raw.stderr))
        const px = raw.stdout
        let max = -1
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] > 200 && px[i + 3] > 200) max = Math.max(max, (i / 4) % 1080)
        }
        return max
      }
      const xs = [30, 60, 90].map(rightmost)
      assert.ok(xs[0] > 0, `the line is drawn at 1 s (${xs})`)
      assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `the tip moves right: ${xs}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// render/test/hdr-graphics.test.mjs
//
// The graphics mapping's numbers (hdr-graphics.js). The ffmpeg side, the LUT
// applied to real captures and images, is hdr-overlay-color.integration.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  GRAPHICS_WHITE_NITS, graphicsToHdr, graphicsLutText, graphicsLutPath, graphicsToHdrChain,
  hlgOetf, pqOetf, srgbToLinear,
} from '../hdr-graphics.js'

const close = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tolerance ${tol})`)

test('white sits at 800 nits', () => {
  // The product owner lowered it from 900 ("too much") on 2026-10-02.
  assert.equal(GRAPHICS_WHITE_NITS, 800)
})

test('the transfer functions match their published values', () => {
  // BT.2100 HLG: E = 1/12 → 0.5, E = 1 → 1.
  close(hlgOetf(1 / 12), 0.5, 1e-9, 'HLG OETF at 1/12')
  close(hlgOetf(1), 1, 1e-6, 'HLG OETF at 1')
  // ST 2084: 100 nits → 0.5081, 1000 nits → 0.7518, 10000 → 1.
  close(pqOetf(100), 0.5081, 1e-4, 'PQ at 100 nits')
  close(pqOetf(1000), 0.7518, 1e-4, 'PQ at 1000 nits')
  close(pqOetf(10000), 1, 1e-9, 'PQ at 10000 nits')
  // IEC 61966-2-1: the linear segment and the power segment.
  close(srgbToLinear(0.04), 0.04 / 12.92, 1e-12, 'sRGB EOTF, linear segment')
  close(srgbToLinear(0.5), 0.214041, 1e-6, 'sRGB EOTF at 0.5')
})

// The expected numbers below come from an independent Python implementation of
// the same standards (sRGB EOTF, the BT.2087 matrix, BT.2100 HLG with a
// 1000-nit display and system gamma 1.2, ST 2084 PQ), not from this module. It
// reproduces every 900-nit value this file pinned before (HLG Y10 926, PQ 713,
// the n900.cube entries) exactly, then gives at 800 nits:
//   HLG: scene light (800/1000)^(1/1.2) = 0.83031, signal 0.96586,
//        Y10 round(64 + 876 * 0.96586) = 910
//   PQ:  signal pqOetf(800) = 0.72753, Y10 round(64 + 876 * 0.72753) = 701
test('HLG white: scene light (800/1000)^(1/1.2), signal 0.96586, Y10 910', () => {
  const [r, g, b] = graphicsToHdr([1, 1, 1], 'hdr_hlg')
  close(r, hlgOetf(0.8 ** (1 / 1.2)), 1e-12, 'white')
  // The BT.2087 rows sum to 1 only to 6 decimals (two to 0.999999).
  close(g, r, 1e-5, 'white is neutral (green)')
  close(b, r, 1e-5, 'white is neutral (blue)')
  close(r, 0.96586, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 910)
})

test('PQ white: 800 nits absolute, signal 0.72753, Y10 701', () => {
  const [r] = graphicsToHdr([1, 1, 1], 'hdr_pq')
  close(r, pqOetf(800), 1e-12, 'white')
  close(r, 0.72753, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 701)
})

test('the HLG LUT reproduces an independently built reference cube at 800 nits', () => {
  // Grid entries computed by the independent Python implementation described
  // above (the one that reproduced every entry of the orchestrator's n900.cube,
  // the cube the 900-nit white was first chosen on, 2026-10-01), at 800 nits:
  //   out = hlg_oetf((800/1000)^(1/1.2) * M_709_2020 @ srgb_eotf(rgb))
  // printed to 6 decimals. Keys are grid indices (r, g, b) on the 65-point grid.
  const reference = [
    [[64, 64, 64], [0.965855, 0.965855, 0.965855]],
    [[1, 0, 0], [0.043474, 0.014427, 0.007027]],
    [[32, 32, 32], [0.669731, 0.669731, 0.669731]],
    [[64, 0, 0], [0.879339, 0.414869, 0.202062]],
    [[0, 64, 0], [0.756153, 0.950394, 0.468225]],
    [[0, 0, 64], [0.328466, 0.168232, 0.945522]],
    [[10, 20, 30], [0.343949, 0.437242, 0.626425]],
    [[0, 45, 54], [0.631647, 0.805022, 0.885794]],
  ]
  const lines = graphicsLutText('hdr_hlg').trim().split('\n')
  assert.equal(lines[1], 'LUT_3D_SIZE 65')
  const data = lines.slice(2)
  assert.equal(data.length, 65 ** 3)
  for (const [[r, g, b], want] of reference) {
    // .cube order: red fastest, then green, then blue.
    const got = data[r + 65 * g + 65 * 65 * b].split(' ').map(Number)
    assert.deepEqual(got, want, `entry (${r}, ${g}, ${b})`)
  }
})

test('neutrals stay neutral and the primaries widen in BT.2020', () => {
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    const [r, g, b] = graphicsToHdr([0.5, 0.5, 0.5], key)
    assert.ok(Math.abs(r - g) < 1e-5 && Math.abs(g - b) < 1e-5, `${key}: grey is neutral`)
    // sRGB red is inside BT.2020: it gains green and blue there.
    const red = graphicsToHdr([1, 0, 0], key)
    assert.ok(red[1] > 0 && red[2] > 0, `${key}: red ${red}`)
  }
})

test('graphicsLutPath writes the LUT once, under a name hashed from its text, and dry runs write nothing', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'montaj-lut-'))
  const before = process.env.TMPDIR
  try {
    // os.tmpdir() reads TMPDIR on each call, and the module memoizes per
    // instance, so a fresh import under a new TMPDIR is a fresh process's view.
    process.env.TMPDIR = tmp
    const m = await import(`../hdr-graphics.js?fresh=${Date.now()}`)
    const named = m.graphicsLutPath('hdr_pq', { write: false })
    assert.ok(named.startsWith(tmp), `${named} is under the temp dir`)
    assert.ok(!existsSync(named), 'a dry run writes nothing')
    const written = m.graphicsLutPath('hdr_pq')
    assert.equal(written, named)
    assert.equal(readFileSync(written, 'utf8'), m.graphicsLutText('hdr_pq'))
    assert.match(path.basename(written), /^graphics-hdr_pq-[0-9a-f]{16}\.cube$/)
    assert.notEqual(m.graphicsLutPath('hdr_hlg', { write: false }), written, 'HLG and PQ are separate files')
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the chain reads a capture as BT.601 limited and ends in 10-bit 4:4:4 with alpha, tagged as the HDR canvas', () => {
  const chain = graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false })
  assert.match(chain, /^setparams=colorspace=bt470bg:range=tv,scale=in_color_matrix=bt601:in_range=tv:/)
  assert.match(chain, /format=gbrapf32le,lut3d=file=[^,]+:interp=tetrahedral,/)
  assert.match(chain, /scale=out_color_matrix=bt2020:out_range=tv:[^,]+,format=yuva444p10le,/)
  assert.match(chain, /setparams=colorspace=bt2020nc:color_trc=arib-std-b67:color_primaries=bt2020:range=tv$/)
  assert.doesNotMatch(chain, /zscale/, 'zscale drops alpha rows writing 4:2:0 under slice threading')
  const image = graphicsToHdrChain('hdr_pq', { input: 'rgb', write: false })
  assert.match(image, /^format=gbrapf32le,/)
  assert.match(image, /color_trc=smpte2084/)
})

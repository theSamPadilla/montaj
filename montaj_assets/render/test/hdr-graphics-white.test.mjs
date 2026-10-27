// render/test/hdr-graphics-white.test.mjs
//
// The graphics mapping's white level is a parameter (hdr-graphics.js
// `whiteNits`), 800 by default: every graphic in an HDR render maps there (the
// product owner, 2026-10-26). A level other than 800 is not used by the
// renderer; 300 nits stays here as a second point proving the parameter
// reaches the math, the LUT file and the filter chain. Which white each graphic
// takes in a render is in hdr-one-white.test.mjs; the pixels are proven in
// hdr-overlay-color.integration.test.mjs.
//
// The expected numbers come from an independent Python implementation of the
// standards (sRGB EOTF, the BT.2087 matrix, BT.2100 HLG with a 1000-nit display
// and system gamma 1.2, ST 2084 PQ), the one that reproduced every 900-, 800-
// and 203-nit value these tests have pinned. At 300 nits it gives:
//   HLG: scene light (300/1000)^(1/1.2) = 0.36666, signal 0.81291,
//        Y10 round(64 + 876 * 0.81291) = 776
//   PQ:  signal pqOetf(300) = 0.62186, Y10 round(64 + 876 * 0.62186) = 609

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPHICS_WHITE_NITS,
  graphicsToHdr, graphicsLutText, graphicsLutPath, graphicsToHdrChain, hlgOetf, pqOetf,
} from '../hdr-graphics.js'
import { SDR_WHITE_NITS } from '../encode-segment.js'

const OTHER_WHITE_NITS = 300

const close = (got, want, tol, label) =>
  assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want} (tolerance ${tol})`)

test('800 is the default white, above SDR clip white', () => {
  assert.equal(GRAPHICS_WHITE_NITS, 800)
  // Decoupled from SDR clips: an SDR clip in an HDR project stays at BT.2408's 203.
  assert.equal(SDR_WHITE_NITS, 203)
  assert.ok(GRAPHICS_WHITE_NITS > SDR_WHITE_NITS)
})

test('HLG white at 300 nits: scene light (300/1000)^(1/1.2), signal 0.81291, Y10 776', () => {
  const [r, g, b] = graphicsToHdr([1, 1, 1], 'hdr_hlg', OTHER_WHITE_NITS)
  close(r, hlgOetf(0.3 ** (1 / 1.2)), 1e-12, 'white')
  close(g, r, 1e-5, 'white is neutral (green)')
  close(b, r, 1e-5, 'white is neutral (blue)')
  close(r, 0.81291, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 776)
})

test('PQ white at 300 nits: 300 nits absolute, signal 0.62186, Y10 609', () => {
  const [r] = graphicsToHdr([1, 1, 1], 'hdr_pq', OTHER_WHITE_NITS)
  close(r, pqOetf(300), 1e-12, 'white')
  close(r, 0.62186, 5e-5, 'white signal')
  assert.equal(Math.round(64 + 876 * r), 609)
})

test('the white level defaults to GRAPHICS_WHITE_NITS', () => {
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    assert.deepEqual(graphicsToHdr([0.3, 0.6, 0.9], key), graphicsToHdr([0.3, 0.6, 0.9], key, 800))
  }
  assert.equal(graphicsLutText('hdr_pq'), graphicsLutText('hdr_pq', 800))
})

test('the 300-nit HLG LUT reproduces the independent reference', () => {
  // The Python implementation above at 300 nits, printed to 6 decimals.
  const reference = [
    [[64, 64, 64], [0.812907, 0.812907, 0.812907]],
    [[1, 0, 0], [0.028890, 0.009587, 0.004670]],
    [[32, 32, 32], [0.485225, 0.485225, 0.485225]],
    [[64, 0, 0], [0.722040, 0.275692, 0.134276]],
    [[0, 64, 0], [0.587094, 0.796821, 0.311149]],
    [[0, 0, 64], [0.218275, 0.111795, 0.791740]],
    [[10, 20, 30], [0.228563, 0.290559, 0.437683]],
    [[0, 45, 54], [0.443070, 0.641708, 0.728902]],
  ]
  const lines = graphicsLutText('hdr_hlg', 300).trim().split('\n')
  assert.equal(lines[0], 'TITLE "montaj graphics hdr_hlg 300 nits"')
  const data = lines.slice(2)
  for (const [[r, g, b], want] of reference) {
    assert.deepEqual(data[r + 65 * g + 65 * 65 * b].split(' ').map(Number), want, `entry (${r}, ${g}, ${b})`)
  }
})

test('each white level has its own LUT file, and the chain names the one it was given', () => {
  const at800 = graphicsLutPath('hdr_hlg', { write: false })
  const atOther = graphicsLutPath('hdr_hlg', { write: false, whiteNits: OTHER_WHITE_NITS })
  assert.notEqual(at800, atOther)
  assert.equal(graphicsLutPath('hdr_hlg', { write: false, whiteNits: 800 }), at800)
  const chain = graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false, whiteNits: OTHER_WHITE_NITS })
  assert.ok(chain.includes(atOther.split('/').pop()), `${chain} names the 300-nit LUT`)
  assert.ok(!chain.includes(at800.split('/').pop()))
  assert.ok(graphicsToHdrChain('hdr_hlg', { input: 'capture', write: false }).includes(at800.split('/').pop()))
})

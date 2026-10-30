import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RADIAL_MAX_PASSES, RADIAL_MAX_TAPS, radialBlurPlan, radialBlurReference, radialBlurTravel,
  radialCenterInPicture, radialTapInverse, zoomScaleRange,
} from '../index.js'

const close = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not ${b} (within ${eps})`)
const sum = (xs) => xs.reduce((s, v) => s + v, 0)
const PORTRAIT = { w: 1080, h: 1920 }
const MID = [540, 960]

/** The plan's effective copies: every combination of one tap a pass, offsets composed (angles add, scales multiply). */
function composed(type, plan) {
  let eff = [{ offset: type === 'spin' ? 0 : 1, weight: 1 }]
  for (const pass of plan.passes) {
    const next = []
    for (const e of eff) for (const t of pass.taps) {
      next.push({ offset: type === 'spin' ? e.offset + t.offset : e.offset * t.offset, weight: e.weight * t.weight })
    }
    eff = next
  }
  return eff.sort((a, b) => a.offset - b.offset)
}

/** Offsets in the sweep's own unit: degrees, or log scale. */
const unit = (type, o) => (type === 'spin' ? o : Math.log(o))

test('travel: the farthest corner\'s arc (spin) or radial distance (zoom)', () => {
  const r = Math.hypot(540, 960)
  close(radialBlurTravel({ type: 'spin', amount: 30, center: MID, rect: PORTRAIT }), r * Math.PI / 6, 1e-9, 'spin 30')
  const { lo, hi } = zoomScaleRange(40)
  close(hi, 1.2, 1e-12, 'zoom hi')
  close(lo, 1 / 1.2, 1e-12, 'zoom lo')
  close(radialBlurTravel({ type: 'zoom', amount: 40, center: MID, rect: PORTRAIT }), r * (hi - lo), 1e-9, 'zoom 40')
  // A centre at a corner: the opposite corner is the farthest.
  close(radialBlurTravel({ type: 'spin', amount: 90, center: [0, 0], rect: { w: 30, h: 40 } }), 50 * Math.PI / 2, 1e-9, 'corner centre')
  // Outside the picture: still the farthest corner.
  close(radialBlurTravel({ type: 'spin', amount: 90, center: [-30, 0], rect: { w: 30, h: 40 } }), Math.hypot(60, 40) * Math.PI / 2, 1e-9, 'outside')
  assert.equal(radialBlurTravel({ type: 'spin', amount: 0, center: MID, rect: PORTRAIT }), 0)
  assert.equal(radialBlurTravel({ type: 'spin', amount: 10, center: MID, rect: { w: 0, h: 10 } }), 0)
})

test('amount 0, negative, NaN or no picture: no passes', () => {
  for (const amount of [0, -5, NaN, Infinity]) {
    assert.deepEqual(radialBlurPlan({ type: 'spin', amount, center: MID, rect: PORTRAIT }).passes, [])
  }
  assert.deepEqual(radialBlurPlan({ type: 'zoom', amount: 40, center: [0, 0], rect: { w: 0, h: 0 } }).passes, [])
})

test('up to 12 px of travel: one pass, one tap a pixel plus the end (at least 2, at most 12)', () => {
  const rect = { w: 20, h: 20 }
  const c = [10, 10]
  const r = Math.hypot(10, 10)
  for (const travel of [0.3, 1, 2.5, 7, 11.5, 12]) {
    const amount = (travel / r) * 180 / Math.PI
    const plan = radialBlurPlan({ type: 'spin', amount, center: c, rect })
    close(plan.travel, travel, 1e-9, 'travel')
    assert.equal(plan.passes.length, 1)
    assert.equal(plan.passes[0].taps.length, Math.min(12, Math.ceil(travel - 1e-9) + 1), `taps at ${travel} px`)
    assert.ok(plan.spacing <= (travel > 11 ? 12 / 11 : 1) + 1e-12, `spacing ${plan.spacing}`)
  }
})

test('beyond 12 px: 2 passes up to 214.5 px, 3 beyond; N = clamp(ceil(travel^(1/P)), 2, 12)', () => {
  const rect = { w: 200, h: 200 }
  const c = [100, 100]
  const r = Math.hypot(100, 100)
  for (const [travel, passes, n] of [[12.5, 2, 4], [16, 2, 4], [17, 2, 5], [100, 2, 10], [144, 2, 12], [200, 2, 12], [214, 2, 12],
    [215, 3, 6], [400, 3, 8], [1700, 3, 12], [5000, 3, 12]]) {
    const amount = (travel / r) * 180 / Math.PI
    const plan = radialBlurPlan({ type: 'spin', amount, center: c, rect })
    assert.equal(plan.passes.length, passes, `passes at ${travel} px`)
    for (const p of plan.passes) assert.equal(p.taps.length, n, `N at ${travel} px`)
    assert.equal(plan.samples, n ** passes)
    close(plan.spacing, travel / (n ** passes - 1), 1e-9, 'spacing')
    if (travel <= 2590) assert.ok(plan.spacing <= 1.5, `spacing ${plan.spacing} at ${travel}`)
    assert.ok(plan.passes.length <= RADIAL_MAX_PASSES && n <= RADIAL_MAX_TAPS)
  }
})

test('every pass\'s weights sum to 1, the taps are symmetric about 0 (spin) or 1 in log (zoom)', () => {
  for (const type of ['spin', 'zoom']) {
    for (const amount of [1, 10, 30, 90, 150, 180, 200]) {
      const plan = radialBlurPlan({ type, amount, center: MID, rect: PORTRAIT })
      assert.ok(plan.passes.length >= 1)
      for (const p of plan.passes) {
        close(sum(p.taps.map((t) => t.weight)), 1, 1e-12, `${type} ${amount} weights`)
        const n = p.taps.length
        for (let i = 0; i < n; i++) {
          close(unit(type, p.taps[i].offset), -unit(type, p.taps[n - 1 - i].offset), 1e-12, `${type} ${amount} symmetric offset`)
          close(p.taps[i].weight, p.taps[n - 1 - i].weight, 1e-12, `${type} ${amount} symmetric weight`)
        }
      }
    }
  }
})

test('the effective copies cover the sweep end to end on a uniform grid of N^P offsets', () => {
  for (const [type, amount] of [['spin', 10], ['spin', 30], ['spin', 90], ['spin', 180], ['zoom', 10], ['zoom', 40], ['zoom', 150], ['zoom', 200]]) {
    const plan = radialBlurPlan({ type, amount, center: MID, rect: PORTRAIT })
    const eff = composed(type, plan)
    assert.equal(eff.length, plan.samples)
    const sweep = type === 'spin' ? amount : 2 * Math.log(1 + amount / 200)
    const d = sweep / (plan.samples - 1)
    for (let i = 0; i < eff.length; i++) {
      close(unit(type, eff[i].offset), (i - (eff.length - 1) / 2) * d, 1e-9 * sweep, `${type} ${amount} offset ${i}`)
    }
    if (type === 'zoom') {
      close(eff.at(-1).offset, 1 + amount / 200, 1e-9, 'zoom outward end')
      close(eff[0].offset, 1 / (1 + amount / 200), 1e-9, 'zoom inward end')
    } else {
      close(eff.at(-1).offset, amount / 2, 1e-9, 'spin end')
    }
  }
})

test('multi-pass weights: the single-pass Gaussian (sigma a quarter of the sweep) to within a cell, same mass per cell', () => {
  for (const [type, amount] of [['spin', 30], ['spin', 90], ['spin', 180], ['zoom', 40], ['zoom', 150]]) {
    const plan = radialBlurPlan({ type, amount, center: MID, rect: PORTRAIT })
    assert.ok(plan.passes.length >= 2, `${type} ${amount} is multi-pass`)
    const eff = composed(type, plan)
    const m = eff.length
    const sweep = type === 'spin' ? amount : 2 * Math.log(1 + amount / 200)
    const sigma = sweep / 4
    const g = eff.map((e) => Math.exp(-(unit(type, e.offset) ** 2) / (2 * sigma * sigma)))
    const gs = sum(g)
    const target = g.map((v) => v / gs)
    let cdfA = 0
    let cdfB = 0
    let worst = 0
    for (let i = 0; i < m; i++) {
      cdfA += eff[i].weight
      cdfB += target[i]
      worst = Math.max(worst, Math.abs(cdfA - cdfB))
    }
    const n = plan.passes[0].taps.length
    // The staircase moves at most half a cell's mass: under 1/N of the whole.
    assert.ok(worst < 0.6 / n, `${type} ${amount}: CDF off by ${worst.toFixed(4)} (N ${n})`)
    // Mass per coarse cell is the target's exactly.
    const cell = m / n
    for (let c = 0; c < n; c++) {
      close(sum(eff.slice(c * cell, (c + 1) * cell).map((e) => e.weight)), sum(target.slice(c * cell, (c + 1) * cell)), 1e-9, `${type} ${amount} cell ${c}`)
    }
    // Variance: the target's within a percent or two.
    const varOf = (ws) => sum(ws.map((w, i) => w * unit(type, eff[i].offset) ** 2))
    close(varOf(eff.map((e) => e.weight)) / varOf(target), 1, 0.06, `${type} ${amount} variance ratio`)
  }
})

test('single pass: Gaussian weights with the ends at e^-2 of the middle', () => {
  const plan = radialBlurPlan({ type: 'spin', amount: 1, center: [100, 100], rect: { w: 200, h: 200 } })
  assert.equal(plan.passes.length, 1)
  const taps = plan.passes[0].taps
  const n = taps.length
  assert.ok(n >= 2)
  const mid = Math.max(...taps.map((t) => t.weight))
  if (n % 2 === 1) close(taps[0].weight / mid, Math.exp(-2), 1e-9, 'end weight')
  close(taps[0].offset, -0.5, 1e-12, 'first tap at -sweep/2')
  close(taps[n - 1].offset, 0.5, 1e-12, 'last tap at +sweep/2')
})

test('numbers at 1080x1920, centred (the report\'s table)', (t) => {
  for (const [type, amount] of [['spin', 10], ['spin', 30], ['spin', 90], ['zoom', 10], ['zoom', 40], ['zoom', 150]]) {
    const p = radialBlurPlan({ type, amount, center: MID, rect: PORTRAIT })
    const n = p.passes[0].taps.length
    t.diagnostic(`${type} ${amount}: travel ${p.travel.toFixed(1)} px, ${p.passes.length} passes x ${n} taps = ${p.passes.length * n} transforms, ${p.samples} copies at ${p.spacing.toFixed(2)} px`)
  }
  const spin30 = radialBlurPlan({ type: 'spin', amount: 30, center: MID, rect: PORTRAIT })
  assert.equal(spin30.passes.length, 3)
})

test('radialTapInverse: a turn by -offset, a scale by 1/offset', () => {
  const [a, b] = radialTapInverse('spin', 90)
  close(a, 0, 1e-12, 'cos')
  close(b, -1, 1e-12, '-sin')
  // The output at p = c + (1, 0) reads c + [[a, -b], [b, a]] (1, 0) = c + (a, b) = c + (0, -1):
  // the input point a quarter turn anticlockwise lands there, so the picture turned clockwise.
  assert.deepEqual(radialTapInverse('zoom', 2), [0.5, 0])
})

test('radialCenterInPicture: box fractions to picture pixels through the picture\'s rect', () => {
  assert.deepEqual(radialCenterInPicture({ x: 0.5, y: 0.5 }, { x: 0, y: 0, w: 1, h: 1 }, 100, 50), [50, 25])
  // A 16:9 band in a 9:16 box: the box's centre is the picture's centre; its top edge is above the picture.
  const rect = { x: 0, y: 0.341796875, w: 1, h: 0.31640625 }
  const [cx, cy] = radialCenterInPicture({ x: 0.5, y: 0.5 }, rect, 1080, 607.5)
  close(cx, 540, 1e-9, 'cx')
  close(cy, 303.75, 1e-9, 'cy')
  assert.ok(radialCenterInPicture({ x: 0.5, y: 0 }, rect, 1080, 607.5)[1] < 0)
})

// ── The reference sampler ───────────────────────────────────────────────────

function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [r, g, b, a] = fill(i, j)
    data.set([r, g, b, a], (j * w + i) * 4)
  }
  return { data, width: w, height: h }
}
const lum = (out, i, j) => { const o = (j * out.width + i) * 4; return (out.data[o] + out.data[o + 1] + out.data[o + 2]) / 3 }

test('reference: a white dot spun 60 degrees about the centre becomes an arc of 60 degrees at its radius', () => {
  const W = 101
  const c = [50.5, 50.5]
  // A 3x3 dot centred 30 px right of the centre.
  const img = image(W, W, (i, j) => (Math.abs(i - 80) <= 1 && Math.abs(j - 50) <= 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  const plan = radialBlurPlan({ type: 'spin', amount: 60, center: c, rect: { w: W, h: W } })
  const out = radialBlurReference(img, { type: 'spin', plan, center: c })
  const at = (deg) => {
    const t = deg * Math.PI / 180
    return lum(out, Math.floor(c[0] + 30 * Math.cos(t)), Math.floor(c[1] + 30 * Math.sin(t)))
  }
  for (const deg of [-25, -15, 0, 15, 25]) assert.ok(at(deg) > 0.01, `lit at ${deg} deg: ${at(deg)}`)
  for (const deg of [-45, 45, 90, 180]) assert.ok(at(deg) < 0.002, `dark at ${deg} deg: ${at(deg)}`)
  // Off the radius, dark.
  assert.ok(lum(out, 50, 50) < 0.002 && lum(out, 50 + 15, 50) < 0.002)
  // The middle is brighter than the ends (Gaussian), and the light is conserved.
  assert.ok(at(0) > at(25) * 1.5)
  let total = 0
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) total += lum(out, i, j)
  close(total, 9, 0.05, 'the dot\'s light')
  // Opaque in, opaque out.
  for (let o = 3; o < out.data.length; o += 4) assert.equal(out.data[o], 1)
})

test('reference: a ring zoomed 50% spreads into radial streaks from 0.8 to 1.25 of its radius', () => {
  const W = 81
  const c = [40.5, 40.5]
  const img = image(W, W, (i, j) => (Math.abs(Math.hypot(i + 0.5 - c[0], j + 0.5 - c[1]) - 20) <= 0.75 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  const plan = radialBlurPlan({ type: 'zoom', amount: 50, center: c, rect: { w: W, h: W } })
  const out = radialBlurReference(img, { type: 'zoom', plan, center: c })
  for (const deg of [0, 37, 90, 200, 300]) {
    const t = deg * Math.PI / 180
    const at = (r) => lum(out, Math.floor(c[0] + r * Math.cos(t)), Math.floor(c[1] + r * Math.sin(t)))
    for (const r of [17.5, 20, 23.5]) assert.ok(at(r) > 0.01, `lit at r ${r}, ${deg} deg: ${at(r)}`)
    for (const r of [12, 29]) assert.ok(at(r) < 0.003, `dark at r ${r}, ${deg} deg: ${at(r)}`)
  }
})

test('reference: a flat picture stays flat and opaque to its edges, whatever the centre (the renormalisation)', () => {
  const img = image(40, 30, () => [200, 120, 40, 255])
  for (const [type, amount, center] of [['spin', 120, [20, 15]], ['spin', 180, [-30, 50]], ['zoom', 200, [0, 0]], ['zoom', 150, [60, -10]]]) {
    const plan = radialBlurPlan({ type, amount, center, rect: { w: 40, h: 30 } })
    const out = radialBlurReference(img, { type, plan, center })
    for (let o = 0; o < out.data.length; o += 4) {
      close(out.data[o] * 255, 200, 1e-3, `${type} r`)
      close(out.data[o + 1] * 255, 120, 1e-3, `${type} g`)
      close(out.data[o + 2] * 255, 40, 1e-3, `${type} b`)
      assert.equal(out.data[o + 3], 1)
    }
  }
})

test('reference: the source alpha is kept exactly; transparent pixels weigh nothing', () => {
  // Left half transparent (white under alpha 0), right half opaque red with an alpha ramp.
  const img = image(32, 16, (i) => (i < 16 ? [255, 255, 255, 0] : [255, 0, 0, Math.round(128 + (i - 16) * 8)]))
  const plan = radialBlurPlan({ type: 'spin', amount: 90, center: [16, 8], rect: { w: 32, h: 16 } })
  const out = radialBlurReference(img, { type: 'spin', plan, center: [16, 8] })
  for (let j = 0; j < 16; j++) for (let i = 0; i < 32; i++) {
    const o = (j * 32 + i) * 4
    close(out.data[o + 3], img.data[o + 3] / 255, 1e-7, 'alpha')
    // No white bleeds in from under alpha 0: red stays pure where it is seen.
    if (i >= 16) { close(out.data[o], 1, 1e-6, 'red'); close(out.data[o + 1], 0, 1e-6, 'no white') }
  }
})

test('reference: a sub-rect reads only the picture (bars around it weigh nothing)', () => {
  // Black bars above and below a flat grey picture.
  const img = image(20, 30, (i, j) => (j >= 10 && j < 20 ? [100, 100, 100, 255] : [0, 0, 0, 255]))
  const rect = { x: 0, y: 10, w: 20, h: 10 }
  const plan = radialBlurPlan({ type: 'zoom', amount: 120, center: [10, 5], rect })
  const out = radialBlurReference(img, { type: 'zoom', plan, center: [10, 5], rect })
  assert.equal(out.width, 20)
  assert.equal(out.height, 10)
  for (let o = 0; o < out.data.length; o += 4) close(out.data[o] * 255, 100, 1e-3, 'grey to the edge')
})

test('reference: passes compose; multi-pass lands near one pass of every effective copy', (t) => {
  // A smooth picture with detail: the difference is the staircase in the weights and the
  // picture-domain cut between passes (near the edges), not the sampling.
  const W = 48
  const img = image(W, W, (i, j) => [
    Math.round(127 + 120 * Math.sin(i / 4)), Math.round(127 + 120 * Math.cos(j / 5)), Math.round(((i + j) * 5) % 256), 255])
  for (const [type, amount] of [['spin', 90], ['zoom', 80]]) {
    const center = [20, 26]
    const plan = radialBlurPlan({ type, amount, center, rect: { w: W, h: W } })
    assert.equal(plan.passes.length, 2, `${type} is two passes`)
    const multi = radialBlurReference(img, { type, plan, center })
    // The single-pass target: every effective offset, the exact Gaussian weights.
    const eff = composed(type, plan)
    const sweep = type === 'spin' ? amount : 2 * Math.log(1 + amount / 200)
    const g = eff.map((e) => Math.exp(-(unit(type, e.offset) ** 2) / (2 * (sweep / 4) ** 2)))
    const gs = sum(g)
    const one = radialBlurReference(img, { type, center, plan: { ...plan, passes: [{ taps: eff.map((e, i) => ({ offset: e.offset, weight: g[i] / gs })) }] } })
    let worst = 0
    let total = 0
    let count = 0
    for (let j = 8; j < W - 8; j++) for (let i = 8; i < W - 8; i++) for (let ch = 0; ch < 3; ch++) {
      const o = (j * W + i) * 4 + ch
      const d = Math.abs(multi.data[o] - one.data[o]) * 255
      worst = Math.max(worst, d)
      total += d
      count++
    }
    const mean = total / count
    t.diagnostic(`${type} ${amount}: multi-pass against one pass of every copy, worst ${worst.toFixed(1)}, mean ${mean.toFixed(2)} codes`)
    assert.ok(worst < 16 && mean < 2, `${type}: multi-pass against one pass, worst ${worst.toFixed(1)}, mean ${mean.toFixed(2)} codes`)
  }
})

test('reference: coverage is the summed alpha, 1 where every tap lands on an opaque picture, falling off past its edges', () => {
  const W = 40
  const img = image(W, W, () => [200, 100, 50, 255])
  const mid = radialBlurReference(img, { type: 'spin', center: [20, 20],
    plan: radialBlurPlan({ type: 'spin', amount: 90, center: [20, 20], rect: { w: W, h: W } }) })
  assert.equal(mid.coverage.length, W * W)
  // Near the centre the turned copies stay on the picture: all of it lands.
  assert.ok(Math.abs(mid.coverage[20 * W + 20] - 1) < 1e-4, `${mid.coverage[20 * W + 20]}`)
  // About a corner, the far corner turns off the picture both ways: almost nothing lands.
  const corner = radialBlurReference(img, { type: 'spin', center: [0, 0],
    plan: radialBlurPlan({ type: 'spin', amount: 90, center: [0, 0], rect: { w: W, h: W } }) })
  assert.ok(corner.coverage[W * W - 1] < 1 / 16, `${corner.coverage[W * W - 1]}`)
  for (const v of [...mid.coverage, ...corner.coverage]) assert.ok(v >= 0 && v <= 1 + 1e-5)
})

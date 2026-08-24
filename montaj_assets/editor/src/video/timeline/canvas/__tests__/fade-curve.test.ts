/**
 * Fade-shape math (`fade-curve.ts`) — the one source of truth for what
 * linear/log/exp look and sound like, shared by the envelope curve
 * (draw.ts), the waveform's amplitude scaling (waveforms.ts), and — via a
 * name mapping kept there — the rendered mix (mix-audio.js).
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_FADE_CURVE, fadeCurveIconPoints, fadeGain, makeFadeGainAt } from '../fade-curve'

describe('DEFAULT_FADE_CURVE', () => {
  it('is exp — the shape every fade had before curves existed', () => {
    expect(DEFAULT_FADE_CURVE).toBe('exp')
  })
})

describe('fadeGain', () => {
  it('is 0 at p=0 (the silent edge) and 1 at p=1 (the full-volume edge), for every shape', () => {
    for (const curve of ['linear', 'log', 'exp'] as const) {
      expect(fadeGain(0, curve)).toBe(0)
      expect(fadeGain(1, curve)).toBe(1)
    }
  })

  it('linear is a straight ramp: gain(p) === p', () => {
    expect(fadeGain(0.25, 'linear')).toBeCloseTo(0.25)
    expect(fadeGain(0.5, 'linear')).toBeCloseTo(0.5)
    expect(fadeGain(0.75, 'linear')).toBeCloseTo(0.75)
  })

  it('exp (t²) sits BELOW the linear ramp everywhere in (0,1) — slow start, fast finish', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(fadeGain(p, 'exp')).toBeLessThan(p)
    }
    expect(fadeGain(0.5, 'exp')).toBeCloseTo(0.25)
  })

  it('log (t(2-t)) sits ABOVE the linear ramp everywhere in (0,1) — fast start, slow finish', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(fadeGain(p, 'log')).toBeGreaterThan(p)
    }
    expect(fadeGain(0.5, 'log')).toBeCloseTo(0.75)
  })

  it('log is the mirror of exp: log(p) === 1 - exp(1 - p)', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(fadeGain(p, 'log')).toBeCloseTo(1 - fadeGain(1 - p, 'exp'), 10)
    }
  })

  it('clamps p outside [0, 1] rather than extrapolating', () => {
    expect(fadeGain(-0.5, 'linear')).toBe(0)
    expect(fadeGain(1.5, 'linear')).toBe(1)
    expect(fadeGain(-1, 'exp')).toBe(0)
    expect(fadeGain(2, 'log')).toBe(1)
  })

  it('every shape is monotonically non-decreasing across [0, 1]', () => {
    for (const curve of ['linear', 'log', 'exp'] as const) {
      let prev = -Infinity
      for (let p = 0; p <= 1; p += 0.05) {
        const g = fadeGain(p, curve)
        expect(g).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = g
      }
    }
  })
})

describe('makeFadeGainAt', () => {
  it('is 1 (full gain) everywhere when neither fade is set', () => {
    const gainAt = makeFadeGainAt(0, 100, 0, 0, 'exp', 'exp')
    expect(gainAt(0)).toBe(1)
    expect(gainAt(50)).toBe(1)
    expect(gainAt(100)).toBe(1)
  })

  it('fade-in only: 0 at the span start, 1 at (and past) the fade-in edge', () => {
    const gainAt = makeFadeGainAt(0, 100, 20, 0, 'linear', 'exp')
    expect(gainAt(0)).toBeCloseTo(0)
    expect(gainAt(10)).toBeCloseTo(0.5)   // linear, halfway through a 20px fade-in
    expect(gainAt(20)).toBeCloseTo(1)
    expect(gainAt(80)).toBeCloseTo(1)     // well past the fade-in, unaffected
  })

  it('fade-out only: 1 up to the fade-out edge, 0 at the span end', () => {
    const gainAt = makeFadeGainAt(0, 100, 0, 20, 'exp', 'linear')
    expect(gainAt(0)).toBeCloseTo(1)
    expect(gainAt(79)).toBeCloseTo(1, 0)  // just before the fade-out region starts
    expect(gainAt(90)).toBeCloseTo(0.5)   // linear, halfway through a 20px fade-out
    expect(gainAt(100)).toBeCloseTo(0)
  })

  it('each side samples its OWN curve independently', () => {
    const gainAt = makeFadeGainAt(0, 100, 20, 20, 'linear', 'exp')
    // Midpoint of the fade-in (p=0.5): linear → 0.5.
    expect(gainAt(10)).toBeCloseTo(0.5)
    // Midpoint of the fade-out (p=0.5 from the silent end): exp → 0.25.
    expect(gainAt(90)).toBeCloseTo(0.25)
  })

  it('overlapping fades (a bar shorter than fadeIn + fadeOut): the lower gain wins', () => {
    // A 30px-wide span with a 20px fade-in AND a 20px fade-out overlapping
    // across its whole width — every point should take whichever fade pulls
    // it lower, so gain never exceeds what either side alone would allow.
    const gainAt = makeFadeGainAt(0, 30, 20, 20, 'linear', 'linear')
    for (let x = 0; x <= 30; x += 3) {
      const g = gainAt(x)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
    }
    // The very center should be pulled down by BOTH fades, not sitting at 1.
    expect(gainAt(15)).toBeLessThan(1)
  })

  it('anchors to spanX, not x=0 — a scrolled/offset span still fades correctly', () => {
    const gainAt = makeFadeGainAt(-100, 300, 40, 30, 'linear', 'linear')
    expect(gainAt(-100)).toBeCloseTo(0)     // span start: silent
    expect(gainAt(-60)).toBeCloseTo(1)      // fade-in's own inner edge
    expect(gainAt(170)).toBeCloseTo(1)      // fade-out's own inner edge
    expect(gainAt(200)).toBeCloseTo(0)      // span end: silent
  })

  it('clamps the result to [0, 1]', () => {
    const gainAt = makeFadeGainAt(0, 100, 20, 20, 'linear', 'linear')
    expect(gainAt(-50)).toBeGreaterThanOrEqual(0)
    expect(gainAt(500)).toBeGreaterThanOrEqual(0)
  })
})

describe('fadeCurveIconPoints', () => {
  const W = 40
  const H = 28

  it('returns segments+1 points, defaulting to 24 segments', () => {
    expect(fadeCurveIconPoints('linear', W, H)).toHaveLength(25)
    expect(fadeCurveIconPoints('linear', W, H, 10)).toHaveLength(11)
  })

  it('starts at the bottom-left (silent) and ends at the top-right (full volume), for every shape', () => {
    for (const curve of ['linear', 'log', 'exp'] as const) {
      const points = fadeCurveIconPoints(curve, W, H)
      expect(points[0]).toEqual({ x: 0, y: H })          // p=0, gain=0 → bottom-left
      expect(points[points.length - 1]).toEqual({ x: W, y: 0 })  // p=1, gain=1 → top-right
    }
  })

  it('x runs left→right in equal steps, independent of the curve', () => {
    const points = fadeCurveIconPoints('exp', W, H, 4)
    expect(points.map(p => p.x)).toEqual([0, W / 4, W / 2, (3 * W) / 4, W])
  })

  it('linear is a straight diagonal: y is an exact linear function of x', () => {
    const points = fadeCurveIconPoints('linear', W, H)
    for (const { x, y } of points) {
      expect(y).toBeCloseTo(H - (x / W) * H)
    }
  })

  it('exp is concave-up: stays LOW (near the bottom) through the midpoint, then rises sharply', () => {
    // Reuses `fadeGain` directly, so this is really just checking the icon
    // wires the same math through — see fadeGain's own concave-up test for
    // the underlying claim.
    const points = fadeCurveIconPoints('exp', W, H)
    const mid = points[Math.round(points.length / 2) - 1]
    const linearMidY = H - 0.5 * H
    // "Stays low" in a y-down SVG means a LARGER y (closer to the bottom)
    // than the straight-line midpoint.
    expect(mid.y).toBeGreaterThan(linearMidY)
  })

  it('log is concave-down: rises fast, sitting HIGH (near the top) by the midpoint', () => {
    const points = fadeCurveIconPoints('log', W, H)
    const mid = points[Math.round(points.length / 2) - 1]
    const linearMidY = H - 0.5 * H
    // "Levels near the top" means a SMALLER y than the straight-line midpoint.
    expect(mid.y).toBeLessThan(linearMidY)
  })

  it('every shape is monotonically non-increasing in y as x increases (gain only ever rises)', () => {
    for (const curve of ['linear', 'log', 'exp'] as const) {
      const points = fadeCurveIconPoints(curve, W, H)
      for (let i = 1; i < points.length; i++) {
        expect(points[i].y).toBeLessThanOrEqual(points[i - 1].y + 1e-9)
      }
    }
  })
})

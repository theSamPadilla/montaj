/**
 * Fade-envelope shapes (Vegas Pro's first three: linear, logarithmic,
 * exponential) — the pure math shared by three consumers that must never
 * disagree about what a given shape sounds/looks like: the envelope curve
 * drawn on an audio bar (`draw.ts`'s `drawFadeEnvelope`), the waveform's own
 * amplitude scaling under a fade (`waveforms.ts`'s `drawWaveformBars`), and
 * the rendered mix (`mix-audio.js`'s ffmpeg `afade` filter, via a name
 * mapping kept in that file since ffmpeg's vocabulary — `tri`/`exp`/`log` —
 * is render-only and has no reason to leak into the editor).
 *
 * `p` is always position ACROSS THE FADE, 0 at the silent edge (the clip's
 * own start for a fade-in, its own end for a fade-out) and 1 at the fade's
 * full-volume inner edge — never raw pixels or seconds, so one function
 * serves both a fade-in and a fade-out by construction.
 */

export type FadeCurve = 'linear' | 'log' | 'exp'

/** Exponential was the only shape before curves existed (`drawFadeEnvelope`'s
 *  quadratic ease) — keeping it the default means every project on disk today
 *  looks exactly as it did until an operator picks a different shape. */
export const DEFAULT_FADE_CURVE: FadeCurve = 'exp'

/**
 * Gain at position `p` (0 = silent edge, 1 = full-volume edge), for one of
 * the three shapes. Clamped to [0, 1] first so a caller doesn't have to —
 * every consumer here computes `p` from a division that can overshoot by a
 * hair at the exact edges.
 *
 *  - `linear`: a straight ramp — Vegas' "Linear".
 *  - `exp`: `t²` — slow to leave the silent edge, fast into the full-volume
 *    one (concave up). This is the shape the old single quadratic ease
 *    approximated, so it is the DEFAULT (above) rather than `linear`.
 *  - `log`: `t(2-t)` — the mirror of `exp`, fast to leave silence and slow
 *    into full volume (concave down). Vegas' "Fast" logarithmic curve family;
 *    picked over a true `log()` curve (which blows up at t=0) for the same
 *    reason `exp` uses `t²` rather than an exponential blowing up at t=1 —
 *    both need to be exactly 0 and 1 at their endpoints with no asymptote to
 *    clip.
 */
export function fadeGain(p: number, curve: FadeCurve): number {
  const t = p < 0 ? 0 : p > 1 ? 1 : p
  if (curve === 'linear') return t
  if (curve === 'exp') return t * t
  return t * (2 - t)
}

/**
 * A gain-at-surface-x function for one audio bar, folding both fade regions
 * (each with its own curve) into one lookup — the shape `drawWaveformBars`
 * and `drawFadeEnvelope`'s sampling both want: call it with a column's x and
 * get back how much amplitude survives there.
 *
 * `spanX`/`spanWidth` are the bar's TRUE (unclamped) span in surface x —
 * same contract as `AudioItemDrawArgs.fadeSpanX`/`fadeSpanWidth` in draw.ts —
 * so the returned function keeps working under horizontal scroll without the
 * caller re-deriving anything.
 *
 * Where the two fades overlap (a bar shorter than fadeInPx + fadeOutPx), the
 * lower of the two gains wins — `Math.min` — matching the clamp `applyAudioFade`
 * already enforces (fadeIn + fadeOut never exceeds the bar's own duration) but
 * defensively correct even if that invariant is ever violated on disk.
 */
export function makeFadeGainAt(
  spanX: number,
  spanWidth: number,
  fadeInPx: number,
  fadeOutPx: number,
  inCurve: FadeCurve,
  outCurve: FadeCurve,
): (x: number) => number {
  return (x: number) => {
    const local = x - spanX
    let g = 1
    if (fadeInPx > 0 && local < fadeInPx) g = Math.min(g, fadeGain(local / fadeInPx, inCurve))
    if (fadeOutPx > 0 && local > spanWidth - fadeOutPx) {
      g = Math.min(g, fadeGain((spanWidth - local) / fadeOutPx, outCurve))
    }
    return g < 0 ? 0 : g > 1 ? 1 : g
  }
}

/** One point of a curve's icon polyline, in SVG-style coordinates (y grows
 *  DOWNWARD) — see `fadeCurveIconPoints`. */
export interface FadeCurveIconPoint {
  x: number
  y: number
}

/**
 * Sampled points for a small ICON depicting `curve`'s shape — the fade-shape
 * picker (Timeline.tsx) draws these as an inline SVG polyline so each menu
 * option shows what the shape actually looks like instead of naming it.
 * Reuses `fadeGain` directly (the SAME function the real envelope and
 * waveform scaling sample), so the icon is a faithful miniature of the
 * actual curve, never a decorative approximation drawn by hand.
 *
 * `p` (0→1) maps to `x` (0→`width`, left→right); gain (0→1) maps to `y`
 * (`height`→0, bottom→top) — SVG's y-axis grows downward, so full gain (1)
 * is the SMALLEST y. Silent is therefore the bottom-left corner, full volume
 * the top-right — Vegas' own fade-icon convention, and the same corners
 * `drawFadeEnvelope` uses for a fade-in's silent/full ends.
 */
export function fadeCurveIconPoints(curve: FadeCurve, width: number, height: number, segments = 24): FadeCurveIconPoint[] {
  const points: FadeCurveIconPoint[] = []
  for (let i = 0; i <= segments; i++) {
    const p = i / segments
    points.push({ x: p * width, y: height - fadeGain(p, curve) * height })
  }
  return points
}

export type SnapGuide = { axis: 'x' | 'y'; at: number };

export type SnapResult = {
  position: { x: number; y: number };
  guides: SnapGuide[];
};

// `threshold` is in the SAME units as proposed/slide (logical, unscaled).
// Callers that want a screen-pixel-relative feel should pass roughly
// `desired_screen_px / scale`. Default is a conservative ~0.7% of a 1080-unit
// slide — tight enough that snap doesn't trap a near-aligned element at rest,
// loose enough to still feel magnetic on deliberate alignment passes.
export function snapToSlide(
  proposed: { x: number; y: number; w: number; h: number },
  slide: { w: number; h: number },
  threshold: number = 8,
): SnapResult {
  const thresholdX = threshold;
  const thresholdY = threshold;
  const guides: SnapGuide[] = [];
  let { x, y } = proposed;

  // X-axis snap candidates: element-left/center/right vs slide-left/center/right.
  const elCenterX = proposed.x + proposed.w / 2;
  const elRightX = proposed.x + proposed.w;
  const slideCenterX = slide.w / 2;
  const xCandidates: Array<{ at: number; dx: number }> = [
    { at: 0, dx: -proposed.x }, // align element left to slide left
    { at: slideCenterX, dx: slideCenterX - elCenterX }, // center
    { at: slide.w, dx: slide.w - elRightX }, // align element right to slide right
  ];
  let bestX = { dx: Infinity, at: 0 };
  for (const c of xCandidates) {
    if (Math.abs(c.dx) < Math.abs(bestX.dx) && Math.abs(c.dx) <= thresholdX) {
      bestX = c;
    }
  }
  if (bestX.dx !== Infinity) {
    x = proposed.x + bestX.dx;
    guides.push({ axis: 'x', at: bestX.at });
  }

  // Y-axis snap (mirror).
  const elCenterY = proposed.y + proposed.h / 2;
  const elBottomY = proposed.y + proposed.h;
  const slideCenterY = slide.h / 2;
  const yCandidates: Array<{ at: number; dy: number }> = [
    { at: 0, dy: -proposed.y },
    { at: slideCenterY, dy: slideCenterY - elCenterY },
    { at: slide.h, dy: slide.h - elBottomY },
  ];
  let bestY = { dy: Infinity, at: 0 };
  for (const c of yCandidates) {
    if (Math.abs(c.dy) < Math.abs(bestY.dy) && Math.abs(c.dy) <= thresholdY) {
      bestY = c;
    }
  }
  if (bestY.dy !== Infinity) {
    y = proposed.y + bestY.dy;
    guides.push({ axis: 'y', at: bestY.at });
  }

  return { position: { x, y }, guides };
}

// ── Smart guides (§586 M7) ──
// The dragged box also snaps to the other elements' left/centre/right and
// top/middle/bottom, and to equal gaps between two neighbours. Every box,
// the dragged one included, counts by the box it covers when turned; the snap
// offset found on that box moves its x and y.

export type SnapBox = { x: number; y: number; w: number; h: number; rotation?: number };

/** One gap of an equal-gap snap: from `from` to `to` along `axis`, drawn at `at` on the other axis. */
export type GapSegment = { axis: 'x' | 'y'; from: number; to: number; at: number };

export type SmartSnapResult = SnapResult & { gaps: GapSegment[] };

export type SmartSnapOptions = {
  // Snap nothing and show no guide (Cmd or Ctrl held during the drag).
  skip?: boolean;
};

type Span = { lo: number; hi: number };
type Covered = { x: Span; y: Span };

/** The axis-aligned box `b` covers, rotation (about its centre) included. */
function covered(b: SnapBox): Covered {
  const rad = ((b.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const halfW = (b.w * cos + b.h * sin) / 2;
  const halfH = (b.w * sin + b.h * cos) / 2;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: { lo: cx - halfW, hi: cx + halfW }, y: { lo: cy - halfH, hi: cy + halfH } };
}

const overlaps = (a: Span, b: Span) => a.lo < b.hi && a.hi > b.lo;

type AxisSnap = { d: number; guide?: number; between?: [Covered, Covered] };

// The smallest move along one axis that lines the box up: its left/centre/right
// with the slide's (as snapToSlide pairs them), any of them with any of a
// neighbour's, or its two gaps equal between the nearest neighbour on each side
// that overlaps it on the other axis. Earlier candidates win ties.
function snapAxis(
  self: Covered,
  axis: 'x' | 'y',
  slideLen: number,
  others: readonly Covered[],
  threshold: number,
): AxisSnap | null {
  const cross = axis === 'x' ? 'y' : 'x';
  const s = self[axis];
  const anchors = [s.lo, (s.lo + s.hi) / 2, s.hi];
  let best: AxisSnap | null = null;
  const offer = (c: AxisSnap) => {
    if (Math.abs(c.d) <= threshold && (!best || Math.abs(c.d) < Math.abs(best.d))) best = c;
  };

  [0, slideLen / 2, slideLen].forEach((at, i) => offer({ d: at - anchors[i], guide: at }));
  for (const o of others) {
    const span = o[axis];
    for (const at of [span.lo, (span.lo + span.hi) / 2, span.hi]) {
      for (const a of anchors) offer({ d: at - a, guide: at });
    }
  }

  let before: Covered | null = null;
  let after: Covered | null = null;
  for (const o of others) {
    if (!overlaps(o[cross], self[cross])) continue;
    if (o[axis].hi <= s.lo && (!before || o[axis].hi > before[axis].hi)) before = o;
    if (o[axis].lo >= s.hi && (!after || o[axis].lo < after[axis].lo)) after = o;
  }
  if (before && after) {
    const gapBefore = s.lo - before[axis].hi;
    const gapAfter = after[axis].lo - s.hi;
    if (gapBefore + gapAfter > 0) offer({ d: (gapAfter - gapBefore) / 2, between: [before, after] });
  }
  return best;
}

/**
 * Where a dragged box lands near the slide and the `others` (the visible
 * elements not being dragged), in the same units as `threshold`. Line guides
 * span the slide at each snapped coordinate; an equal-gap snap shows its two
 * gaps as `gaps` instead.
 */
export function snapToSlideAndElements(
  proposed: SnapBox,
  slide: { w: number; h: number },
  others: readonly SnapBox[],
  threshold: number = 8,
  opts: SmartSnapOptions = {},
): SmartSnapResult {
  if (opts.skip) return { position: { x: proposed.x, y: proposed.y }, guides: [], gaps: [] };
  const self = covered(proposed);
  const near = others.map(covered);
  const sx = snapAxis(self, 'x', slide.w, near, threshold);
  const sy = snapAxis(self, 'y', slide.h, near, threshold);
  const dx = sx?.d ?? 0;
  const dy = sy?.d ?? 0;
  const landed: Covered = {
    x: { lo: self.x.lo + dx, hi: self.x.hi + dx },
    y: { lo: self.y.lo + dy, hi: self.y.hi + dy },
  };

  const guides: SnapGuide[] = [];
  const gaps: GapSegment[] = [];
  for (const [axis, snap] of [['x', sx], ['y', sy]] as const) {
    if (!snap) continue;
    if (snap.guide !== undefined) guides.push({ axis, at: snap.guide });
    if (!snap.between) continue;
    const cross = axis === 'x' ? 'y' : 'x';
    const [before, after] = snap.between;
    // Each gap is drawn halfway across the overlap of the box and that neighbour.
    const mid = (o: Covered) =>
      (Math.max(o[cross].lo, landed[cross].lo) + Math.min(o[cross].hi, landed[cross].hi)) / 2;
    gaps.push({ axis, from: before[axis].hi, to: landed[axis].lo, at: mid(before) });
    gaps.push({ axis, from: landed[axis].hi, to: after[axis].lo, at: mid(after) });
  }
  return { position: { x: proposed.x + dx, y: proposed.y + dy }, guides, gaps };
}

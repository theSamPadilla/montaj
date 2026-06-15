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

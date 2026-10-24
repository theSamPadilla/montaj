export type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

type Box = { x: number; y: number; w: number; h: number };

export type ResizeState = {
  elementId: string;
  handle: ResizeHandle;
  startCursor: { x: number; y: number };
  // `rotation`: clockwise degrees about the box centre, as the renderer draws it.
  startBox: Box & { rotation?: number };
};

export type ResizeOptions = {
  // Corner handles only: keep the start box's w/h. Side handles always move
  // one side. Off by default.
  keepRatio?: boolean;
};

// The smallest w or h a resize leaves.
const MIN_SIZE = 1;

// The box model, shared with the renderer (render/templates/slide.jsx): x, y
// is the unrotated top-left and the box turns `rotation` degrees clockwise
// about its centre. In the box's own axes a handle sits at (sx * w/2, sy * h/2)
// from the centre, and the point that stays put on the slide is the opposite
// one, (-sx * w/2, -sy * h/2): the opposite corner for a corner handle, the
// opposite side's midpoint for a side handle.
function handleSigns(handle: ResizeHandle): { sx: number; sy: number } {
  return {
    sx: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    sy: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0,
  };
}

// cos and sin of a clockwise turn in degrees (y down), exact at quarter turns.
function turn(rotation: number | undefined): { cos: number; sin: number } {
  const deg = rotation !== undefined && Number.isFinite(rotation) ? ((rotation % 360) + 360) % 360 : 0;
  if (deg === 0) return { cos: 1, sin: 0 };
  if (deg === 90) return { cos: 0, sin: 1 };
  if (deg === 180) return { cos: -1, sin: 0 };
  if (deg === 270) return { cos: 0, sin: -1 };
  const rad = (deg * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

export function startResize(
  elementId: string,
  handle: ResizeHandle,
  cursor: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number; rotation?: number },
): ResizeState {
  return { elementId, handle, startCursor: cursor, startBox: box };
}

// Each side the handle names follows the cursor's travel (du, dv) in the box's
// own axes; the other sides stay. A side that would pass the minimum stops
// there.
function freeResize(start: Box, handle: ResizeHandle, du: number, dv: number): Box {
  let { x, y, w, h } = start;
  if (handle.includes('w')) {
    const proposedW = start.w - du;
    if (proposedW < MIN_SIZE) {
      x = start.x + start.w - MIN_SIZE;
      w = MIN_SIZE;
    } else {
      x = start.x + du;
      w = proposedW;
    }
  }
  if (handle.includes('e')) {
    w = start.w + du;
  }
  if (handle.includes('n')) {
    const proposedH = start.h - dv;
    if (proposedH < MIN_SIZE) {
      y = start.y + start.h - MIN_SIZE;
      h = MIN_SIZE;
    } else {
      y = start.y + dv;
      h = proposedH;
    }
  }
  if (handle.includes('s')) {
    h = start.h + dv;
  }
  return { x, y, w: Math.max(w, MIN_SIZE), h: Math.max(h, MIN_SIZE) };
}

// A corner handle keeping w/h: the dragged corner goes to the cursor's
// projection onto the diagonal from the pinned corner, so the box scales by
// that projection's share of the diagonal, never below the minimum on either
// side.
function ratioResize(start: Box, sx: number, sy: number, du: number, dv: number): Box {
  const along = (sx * start.w * du + sy * start.h * dv) / (start.w * start.w + start.h * start.h);
  const k = Math.max(1 + along, MIN_SIZE / start.w, MIN_SIZE / start.h);
  const w = start.w * k;
  const h = start.h * k;
  return {
    x: sx < 0 ? start.x + (start.w - w) : start.x,
    y: sy < 0 ? start.y + (start.h - h) : start.y,
    w,
    h,
  };
}

// The box after the cursor moved from where the resize started, unrounded.
// The cursor's travel is turned into the box's own axes, and the point
// opposite the handle keeps its place on the slide, so the dragged handle
// follows the cursor. With no rotation and `keepRatio` off this is the box
// the unrotated resize always gave.
export function nextResizeBox(
  state: ResizeState,
  cursor: { x: number; y: number },
  scale: number,
  options: ResizeOptions = {},
): Box {
  const start = state.startBox;
  const { cos, sin } = turn(start.rotation);
  const unrotated = cos === 1 && sin === 0;
  const dx = (cursor.x - state.startCursor.x) / scale;
  const dy = (cursor.y - state.startCursor.y) / scale;
  const du = unrotated ? dx : cos * dx + sin * dy;
  const dv = unrotated ? dy : cos * dy - sin * dx;

  const { sx, sy } = handleSigns(state.handle);
  const corner = sx !== 0 && sy !== 0;
  // The new box in the start box's own frame, as if it were not turned.
  const local =
    options.keepRatio && corner && start.w > 0 && start.h > 0
      ? ratioResize(start, sx, sy, du, dv)
      : freeResize(start, state.handle, du, dv);
  if (unrotated) return local;

  // The box turns about its own centre: carry the new centre's offset from
  // the start centre through the turn, which keeps the pinned point in place.
  const ex = local.x + local.w / 2 - (start.x + start.w / 2);
  const ey = local.y + local.h / 2 - (start.y + start.h / 2);
  return {
    x: local.x + (cos - 1) * ex - sin * ey,
    y: local.y + sin * ex + (cos - 1) * ey,
    w: local.w,
    h: local.h,
  };
}

// Whole slide pixels for the commit: w and h round first, then x and y are
// placed from the pinned point with the rounded size, then they round. The
// pinned point moves by at most half a pixel on each axis.
export function roundResizedBox(box: Box, handle: ResizeHandle, rotation?: number): Box {
  const { cos, sin } = turn(rotation);
  const { sx, sy } = handleSigns(handle);
  const w = Math.max(MIN_SIZE, Math.round(box.w));
  const h = Math.max(MIN_SIZE, Math.round(box.h));
  // The centre moves half the size change toward the dragged side, in the
  // box's own axes.
  const du = (sx * (w - box.w)) / 2;
  const dv = (sy * (h - box.h)) / 2;
  const cx = box.x + box.w / 2 + cos * du - sin * dv;
  const cy = box.y + box.h / 2 + sin * du + cos * dv;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

export type ResizeState = {
  elementId: string;
  handle: ResizeHandle;
  startCursor: { x: number; y: number };
  startBox: { x: number; y: number; w: number; h: number };
};

export function startResize(
  elementId: string,
  handle: ResizeHandle,
  cursor: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number },
): ResizeState {
  return { elementId, handle, startCursor: cursor, startBox: box };
}

export function nextResizeBox(
  state: ResizeState,
  cursor: { x: number; y: number },
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const dx = (cursor.x - state.startCursor.x) / scale;
  const dy = (cursor.y - state.startCursor.y) / scale;
  let { x, y, w, h } = state.startBox;

  if (state.handle.includes('w')) {
    const proposedW = state.startBox.w - dx;
    if (proposedW < 1) {
      x = state.startBox.x + state.startBox.w - 1;
      w = 1;
    } else {
      x = state.startBox.x + dx;
      w = proposedW;
    }
  }
  if (state.handle.includes('e')) {
    w = state.startBox.w + dx;
  }
  if (state.handle.includes('n')) {
    const proposedH = state.startBox.h - dy;
    if (proposedH < 1) {
      y = state.startBox.y + state.startBox.h - 1;
      h = 1;
    } else {
      y = state.startBox.y + dy;
      h = proposedH;
    }
  }
  if (state.handle.includes('s')) {
    h = state.startBox.h + dy;
  }
  return {
    x,
    y,
    w: Math.max(w, 1),
    h: Math.max(h, 1),
  };
}

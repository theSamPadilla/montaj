export type DragState = {
  elementId: string;
  startCursor: { x: number; y: number };
  startElement: { x: number; y: number };
};

export function startDrag(
  elementId: string,
  cursor: { x: number; y: number },
  element: { x: number; y: number },
): DragState {
  return { elementId, startCursor: cursor, startElement: element };
}

export function nextDragPosition(
  state: DragState,
  cursor: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  return {
    x: state.startElement.x + (cursor.x - state.startCursor.x) / scale,
    y: state.startElement.y + (cursor.y - state.startCursor.y) / scale,
  };
}

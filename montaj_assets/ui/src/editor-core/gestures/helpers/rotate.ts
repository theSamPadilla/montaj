export type RotateState = {
  elementId: string;
  center: { x: number; y: number };
  startCursorAngle: number; // degrees
  startRotation: number;     // degrees
};

const RAD_TO_DEG = 180 / Math.PI;

function angleOf(center: { x: number; y: number }, cursor: { x: number; y: number }): number {
  return Math.atan2(cursor.y - center.y, cursor.x - center.x) * RAD_TO_DEG;
}

export function startRotate(
  elementId: string,
  center: { x: number; y: number },
  cursor: { x: number; y: number },
  rotation: number,
): RotateState {
  return {
    elementId,
    center,
    startCursorAngle: angleOf(center, cursor),
    startRotation: rotation,
  };
}

export function nextRotation(
  state: RotateState,
  cursor: { x: number; y: number },
  snapThresholdDeg: number = 5,
): number {
  const cursorAngle = angleOf(state.center, cursor);
  const delta = cursorAngle - state.startCursorAngle;
  const raw = state.startRotation + delta;
  // Normalize to [0, 360).
  const norm = ((raw % 360) + 360) % 360;
  for (const snap of [0, 90, 180, 270]) {
    if (Math.abs(norm - snap) <= snapThresholdDeg) return snap;
  }
  // Also check the 360 boundary (which is 0).
  if (Math.abs(norm - 360) <= snapThresholdDeg) return 0;
  return norm;
}

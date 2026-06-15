import { useCallback, useRef, useState } from 'react';
import { startDrag, nextDragPosition, type DragState } from '../helpers/drag';
import { snapToSlide, type SnapGuide } from '../helpers/snap';

// Cursor must travel this many screen pixels from pointer-down before snap
// engages. Prevents the element from being trapped at a snap target that
// happens to align with its starting position (e.g. an element whose bottom
// edge sits exactly on the slide's bottom edge would otherwise re-snap on
// every pointer event until the user crosses the threshold).
const DEAD_ZONE_PX = 12;

// Screen-pixel-relative snap distance. Converted to logical units per move
// using the current scale; floored at 1 logical unit so very-zoomed-out views
// still snap meaningfully.
const SNAP_PX = 6;

export type UseOverlayDragArgs = {
  scale: number;
  slide: { w: number; h: number };
  // Called on every pointer move with the latest position and current rotation.
  // Consumers should perform a cheap, side-effect-only update here (e.g. mutate
  // DOM style) — do NOT trigger React state updates, since this fires at
  // pointer-event rate.
  onPreview: (elementId: string, x: number, y: number, rotation: number) => void;
  // Called once on pointer up with the final position. This is where React
  // state should be committed and persistence should be triggered.
  onCommit?: (elementId: string, x: number, y: number) => void | Promise<void>;
};

export type UseOverlayDragReturn = {
  guides: SnapGuide[];
  onPointerDown: (
    elementId: string,
    cursor: { x: number; y: number },
    element: { x: number; y: number; w: number; h: number; rotation?: number },
  ) => void;
  onPointerMove: (cursor: { x: number; y: number }) => void;
  onPointerUp: () => void;
};

export function useOverlayDrag({ scale, slide, onPreview, onCommit }: UseOverlayDragArgs): UseOverlayDragReturn {
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const stateRef = useRef<DragState | null>(null);
  const sizeRef = useRef<{ w: number; h: number } | null>(null);
  const latestRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const rotationRef = useRef<number>(0);

  const onPointerDown = useCallback(
    (
      elementId: string,
      cursor: { x: number; y: number },
      element: { x: number; y: number; w: number; h: number; rotation?: number },
    ) => {
      stateRef.current = startDrag(elementId, cursor, element);
      sizeRef.current = { w: element.w, h: element.h };
      rotationRef.current = element.rotation ?? 0;
      latestRef.current = { id: elementId, x: element.x, y: element.y };
    },
    [],
  );

  const onPointerMove = useCallback(
    (cursor: { x: number; y: number }) => {
      const s = stateRef.current;
      const size = sizeRef.current;
      if (!s || !size) return;
      const raw = nextDragPosition(s, cursor, scale);

      // Skip snapping until the cursor has cleared the dead-zone. This is a
      // gesture-level escape hatch: elements that start at a snap target can
      // never get unstuck otherwise (every move re-snaps them back).
      const cursorDx = cursor.x - s.startCursor.x;
      const cursorDy = cursor.y - s.startCursor.y;
      const cursorDistSq = cursorDx * cursorDx + cursorDy * cursorDy;
      const inDeadZone = cursorDistSq < DEAD_ZONE_PX * DEAD_ZONE_PX;

      const snap = inDeadZone
        ? { position: raw, guides: [] as SnapGuide[] }
        : snapToSlide(
            { x: raw.x, y: raw.y, w: size.w, h: size.h },
            slide,
            Math.max(SNAP_PX / scale, 1),
          );

      setGuides(snap.guides);
      latestRef.current = { id: s.elementId, x: snap.position.x, y: snap.position.y };
      onPreview(s.elementId, snap.position.x, snap.position.y, rotationRef.current);
    },
    [scale, slide, onPreview],
  );

  const onPointerUp = useCallback(() => {
    const final = latestRef.current;
    // Idempotent — `pointercancel` and `pointerup` can both fire for the same
    // gesture (especially after `setPointerCapture`); the second arrival sees
    // null state and exits before re-committing.
    if (!final) return;
    stateRef.current = null;
    sizeRef.current = null;
    latestRef.current = null;
    setGuides([]);
    void onCommit?.(final.id, final.x, final.y);
  }, [onCommit]);

  return { guides, onPointerDown, onPointerMove, onPointerUp };
}

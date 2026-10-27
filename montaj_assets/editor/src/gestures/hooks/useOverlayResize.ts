import { useCallback, useRef } from 'react';
import { startResize, nextResizeBox, type ResizeState, type ResizeHandle } from '../helpers/resize';

// Modifier keys held during a resize move.
export type ResizeModifiers = { shiftKey?: boolean };

// The resize as it started, and whether its latest box kept the start box's
// w/h: a corner handle moved with modifiers and no Shift.
export type ResizeGesture = ResizeState & { keptRatio: boolean };

export type UseOverlayResizeArgs = {
  scale: number;
  // Called on every pointer move with the new box, current rotation and the
  // gesture. Use for cheap, side-effect-only previews (e.g. direct DOM
  // mutation) — do NOT re-render the canvas here. What must re-render (an
  // overlay drawn from its box) subscribes to its own live size instead.
  onPreview: (
    elementId: string,
    box: { x: number; y: number; w: number; h: number },
    rotation: number,
    gesture: ResizeGesture,
  ) => void;
  // Called once on pointer up with the final box (unrounded), and only when the
  // box changed: a press and release in place commits nothing. `gesture` is the
  // resize as it started (handle, start box with its rotation), which
  // `roundResizedBox` needs to round about the pinned point, and whether the
  // final box kept the ratio. Commit React state here.
  onCommit?: (
    elementId: string,
    box: { x: number; y: number; w: number; h: number },
    gesture: ResizeGesture,
  ) => void | Promise<void>;
};

export type UseOverlayResizeReturn = {
  onPointerDown: (
    elementId: string,
    handle: ResizeHandle,
    cursor: { x: number; y: number },
    box: { x: number; y: number; w: number; h: number; rotation?: number },
  ) => void;
  // With `modifiers` (the keys held), corner handles keep the box's aspect ratio
  // and Shift held frees it. Without them the resize is free, as it was before
  // modifiers existed. Side handles always move one side.
  onPointerMove: (cursor: { x: number; y: number }, modifiers?: ResizeModifiers) => void;
  onPointerUp: () => void;
};

export function useOverlayResize({ scale, onPreview, onCommit }: UseOverlayResizeArgs): UseOverlayResizeReturn {
  const stateRef = useRef<ResizeState | null>(null);
  const latestRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const rotationRef = useRef<number>(0);
  const keptRatioRef = useRef(false);

  const onPointerDown = useCallback(
    (
      elementId: string,
      handle: ResizeHandle,
      cursor: { x: number; y: number },
      box: { x: number; y: number; w: number; h: number; rotation?: number },
    ) => {
      stateRef.current = startResize(elementId, handle, cursor, box);
      rotationRef.current = box.rotation ?? 0;
      keptRatioRef.current = false;
      // Nothing to commit until the pointer moves.
      latestRef.current = null;
    },
    [],
  );

  const onPointerMove = useCallback(
    (cursor: { x: number; y: number }, modifiers?: ResizeModifiers) => {
      const s = stateRef.current;
      if (!s) return;
      // A caller that passes no modifiers gets the free resize it always had; one
      // that passes them keeps the corner's ratio unless Shift is held.
      const keepRatio = modifiers ? !modifiers.shiftKey : false;
      const box = nextResizeBox(s, cursor, scale, { keepRatio });
      latestRef.current = box;
      // Side handles move one side whatever is held.
      keptRatioRef.current = keepRatio && s.handle.length === 2;
      onPreview(s.elementId, box, rotationRef.current, { ...s, keptRatio: keptRatioRef.current });
    },
    [scale, onPreview],
  );

  const onPointerUp = useCallback(() => {
    const s = stateRef.current;
    const final = latestRef.current;
    stateRef.current = null;
    latestRef.current = null;
    if (!s || !final) return;
    const b = s.startBox;
    if (final.x === b.x && final.y === b.y && final.w === b.w && final.h === b.h) return;
    void onCommit?.(s.elementId, final, { ...s, keptRatio: keptRatioRef.current });
  }, [onCommit]);

  return { onPointerDown, onPointerMove, onPointerUp };
}

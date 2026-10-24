import { useCallback, useRef } from 'react';
import { startResize, nextResizeBox, type ResizeState, type ResizeHandle } from '../helpers/resize';

// Modifier keys held during a resize move.
export type ResizeModifiers = { shiftKey?: boolean };

export type UseOverlayResizeArgs = {
  scale: number;
  // Called on every pointer move with the new box and current rotation. Use for
  // cheap, side-effect-only previews (e.g. direct DOM mutation) — do NOT trigger
  // React state updates here.
  onPreview: (
    elementId: string,
    box: { x: number; y: number; w: number; h: number },
    rotation: number,
  ) => void;
  // Called once on pointer up with the final box (unrounded), and only when the
  // box changed: a press and release in place commits nothing. `gesture` is the
  // resize as it started (handle, start box with its rotation), which
  // `roundResizedBox` needs to round about the pinned point. Commit React state
  // here.
  onCommit?: (
    elementId: string,
    box: { x: number; y: number; w: number; h: number },
    gesture: ResizeState,
  ) => void | Promise<void>;
};

export type UseOverlayResizeReturn = {
  onPointerDown: (
    elementId: string,
    handle: ResizeHandle,
    cursor: { x: number; y: number },
    box: { x: number; y: number; w: number; h: number; rotation?: number },
  ) => void;
  // Corner handles keep the box's aspect ratio; Shift held frees it. Side
  // handles always move one side.
  onPointerMove: (cursor: { x: number; y: number }, modifiers?: ResizeModifiers) => void;
  onPointerUp: () => void;
};

export function useOverlayResize({ scale, onPreview, onCommit }: UseOverlayResizeArgs): UseOverlayResizeReturn {
  const stateRef = useRef<ResizeState | null>(null);
  const latestRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const rotationRef = useRef<number>(0);

  const onPointerDown = useCallback(
    (
      elementId: string,
      handle: ResizeHandle,
      cursor: { x: number; y: number },
      box: { x: number; y: number; w: number; h: number; rotation?: number },
    ) => {
      stateRef.current = startResize(elementId, handle, cursor, box);
      rotationRef.current = box.rotation ?? 0;
      // Nothing to commit until the pointer moves.
      latestRef.current = null;
    },
    [],
  );

  const onPointerMove = useCallback(
    (cursor: { x: number; y: number }, modifiers?: ResizeModifiers) => {
      const s = stateRef.current;
      if (!s) return;
      const box = nextResizeBox(s, cursor, scale, { keepRatio: !modifiers?.shiftKey });
      latestRef.current = box;
      onPreview(s.elementId, box, rotationRef.current);
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
    void onCommit?.(s.elementId, final, s);
  }, [onCommit]);

  return { onPointerDown, onPointerMove, onPointerUp };
}

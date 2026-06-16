import { useCallback, useRef } from 'react';
import { startRotate, nextRotation, type RotateState } from '../helpers/rotate';

export type UseOverlayRotateArgs = {
  // Called on every pointer move with the new rotation and the element's (x, y).
  // Use for cheap, side-effect-only previews (e.g. direct DOM mutation) — do NOT
  // trigger React state updates here.
  onPreview: (elementId: string, rotation: number, x: number, y: number) => void;
  // Called once on pointer up with the final rotation. Commit React state here.
  onCommit?: (elementId: string, rotation: number) => void | Promise<void>;
};

export type UseOverlayRotateReturn = {
  onPointerDown: (
    elementId: string,
    center: { x: number; y: number },
    cursor: { x: number; y: number },
    currentRotation: number,
    position: { x: number; y: number },
  ) => void;
  onPointerMove: (cursor: { x: number; y: number }) => void;
  onPointerUp: () => void;
};

export function useOverlayRotate({ onPreview, onCommit }: UseOverlayRotateArgs): UseOverlayRotateReturn {
  const stateRef = useRef<RotateState | null>(null);
  const latestRef = useRef<{ id: string; rotation: number } | null>(null);
  const positionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (
      elementId: string,
      center: { x: number; y: number },
      cursor: { x: number; y: number },
      currentRotation: number,
      position: { x: number; y: number },
    ) => {
      stateRef.current = startRotate(elementId, center, cursor, currentRotation);
      positionRef.current = position;
      latestRef.current = { id: elementId, rotation: currentRotation };
    },
    [],
  );

  const onPointerMove = useCallback(
    (cursor: { x: number; y: number }) => {
      const s = stateRef.current;
      if (!s) return;
      const rotation = nextRotation(s, cursor);
      latestRef.current = { id: s.elementId, rotation };
      onPreview(s.elementId, rotation, positionRef.current.x, positionRef.current.y);
    },
    [onPreview],
  );

  const onPointerUp = useCallback(() => {
    const final = latestRef.current;
    stateRef.current = null;
    latestRef.current = null;
    if (final) void onCommit?.(final.id, final.rotation);
  }, [onCommit]);

  return { onPointerDown, onPointerMove, onPointerUp };
}

import { useCallback, useRef } from 'react';
import { startResize, nextResizeBox, type ResizeState, type ResizeHandle } from '../helpers/resize';

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
  // Called once on pointer up with the final box. Commit React state here.
  onCommit?: (elementId: string, box: { x: number; y: number; w: number; h: number }) => void | Promise<void>;
};

export type UseOverlayResizeReturn = {
  onPointerDown: (
    elementId: string,
    handle: ResizeHandle,
    cursor: { x: number; y: number },
    box: { x: number; y: number; w: number; h: number; rotation?: number },
  ) => void;
  onPointerMove: (cursor: { x: number; y: number }) => void;
  onPointerUp: () => void;
};

export function useOverlayResize({ scale, onPreview, onCommit }: UseOverlayResizeArgs): UseOverlayResizeReturn {
  const stateRef = useRef<ResizeState | null>(null);
  const latestRef = useRef<{ id: string; box: { x: number; y: number; w: number; h: number } } | null>(null);
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
      latestRef.current = { id: elementId, box };
    },
    [],
  );

  const onPointerMove = useCallback(
    (cursor: { x: number; y: number }) => {
      const s = stateRef.current;
      if (!s) return;
      const box = nextResizeBox(s, cursor, scale);
      latestRef.current = { id: s.elementId, box };
      onPreview(s.elementId, box, rotationRef.current);
    },
    [scale, onPreview],
  );

  const onPointerUp = useCallback(() => {
    const final = latestRef.current;
    stateRef.current = null;
    latestRef.current = null;
    if (final) void onCommit?.(final.id, final.box);
  }, [onCommit]);

  return { onPointerDown, onPointerMove, onPointerUp };
}

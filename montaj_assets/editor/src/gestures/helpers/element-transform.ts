// Builds the CSS `transform` value for an element wrapper. Centralised so
// React renders (JSX style) and in-gesture mutations (direct DOM style
// writes in SlideCanvas) produce byte-identical strings — that prevents
// the wrapper from "snapping" on commit when React's render writes a
// slightly different transform than the one the DOM already has.

export function buildElementTransform(
  x: number,
  y: number,
  scale: number,
  rotation: number | undefined | null,
): string {
  const base = `translate(${x * scale}px, ${y * scale}px)`
  return rotation ? `${base} rotate(${rotation}deg)` : base
}

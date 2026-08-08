// Shared positioner for caption segments. Lives here (rather than as a sibling
// file under render/templates/captions/) because caption templates are loaded
// by two different mechanisms — render's esbuild bundle (real filesystem
// import resolution) and the UI's in-browser eval (overlay-eval.ts strips all
// import statements and injects only the globals this package produces via
// makeOverlayGlobals). A bare relative import from a template would resolve
// in the first and silently fail in the second, so these live where every
// other cross-context primitive (interpolate, spring, ...) already lives, and
// reach templates the same way: re-exported through 'montaj/render' and
// injected as a preview global.
//
// Segment offsets are percent-of-frame, matching overlay/video items. Split
// into two boxes so the percentages have the right basis:
//  - OUTER: position fixed, inset 0 — exactly frame-sized in both the Puppeteer
//    viewport and the editor preview (the preview's scaled design-resolution
//    container is a transformed ancestor, which makes `fixed` resolve against
//    it). translate% on this box therefore IS percent-of-frame.
//  - INNER: the template's historical anchor (bottom/left/right/padding) plus
//    segment scale, scaled around its own center so a bottom-anchored caption
//    grows in place instead of drifting toward frame center.

/**
 * @param {{ offsetX?: number, offsetY?: number }} [seg]
 * @returns {object} style for the frame-sized outer wrapper
 */
export function captionOuterStyle(seg) {
  const ox = seg?.offsetX ?? 0
  const oy = seg?.offsetY ?? 0
  const style = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }
  if (ox || oy) style.transform = `translate(${ox}%, ${oy}%)`
  return style
}

/**
 * @param {{ scale?: number }} [seg]
 * @param {object} anchor - the template's existing wrapper style MINUS
 *   `position: 'fixed'`, switched to `position: 'absolute'` (it now positions
 *   inside the outer box).
 * @returns {object} style for the inner anchor box
 */
export function captionInnerStyle(seg, anchor) {
  const sc = seg?.scale ?? 1
  const style = { position: 'absolute', ...anchor }
  if (sc !== 1) { style.transform = `scale(${sc})`; style.transformOrigin = 'center center' }
  return style
}

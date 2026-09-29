// Compat shim — kept because in-tree consumers still import via this path:
//   - render-carousel.js (its shim writes `import { interpolate, spring } from 'montaj/render'`)
//   - Caption templates (all seven, under templates/captions/) — also import
//     captionOuterStyle/captionInnerStyle from here, the per-segment position
//     helpers. They can't import a sibling `_position.js` file directly: the
//     editor preview evaluates template source via overlay-eval.ts, which
//     strips every import statement and only injects globals produced by
//     montaj-overlay-runtime's makeOverlayGlobals(). Re-exporting through
//     this file (which IS aliased in both the esbuild bundle below and the
//     preview's global injection) keeps the two consumers in sync the same
//     way interpolate/spring already do.
//   - bundle.js's esbuild alias config maps 'montaj/render' here
// User-authored overlay JSX mostly uses bare globals, but it may also import
// 'montaj/render', which resolves here. We forward to the runtime so there's exactly one source
// of truth for the implementations.
export {
  interpolate,
  spring,
  useThreeFrame,
  captionOuterStyle,
  captionInnerStyle,
} from 'montaj-overlay-runtime'

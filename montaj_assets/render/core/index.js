// Compat shim — kept because in-tree consumers still import via this path:
//   - render-carousel.js (its shim writes `import { interpolate, spring } from 'montaj/render'`)
//   - Caption templates (karaoke.jsx, pop.jsx, subtitle.jsx, word-by-word.jsx)
//   - bundle.js's esbuild alias config maps 'montaj/render' here
// User-authored overlay JSX (inspected via `grep -rn` across /Users/Sam/Montaj
// projects) uses bare globals only and would not need this — but the in-tree
// consumers above do. We forward to the runtime so there's exactly one source
// of truth for the implementations.
export {
  interpolate,
  spring,
  useThreeFrame,
} from 'montaj-overlay-runtime'

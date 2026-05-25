import { createElement } from 'react'
import { Canvas as R3FCanvas } from '@react-three/fiber'

// r3f measures its container via react-use-measure, which by default uses
// getBoundingClientRect() to determine the canvas size. In the Montaj UI
// preview, the design canvas (1080×1920) sits inside a CSS-transformed
// ancestor (`transform: scale(0.x)`) that fits the preview pane. With the
// default measurement, r3f reads the *post-transform* rect (e.g. 245×113 px)
// and sizes the WebGL canvas + camera frustum for that tiny region — making
// the rendered 3D content appear shrunk relative to the rest of the overlay.
//
// `react-use-measure` exposes `offsetSize: true` as the escape hatch for
// exactly this case: it uses `element.offsetWidth/offsetHeight` instead, which
// are layout-space dimensions unaffected by ancestor CSS transforms. r3f's
// Canvas exposes the underlying measurement options via the `resize` prop.
// The render context does NOT need this — it runs in a full 1080×1920 layout
// inside Puppeteer with no CSS transform ancestor.
const PREVIEW_RESIZE_OPTS = {
  scroll: true,
  debounce: { scroll: 50, resize: 0 },
  offsetSize: true,
}

/**
 * Returns a Canvas component configured for the given context.
 *
 *   - 'render':  r3f's Canvas, unchanged. Respects user-authored
 *                frameloop="never" (mandated for render-correctness).
 *
 *   - 'preview': a wrapper that *overrides* the user's frameloop prop to
 *                "always". In preview, frameloop="never" would mean the Canvas
 *                never draws (nothing calls window.__renderThree in the live
 *                editor). Forcing "always" lets r3f's internal RAF loop drive
 *                the scene. The trade-off: preview is RAF-driven and not
 *                perfectly frame-accurate to a scrubbed video position, but
 *                it's visually correct — sufficient for "what will this look
 *                like" review. Also forces offsetSize-based measurement so
 *                ancestor CSS transforms don't shrink the rendered scene.
 */
export function makeCanvas(context) {
  if (context === 'render') return R3FCanvas
  if (context === 'preview') {
    // Warn ONCE per session if an author passes frameloop="never" and we're
    // overriding it. Authors follow the skill's render-correctness rule
    // (frameloop="never" is mandatory for render) and we silently change it in
    // preview — visibility helps diagnose "why does preview look different
    // from render" without forcing every JSX file to know about contexts.
    let warned = false
    return function PreviewCanvas(props) {
      if (!warned && props.frameloop === 'never') {
        // eslint-disable-next-line no-console
        console.warn(
          '[montaj-overlay-runtime] preview Canvas: overriding frameloop="never" → "always" ' +
          'so r3f\'s RAF loop drives the scene. Render keeps frameloop="never". ' +
          'See skills/write-overlay/SKILL.md "3D / Three.js" section.',
        )
        warned = true
      }
      return createElement(R3FCanvas, {
        ...props,
        frameloop: 'always',
        resize: PREVIEW_RESIZE_OPTS,
      })
    }
  }
  throw new Error(`makeCanvas: unknown context ${context}`)
}

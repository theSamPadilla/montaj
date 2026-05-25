import { createElement, useEffect } from 'react'
import { Canvas as R3FCanvas, useThree } from '@react-three/fiber'

// r3f measures its container via react-use-measure, which (despite our passing
// `offsetSize: true` via the `resize` prop) ends up using the post-transform
// `getBoundingClientRect()` dimensions for the canvas style + WebGL viewport.
// In the Montaj UI preview, the design canvas (1080×1920) sits inside a
// CSS-transformed ancestor (`transform: scale(0.x)`) that fits the preview
// pane, so r3f sees e.g. 245×113 px and sets canvas.style.width=247px. The
// ancestor transform then scales the canvas *visually* by another 0.x, so 3D
// content renders at ~5× shrinkage relative to where the same JSX places it
// in the final MP4. Visible symptom: in preview the cube appears tiny and
// off-center, but in the rendered .mp4 it's correctly sized.
//
// We patch this by mounting a child component inside <Canvas> that calls
// `gl.setSize(parent.offsetWidth, parent.offsetHeight)` from inside r3f's
// state, then re-applies on any subsequent resize via ResizeObserver. The
// `offsetWidth`/`offsetHeight` of the canvas's parent (r3f's measurement div)
// are unaffected by ancestor transforms, so we get layout-space dimensions
// here even though r3f's own measurement does not.
//
// The render context does NOT need this — it runs in a full 1080×1920 layout
// inside Puppeteer with no CSS transform ancestor.
function PreviewForceSize() {
  const gl = useThree((s) => s.gl)
  const setSize = useThree((s) => s.setSize)
  useEffect(() => {
    const canvas = gl.domElement
    const measureFrom = canvas.parentElement // r3f's containerRef div, sized 100%/100% of the user's overlay container
    if (!measureFrom) return
    let raf = 0
    const apply = () => {
      const w = measureFrom.offsetWidth
      const h = measureFrom.offsetHeight
      if (w > 0 && h > 0) setSize(w, h, true)
    }
    apply()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    })
    ro.observe(measureFrom)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [gl, setSize])
  return null
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
    return function PreviewCanvas({ children, ...rest }) {
      if (!warned && rest.frameloop === 'never') {
        // eslint-disable-next-line no-console
        console.warn(
          '[montaj-overlay-runtime] preview Canvas: overriding frameloop="never" → "always" ' +
          'so r3f\'s RAF loop drives the scene. Render keeps frameloop="never". ' +
          'See skills/write-overlay/SKILL.md "3D / Three.js" section.',
        )
        warned = true
      }
      const kids = Array.isArray(children) ? children : (children == null ? [] : [children])
      return createElement(
        R3FCanvas,
        { ...rest, frameloop: 'always' },
        createElement(PreviewForceSize, { key: '__montaj_force_size__' }),
        ...kids,
      )
    }
  }
  throw new Error(`makeCanvas: unknown context ${context}`)
}

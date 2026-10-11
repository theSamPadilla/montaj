import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Canvas as R3FCanvas } from '@react-three/fiber'
import { THREE_MARK, ThreeCommitProbe } from './three-bridge.js'

// Preview sizing. The editor preview fits the design canvas (e.g. 1080×1920)
// into its pane with an ancestor CSS `transform: scale(s)`. r3f measures its
// container with react-use-measure, which by default reads
// getBoundingClientRect(): the POST-transform size. r3f then sizes the canvas
// (style and drawing buffer) to that shrunk rect, and the ancestor transform
// shrinks it again, so the scene drew as a small box in the top-left corner.
// r3f re-applies its measured size on every render of <Canvas> (a layout
// effect calls root.configure({ size })), and the editor re-renders overlays
// every frame and every scrub, so correcting the size once is not enough: the
// measurement itself has to be right.
//
// The preview Canvas therefore passes `resize: { offsetSize: true }`, which
// makes react-use-measure (2.1.x) report the container's
// offsetWidth/offsetHeight: layout-space, unaffected by ancestor transforms.
// Measured in render/test/preview-canvas-offset-size.puppeteer.test.mjs.
//
// The render context does NOT need this: it runs in a full 1080×1920 layout
// inside Puppeteer with no CSS transform ancestor.
//
// Preview drawing buffer (§208). Sized from the layout size, the buffer was the
// design size times devicePixelRatio (2160×3840 on a Retina Mac) for a canvas
// shown a few hundred pixels wide, redrawn every animation frame with MSAA:
// measured 28 fps paused on a 3D overlay. The preview Canvas therefore passes
// r3f a `dpr` of devicePixelRatio × shown width / layout width (previewDpr), so
// the buffer matches the pixels on screen (97 fps). It is measured after every
// render (the editor re-renders overlays each frame and each scrub, and an
// ancestor transform fires no ResizeObserver) and on a window resize. An
// author's own `dpr` is for render; the preview ignores it. Render is unchanged.
const MIN_PREVIEW_DPR = 0.25
const MAX_PREVIEW_DPR = 2

/** The preview Canvas's dpr: the screen pixels per layout pixel, clamped. */
export function previewDpr(devicePixelRatio, shownWidth, layoutWidth) {
  const screen = devicePixelRatio > 0 ? devicePixelRatio : 1
  if (!(shownWidth > 0) || !(layoutWidth > 0)) return Math.min(MAX_PREVIEW_DPR, screen)
  return Math.min(MAX_PREVIEW_DPR, Math.max(MIN_PREVIEW_DPR, (screen * shownWidth) / layoutWidth))
}

/**
 * Returns a Canvas component configured for the given context.
 *
 *   - 'render':  r3f's Canvas. Respects user-authored frameloop="never"
 *                (mandated for render-correctness). Such a Canvas also marks
 *                its host element with the frame it was rendered for
 *                (THREE_MARK) and mounts a ThreeCommitProbe in its scene, so
 *                the shim's drawThreeFrame (three-bridge.js) can wait for r3f
 *                to commit that frame and know whether it drew. Any other
 *                frameloop gets r3f's Canvas unchanged.
 *
 *   - 'preview': a wrapper that *overrides* the user's frameloop prop to
 *                "always". In preview, frameloop="never" would mean the Canvas
 *                never draws (nothing calls window.__renderThree in the live
 *                editor). Forcing "always" lets r3f's internal RAF loop drive
 *                the scene. The trade-off: preview is RAF-driven and not
 *                perfectly frame-accurate to a scrubbed video position, but
 *                it's visually correct — sufficient for "what will this look
 *                like" review. Also measures its container with offsetSize
 *                (resize: { offsetSize: true }) so ancestor CSS transforms
 *                don't shrink the rendered scene, and draws at the shown size
 *                (dpr from previewDpr), not the layout size.
 */
export function makeCanvas(context) {
  if (context === 'render') {
    return function RenderCanvas({ children, ...rest }) {
      if (rest.frameloop !== 'never') return createElement(R3FCanvas, rest, children)
      // The shim sets window.frame before committing a frame; r3f spreads
      // unknown props onto its host <div>, which carries the mark.
      const token = String(window.frame)
      const kids = Array.isArray(children) ? children : (children == null ? [] : [children])
      return createElement(
        R3FCanvas,
        { ...rest, [THREE_MARK]: token },
        createElement(ThreeCommitProbe, { key: '__montaj_three_commit__', token }),
        ...kids,
      )
    }
  }
  if (context === 'preview') {
    // Warn ONCE per session if an author passes frameloop="never" and we're
    // overriding it. Authors follow the skill's render-correctness rule
    // (frameloop="never" is mandatory for render) and we silently change it in
    // preview — visibility helps diagnose "why does preview look different
    // from render" without forcing every JSX file to know about contexts.
    let warned = false
    return function PreviewCanvas({ children, ref: authorRef, ...rest }) {
      const canvasRef = useRef(null)
      const [dpr, setDpr] = useState(1)
      const measure = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const next = previewDpr(window.devicePixelRatio, canvas.getBoundingClientRect().width, canvas.offsetWidth)
        // A sub-2% change is rounding: never a re-render for it.
        setDpr((prev) => (Math.abs(next - prev) > prev * 0.02 ? next : prev))
      }, [])
      useLayoutEffect(measure)
      useEffect(() => {
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [measure])
      const ref = useCallback((el) => {
        canvasRef.current = el
        if (typeof authorRef === 'function') authorRef(el)
        else if (authorRef) authorRef.current = el
      }, [authorRef])
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
        { ...rest, ref, dpr, frameloop: 'always', resize: { offsetSize: true, ...rest.resize } },
        ...kids,
      )
    }
  }
  throw new Error(`makeCanvas: unknown context ${context}`)
}


import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { makeOverlayGlobals } from 'montaj-overlay-runtime'
import Component from "/abs/overlay.jsx"

// Overlay components use frame, fps, duration, props, interpolate, spring, Ph, FaIcon,
// FaSolid, FaBrands, THREE, Canvas, useThreeFrame as bare globals (no imports, no props
// destructuring). Inject them onto window so bare-identifier access resolves correctly
// inside the component.
// NOTE: do NOT use esbuild define for these — define rewrites to the import alias name
// which esbuild renames during bundling, making the reference undefined at runtime.
const __overlayGlobals = makeOverlayGlobals('render')
for (const [__k, __v] of Object.entries(__overlayGlobals)) {
  window[__k] = __v
}
window.fps         = 30
window.duration    = 90
window.props       = {"title":"hi","img":"file:///abs/pic.png"}
window.frame       = 0

const __props = {"title":"hi","img":"file:///abs/pic.png"}
let __setFrame

function App() {
  const [frame, setFrame] = useState(0)
  __setFrame = setFrame
  window.frame = frame  // keep global in sync with React state during render
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Component
        frame={frame}
        fps={30}
        duration={90}
        {...__props}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)

// flushSync makes React process the state update synchronously within this call,
// so the DOM is fully updated before Puppeteer takes the next screenshot.
// After flushSync, stamp the rendered frame number onto the root element so
// Puppeteer can use waitForFunction to confirm the DOM reflects the right frame
// before taking the screenshot (rAF-only waits are unreliable in headless Chrome).
//
// Block frame 0 paint on document.fonts.ready so any Google Fonts declared in
// the page <head> are fully loaded before the first screenshot (otherwise the
// first frames flash a CSS fallback). 5s timeout so a flaky network can't stall
// the render; on timeout we proceed and frames paint with whatever fallback the
// JSX declared. After the first call settles, subsequent calls re-use the same
// resolved promise (effectively free).
//
// __setFrame is defined synchronously — renderer.js does a one-shot
// `typeof window.__setFrame === 'function'` check right after page.goto and
// gating that on a promise would race. The fonts-ready wait happens inside the
// function, on the first call only.
//
// We read `document.fonts.ready` lazily on the first call, not at shim eval
// time, because the FontFaceSet.ready promise reflects only loads that are
// pending *when accessed*. If we capture it before React has committed any
// font-family styles to the DOM, the browser hasn't kicked off the woff2 load
// yet and ready resolves immediately. By first __setFrame call, React's initial
// render has committed and any required font fetches are in flight.
let __fontsReadyPromise
function __waitForFonts() {
  if (__fontsReadyPromise) return __fontsReadyPromise
  __fontsReadyPromise = Promise.race([
    document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise(resolve => setTimeout(() => {
      console.warn('[montaj] document.fonts.ready timed out after 5s — rendering with fallback')
      resolve()
    }, 5000)),
  ])
  return __fontsReadyPromise
}
window.__setFrame = async (n) => {
  await __waitForFonts()
  window.frame = n  // update global before React re-renders
  flushSync(() => __setFrame?.(n))
  // If the overlay mounted a <Canvas> and called useThreeFrame, force Three's
  // WebGL draw to complete now so Puppeteer's next screenshot reflects this
  // frame. No-op for overlays that don't use Three (the global is never set).
  window.__renderThree?.()
  document.documentElement.dataset.renderedFrame = String(n)
}

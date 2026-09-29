
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
let __setEpoch

// Set whenever a webfont finishes loading; __setFrame clears it by remounting
// the overlay. Registered before the first mount so the mount's own font
// loads count.
let __fontsDirty = false
document.fonts?.addEventListener('loadingdone', () => { __fontsDirty = true })

function App() {
  const [frame, setFrame] = useState(0)
  const [epoch, setEpoch] = useState(0)
  __setFrame = setFrame
  __setEpoch = setEpoch
  window.frame = frame  // keep global in sync with React state during render
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Component
        key={epoch}
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
//
// Waiting is not enough on its own: the overlay MOUNTED before its font loaded,
// so anything it measured at mount used fallback metrics, and a re-render does
// not fix that. `flushSync(() => __setFrame(0))` sets a value React already
// holds, so frame 0 does not even re-render, and an effect keyed on `frame` or
// a mount-only (`[]`) effect never re-runs at the same frame. Measured
// (PV50 T1, Bebas Neue 160px): words laid out at 60,383,608 instead of
// 60,333,547 on frame 0 for an overlay measuring per frame, and on EVERY frame
// of every chunk for one measuring once at mount. So when a font has finished
// loading since the overlay last committed (`__fontsDirty`, set by
// `loadingdone`), the commit also bumps the overlay's `key` and it remounts,
// measuring again with the real metrics. The remount uses faces that are
// already loaded, so it starts no load of its own and cannot loop.
//
// A face the overlay first uses on a later frame is not covered by the one-shot
// wait above (T1: Oswald first used on frame 10 was captured in fallback). So
// after each commit we force a layout, which starts the load of any face that
// commit introduced (measured: `document.fonts.status` reads 'loading' only
// after layout), and if a new load is in flight we wait for it, with the same
// 5s cap, and remount again. `__fontsWaitedOn` is the `ready` promise last
// waited on; the browser keeps one per loading episode, so a face that never
// loads costs the 5s once rather than on every frame.
//
// An overlay that loads no font never sets the flag and never remounts, so its
// frames are byte-identical to what they were before the remount existed.
let __fontsReadyPromise
let __fontsWaitedOn
function __fontsReadyOrTimeout() {
  __fontsWaitedOn = document.fonts ? document.fonts.ready : undefined
  return Promise.race([
    __fontsWaitedOn ?? Promise.resolve(),
    new Promise(resolve => setTimeout(() => {
      console.warn('[montaj] document.fonts.ready timed out after 5s — rendering with fallback')
      resolve()
    }, 5000)),
  ])
}
function __waitForFonts() {
  if (__fontsReadyPromise) return __fontsReadyPromise
  __fontsReadyPromise = __fontsReadyOrTimeout()
  return __fontsReadyPromise
}
function __remount() {
  __fontsDirty = false
  __setEpoch?.(e => e + 1)
}
// A remounted <Canvas> builds a new WebGL renderer, and r3f does that
// asynchronously: the old useThreeFrame deletes `__renderThree` during the
// remount and the new one registers a few animation frames later (measured:
// about 70ms), after this frame would already have been captured blank. So after
// a remount, wait for a fresh registration, capped at 2s.
function __threeRemounted(previous) {
  const deadline = performance.now() + 2000
  return new Promise(resolve => {
    const poll = () => {
      const current = window.__renderThree
      if (current && current !== previous) return resolve()
      if (performance.now() > deadline) {
        console.warn('[montaj] Three.js canvas did not re-register within 2s of a font remount')
        return resolve()
      }
      requestAnimationFrame(poll)
    }
    poll()
  })
}
window.__setFrame = async (n) => {
  await __waitForFonts()
  window.frame = n  // update global before React re-renders
  let three = window.__renderThree
  let remounted = __fontsDirty
  flushSync(() => {
    __setFrame?.(n)
    if (__fontsDirty) __remount()
  })
  document.documentElement.getBoundingClientRect()
  if (document.fonts?.status === 'loading' && document.fonts.ready !== __fontsWaitedOn) {
    await __fontsReadyOrTimeout()
    three = window.__renderThree ?? three
    flushSync(__remount)
    remounted = true
  }
  if (remounted && three) await __threeRemounted(three)
  // If the overlay mounted a <Canvas> and called useThreeFrame, force Three's
  // WebGL draw to complete now so Puppeteer's next screenshot reflects this
  // frame. No-op for overlays that don't use Three (the global is never set).
  window.__renderThree?.()
  document.documentElement.dataset.renderedFrame = String(n)
}

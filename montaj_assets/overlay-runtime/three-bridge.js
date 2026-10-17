import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { makeAccumulator } from './three-blur.js'

/**
 * Returns a `useThreeFrame()` hook configured for the given context.
 *
 *   - 'render':  registers this canvas's draw (gl.render, then gl.finish(),
 *                which blocks until the GPU has flushed) for `drawThreeFrame`,
 *                which the Puppeteer shim calls inside __setFrame before the
 *                screenshot. Also still sets window.__renderThree to it.
 *   - 'preview': no-op. The preview-context Canvas wrapper forces
 *                frameloop="always", so r3f's internal RAF loop handles the
 *                drawing. Authors still call useThreeFrame() (it's mandated by
 *                the skill) but in preview it just returns without doing
 *                anything.
 */
export function makeUseThreeFrame(context) {
  if (context === 'render') {
    return function useThreeFrame() {
      const gl     = useThree(s => s.gl)
      const scene  = useThree(s => s.scene)
      const camera = useThree(s => s.camera)
      useLayoutEffect(() => {
        const rawGL = gl.getContext()
        const draw = () => {
          gl.render(scene, camera)
          rawGL.finish()
        }
        const entry = threeEntry(gl.domElement)
        entry.draw = draw
        entry.gl = rawGL
        // The renderer too: motion blur's GL runs in its context and resets its state after (three-blur.js).
        entry.renderer = gl
        // Taken while the context is live: a lost context returns no extensions.
        entry.loseExt = rawGL.getExtension('WEBGL_lose_context')
        wake(entry)
        window.__renderThree = draw
        return () => {
          if (entry.draw === draw) entry.draw = null
          if (window.__renderThree === draw) delete window.__renderThree
        }
      }, [gl, scene, camera])
    }
  }
  if (context === 'preview') {
    return function useThreeFrame() { /* no-op — r3f's RAF handles drawing */ }
  }
  throw new Error(`makeUseThreeFrame: unknown context ${context}`)
}

// ---------------------------------------------------------------------------
// Drawing a frame-stepped 3D canvas, and knowing it drew
// ---------------------------------------------------------------------------
//
// A <Canvas frameloop="never"> draws only when the shim asks it to, and these
// left that draw silently missing, so the frame was captured with the canvas
// blank (only what is behind it). Each was forced and measured (PL85.1 T6):
//   - r3f mounts its root asynchronously (a ResizeObserver measure, an async
//     configure, a concurrent commit), after the page has loaded. A frame set
//     before that found no draw registered, and `__renderThree?.()` drew nothing.
//   - A lost WebGL context draws nothing, whether lost before the draw or
//     between it and the capture.
//   - Resizing the canvas after the draw clears it.
// r3f also commits each frame's props asynchronously, after the shim's
// synchronous draw, so a draw showed the previous frame's scene, and the first
// frame of a fresh page showed frame 0's.
//
// So the render-context Canvas marks its host element with the frame it was
// rendered for (THREE_MARK), a probe inside its r3f tree records the frame r3f
// has committed, and useThreeFrame registers the draw. drawThreeFrame waits for
// every marked canvas to have committed this frame, with a draw and a live
// context, then draws each, and names the first that could not be drawn.
// threeCaptureCheck says whether a canvas lost its drawing after that.

/** The attribute on a frame-stepped Canvas's host element: the frame it was rendered for. */
export const THREE_MARK = 'data-montaj-three'

/**
 * How long one drawThreeFrame waits for its canvases, in ms; events end the
 * wait early. A page may set `window.__montajThreeWaitMs` before its first
 * frame to shorten it (the tests do, to fail fast).
 */
export const THREE_WAIT_MS = 5000

const entries = new WeakMap() // canvas element → its entry
let lastDrawn = []

function threeEntry(canvas) {
  let entry = entries.get(canvas)
  if (entry) return entry
  entry = { draw: null, gl: null, renderer: null, loseExt: null, committed: undefined, losses: 0, waiters: new Set(), blur: null }
  canvas.addEventListener('webglcontextlost', () => { entry.losses++; wake(entry) })
  canvas.addEventListener('webglcontextrestored', () => wake(entry))
  entries.set(canvas, entry)
  return entry
}

function wake(entry) {
  for (const waiter of [...entry.waiters]) waiter()
}

/**
 * Mounted by the render-context Canvas inside its r3f tree: records the frame
 * r3f has committed. It is a sibling of the overlay's own scene in the same
 * commit, so once its layout effect runs the scene holds that frame's props.
 */
export function ThreeCommitProbe({ token }) {
  const gl = useThree(s => s.gl)
  useLayoutEffect(() => {
    const entry = threeEntry(gl.domElement)
    entry.committed = token
    wake(entry)
  }, [gl, token])
  return null
}

function notDrawable(entry, token) {
  if (entry.committed !== token) return 'not_rendered'
  if (!entry.draw) return 'no_bridge'
  if (entry.gl.isContextLost()) return 'context_lost'
  return null
}

// Resolves with null once the canvas can be drawn for `token`, 'gone' if its
// host leaves the page meanwhile (an overlay that threw unmounts), or with why
// not at the deadline. The canvas's own events end the wait at once; a poll
// covers the rest. A lost context is asked to restore (three.js prevents the
// lost event's default, so the browser allows it).
function drawable(entry, token, deadline, host) {
  return new Promise(resolve => {
    let timer = 0
    const done = (reason) => {
      entry.waiters.delete(check)
      clearTimeout(timer)
      resolve(reason)
    }
    const check = () => {
      if (!host.isConnected) return done('gone')
      const reason = notDrawable(entry, token)
      if (!reason) return done(null)
      const left = deadline - performance.now()
      if (left <= 0) return done(reason)
      if (reason === 'context_lost') {
        try { entry.loseExt?.restoreContext() } catch {}
      }
      clearTimeout(timer)
      timer = setTimeout(check, Math.min(50, left))
    }
    entry.waiters.add(check)
    check()
  })
}

/**
 * Draws every 3D canvas on the page for the frame just committed.
 *
 * Returns null when the page has no frame-stepped canvas, without waiting. A
 * page with one gets `{ canvases, blank }`, where `blank` is null when every
 * canvas drew, else the first reason one did not: `not_rendered` (r3f had not
 * rendered this frame), `no_bridge` (no useThreeFrame() in the Canvas) or
 * `context_lost`.
 *
 * A canvas whose host is laid out at zero size is skipped: r3f never mounts
 * one, and there is nothing of it to see. A canvas with another frameloop
 * draws itself; one with a useThreeFrame() is still drawn here, as before.
 */
export async function drawThreeFrame({ waitMs = window.__montajThreeWaitMs ?? THREE_WAIT_MS } = {}) {
  const hosts = [...document.querySelectorAll(`[${THREE_MARK}]`)]
  for (const canvas of document.querySelectorAll('canvas')) {
    if (canvas.closest(`[${THREE_MARK}]`)) continue
    const entry = entries.get(canvas)
    if (!entry?.draw) continue
    entry.draw()
    // It also draws itself, on its own loop, so an average of it would not hold until the capture.
    if (pass) pass.unsupported ??= 'unstepped_canvas'
  }
  lastDrawn = []
  if (hosts.length === 0) return null
  const deadline = performance.now() + waitMs
  let blank = null
  for (const host of hosts) {
    const canvas = host.querySelector('canvas')
    if (!canvas || host.offsetWidth === 0 || host.offsetHeight === 0) continue
    const entry = threeEntry(canvas)
    const reason = await drawable(entry, host.getAttribute(THREE_MARK), deadline, host)
    if (reason === 'gone') continue
    if (reason) { blank ??= reason; continue }
    entry.draw()
    if (entry.gl.isContextLost()) { blank ??= 'context_lost'; continue }
    // Motion blur in the page: added now, before anything can clear what was just drawn.
    if (pass) addToPass(canvas, entry)
    lastDrawn.push({ canvas, entry, losses: entry.losses, width: canvas.width, height: canvas.height })
  }
  return { canvases: hosts.length, blank }
}

/**
 * After the capture: null when every canvas the last drawThreeFrame drew still
 * holds that drawing, else why one does not (`context_lost`, `resized`).
 */
export function threeCaptureCheck() {
  for (const d of lastDrawn) {
    if (!d.canvas.isConnected) continue
    if (d.entry.losses !== d.losses || d.entry.gl.isContextLost()) return 'context_lost'
    if (d.canvas.width !== d.width || d.canvas.height !== d.height) return 'resized'
  }
  return null
}

// ---------------------------------------------------------------------------
// Motion blur, averaged in the page (§377)
// ---------------------------------------------------------------------------
//
// A motion-blurred frame of a 3D overlay used to be N screenshots, one per
// sub-frame, averaged by the chunk's ffmpeg. averageThreeFrames sets and draws
// each sub-frame instead (through the shim's own __setFrame, so exactly as an
// unblurred frame is set and drawn), adds every canvas's drawing into that
// canvas's float accumulator right after the draw (three-blur.js), and after
// the last sub-frame draws each canvas's average onto it: one capture per frame.
//
// Only the 3D canvases are averaged. The rest of the page shows the last
// sub-frame, which is right for a 3D stage, whose page is its canvas over a
// still background (a CSS filter on the canvas then applies to the average,
// not to each sub-frame). A page that cannot be averaged says so up front
// ({ unsupported }), and the renderer captures every sub-frame as before.

let pass = null // the averageThreeFrames in progress: { id, count, canvases, unsupported, broken }
let passes = 0

// Adds what `canvas` just drew to its accumulator, made on its first use and
// remade after a lost context (which takes every GL object with it). The first
// sub-frame of a pass starts the sums at zero, so nothing carries over from the
// last output frame.
function addToPass(canvas, entry) {
  if (pass.unsupported) return
  const gl = entry.gl
  try {
    if (entry.blur && entry.blur.losses !== entry.losses) entry.blur = null
    entry.blur ??= { gpu: makeAccumulator(gl, entry.renderer), losses: entry.losses, pass: 0, count: 0 }
    const acc = entry.blur
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (acc.pass !== pass.id) {
      acc.gpu.begin(w, h)
      acc.pass = pass.id
      acc.count = 0
    } else if (acc.gpu.width !== w || acc.gpu.height !== h) {
      pass.broken ??= 'resized'
      return
    }
    acc.gpu.add()
    acc.count++
    pass.canvases.set(canvas, entry)
  } catch (err) {
    entry.blur = null
    pass.unsupported ??= err?.reason ?? 'no_float_target'
  }
}

// Draws each canvas's average onto it. Null once all are drawn, else why the
// pass cannot stand (the frame is then set again): a canvas that lost its
// context or was resized since its first sub-frame, or one drawn for fewer
// than every sub-frame (a Canvas remounted mid-frame).
function presentPass() {
  if (pass.broken) return pass.broken
  const shown = []
  for (const [canvas, entry] of pass.canvases) {
    if (!canvas.isConnected || canvas.offsetWidth === 0 || canvas.offsetHeight === 0) continue
    const acc = entry.blur
    if (!acc || acc.pass !== pass.id || acc.losses !== entry.losses || entry.gl.isContextLost()) return 'context_lost'
    if (acc.gpu.width !== entry.gl.drawingBufferWidth || acc.gpu.height !== entry.gl.drawingBufferHeight) return 'resized'
    if (acc.count !== pass.count) return 'subframes_missed'
    shown.push(acc)
  }
  for (const acc of shown) acc.gpu.present(acc.count)
  return null
}

/**
 * Sets the page to each sub-frame time in `times` with `setFrame` (the shim's
 * __setFrame), and draws the average of every 3D canvas's sub-frames onto it.
 *
 * Returns what the last `setFrame` returned (`{ canvases, blank }`), with
 * `blank` set when a sub-frame did not draw (and `frame`, the sub-frame's
 * time) or the average could not be drawn: the caller sets the whole frame
 * again, as it retries any blank frame. Returns `{ unsupported: reason }`,
 * right after the first sub-frame, when the page cannot average: no 3D canvas
 * (`no_canvas`), a canvas that also draws itself (`unstepped_canvas`), or one
 * that cannot hold a float target (three-blur.js blurUnsupported).
 *
 * @param {number[]} times
 * @param {(t: number) => Promise<{ canvases: number, blank: string|null } | null>} setFrame
 */
export async function averageThreeFrames(times, setFrame) {
  pass = { id: ++passes, count: 0, canvases: new Map(), unsupported: null, broken: null }
  try {
    let three = null
    for (const t of times) {
      three = await setFrame(t)
      pass.count++
      if (!three) return { unsupported: 'no_canvas' }
      if (pass.unsupported) return { unsupported: pass.unsupported }
      if (three.blank) return { ...three, frame: t }
    }
    const broken = presentPass()
    return broken ? { ...three, blank: broken } : three
  } finally {
    pass = null
  }
}

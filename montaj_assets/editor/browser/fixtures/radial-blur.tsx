// The page for browser/radial-blur.test.mjs: the preview's spin and zoom pass
// (src/video/preview/radialBlurGL.ts and RadialBlurSurface.tsx) against
// timeline-core's CPU reference, in the same page, on synthetic pictures.
import { createRoot } from 'react-dom/client'
import { createRef } from 'react'
import { flushSync } from 'react-dom'
import { radialBlurPlan, radialBlurReference } from '@bycrux/timeline-core'
import { drawRadialBlur, radialBlurDebug, type FracRect } from '../../src/video/preview/radialBlurGL'
import RadialBlurSurface, { type RadialBlurSurfaceHandle } from '../../src/video/preview/RadialBlurSurface'

type Kind = 'spin' | 'zoom'

declare global {
  interface Window {
    __ready: boolean
    __webgl2: boolean
    __compare: typeof compare
    __timing: typeof timing
    __videoSurface: typeof videoSurface
    __videoState: typeof videoState
    __video: () => HTMLVideoElement | null
    __surface: typeof surface
    __surfaceState: () => { canvases: number; status: boolean[] }
    __lose: () => boolean
    __restore: () => boolean
    __redraw: () => void
  }
}

/** A detailed opaque picture (gradients, rings, a checker, hard edges), or with an alpha ramp. */
function picture(w: number, h: number, alpha: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1d3b8f')
  g.addColorStop(0.5, '#e8c547')
  g.addColorStop(1, '#b8325a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  for (let y = 0; y < h; y += 8) for (let x = (y / 8) % 2 ? 8 : 0; x < w * 0.4; x += 16) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, y, 8, 8)
  }
  ctx.lineWidth = 3
  for (let r = 6; r < Math.max(w, h); r += 14) {
    ctx.strokeStyle = r % 28 ? '#0b0b0b' : '#40e0d0'
    ctx.beginPath()
    ctx.arc(w * 0.65, h * 0.45, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = '#ff2020'
  ctx.fillRect(w - 18, 4, 14, 14)
  if (alpha) {
    // Alpha falls from 1 on the left to 0.25 on the right; a fully transparent hole.
    const img = ctx.getImageData(0, 0, w, h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const hole = Math.hypot(x - w * 0.3, y - h * 0.6) < h * 0.15
      img.data[o + 3] = hole ? 0 : Math.round(255 * (1 - 0.75 * (x / (w - 1))))
    }
    ctx.putImageData(img, 0, 0)
  }
  return c
}

interface CompareCase {
  type: Kind
  amount: number
  /** Fractions of the box. */
  center: { x: number; y: number }
  /** The picture's size in pixels (the source's), and the box it sits in (the target). */
  pic: { w: number; h: number }
  box: { w: number; h: number }
  /** Where the picture sits in the box, whole pixels. */
  at: { x: number; y: number }
  /** 'picture': the source is the picture alone; 'engine': the source spans the box, black around the picture. */
  source?: 'picture' | 'engine'
  alpha?: boolean
}

/** GL against the CPU reference on one case: worst and mean differences in codes, inside the picture. */
function compare(c: CompareCase) {
  const pic = picture(c.pic.w, c.pic.h, !!c.alpha)
  const pictureRect: FracRect = { x: c.at.x / c.box.w, y: c.at.y / c.box.h, w: c.pic.w / c.box.w, h: c.pic.h / c.box.h }
  let source: HTMLCanvasElement = pic
  let sourceRect: FracRect | undefined
  if (c.source === 'engine') {
    source = document.createElement('canvas')
    source.width = c.box.w
    source.height = c.box.h
    const ctx = source.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, c.box.w, c.box.h)
    ctx.drawImage(pic, c.at.x, c.at.y)
    sourceRect = pictureRect
  }
  const target = document.createElement('canvas')
  target.width = c.box.w
  target.height = c.box.h
  const t0 = performance.now()
  const res = drawRadialBlur({ source, target, type: c.type, amount: c.amount, center: c.center, pictureRect, sourceRect })
  const ms = performance.now() - t0
  if (res !== 'drawn') return { res }
  const got = target.getContext('2d')!.getImageData(0, 0, c.box.w, c.box.h).data

  const center: [number, number] = [c.center.x * c.box.w - c.at.x, c.center.y * c.box.h - c.at.y]
  const plan = radialBlurPlan({ type: c.type, amount: c.amount, center, rect: c.pic })
  const img = pic.getContext('2d')!.getImageData(0, 0, c.pic.w, c.pic.h)
  const ref = radialBlurReference(img, { type: c.type, plan, center })

  let worst = 0
  let sum = 0
  let n = 0
  let moved = 0
  let worstAlpha = 0
  let outside = 0
  for (let y = 0; y < c.box.h; y++) for (let x = 0; x < c.box.w; x++) {
    const o = (y * c.box.w + x) * 4
    const inside = x >= c.at.x && x < c.at.x + c.pic.w && y >= c.at.y && y < c.at.y + c.pic.h
    if (!inside) { outside = Math.max(outside, got[o + 3]); continue }
    const r = ((y - c.at.y) * c.pic.w + (x - c.at.x)) * 4
    const a = Math.round(ref.data[r + 3] * 255)
    worstAlpha = Math.max(worstAlpha, Math.abs(got[o + 3] - a))
    // Colour where it is seen well enough to read back (getImageData unpremultiplies 8-bit values).
    if (a < 128) continue
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(got[o + ch] - Math.round(ref.data[r + ch] * 255))
      worst = Math.max(worst, d)
      sum += d
      moved += Math.abs(got[o + ch] - img.data[r + ch])
      n++
    }
  }
  return {
    res, worst, mean: sum / Math.max(1, n), moved: moved / Math.max(1, n), worstAlpha, outside, ms,
    passes: plan.passes.length, taps: plan.passes[0]?.taps.length ?? 0, travel: plan.travel,
  }
}

// ── The React surface ───────────────────────────────────────────────────────

const status: boolean[] = []
const handle = createRef<RadialBlurSurfaceHandle>()
let surfaceRoot: ReturnType<typeof createRoot> | null = null

/** Mounts a RadialBlurSurface over a `w` x `h` box on a picture canvas; resolves its pixels (or null). */
function surface(o: { type: Kind; amount: number; w: number; h: number; center: { x: number; y: number } }) {
  const host = document.getElementById('surface')!
  host.style.cssText = `position:relative;width:${o.w}px;height:${o.h}px`
  const source = picture(o.w, o.h, false)
  surfaceRoot ??= createRoot(host)
  flushSync(() => surfaceRoot!.render(
    <RadialBlurSurface ref={handle} source={source} type={o.type} amount={o.amount} center={o.center}
      pictureRect={{ x: 0, y: 0, w: 1, h: 1 }} onStatus={(s) => status.push(s)} />,
  ))
  const canvas = host.querySelector('canvas')
  // The same blur drawn directly, to compare.
  const direct = document.createElement('canvas')
  direct.width = o.w
  direct.height = o.h
  drawRadialBlur({ source, target: direct, type: o.type, amount: o.amount, center: o.center, pictureRect: { x: 0, y: 0, w: 1, h: 1 } })
  if (!canvas) return { mounted: false, status: [...status] }
  const a = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const b = direct.getContext('2d')!.getImageData(0, 0, o.w, o.h).data
  let worst = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return { mounted: true, width: canvas.width, height: canvas.height, worst, status: [...status] }
}

/** Mean ms a draw at `w` x `h` takes, read back each time (getImageData waits for the GPU). */
function timing(o: { type: Kind; amount: number; w: number; h: number; runs: number }) {
  const source = picture(o.w, o.h, false)
  const target = document.createElement('canvas')
  target.width = o.w
  target.height = o.h
  const ctx = target.getContext('2d', { willReadFrequently: false })!
  const job = { source, target, type: o.type, amount: o.amount, center: { x: 0.5, y: 0.5 }, pictureRect: { x: 0, y: 0, w: 1, h: 1 } }
  drawRadialBlur(job)
  ctx.getImageData(0, 0, 1, 1)
  const t0 = performance.now()
  for (let i = 0; i < o.runs; i++) { drawRadialBlur(job); ctx.getImageData(0, 0, 1, 1) }
  return (performance.now() - t0) / o.runs
}

/** A <video> source (mounted at opacity 0, as the host keeps it) under a surface; counts its draws. */
let videoDraws = 0
let videoEl: HTMLVideoElement | null = null
function videoSurface(src: string) {
  const host = document.getElementById('video')!
  host.style.cssText = 'position:relative;width:90px;height:160px'
  videoEl = document.createElement('video')
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.src = src
  videoEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0'
  host.appendChild(videoEl)
  const layer = document.createElement('div')
  layer.style.cssText = 'position:absolute;inset:0'
  host.appendChild(layer)
  createRoot(layer).render(
    <RadialBlurSurface source={videoEl} type="spin" amount={40} center={{ x: 0.5, y: 0.5 }}
      pictureRect={{ x: 0, y: 0, w: 1, h: 1 }} onDraw={() => { videoDraws++ }} />,
  )
}
/** Draws so far, and how much of the surface is painted (alpha > 0). */
function videoState() {
  const canvas = document.querySelector('#video canvas') as HTMLCanvasElement | null
  let painted = 0
  if (canvas && canvas.width > 0) {
    const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++
    painted /= d.length / 4
  }
  return { draws: videoDraws, painted, time: videoEl?.currentTime ?? 0, paused: videoEl?.paused ?? true }
}

window.__compare = compare
window.__videoSurface = videoSurface
window.__videoState = videoState
window.__video = () => videoEl
window.__timing = timing
window.__surface = surface
window.__surfaceState = () => ({ canvases: document.querySelectorAll('#surface canvas').length, status: [...status] })
window.__redraw = () => handle.current?.draw()
// Taken while the context is live: a lost context answers no extensions.
let loser: WEBGL_lose_context | null = null
window.__lose = () => {
  loser = radialBlurDebug.context()?.getExtension('WEBGL_lose_context') ?? null
  loser?.loseContext()
  return !!loser
}
window.__restore = () => {
  loser?.restoreContext()
  return !!loser
}
window.__webgl2 = !!new OffscreenCanvas(1, 1).getContext('webgl2')
window.__ready = true

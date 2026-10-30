// The page for browser/radial-blur.test.mjs: the preview's spin and zoom pass
// (src/video/preview/radialBlurGL.ts and RadialBlurSurface.tsx) against
// timeline-core's CPU reference, in the same page, on synthetic pictures.
import { createRoot } from 'react-dom/client'
import { createRef } from 'react'
import { flushSync } from 'react-dom'
import { radialBlurPlan, radialBlurReference } from '@bycrux/timeline-core'
import { drawRadialBlur, radialBlurDebug, type FracRect } from '../../src/video/preview/radialBlurGL'
import RadialBlurSurface, { type RadialBlurSurfaceHandle } from '../../src/video/preview/RadialBlurSurface'
import CroppedImage from '../../src/video/preview/CroppedImage'
import { radialBlurSpec } from '../../src/video/preview/itemBlur'
import type { VisualItem } from '../../src/schema'

type Kind = 'spin' | 'zoom'

declare global {
  interface Window {
    __ready: boolean
    __webgl2: boolean
    __compare: typeof compare
    __preview: typeof preview
    __timing: typeof timing
    __videoSurface: typeof videoSurface
    __videoState: typeof videoState
    __video: () => HTMLVideoElement | null
    __surface: typeof surface
    __surfaceState: () => { canvases: number; status: boolean[] }
    __lose: () => boolean
    __restore: () => boolean
    __redraw: () => void
    __specMount: typeof specMount
    __specDraw: typeof specDraw
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

/**
 * The preview's pixels for one case, for the export parity test: the picture
 * (RGBA, straight, its own size) and what the pass drew over the box (RGBA as
 * getImageData reads it), both as plain arrays.
 */
function preview(c: CompareCase) {
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
  const res = drawRadialBlur({ source, target, type: c.type, amount: c.amount, center: c.center, pictureRect, sourceRect })
  if (res !== 'drawn') return { res }
  return {
    res,
    picture: Array.from(pic.getContext('2d')!.getImageData(0, 0, c.pic.w, c.pic.h).data),
    got: Array.from(target.getContext('2d')!.getImageData(0, 0, c.box.w, c.box.h).data),
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

// ── The real mapping (itemBlur.tsx radialBlurSpec) ──────────────────────────
//
// A clip's media mounted sharp the way the preview mounts it (CroppedImage
// with its fit and crop in the media box; the engine's canvas spanning the
// box with black bars around the picture), so the test can screenshot what
// the browser shows; then the pass drawn from that same element with the
// rects radialBlurSpec gives. The test blurs the screenshot with the
// reference over the spec's picture rect: a wrong rect or source rect puts
// the blurred picture somewhere the screenshot does not.

interface SpecCase {
  kind: 'image' | 'engine'
  fit?: 'cover' | 'contain' | 'fill'
  crop?: { x: number; y: number; w: number; h: number }
  /** The image's natural size, or the footage's (engine). */
  natural: { w: number; h: number }
  /** The design canvas (square here) and the clip's box scale on it; the box is canvas x scale CSS px. */
  canvas: number
  scaleX: number
  scaleY: number
  type: Kind
  amount: number
  center: { x: number; y: number }
}

/** Smooth, medium-frequency colour (so resampling differs by little but a misplaced picture by a lot). */
function smooth(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    const u = x / w
    const v = y / h
    img.data[o] = 128 + 110 * Math.sin(u * 9 + v * 2)
    img.data[o + 1] = 128 + 110 * Math.sin(v * 8 - u * 3 + 1)
    img.data[o + 2] = 128 + 110 * Math.sin((u + v) * 6 + 2)
    img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

let specRoot: ReturnType<typeof createRoot> | null = null

/** Mounts the case's media in #spec (the box, CSS px), sharp; resolves once it shows. */
async function specMount(c: SpecCase) {
  const host = document.getElementById('spec')!
  const bw = c.canvas * c.scaleX
  const bh = c.canvas * c.scaleY
  host.style.cssText = `position:relative;width:${bw}px;height:${bh}px;background:#fff;overflow:hidden`
  specRoot?.unmount()
  host.innerHTML = ''
  specRoot = createRoot(host)
  if (c.kind === 'engine') {
    // The engine canvas spans the box: black, the footage contain-fitted in it.
    const canvas = document.createElement('canvas')
    canvas.width = bw
    canvas.height = bh
    canvas.dataset.montajEngineCanvas = ''
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, bw, bh)
    // At fractional positions, as the engine's draw plan places it (scheduler.ts).
    const k = Math.min(bw / c.natural.w, bh / c.natural.h)
    const w = c.natural.w * k
    const h = c.natural.h * k
    ctx.drawImage(smooth(c.natural.w, c.natural.h), (bw - w) / 2, (bh - h) / 2, w, h)
    host.appendChild(canvas)
    return { box: { w: bw, h: bh } }
  }
  const src = smooth(c.natural.w, c.natural.h).toDataURL('image/png')
  flushSync(() => specRoot!.render(<CroppedImage src={src} crop={c.crop} fit={c.fit ?? 'contain'} boxWidth={bw} boxHeight={bh} />))
  const img = host.querySelector('img')!
  if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }))
  // A cropped image re-renders once its natural size is known.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return { box: { w: bw, h: bh } }
}

/** The pass drawn from the mounted element with radialBlurSpec's rects; the spec and the pixels. */
function specDraw(c: SpecCase) {
  const host = document.getElementById('spec')!
  const source = (c.kind === 'engine' ? host.querySelector('canvas') : host.querySelector('img')) as HTMLCanvasElement | HTMLImageElement
  const item = (c.kind === 'engine'
    ? { id: 'v', type: 'video', src: 'v.mp4', start: 0, end: 1, sourceWidth: c.natural.w, sourceHeight: c.natural.h }
    : { id: 'i', type: 'image', src: 'i.png', start: 0, end: 1, fit: c.fit }) as unknown as VisualItem
  Object.assign(item, { blur: c.amount, blurType: c.type, blurX: c.center.x, blurY: c.center.y })
  const spec = radialBlurSpec({
    item, crop: c.crop, fit: c.fit, renderScale: 1, canvasW: c.canvas, canvasH: c.canvas,
    scaleX: c.scaleX, scaleY: c.scaleY, engineCanvas: c.kind === 'engine',
  }, c.kind === 'engine' ? null : c.natural)
  if (!spec) return { res: 'nospec' as const }
  const target = document.createElement('canvas')
  target.width = c.canvas * c.scaleX
  target.height = c.canvas * c.scaleY
  const res = drawRadialBlur({ source, target, type: spec.type, amount: spec.amount, center: spec.center,
    pictureRect: spec.pictureRect, sourceRect: spec.sourceRect })
  if (res !== 'drawn') return { res }
  return {
    res, pictureRect: spec.pictureRect, sourceRect: spec.sourceRect ?? null, center: spec.center,
    got: Array.from(target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data),
  }
}

window.__specMount = specMount
window.__specDraw = specDraw
window.__compare = compare
window.__preview = preview
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

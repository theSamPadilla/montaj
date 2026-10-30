// Spin and zoom blurs in the preview: one shared WebGL2 context that draws
// every blurred clip, the maths of timeline-core `radialBlurReference`.
//
// The export draws the same blur with ffmpeg (render item-blur.js), from the
// same plan (timeline-core `radialBlurPlan`). The CPU reference is the
// contract both meet; editor/browser/radial-blur.test.mjs measures this pass
// against it in a real Chromium.
//
// ── One context ─────────────────────────────────────────────────────────────
// A single WebGL2 context on an OffscreenCanvas renders every blurred clip and
// copies each result into that clip's own 2D canvas (`drawImage`), so many
// clips never reach the browser's limit on live contexts, and a lost context
// recovers in one place: `onRadialBlurRestored` tells every surface to redraw.
//
// ── The passes ──────────────────────────────────────────────────────────────
// Working textures are the picture's size plus a one-texel transparent border
// on every side (allocated at the largest size seen; a draw uses the corner).
//
//   1. FIT: the source, cut to `sourceRect` (the crop, or the picture's place
//      on an engine canvas), resampled bilinear to the picture's size in the
//      target's pixels. The source uploads PREMULTIPLIED
//      (UNPACK_PREMULTIPLY_ALPHA_WEBGL), so this resample and everything after
//      runs on premultiplied colour, as the reference does.
//   2. BLUR, one draw per plan pass, ping-ponging two textures: for each tap,
//      a hardware-bilinear read of the previous result at the tap's inverse
//      map (timeline-core `radialTapInverse`) about the centre. The border is
//      0 and a read whose point lies past it is skipped, so every texel
//      outside the picture counts 0: the reference's rule. Each pass writes 0
//      outside the picture, so the next reads only the picture.
//   3. OUT: colour divided by the summed alpha (the renormalisation), times
//      the fitted source pixel's alpha; premultiplied for the drawing buffer.
//      Where the summed alpha is 0, the source pixel.
//
// FORMATS. The working textures are RGBA16F when the context can render to
// them (EXT_color_buffer_float), else RGBA8: the division by the summed alpha
// magnifies the rounding of an 8-bit premultiplied colour, as the export's
// 16-bit note says.
//
// COLOURS. Encoded sRGB values, no linearising, as ffmpeg works: the drawing
// buffer and the unpack colour space are 'srgb', and no texture is an sRGB
// format (which would linearise on read).
//
// ALPHA. The context has premultipliedAlpha: true; the OUT pass writes
// premultiplied colour, and the 2D canvas it is drawn into stores it as is.
//
// FAILURE. No WebGL2 or OffscreenCanvas, or a lost context: `drawRadialBlur`
// answers 'unsupported' or 'lost' and draws nothing, and one console warning
// says so; the host shows the source unblurred. After `webglcontextrestored`
// the programs are rebuilt and every subscriber redraws.

import { radialBlurPlan, radialTapInverse } from '@bycrux/timeline-core'

/** What a blurred clip's picture is read from. */
export type RadialBlurSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap

/** A rect as fractions of its whole. */
export interface FracRect { x: number; y: number; w: number; h: number }

export interface RadialBlurJob {
  source: RadialBlurSource
  /** The 2D canvas that receives the result; its backing size is the working resolution. It fills the clip's box. */
  target: HTMLCanvasElement | OffscreenCanvas
  type: 'spin' | 'zoom'
  /** Degrees (spin) or percent (zoom), timeline-core `blurOf`. */
  amount: number
  /** The centre, fractions of the box (timeline-core `blurCenterOf`). */
  center: { x: number; y: number }
  /** The picture's rect in the box, fractions (timeline-core `pictureRectInBox`). */
  pictureRect: FracRect
  /** The part of the source that fills the picture, fractions of the source: the crop, or for an engine canvas
   *  spanning the box, the picture's rect itself. The whole source when absent. */
  sourceRect?: FracRect
}

/** 'drawn'; 'empty' (the source has no frame yet, or no picture: the target is left as it was);
 *  'unsupported' (no WebGL2) or 'lost' (the context is lost): nothing drawn, show the source. */
export type RadialBlurResult = 'drawn' | 'empty' | 'unsupported' | 'lost'

/** The most taps a pass takes (timeline-core RADIAL_MAX_TAPS): the shader's uniform array. */
const MAX_TAPS = 12

/** The short edge the working resolution is capped at, as the export's design canvas. */
export const RADIAL_WORK_SHORT_EDGE = 1080

/**
 * The working resolution for a box `cssW` x `cssH` CSS pixels drawn at `scale`
 * (the box's own on-screen scale, 1 when none) on a `dpr` display: its device
 * pixels, capped so the short edge is at most 1080, halved for `half`.
 */
export function radialWorkSize(cssW: number, cssH: number, dpr: number, scale = 1, half = false): { w: number; h: number } {
  const k = (Number.isFinite(dpr) && dpr > 0 ? dpr : 1) * (Number.isFinite(scale) && scale > 0 ? scale : 1)
  let w = cssW * k
  let h = cssH * k
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 }
  const short = Math.min(w, h)
  if (short > RADIAL_WORK_SHORT_EDGE) {
    w *= RADIAL_WORK_SHORT_EDGE / short
    h *= RADIAL_WORK_SHORT_EDGE / short
  }
  if (half) { w /= 2; h /= 2 }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) }
}

// ── Shaders ─────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// Picture pixel coordinates: q = gl_FragCoord.xy - 1 (the one-texel border),
// a pixel's centre at i + 0.5, row 0 the picture's top.
const FIT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uPic;
uniform vec4 uSrcRect;
out vec4 o;
void main() {
  vec2 q = gl_FragCoord.xy - 1.0;
  if (q.x < 0.0 || q.y < 0.0 || q.x > uPic.x || q.y > uPic.y) { o = vec4(0.0); return; }
  o = texture(uSrc, uSrcRect.xy + q / uPic * uSrcRect.zw);
}`

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uIn;
uniform vec2 uTex;
uniform vec2 uPic;
uniform vec2 uC;
uniform int uN;
uniform vec4 uTap[${MAX_TAPS}];
out vec4 o;
void main() {
  vec2 q = gl_FragCoord.xy - 1.0;
  if (q.x < 0.0 || q.y < 0.0 || q.x > uPic.x || q.y > uPic.y) { o = vec4(0.0); return; }
  vec2 d = q - uC;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    if (i >= uN) break;
    vec4 t = uTap[i];
    vec2 p = uC + vec2(t.x * d.x - t.y * d.y, t.y * d.x + t.x * d.y);
    if (p.x <= -0.5 || p.y <= -0.5 || p.x >= uPic.x + 0.5 || p.y >= uPic.y + 0.5) continue;
    acc += t.z * texture(uIn, (p + 1.0) / uTex);
  }
  o = acc;
}`

// Drawn into the drawing buffer's top-left pw x ph (viewport y = height - ph):
// the buffer's row 0 is its bottom, so the picture's row is height - y.
const OUT = `#version 300 es
precision highp float;
uniform sampler2D uAcc;
uniform sampler2D uFit;
uniform float uTop;
out vec4 o;
void main() {
  ivec2 t = ivec2(vec2(gl_FragCoord.x, uTop - gl_FragCoord.y)) + 1;
  vec4 acc = texelFetch(uAcc, t, 0);
  vec4 src = texelFetch(uFit, t, 0);
  vec3 rgb = acc.a > 1e-5 ? acc.rgb / acc.a * src.a : src.rgb;
  o = vec4(min(rgb, vec3(src.a)), src.a);
}`

// ── The shared context ──────────────────────────────────────────────────────

interface Program { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

interface GLState {
  canvas: OffscreenCanvas
  gl: WebGL2RenderingContext
  lost: boolean
  fit: Program
  blur: Program
  out: Program
  vao: WebGLVertexArrayObject
  srcTex: WebGLTexture
  work: { tex: WebGLTexture; fb: WebGLFramebuffer }[]
  texW: number
  texH: number
  float: boolean
}

let state: GLState | null = null
let failed = false
const restoreListeners = new Set<() => void>()
const warned = new Set<string>()

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`montaj: ${message}; spin and zoom blurs show unblurred in the preview (the export still blurs).`)
}

function compile(gl: WebGL2RenderingContext, frag: string, names: string[]): Program {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`radial blur shader: ${gl.getShaderInfoLog(s)}`)
    }
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`radial blur program: ${gl.getProgramInfoLog(prog)}`)
  }
  const u: Program['u'] = {}
  for (const n of names) u[n] = gl.getUniformLocation(prog, n)
  return { prog, u }
}

function texture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

/** Programs, textures and framebuffers on a fresh (or restored) context. */
function build(canvas: OffscreenCanvas, gl: WebGL2RenderingContext): GLState {
  const g = gl as WebGL2RenderingContext & { unpackColorSpace?: string; drawingBufferColorSpace?: string }
  if ('drawingBufferColorSpace' in g) g.drawingBufferColorSpace = 'srgb'
  if ('unpackColorSpace' in g) g.unpackColorSpace = 'srgb'
  const float = !!gl.getExtension('EXT_color_buffer_float')
  const vao = gl.createVertexArray()!
  const work = [0, 1, 2].map(() => ({ tex: texture(gl, gl.LINEAR), fb: gl.createFramebuffer()! }))
  return {
    canvas, gl, lost: false, vao, work, texW: 0, texH: 0, float,
    fit: compile(gl, FIT, ['uSrc', 'uPic', 'uSrcRect']),
    blur: compile(gl, BLUR, ['uIn', 'uTex', 'uPic', 'uC', 'uN', 'uTap']),
    out: compile(gl, OUT, ['uAcc', 'uFit', 'uTop']),
    srcTex: texture(gl, gl.LINEAR),
  }
}

function context(): GLState | null {
  if (state) return state
  if (failed) return null
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas')
    const canvas = new OffscreenCanvas(1, 1)
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('no WebGL2')
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      if (state) state.lost = true
      warnOnce('lost', 'the WebGL2 context was lost')
    })
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        state = build(canvas, gl)
      } catch {
        failed = true
        state = null
        return
      }
      warned.delete('lost')
      for (const cb of [...restoreListeners]) cb()
    })
    state = build(canvas, gl)
    return state
  } catch (e) {
    failed = true
    warnOnce('unsupported', `no WebGL2 for the preview's blur (${(e as Error).message})`)
    return null
  }
}

/** Whether the shared WebGL2 context exists (creating it on first ask) and is not lost. */
export function radialBlurAvailable(): boolean {
  const s = context()
  return !!s && !s.lost && !s.gl.isContextLost()
}

/** Calls `cb` after a lost context is restored, so the caller redraws. Returns the unsubscribe. */
export function onRadialBlurRestored(cb: () => void): () => void {
  restoreListeners.add(cb)
  return () => { restoreListeners.delete(cb) }
}

function sourceSize(s: RadialBlurSource): { w: number; h: number } {
  if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) {
    return s.readyState >= 2 ? { w: s.videoWidth, h: s.videoHeight } : { w: 0, h: 0 }
  }
  if (typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement) {
    return s.complete ? { w: s.naturalWidth, h: s.naturalHeight } : { w: 0, h: 0 }
  }
  return { w: s.width, h: s.height }
}

function ensureWork(s: GLState, w: number, h: number) {
  if (w <= s.texW && h <= s.texH) return
  const { gl } = s
  s.texW = Math.max(w, s.texW)
  s.texH = Math.max(h, s.texH)
  for (const { tex, fb } of s.work) {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (s.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, s.texW, s.texH, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.texW, s.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}

const taps = new Float32Array(MAX_TAPS * 4)

/**
 * Draws a spin or zoom blur of `job.source` into `job.target` (cleared first;
 * transparent outside the picture). See the header for what each pass does.
 */
export function drawRadialBlur(job: RadialBlurJob): RadialBlurResult {
  const s = context()
  if (!s) return 'unsupported'
  const { gl } = s
  if (s.lost || gl.isContextLost()) return 'lost'
  const W = job.target.width
  const H = job.target.height
  const src = sourceSize(job.source)
  if (!(W > 0 && H > 0 && src.w > 0 && src.h > 0)) return 'empty'

  // The picture in the target's pixels, whole pixels.
  const r = job.pictureRect
  const rx = Math.round(r.x * W)
  const ry = Math.round(r.y * H)
  const pw = Math.round((r.x + r.w) * W) - rx
  const ph = Math.round((r.y + r.h) * H) - ry
  if (!(pw > 0 && ph > 0)) return 'empty'
  const cx = job.center.x * W - rx
  const cy = job.center.y * H - ry
  const plan = radialBlurPlan({ type: job.type, amount: job.amount, center: [cx, cy], rect: { w: pw, h: ph } })

  ensureWork(s, pw + 2, ph + 2)
  if (s.canvas.width < pw || s.canvas.height < ph) {
    s.canvas.width = Math.max(pw, s.canvas.width)
    s.canvas.height = Math.max(ph, s.canvas.height)
  }
  gl.bindVertexArray(s.vao)
  gl.disable(gl.BLEND)

  // 1. Fit.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.srcTex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, job.source as TexImageSource)
  const sr = job.sourceRect ?? { x: 0, y: 0, w: 1, h: 1 }
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.work[0].fb)
  gl.viewport(0, 0, pw + 2, ph + 2)
  gl.useProgram(s.fit.prog)
  gl.uniform1i(s.fit.u.uSrc, 0)
  gl.uniform2f(s.fit.u.uPic, pw, ph)
  gl.uniform4f(s.fit.u.uSrcRect, sr.x, sr.y, sr.w, sr.h)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // 2. Blur passes, ping-pong between work[1] and work[2].
  let last = 0
  gl.useProgram(s.blur.prog)
  gl.uniform1i(s.blur.u.uIn, 0)
  gl.uniform2f(s.blur.u.uTex, s.texW, s.texH)
  gl.uniform2f(s.blur.u.uPic, pw, ph)
  gl.uniform2f(s.blur.u.uC, cx, cy)
  plan.passes.forEach((pass, k) => {
    const n = Math.min(MAX_TAPS, pass.taps.length)
    taps.fill(0)
    for (let i = 0; i < n; i++) {
      const [a, b] = radialTapInverse(job.type, pass.taps[i].offset)
      taps.set([a, b, pass.taps[i].weight, 0], i * 4)
    }
    const into = k % 2 === 0 ? 1 : 2
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.work[into].fb)
    gl.bindTexture(gl.TEXTURE_2D, s.work[last].tex)
    gl.uniform1i(s.blur.u.uN, n)
    gl.uniform4fv(s.blur.u.uTap, taps)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    last = into
  })

  // 3. Out, into the drawing buffer's top-left pw x ph.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, s.canvas.height - ph, pw, ph)
  gl.useProgram(s.out.prog)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.work[last].tex)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, s.work[0].tex)
  gl.uniform1i(s.out.u.uAcc, 0)
  gl.uniform1i(s.out.u.uFit, 1)
  gl.uniform1f(s.out.u.uTop, s.canvas.height)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.activeTexture(gl.TEXTURE0)
  if (gl.isContextLost()) return 'lost'

  const ctx = job.target.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) return 'unsupported'
  ctx.clearRect(0, 0, W, H)
  ctx.drawImage(s.canvas, 0, 0, pw, ph, rx, ry, pw, ph)
  return 'drawn'
}

/**
 * Calls `onFrame` on every frame `video` presents (`requestVideoFrameCallback`:
 * playback, and the frame a seek lands on), falling back to animation frames
 * while it plays where that is missing. Returns the stop.
 */
export function watchVideoFrames(video: HTMLVideoElement, onFrame: () => void): () => void {
  let stopped = false
  if (typeof video.requestVideoFrameCallback === 'function') {
    let id = 0
    const tick = () => {
      if (stopped) return
      onFrame()
      id = video.requestVideoFrameCallback(tick)
    }
    id = video.requestVideoFrameCallback(tick)
    return () => { stopped = true; video.cancelVideoFrameCallback(id) }
  }
  let raf = 0
  const loop = () => {
    if (stopped) return
    if (!video.paused) onFrame()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  return () => { stopped = true; cancelAnimationFrame(raf) }
}

/** Test hooks: the shared context (to lose and restore it), and forgetting it so the next draw makes a new one. */
export const radialBlurDebug = {
  context: (): WebGL2RenderingContext | null => state?.gl ?? null,
  reset(): void {
    state = null
    failed = false
    warned.clear()
  },
}

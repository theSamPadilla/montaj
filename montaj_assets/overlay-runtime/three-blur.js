/**
 * three-blur.js: a 3D canvas's motion blur, averaged on its own GPU (§377).
 *
 * Motion blur captures N sub-frames per output frame and averages them
 * (render/motion-blur.js). For a 2D overlay each sub-frame is a screenshot and
 * the chunk's ffmpeg averages them. For a frame-stepped 3D canvas the average
 * is made here instead, in the canvas's own WebGL context: right after each
 * sub-frame's draw, before anything can clear the drawing buffer, it is copied
 * into a texture and added into a float target; after the last, the average is
 * drawn back onto the canvas, and the frame is captured once.
 *
 * The sum is exact. Each sub-frame is added as 0..255 integers, the 8-bit
 * values the drawing buffer holds, and a half float holds every integer up to
 * 2048 exactly, so up to 8 sub-frames (MOTION_BLUR_MAX) add with no rounding
 * at all. The average is rounded once, to the nearest 8-bit value, when it is
 * drawn back: N identical sub-frames give back the very same bytes.
 *
 * Alpha. WebGL's drawing buffer is premultiplied (premultipliedAlpha is the
 * default, and r3f keeps it), so the sum is of premultiplied colour and the
 * average is drawn back premultiplied, which is what the compositor reads; the
 * screenshot then unpremultiplies it. That is motionBlurFilter's alpha chain
 * (premultiply, average, unpremultiply): a transparent canvas gets no dark
 * fringes and composites as it did. An opaque canvas (alpha: false) has alpha
 * 1 everywhere, so the same sum is a plain average. A canvas whose buffer is
 * straight alpha (premultipliedAlpha: false with alpha) is not averaged here.
 *
 * The raw GL runs in three.js's own context, between its draws, so three's
 * cached state is reset afterwards (WebGLRenderer.resetState, made for sharing
 * a context) and the default vertex array, which a reset assumes, is bound.
 */

// One triangle over the whole viewport, from the vertex index alone: no buffers.
const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// One sub-frame as 0..255 integers, added into the sums by the blend.
const ADD = `#version 300 es
precision highp float;
uniform highp sampler2D drawn;
out vec4 sum;
void main() {
  sum = floor(texelFetch(drawn, ivec2(gl_FragCoord.xy), 0) * 255.0 + 0.5);
}`

// The sums over `count` sub-frames, rounded to 8 bits once.
const PRESENT = `#version 300 es
precision highp float;
uniform highp sampler2D sums;
uniform float count;
out vec4 color;
void main() {
  color = floor(texelFetch(sums, ivec2(gl_FragCoord.xy), 0) / count + 0.5) / 255.0;
}`

/** Why `renderer`'s canvas cannot average its sub-frames here, or null when it can. */
export function blurUnsupported(gl, renderer) {
  if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return 'no_webgl2'
  if (typeof renderer?.resetState !== 'function') return 'no_renderer'
  const attrs = gl.getContextAttributes()
  if (attrs?.alpha && attrs.premultipliedAlpha === false) return 'straight_alpha'
  // Either one makes RGBA16F renderable (and blendable) in WebGL2.
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return 'no_float_target'
  return null
}

/** An Error whose `reason` says why this canvas cannot be averaged (the page falls back to capturing each sub-frame). */
function unsupported(reason) {
  return Object.assign(new Error(`motion blur cannot be averaged on this canvas: ${reason}`), { reason })
}

function program(gl, fragment) {
  const shader = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const vs = shader(gl.VERTEX_SHADER, VERT)
  const fs = shader(gl.FRAGMENT_SHADER, fragment)
  const p = gl.createProgram()
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    gl.deleteProgram(p)
    throw unsupported('shader')
  }
  return p
}

function texture(gl, format, width, height) {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height)
  return t
}

/**
 * The accumulator of one canvas: `begin(w, h)` clears the sums for a new
 * output frame (sized to the drawing buffer), `add()` adds what the canvas
 * just drew, `present(count)` draws the average over `count` sub-frames onto
 * the canvas. Throws an Error with a `reason` when the context cannot hold a
 * float target (blurUnsupported names the same reasons up front).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{ resetState: () => void }} renderer  the three.js renderer drawing into `gl`
 */
export function makeAccumulator(gl, renderer) {
  const why = blurUnsupported(gl, renderer)
  if (why) throw unsupported(why)
  // The copy's format must match the drawing buffer's: an opaque canvas's has no alpha to copy.
  const copyFormat = gl.getContextAttributes().alpha ? gl.RGBA8 : gl.RGB8
  const add = program(gl, ADD)
  const present = program(gl, PRESENT)
  const vao = gl.createVertexArray()
  const uDrawn = gl.getUniformLocation(add, 'drawn')
  const uSums = gl.getUniformLocation(present, 'sums')
  const uCount = gl.getUniformLocation(present, 'count')
  let width = 0
  let height = 0
  let drawn = null
  let sums = null
  let fbo = null

  // Every pass sets the state it draws with, and leaves three's to a reset.
  function enter() {
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE)
    gl.colorMask(true, true, true, true)
    gl.viewport(0, 0, width, height)
    gl.bindVertexArray(vao)
    gl.activeTexture(gl.TEXTURE0)
    // Dithering may move a value written to the 8-bit canvas; three never sets it.
    const dither = gl.isEnabled(gl.DITHER)
    gl.disable(gl.DITHER)
    return dither
  }
  function leave(dither) {
    if (dither) gl.enable(gl.DITHER)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
    renderer.resetState()
  }

  // Called inside enter()/leave(), so its bindings are on TEXTURE0 and reset after.
  function allocate(w, h) {
    if (drawn) gl.deleteTexture(drawn)
    if (sums) gl.deleteTexture(sums)
    if (fbo) gl.deleteFramebuffer(fbo)
    drawn = texture(gl, copyFormat, w, h)
    sums = texture(gl, gl.RGBA16F, w, h)
    fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sums, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo)
      fbo = null
      throw unsupported('no_float_target')
    }
    width = w
    height = h
  }

  return {
    get width() { return width },
    get height() { return height },

    /** A new output frame: the sums, sized to the drawing buffer, start at zero. */
    begin(w, h) {
      const dither = enter()
      try {
        if (w !== width || h !== height || !fbo) allocate(w, h)
        gl.viewport(0, 0, width, height)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      } finally {
        leave(dither)
      }
    },

    /** Adds what the canvas just drew. Call right after the draw, in the same task. */
    add() {
      const dither = enter()
      // The drawing buffer as drawn (an antialiased one is resolved by the copy).
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, drawn)
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo)
      gl.enable(gl.BLEND)
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(add)
      gl.uniform1i(uDrawn, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      leave(dither)
    },

    /** Draws the average of `count` added sub-frames onto the canvas, then waits for the GPU, as a draw does. */
    present(count) {
      const dither = enter()
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, sums)
      gl.useProgram(present)
      gl.uniform1i(uSums, 0)
      gl.uniform1f(uCount, count)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      leave(dither)
      gl.finish()
    },
  }
}

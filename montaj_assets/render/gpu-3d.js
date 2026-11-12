/**
 * gpu-3d.js — whether this machine can draw the 3D stage, asked once before a render with 3D starts.
 *
 * The stage draws through r3f, which asks WebGL for powerPreference 'high-performance'. A machine with no usable GPU
 * (a Windows VM, Remote Desktop, no display driver) draws WebGL on a software rasterizer: there that context is not
 * created at all (Chrome 127 on windows-latest: "Could not find SharedImageBackingFactory ... HighPerformanceGpu"),
 * and a frame that does draw takes seconds, so a 3D export would run for hours. Such a render stops before its first
 * frame with NO_3D_GRAPHICS instead. A Mac or a PC with a working GPU answers true and renders as before.
 */

/**
 * MONTAJ_RENDER_SOFTWARE_3D=1 skips the check: a machine known to draw 3D in software renders it anyway, slowly. Only
 * for CI with no GPU (montaj's own ubuntu job), never set by the app.
 */
export function softwareAllowed(env = process.env) {
  return env.MONTAJ_RENDER_SOFTWARE_3D === '1'
}

/** What the user reads (the app's export card shows it as written; the AI reads it from the render log). */
export const NO_3D_GRAPHICS = "This PC's graphics can't render 3D. Use a PC with a graphics card, or update its graphics driver."

/** A WebGL renderer string that names a software rasterizer, not a GPU. */
export const SOFTWARE_RENDERER = /swiftshader|basic render driver|llvmpipe|softpipe|software rasterizer/i

/** The answer of the check, in the page: the context the stage asks for, and what draws it. Pure, for the page. */
export function probeInPage() {
  for (const kind of ['webgl2', 'webgl']) {
    const ctx = document.createElement('canvas').getContext(kind, { powerPreference: 'high-performance', antialias: true, alpha: true, preserveDrawingBuffer: true })
    if (!ctx) continue
    const info = ctx.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER))
    ctx.getExtension('WEBGL_lose_context')?.loseContext()
    return { context: kind, renderer }
  }
  return { context: null, renderer: null }
}

/**
 * `{ ok, renderer, reason }` for `browser` (puppeteer): ok when the stage's context is made and a GPU draws it. A check
 * that cannot run at all (the page fails to open) answers ok: it never stops a render for a reason of its own.
 */
export async function check3dGraphics(browser) {
  let page
  try {
    page = await browser.newPage()
    const got = await page.evaluate(probeInPage)
    if (!got.context) return { ok: false, renderer: null, reason: 'no WebGL context at powerPreference high-performance' }
    if (SOFTWARE_RENDERER.test(got.renderer)) return { ok: false, renderer: got.renderer, reason: `software renderer: ${got.renderer}` }
    return { ok: true, renderer: got.renderer, reason: null }
  } catch {
    return { ok: true, renderer: null, reason: null }
  } finally {
    await page?.close().catch(() => {})
  }
}

/** The error a render with 3D throws on a machine that cannot draw it (render.js fails it as no_3d_graphics). */
export function no3dGraphicsError(reason) {
  return Object.assign(new Error(NO_3D_GRAPHICS), { code: 'no_3d_graphics', reason })
}

export function isNo3dGraphics(err) {
  return err?.code === 'no_3d_graphics'
}

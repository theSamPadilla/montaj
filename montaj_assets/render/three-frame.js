/**
 * three-frame.js — a 3D overlay frame that did not draw is retried, then fails.
 *
 * An overlay page's `__setFrame(n)` (bundle.js's shim) draws its 3D canvases
 * through montaj-overlay-runtime's drawThreeFrame and returns what happened:
 * null for a page with no 3D canvas, else `{ canvases, blank }`. After the
 * capture, `__montajThreeCheck()` says whether a canvas lost its drawing since
 * (a lost WebGL context, a resize). Either one means the capture would show
 * the canvas blank, which is never shipped: the frame is set and captured
 * again, and after THREE_FRAME_ATTEMPTS it fails as `three_frame_blank`,
 * naming the overlay, the frame and the reason.
 *
 * A page with no 3D canvas costs nothing extra: one `__setFrame` call, as
 * before, and no check after its capture.
 *
 * A motion-blurred frame of a 3D overlay (§377) is set by `__setFrameBlurred`
 * instead, which sets and draws every sub-frame and draws their average onto
 * the 3D canvases: a sub-frame that did not draw, or an average that could not
 * be drawn, retries the whole frame by the same rule. A page that cannot
 * average at all fails as `three_blur_unsupported`, before any capture.
 */

/** The first try and two retries. */
export const THREE_FRAME_ATTEMPTS = 3

/**
 * `pageErrors` are the page's own errors so far, if any: an overlay whose
 * scene throws is one reason its canvas never draws.
 *
 * @param {{ overlay: string, frame: number, reason: string, attempts: number, pageErrors?: string[] }} p
 * @returns {Error & { code: 'three_frame_blank', overlay: string, frame: number, reason: string, attempts: number }}
 */
export function threeFrameBlankError({ overlay, frame, reason, attempts, pageErrors = [] }) {
  const err = new Error(
    `three_frame_blank: the 3D canvas in ${overlay} did not draw frame ${frame} (${reason}), `
    + `${attempts} attempt${attempts === 1 ? '' : 's'}`
    + (pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''),
  )
  err.code = 'three_frame_blank'
  err.overlay = overlay
  err.frame = frame
  err.reason = reason
  err.attempts = attempts
  return err
}

/** @param {unknown} err */
export function isThreeFrameBlank(err) {
  return !!err && typeof err === 'object' && err.code === 'three_frame_blank'
}

/**
 * The page cannot average a frame's sub-frames itself (three-bridge.js
 * averageThreeFrames names why: no 3D canvas, a canvas that also draws itself,
 * no float render target). renderer.js then captures each sub-frame, as for a
 * 2D overlay, when this comes at its chunk's first frame.
 *
 * @param {{ overlay: string, frame: number, reason: string }} p
 */
export function threeBlurUnsupportedError({ overlay, frame, reason }) {
  const err = new Error(`three_blur_unsupported: the 3D page of ${overlay} cannot average the motion blur of frame ${frame} itself (${reason})`)
  err.code = 'three_blur_unsupported'
  err.overlay = overlay
  err.frame = frame
  err.reason = reason
  return err
}

/** @param {unknown} err */
export function isThreeBlurUnsupported(err) {
  return !!err && typeof err === 'object' && err.code === 'three_blur_unsupported'
}

/**
 * The retry state of one frame on one page, for a caller whose capture does
 * not fit captureWithThree (sample-frame.js). Every `set()` is one attempt.
 *
 * `subframes` (§377): the sub-frame times of a motion-blurred frame
 * (motion-blur.js subframeTimes), which `set()` hands to the page's
 * `__setFrameBlurred` as they are. A blank names the sub-frame that did not draw.
 *
 * @param {{ page: import('puppeteer').Page, frame: number, overlay: string,
 *   log?: (msg: string) => void, attempts?: number, pageErrors?: string[], subframes?: number[] }} opts
 */
export function threeFrameRetry({ page, frame, overlay, log, attempts = THREE_FRAME_ATTEMPTS, pageErrors, subframes }) {
  let attempt = 0
  const retry = {
    /** `__setFrame(frame)` until its 3D canvases drew; returns its status (null: no 3D canvas). */
    async set() {
      for (;;) {
        attempt++
        const three = subframes
          ? await page.evaluate((f, times) => window.__setFrameBlurred(f, times), frame, subframes)
          : await page.evaluate((f) => window.__setFrame(f), frame)
        if (three?.unsupported) throw threeBlurUnsupportedError({ overlay, frame, reason: three.unsupported })
        if (!three?.blank) return three
        retry.failed(three.blank, three.frame ?? frame)
      }
    },
    /** After the capture: why a canvas `set()` drew has lost its drawing, or null. */
    async lost(three) {
      return three ? page.evaluate(() => window.__montajThreeCheck?.() ?? null) : null
    },
    /** One attempt did not draw (`at`: the frame, or the sub-frame, that did not): throws three_frame_blank when it was the last. */
    failed(reason, at = frame) {
      if (attempt >= attempts) throw threeFrameBlankError({ overlay, frame: at, reason, attempts: attempt, pageErrors })
      log?.(`the 3D canvas in ${overlay} did not draw frame ${at} (${reason}); retrying (${attempt}/${attempts - 1})`)
    },
  }
  return retry
}

/**
 * Sets `page` to `frame` and captures it, retrying while a 3D canvas did not
 * draw it. `capture()` does everything after the commit up to and including
 * the screenshot; its result is returned.
 *
 * @template T
 * @param {import('puppeteer').Page} page
 * @param {number} frame
 * @param {() => Promise<T>} capture
 * With `opts.subframes` (§377) the page averages those sub-frames of a
 * motion-blurred frame itself, and `capture()` takes the one capture of it.
 *
 * @param {{ overlay: string, log?: (msg: string) => void, attempts?: number, pageErrors?: string[], subframes?: number[] }} opts
 * @returns {Promise<T>}
 */
export async function captureWithThree(page, frame, capture, opts) {
  const retry = threeFrameRetry({ page, frame, ...opts })
  for (;;) {
    const three = await retry.set()
    const result = await capture()
    const reason = await retry.lost(three)
    if (!reason) return result
    retry.failed(reason)
  }
}

// montaj_assets/render/item-mask.js
//
// The item mask PRE-PASS (§616). A clip's mask (ellipse, rounded rect or wipe,
// feathered, invertible, keyframable) is drawn ONCE, ahead of the clip's own
// filter graph, into a gray plane the size of the clip's box, and the graph
// multiplies that plane into the clip's alpha ({@link maskFilterParts}).
//
// Why a pre-pass and not an in-graph `geq`: `geq` evaluates a per-pixel
// expression in interpreted code. An animated ellipse measured 0.22 s a frame
// at 1080x1920 and 0.42 s at 3840x2160 (ffmpeg 9.0.1, 2026-10-28), against
// 11 ms a frame for `gblur` at 4K, and it has no Gaussian feather. Here the polygon is the SAME vertex
// list the editor preview paints as SVG (timeline-core's `maskPolygon`),
// scan-converted by `rasterizeMask`; the feather is one `gblur` over a plane
// that extends a margin past the box, so the blur has real black (or, inverted,
// white) to pull in. `steps=6`: gblur approximates a Gaussian with that many box
// passes; 3 drifts up to 11 codes from the true curve at a large feather on a
// small shape (feather 0.2: exact 45, steps=3 gives 56, steps=6 gives 50), and
// the preview's SVG blur is close to exact. A still mask is one PNG, looped; a moving mask is one
// frame per output frame in a lossless ffv1 file.
import { spawn } from 'child_process'
import { maskAt, hasMaskKeyframes, maskSigmaPx, rasterizeMask } from '@bycrux/timeline-core'
import { FFMPEG } from './ffmpeg-bin.js'
import { ffSeconds } from './ff-seconds.js'
import { ffmpegErrorTail } from './ffmpeg-error.js'

/**
 * @typedef {Object} ItemMaskPlan
 * @property {'still' | 'frames'} kind
 * @property {string} path The file the pre-pass writes (.png still, .mkv frames).
 * @property {string[]} inputArgs The ffmpeg input args that read it.
 * @property {number} [frames] Frames written (frames kind).
 * @property {object} item
 * @property {number} boxW
 * @property {number} boxH
 * @property {number} offset Item-relative time of the first frame.
 * @property {number} duration
 * @property {number} fps
 */

/**
 * Plan an item's mask file, or null when the item has no valid mask at `offset`.
 *
 * @param {object} item The timeline item (reads `mask` and `keyframes`).
 * @param {number} boxW The clip's box width in pixels (rounded).
 * @param {number} boxH The clip's box height in pixels (rounded).
 * @param {number} offset Item-relative seconds of the first output frame.
 * @param {number} duration Seconds the mask covers.
 * @param {number} fps
 * @param {string} base Path without extension.
 * @returns {ItemMaskPlan | null}
 */
export function planItemMask(item, boxW, boxH, offset, duration, fps, base) {
  if (!maskAt(item, offset)) return null
  const w = Math.max(1, Math.round(boxW))
  const h = Math.max(1, Math.round(boxH))
  if (!hasMaskKeyframes(item)) {
    const path = base + '.png'
    return {
      kind: 'still', path,
      inputArgs: ['-loop', '1', '-framerate', String(fps), '-t', ffSeconds(duration), '-i', path],
      item, boxW: w, boxH: h, offset, duration, fps,
    }
  }
  const path = base + '.mkv'
  return {
    kind: 'frames', path, inputArgs: ['-i', path],
    frames: Math.round(duration * fps) + 1,
    item, boxW: w, boxH: h, offset, duration, fps,
  }
}

/**
 * Write the planned mask file. One ffmpeg is spawned; rasterized planes (box
 * plus a fixed margin) go in on stdin, `gblur` feathers them, the crop returns
 * the box.
 *
 * @param {ItemMaskPlan} plan
 * @returns {Promise<void>}
 */
export function writeItemMask(plan) {
  const { item, boxW, boxH, offset, fps } = plan
  const count = plan.kind === 'still' ? 1 : /** @type {number} */ (plan.frames)
  const sigmas = []
  for (let k = 0; k < count; k++) {
    const m = maskAt(item, offset + k / fps)
    sigmas.push(m ? maskSigmaPx(m, boxW, boxH) : 0)
  }
  const maxSigma = Math.max(...sigmas)
  const margin = Math.ceil(3 * maxSigma)
  const W = boxW + 2 * margin
  const H = boxH + 2 * margin

  let blur = ''
  if (maxSigma > 0) {
    const moving = sigmas.some(s => s !== sigmas[0])
    if (moving) {
      // Per-frame sigma, only where it changes. sendcmd times are stream seconds.
      const cmds = []
      for (let k = 1; k < count; k++) {
        if (sigmas[k] !== sigmas[k - 1]) cmds.push(`${(k / fps).toFixed(6)} gblur@fe sigma ${sigmas[k].toFixed(4)}`)
      }
      blur = `sendcmd=c='${cmds.join(';')}',gblur@fe=sigma=${sigmas[0].toFixed(4)}:steps=6,`
    } else {
      blur = `gblur=sigma=${sigmas[0].toFixed(4)}:steps=6,`
    }
  }
  const filter = `[0:v]${blur}crop=${boxW}:${boxH}:${margin}:${margin},format=gray`
  const out = plan.kind === 'still'
    ? ['-frames:v', '1', '-update', '1', plan.path]
    : ['-c:v', 'ffv1', '-level', '3', plan.path]
  const args = [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-vf', filter.replace(/^\[0:v\]/, ''), ...out,
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-32768) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`item mask write failed (exit ${code})\n${ffmpegErrorTail(stderr)}`))
    })
    // ffmpeg may exit early; an EPIPE then surfaces through 'close' with its stderr.
    proc.stdin.on('error', () => {})
    ;(async () => {
      for (let k = 0; k < count; k++) {
        const m = maskAt(item, offset + k / fps)
        const { data } = rasterizeMask(m, boxW, boxH, { margin })
        if (!proc.stdin.write(data)) {
          await new Promise(r => { proc.stdin.once('drain', r); proc.stdin.once('close', r) })
        }
        if (proc.stdin.destroyed) return
      }
      proc.stdin.end()
    })().catch(reject)
  })
}

/**
 * The filter-graph parts that multiply an item's alpha by its mask input.
 * The caller pins `itemLabel` (e.g. `[v3]`) to an alpha format first.
 *
 * @param {string} itemLabel Bracketed label of the item's stream.
 * @param {number} maskInputIdx ffmpeg input index of the mask file (also the label suffix).
 * @param {string} outLabel Bracketed label for the masked result.
 * @param {{ tenBit?: boolean }} [opts]
 * @returns {string[]}
 */
export function maskFilterParts(itemLabel, maskInputIdx, outLabel, { tenBit = false } = {}) {
  const n = maskInputIdx
  return [
    `${itemLabel}split=2[mc${n}][ma${n}]`,
    `[ma${n}]alphaextract[mal${n}]`,
    `[${n}:v]format=${tenBit ? 'gray10le' : 'gray'},setpts=PTS-STARTPTS[mk${n}]`,
    `[mal${n}][mk${n}]blend=all_mode=multiply[mam${n}]`,
    `[mc${n}][mam${n}]alphamerge${outLabel}`,
  ]
}

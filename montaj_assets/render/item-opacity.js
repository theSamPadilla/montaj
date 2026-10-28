// montaj_assets/render/item-opacity.js
//
// A clip's opacity, static or keyframed (§616). colorchannelmixer's `aa` takes
// no expression, but it IS a runtime command (ffmpeg 9.0.1, measured), so a
// keyframed opacity is sampled once per frame with timeline-core's opacityAt,
// the sampler the preview uses, and sent with sendcmd. A static value keeps the
// exact string it always had.
import { opacityAt } from '@bycrux/timeline-core'
import { finiteNumber } from './filter-number.js'

const num = (v) => v.toFixed(6)
const hasOpacityTrack = (item) => Array.isArray(item?.keyframes)
  && item.keyframes.some((tr) => tr?.prop === 'opacity' && Array.isArray(tr.points) && tr.points.length > 0)

/** One `TIME TARGET aa VALUE` per frame of [0, duration] whose value differs from the last sent. */
export function opacityCommands(item, target, offset, duration, fps) {
  const out = []
  let last = null
  const frames = Math.max(0, Math.round(duration * fps))
  for (let k = 0; k <= frames; k++) {
    const t = k / fps
    const v = Math.min(1, Math.max(0, opacityAt(item, offset + t)))
    if (last !== null && Math.abs(v - last) < 0.0005) continue
    out.push(`${num(t)} ${target} aa ${num(v)}`)
    last = v
  }
  return out
}

/** The filter step for a clip's opacity: null at full static opacity. `name` is unique per graph. */
export function opacityFilterStep(item, name, offset, duration, fps) {
  if (!hasOpacityTrack(item)) {
    // Written as `!(> 0.001)` so a non-numeric opacity (NaN) is no step, as it always was.
    if (!(Math.abs((item.opacity ?? 1) - 1) > 0.001)) return null
    return `colorchannelmixer=aa=${finiteNumber(item.opacity, 'opacity')}`
  }
  const target = `colorchannelmixer@${name}`
  return `sendcmd=c='${opacityCommands(item, target, offset, duration, fps).join(';')}',${target}=aa=0`
}

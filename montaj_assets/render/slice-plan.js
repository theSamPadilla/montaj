// montaj_assets/render/slice-plan.js
//
// Plans the time slices of a sliced render (§434). An un-sliced render
// captures every overlay for its whole span into FFV1 files that all stay on
// disk until compose (disk-space.js explains). A sliced render captures every
// overlay's frames for one slice, encodes that slice's compose groups, and
// deletes the slice's files, so the capture footprint is one slice and not the
// whole timeline.
//
// A slice is consecutive compose groups. Its edges sit only on group
// boundaries, because cutting a group would add an encode seam. This module is
// pure: it takes the groups compose planned and the overlays, and says where
// the slices go. It does no I/O.
import {
  FFV1_CAPTION_BYTES_PER_PIXEL,
  FFV1_DENSE_BYTES_PER_PIXEL,
  FFV1_SPARSE_BYTES_PER_PIXEL,
} from './disk-space.js'

// The default budget for one slice's captures, and the ceiling: a budget is
// never above this, whatever a caller or the environment asks for.
export const SLICE_BUDGET_BYTES = 2e9

// A slice is closed only once it spans at least this many frames (4 s at 60
// fps), so a tiny group never becomes its own encode.
export const MIN_SLICE_FRAMES = 240

const EDGE_EPSILON = 1e-6

// Bytes of captures the window [a, b) needs: for each overlay, the frames of
// [max(start, a), min(end, b)) at `fps`, at its per-frame FFV1 rate. `px` is
// width * height * captureScale^2.
export function sliceBytes(overlays, a, b, fps, px) {
  const end = Math.round(b * fps)
  const begin = Math.round(a * fps)
  let total = 0
  for (const o of overlays) {
    const from = Math.max(Math.round(o.startSeconds * fps), begin)
    const to = Math.min(Math.round(o.endSeconds * fps), end)
    if (to <= from) continue
    const rate = o.sparse ? FFV1_CAPTION_BYTES_PER_PIXEL : FFV1_DENSE_BYTES_PER_PIXEL
    total += (to - from) * px * rate
  }
  return total
}

// The least a slice's captures can take: its frames, every overlay, at the
// sparse rate (the lower bound disk-space.js prices captures at).
function sliceLowerBytes(overlays, a, b, fps, px) {
  const end = Math.round(b * fps)
  const begin = Math.round(a * fps)
  let frames = 0
  for (const o of overlays) {
    const n = Math.min(Math.round(o.endSeconds * fps), end) - Math.max(Math.round(o.startSeconds * fps), begin)
    if (n > 0) frames += n
  }
  return frames * px * FFV1_SPARSE_BYTES_PER_PIXEL
}

function checkBudget(budgetBytes) {
  if (typeof budgetBytes !== 'number' || !Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError(`slice budget must be a positive number of bytes, got ${budgetBytes}`)
  }
  return Math.min(budgetBytes, SLICE_BUDGET_BYTES)
}

// Plan the slices of `groups` (each `{ start, end }` in seconds, sorted and
// contiguous). Greedy: a slice takes group after group while its captures stay
// within the budget, and is closed only once it spans `minSliceFrames`, so a
// slice below the minimum keeps growing even over budget, and a single group
// over budget is its own slice; both set `oversize`. When the whole
// timeline fits the budget the result is exactly one slice and `sliced` is
// false: the caller runs the un-sliced path. `extraEdges` (seconds) restricts
// the edges to those instants, for --export both, where only the boundaries
// common to both compose plans may cut; a group not ending on one is merged
// into the slice that continues.
export function planSlices({
  groups,
  overlays,
  fps,
  px,
  budgetBytes = SLICE_BUDGET_BYTES,
  minSliceFrames = MIN_SLICE_FRAMES,
  extraEdges,
}) {
  const budget = checkBudget(budgetBytes)
  const n = groups.length
  if (n === 0) return { slices: [], peakBytes: 0, budgetBytes: budget, sliced: false, oversize: false }

  const make = (from, to) => {
    const start = groups[from].start
    const end = groups[to - 1].end
    return {
      from,
      to,
      start,
      end,
      bytes: sliceBytes(overlays, start, end, fps, px),
      frames: Math.round(end * fps) - Math.round(start * fps),
    }
  }
  const finish = (slices, sliced) => ({
    slices,
    peakBytes: Math.max(...slices.map((s) => s.bytes)),
    budgetBytes: budget,
    sliced,
    oversize: slices.some((s) => s.bytes > budget),
  })

  const whole = make(0, n)
  if (whole.bytes <= budget) return finish([whole], false)

  const allowed = (i) =>
    i === n - 1 ||
    !extraEdges ||
    extraEdges.some((e) => Math.abs(e - groups[i].end) <= EDGE_EPSILON)

  const slices = []
  let from = 0
  while (from < n) {
    let to = from + 1
    while (to < n) {
      const cur = make(from, to)
      if (allowed(to - 1) && cur.frames >= minSliceFrames) {
        if (sliceBytes(overlays, cur.start, groups[to].end, fps, px) > budget) break
      }
      to++
    }
    slices.push(make(from, to))
    from = to
  }
  return finish(slices, true)
}

// The budget a render can actually use. Starts at min(wantedBytes, the 2 GB
// ceiling). The room for slice captures is `freeBytes - fixedBytes -
// floorBytes` (fixedBytes: everything else the render keeps on disk at its
// peak, compose's own term plus sources; floorBytes: headroom). If the plan at
// the wanted budget peaks within the room it is used, which keeps a timeline
// that fits both unsliced. Otherwise the budget shrinks (binary search, the
// largest that fits) down to the minimum-slice plan, the least this timeline
// can do. If even that peaks over the room the render is refused, with the free
// bytes it would need. The budget never grows above the wanted one.
export function fitBudget({
  groups,
  overlays,
  fps,
  px,
  wantedBytes = SLICE_BUDGET_BYTES,
  fixedBytes = 0,
  lowerFixedBytes = fixedBytes,
  freeBytes = Infinity,
  floorBytes = 1e9,
  minSliceFrames = MIN_SLICE_FRAMES,
  extraEdges,
}) {
  const wanted = checkBudget(wantedBytes)
  const room = freeBytes - fixedBytes - floorBytes
  const planAt = (b) => planSlices({ groups, overlays, fps, px, budgetBytes: b, minSliceFrames, extraEdges })

  const atWanted = planAt(wanted)
  if (atWanted.peakBytes <= room) return { budgetBytes: wanted, plan: atWanted, refused: false }

  // A budget of one byte puts every group in its own slice, merged only up to
  // the minimum frames: the smallest peak this timeline can reach.
  const minimum = planAt(1)
  const lowerPeak = Math.max(...minimum.slices.map((sl) => sliceLowerBytes(overlays, sl.start, sl.end, fps, px)))
  if (lowerPeak + lowerFixedBytes > freeBytes) {
    return { refused: true, needBytes: lowerPeak + lowerFixedBytes, freeBytes, plan: minimum }
  }
  if (minimum.peakBytes > room) return { budgetBytes: minimum.budgetBytes, plan: minimum, refused: false }

  let lo = 1
  let hi = wanted
  let best = minimum
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const p = planAt(mid)
    if (p.peakBytes <= room) {
      lo = mid
      best = p
    } else {
      hi = mid
    }
  }
  return { budgetBytes: lo, plan: best, refused: false }
}

// MONTAJ_SLICE_BUDGET_MB: a slice budget in megabytes (1e6 bytes, may be
// fractional), for forcing slices on a small project. Empty or invalid is
// null; a value above the ceiling is clamped to it.
export function parseSliceBudget(envValue) {
  if (envValue == null) return null
  const s = String(envValue).trim()
  if (s === '') return null
  const mb = Number(s)
  if (!Number.isFinite(mb) || mb <= 0) return null
  return Math.min(mb * 1e6, SLICE_BUDGET_BYTES)
}

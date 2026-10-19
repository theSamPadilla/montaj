// montaj_assets/render/slice-run.js
//
// Runs a sliced render (§434). slice-plan.js says where the slices go; this
// module captures each slice's overlay frames, encodes the slice's compose
// groups against them, deletes them, and moves on, so the captures on disk are
// one slice at a time. render.js main() wires it with the real capture
// (renderer.js renderAllSegments) and the real encoder (compose.js
// encodeComposeGroups, finishCompose); every side effect is injected, so the
// tests drive it with fakes.
//
// Also here: the overlay descriptor compose reads (overlayDescriptor, shared
// with the unsliced path), the HDR card rule that keeps a render unsliced
// (hdrCardCandidates), and the preliminary compose groups and disk terms the
// estimate uses.
import { mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { isCardPlacement } from './cover-probe.js'
import { planSegments, groupShortSegments, MIN_SEGMENT_FRAMES } from './segment-plan.js'
import { FFV1_CAPTION_BYTES_PER_PIXEL, FFV1_DENSE_BYTES_PER_PIXEL, FFV1_SPARSE_BYTES_PER_PIXEL } from './disk-space.js'

const EDGE_EPSILON = 1e-6

/**
 * The fields compose reads off an overlay, copied from its spec onto `base`
 * (a rendered segment, or a descriptor built before capture). Mutates and
 * returns `base`.
 *
 * Every field rides by reference: segment-plan.js hands these very objects to
 * the encoder (buildOverlayFilterParts). Moved here from render.js's loop over
 * the rendered segments, unchanged.
 */
export function overlayDescriptor(spec, base) {
  base.offsetX   = spec.offsetX   ?? 0
  base.offsetY   = spec.offsetY   ?? 0
  base.scale     = spec.scale     ?? 1
  // Same reference-flow argument as rotation below, and the same shape of
  // partial failure: buildOverlayFilterParts sizes a non-keyframed overlay
  // from `geometryFor(ov, 'overlay')` read off this object, and that
  // resolver reads `scaleX`/`scaleY` before falling back to `scale`. Miss
  // these two lines and a non-uniform overlay renders as a uniform box
  // while the preview shows it stretched. Carried as authored (undefined
  // when absent), never defaulted: geometryFor resolves `?? scale ?? 1`.
  base.scaleX    = spec.scaleX
  base.scaleY    = spec.scaleY
  // rotation must be restated here too: these objects flow BY REFERENCE
  // through segment-plan.js's `overlays` array (built via activeIn() over
  // puppeteerSegs, preserving object identity) into buildOverlayFilterParts,
  // which reads rotation off this very object via geometryFor(ov, 'overlay').
  // Skipping this line is the worst partial failure: images/videos rotate
  // correctly while overlays silently don't.
  base.rotation  = spec.rotation  ?? 0
  // The OTHER half of the missing-overlay-opacity bug. collectPuppeteerSegments
  // has always collected `opacity` onto the spec, but it stopped here, so even
  // once buildOverlayFilterParts learned to emit `colorchannelmixer=aa=`, it
  // would have read `undefined` off every descriptor and emitted nothing. Both
  // halves are required; neither alone does anything.
  base.opacity   = spec.opacity   ?? 1
  base.opaque    = spec.opaque    ?? false
  base.isCaption = spec.isCaption ?? false
  // §308 P3: where it stacks among the clips (segment-plan.js). Captions
  // carry none: they are always last.
  if (spec.layerTrack !== undefined) base.layerTrack = spec.layerTrack
  // Same reference-flow argument as rotation directly above, and the same
  // worst-case partial failure: buildOverlayFilterParts reads `keyframes`
  // off this object to decide that the capture is already positioned. Miss
  // this line and an animated overlay gets its transform applied TWICE:
  // once baked into the pixels, once by the compositor. Assigned only when
  // the spec actually has tracks, so a static overlay's descriptor keeps no
  // `keyframes` key at all and takes the byte-identical filter path.
  if (spec.keyframes?.length) base.keyframes = spec.keyframes
  return base
}

/**
 * The descriptors a sliced render plans compose with, before any capture: the
 * whole span (as the planner needs) and no webmPath yet.
 */
export function plannedDescriptors(specs) {
  return specs.map((spec) => overlayDescriptor(spec, {
    id: spec.id, startSeconds: spec.startSeconds, endSeconds: spec.endSeconds, opaque: spec.opaque ?? false,
  }))
}

/**
 * The overlays an HDR compose would probe for a full-screen card
 * (cover-probe.js markCards): placed over the whole canvas and not flagged
 * `opaque`. The probe reads a whole-span capture and decides for the whole
 * span, so no slice can decide it: an HDR render with any of these runs
 * unsliced.
 */
export function hdrCardCandidates(specs) {
  return specs.filter((spec) => spec.opaque !== true && isCardPlacement(overlayDescriptor(spec, {})))
}

/**
 * The compose groups planCompose would make (planSegments, the leading gap,
 * groupShortSegments), for the estimate and the preliminary slice plan. Only
 * the group edges are used: items need no probes here.
 */
export function previewGroups(items, overlays, vw, vh, fps, minFrames = MIN_SEGMENT_FRAMES) {
  const segments = planSegments(items, overlays, vw, vh, fps)
  if (segments.length === 0) return []
  if (segments[0].start > 0) {
    segments.unshift({ start: 0, end: segments[0].start, items: [], opaqueVideo: false, overlays: [], vw, vh, fps })
  }
  return groupShortSegments(segments, fps, minFrames)
}

/** The group ends of the first plan that every other plan also ends a group on (--export both). */
export function commonEdges(plans) {
  const [first, ...rest] = plans
  return first.groups
    .map((g) => g.end)
    .filter((t) => rest.every((p) => p.groups.some((g) => Math.abs(g.end - t) <= EDGE_EPSILON)))
}

/** Indices of the plan's groups whose [start, end) lies inside the slice. */
export function groupsInSlice(plan, slice) {
  const out = []
  plan.groups.forEach((g, i) => {
    if (g.start >= slice.start - EDGE_EPSILON && g.end <= slice.end + EDGE_EPSILON) out.push(i)
  })
  return out
}

/**
 * The capture jobs of one slice: each spec that overlaps [slice.start,
 * slice.end), cut to the frames inside it (frameFrom/frameTo relative to the
 * overlay's own start, on the frame grid compose uses) and written under
 * `dir`. The specs are copied, never changed.
 */
export function sliceSpecs(specs, slice, fps, dir) {
  const a = Math.round(slice.start * fps)
  const b = Math.round(slice.end * fps)
  const out = []
  for (const spec of specs) {
    const S = Math.round(spec.startSeconds * fps)
    const E = S + spec.frameCount
    const from = Math.max(S, a) - S
    const to = Math.min(E, b) - S
    if (to <= from) continue
    out.push({ ...spec, frameFrom: from, frameTo: to, outputPath: join(dir, basename(spec.outputPath)) })
  }
  return out
}

/** `slice-01`, `slice-02`, ...: the folder of slice `k` (0-based) under render/segments. */
export function sliceDirName(k) {
  return `slice-${String(k + 1).padStart(2, '0')}`
}

/**
 * The disk terms of a slice plan, for disk-space.js estimateRenderDisk's
 * `slicing`: the captures of the peak slice at the expected rates, the
 * largest one file of it that is joined from chunks (it is on disk twice
 * while joined), and the peak slice's frames at the sparse rate (the lower
 * bound). `overlays` carry startSeconds, endSeconds and `sparse`.
 */
export function sliceDiskTerms({ plan, overlays, fps, px, chunkFrames = Infinity }) {
  let peak = null
  for (const s of plan.slices) if (!peak || s.bytes > peak.bytes) peak = s
  if (!peak) return { peakCaptureBytes: 0, peakJoinBytes: 0, lowerCaptureBytes: 0 }
  const a = Math.round(peak.start * fps)
  const b = Math.round(peak.end * fps)
  let frames = 0
  let join = 0
  for (const o of overlays) {
    const n = Math.min(Math.round(o.endSeconds * fps), b) - Math.max(Math.round(o.startSeconds * fps), a)
    if (n <= 0) continue
    frames += n
    const bytes = n * px * (o.sparse ? FFV1_CAPTION_BYTES_PER_PIXEL : FFV1_DENSE_BYTES_PER_PIXEL)
    if (n > chunkFrames) join = Math.max(join, bytes)
  }
  return { peakCaptureBytes: peak.bytes, peakJoinBytes: join, lowerCaptureBytes: frames * px * FFV1_SPARSE_BYTES_PER_PIXEL }
}

const mb = (bytes) => Math.round(bytes / 1e6)

/** The one line a render logs about slicing before it captures. */
export function slicingLine({ sliced, slices = 1, budgetBytes, peakBytes = 0, wantedBytes, freeBytes, captureBytes = 0, reason = null }) {
  if (reason) return `slicing: off (${reason})`
  if (!sliced) return `slicing: off (captures ${mb(captureBytes)} MB fit the ${mb(budgetBytes)} MB budget)`
  const free = Number.isFinite(freeBytes) ? `${mb(freeBytes)} MB` : 'unknown'
  return `slicing: ${slices} slice(s) of <=${mb(Math.max(peakBytes, 0))} MB (budget used ${mb(budgetBytes)} MB, wanted ${mb(wantedBytes)} MB, free ${free})`
}

/**
 * Capture, encode and delete one slice at a time, then finish each compose.
 *
 * For slice k: `capture(sliceSpecs(...), { ...captureConfig, bakeProgress })`
 * (renderAllSegments; its result entries carry each window's start and end),
 * then, for every plan in order, `encode(plan, indices, { overlaysFor })`
 * (encodeComposeGroups) with the plan's groups inside the slice, where
 * overlaysFor gives each overlay a copy pointing at its slice file and
 * starting at its window, then the slice folder is removed unless `keep`.
 * After the last slice, `finish(plan, encoded, i)` for each plan. A failure
 * anywhere stops the loop and rejects; the caller's cleanup owns what is left
 * (render/segments, slice folders included).
 *
 * One bake counter spans the whole render: `createBakeProgress({ total })`
 * sized with the sum of `bakeTotal(specs, captureConfig)` over every slice.
 *
 * @param {object} p
 * @param {object[]} p.plans    compose plans (planCompose), main pass first
 * @param {Array<{start: number, end: number}>} p.slices
 * @param {object[]} p.specs    the bundled overlay specs (whole spans)
 * @param {string} p.segDir     render/segments
 * @param {number} p.fps
 * @param {Function} p.capture  renderAllSegments
 * @param {Function} p.encode   encodeComposeGroups
 * @param {Function} p.finish   (plan, encoded, index) => result
 * @param {boolean} [p.keep]    MONTAJ_KEEP_SEGMENTS: keep each slice folder
 * @param {(msg: string) => void} [p.log]
 * @param {{ mkdir?: Function, rm?: Function }} [p.fsOps]
 * @param {object} [p.captureConfig]  { workers, motionBlur }
 * @param {Function} [p.bakeTotal]
 * @param {Function} [p.createBakeProgress]
 * @returns {Promise<object[]>} finish's results, per plan
 */
export async function runSlices({
  plans, slices, specs, segDir, fps, capture, encode, finish, keep = false, log = () => {},
  fsOps = {}, captureConfig = {}, bakeTotal = null, createBakeProgress = null,
}) {
  const mkdir = fsOps.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }))
  const rm = fsOps.rm ?? ((dir) => rmSync(dir, { recursive: true, force: true }))

  const jobs = slices.map((slice, k) => {
    const dir = join(segDir, sliceDirName(k))
    return { slice, dir, specs: sliceSpecs(specs, slice, fps, dir) }
  })
  let bakeProgress
  if (bakeTotal && createBakeProgress) {
    const total = jobs.reduce((n, j) => n + (j.specs.length ? bakeTotal(j.specs, captureConfig) : 0), 0)
    bakeProgress = createBakeProgress({ total })
  }

  const encoded = plans.map(() => [])
  for (let k = 0; k < jobs.length; k++) {
    const { slice, dir, specs: windowSpecs } = jobs[k]
    const label = `slice ${k + 1}/${jobs.length} (${slice.start.toFixed(2)}-${slice.end.toFixed(2)}s)`
    mkdir(dir)
    log(`${label}: capturing ${windowSpecs.length} overlay window(s)`)
    const captured = windowSpecs.length
      ? await capture(windowSpecs, { ...captureConfig, ...(bakeProgress ? { bakeProgress } : {}) })
      : []
    const byId = new Map(captured.map((r) => [r.id, r]))
    const overlaysFor = (ov) => {
      const r = byId.get(ov.id)
      if (!r) throw new Error(`${label}: overlay ${ov.id} is in a group of this slice but was not captured in it`)
      return { ...ov, webmPath: r.webmPath, startSeconds: r.startSeconds }
    }
    log(`${label}: encoding`)
    for (let i = 0; i < plans.length; i++) {
      const indices = groupsInSlice(plans[i], slice)
      if (indices.length === 0) continue
      encoded[i].push(...await encode(plans[i], indices, { overlaysFor }))
    }
    if (!keep) rm(dir)
  }

  for (let i = 0; i < plans.length; i++) {
    if (encoded[i].length !== plans[i].groups.length) {
      throw new Error(`sliced render encoded ${encoded[i].length} of ${plans[i].groups.length} group(s) of ${plans[i].outputPath}`)
    }
  }
  const results = []
  for (let i = 0; i < plans.length; i++) results.push(await finish(plans[i], encoded[i], i))
  return results
}

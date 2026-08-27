// render/encode-segment.js
/**
 * Encode a single timeline segment to MP4 in the project's working color space.
 *
 * Each call composites:
 *   - N visual items: layered by trackIdx (lower = background). Each item has
 *     scale, offsetX, offsetY, opacity, rotation. Images loop, videos seek+trim.
 *   - 0-N overlays: Puppeteer-rendered MKV/WebM with alpha, scaled from the
 *     1080-design canvas to the output resolution and positioned via offsetX,
 *     offsetY, scale. Captions are always last (topmost z-layer) — ensured by
 *     planSegments.
 *   - Audio: extracted from ALL unmuted video items with audio and mixed via amix.
 *     When only one item has audio, it's used directly (no amix overhead).
 *     When multiple items have audio, they're combined with
 *     amix=inputs=N:duration=longest:normalize=0 — matching the pattern in mix-audio.js.
 *
 * Output codec / pix_fmt / color metadata follow the project's color space:
 *   - sdr_bt709 → libx264 yuv420p bt709
 *   - hdr_hlg   → libx265 yuv420p10le bt2020nc / arib-std-b67 (HLG)
 *   - hdr_pq    → libx265 yuv420p10le bt2020nc / smpte2084 (PQ) + static HDR10 metadata
 *
 * All segments from a single render share the project's working codec, so concat
 * with -c:v copy is safe (uniform format invariant holds, just per-project now).
 *
 * Per-item color conversion: when an item's source color space differs from the
 * project's color space, a conversion filter is injected between the per-item
 * scale and pad steps (see the step-order note in buildVideoItemFilterParts —
 * geometry first so the conversion runs on canvas-sized frames, pad after it so
 * its bars are synthesized in the destination color space). The source's
 * color_transfer is read from item.colorTransfer (stamped by render.js during
 * the videoItems collection pass) — no per-segment ffprobe.
 */
import { spawn, spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { FFMPEG, FFPROBE } from './ffmpeg-bin.js'
import { specFor, detectFromTransfer, DEFAULT_COLOR_SPACE } from './color-space.js'
import { lutPath } from './look.js'
import {
  geometryFor, geometryAt, toRotatedPixelBox, toPixelBox, compileTrackExprInfo,
  transitionProgress,
} from '@bycrux/timeline-core'

const FFMPEG_TIMEOUT_MS = 600_000
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

// Only surface ffmpeg lines that carry actionable signal — suppress banner/input listing.
const FFMPEG_SIGNAL = /warning|error|invalid|failed|matches no streams|^\[.*@/i
function logFfmpegStderr(stderr) {
  const TTY = process.stderr.isTTY
  const dim = TTY ? '\x1b[2m' : ''
  const reset = TTY ? '\x1b[0m' : ''
  for (const line of stderr.split('\n')) {
    if (line.trim() && FFMPEG_SIGNAL.test(line)) {
      process.stderr.write(`${dim}[montaj ffmpeg]${reset} ${line}\n`)
    }
  }
}

/**
 * Async ffmpeg runner shaped like spawnSync's result so call sites keep their
 * checks. Resolves (never rejects) with { status, signal, stderr, error? }. Used
 * for the per-segment encode so a bounded pool (compose.js) can drive several
 * encodes at once without blocking the event loop the way spawnSync would.
 */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args)
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('error', (err) => { clearTimeout(timer); resolve({ status: null, signal: null, stderr, error: err }) })
    proc.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal: timedOut ? 'SIGKILL' : signal, stderr })
    })
  })
}

/** Returns true if the file has at least one audio stream. */
export function fileHasAudio(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 5000 })
  return result.status === 0 && result.stdout.trim().length > 0
}

function isImageItem(item) {
  return item.type === 'image' || IMAGE_EXTENSIONS.test(item.src)
}

// Cache the `ffmpeg -filters` listing across calls — a build's filter set can't
// change mid-process, and both probes below read the same listing so this costs
// one spawn total, not one per filter. Mirrors the functools.lru_cache on
// lib/normalize.py's _has_zscale/_has_lut3d.
let _filtersCache = null
function filterList() {
  if (_filtersCache !== null) return _filtersCache
  const result = spawnSync(FFMPEG, ['-hide_banner', '-filters'], {
    encoding: 'utf8', timeout: 5000,
  })
  _filtersCache = result.status === 0 ? (result.stdout || '') : ''
  return _filtersCache
}

/** True when this ffmpeg build has zscale (requires libzimg). */
export function hasZscale() {
  return /^[A-Z. ]+ zscale\b/m.test(filterList())
}

/** True when this ffmpeg build has lut3d — the filter that applies the Montaj Vivid .cube. */
export function hasLut3d() {
  return /^[A-Z. ]+ lut3d\b/m.test(filterList())
}

/**
 * The Montaj Vivid HDR→SDR chain (SP6b decision 8a). VERBATIM — do not reorder.
 *
 * Byte-for-byte the same shape lib/normalize.py's `_build_tonemap_vf_to_sdr`
 * produces, and for the same reasons; both suites assert these literals so the
 * two runtimes can't drift. Like the Python one, this returns the chain with NO
 * terminal `format=` — the caller appends whatever its encoder needs
 * (`yuv420p` for video, `rgb24` for a PNG).
 *
 * The `format=rgb48le` pin BEFORE `lut3d` is load-bearing: without it ffmpeg
 * hands 8-bit to the LUT and quantizes the grade. After the LUT the pixels are
 * full-range RGB, and the trailing zscale converts them back to limited-range
 * Rec.709 YUV.
 *
 * That trailing zscale sets t=/m=/p= explicitly, not just r=/rin=: zscale only
 * retags an axis it is explicitly given, and an axis it passes through keeps
 * the HDR source's tag — which then beats the encoder's own
 * -color_trc/-color_primaries/-colorspace flags. Omitting t=/p= here produced
 * files still reporting arib-std-b67/bt2020 over bt709 pixels (verified against
 * the managed ffmpeg 8.1.2 during T2).
 *
 * `tin=`/`pin=` are equally load-bearing, for the opposite reason: zscale does
 * not relabel an axis, it CONVERTS to it from whatever the frame currently
 * claims. Arriving frames still carry the source's HDR tags (the LUT rewrites
 * pixels, not tags), so `t=bt709:p=bt709` alone ran a real HLG→709 transfer
 * conversion plus a BT.2020→709 gamut map on pixels the LUT had already
 * tone-mapped — highlights clipped per channel and shifted hue (warm wall →
 * yellow, window → cyan). Pinning the post-LUT truth makes both conversions
 * no-ops and leaves only the retag. See lib/normalize.py's twin for the
 * measured numbers.
 *
 * The LUT is graded for HLG input, so PQ sources get a PQ→HLG pre-step at the
 * LUT's 1000-nit design white — the same value SP6a's generator OOTF used.
 *
 * @param {string} srcKey     'hdr_hlg' or 'hdr_pq'
 * @param {string|null} [sdrCurve]  curve id from looks.json; null → MASTER_LOOK
 * @returns {string}
 */
export function buildVividLutChain(srcKey, sdrCurve = null) {
  const prestep = srcKey === 'hdr_pq'
    ? 'zscale=tin=smpte2084:t=arib-std-b67:npl=1000,'
    : ''
  return prestep
       + 'zscale=matrixin=2020_ncl:rangein=limited:range=full,'
       + 'format=rgb48le,'
       + `lut3d=file=${lutPath(sdrCurve)}:interp=tetrahedral,`
       + 'zscale=tin=bt709:t=bt709:pin=bt709:p=bt709:m=bt709:rin=full:r=tv'
}

/**
 * Build the ffmpeg filter chain to convert a source's color space to the project's.
 * Returns an empty string when src === dst (no conversion needed). Mirrors the
 * Python _build_color_conversion_vf() in lib/normalize.py.
 *
 * The two capability flags control the HDR→SDR arm, in descending fidelity:
 * zscale + lut3d gives the Montaj Vivid LUT; zscale alone falls back to the
 * pre-SP6b Hable chain; neither falls back to the bare tonemap. Both fallbacks
 * are degraded (washed-out highlights, shifted colors). The Python loader emits
 * a loud warning when it takes them at intake; segment-encoder usage is more
 * limited (only kicks in when intake didn't already convert), and warnings here
 * would spam render logs once per segment, so we silently fall back.
 *
 * @param {string} srcKey
 * @param {string} dstKey
 * @param {boolean} hasZscaleFlag
 * @param {object} [opts]
 * @param {string|null} [opts.sdrCurve]  curve id for the LUT; null → MASTER_LOOK.
 *   T7 threads `--sdr-curve` down to here for derived SDR renditions.
 * @param {boolean} [opts.hasLut3d]  defaults to the real probe, so a caller that
 *   forgets it gets a chain this ffmpeg can actually run rather than one naming
 *   a missing filter. Deterministic callers (dry-run) pass it explicitly.
 */
export function buildColorConversionFilter(srcKey, dstKey, hasZscaleFlag, opts = {}) {
  if (srcKey === dstKey) return ''
  const { sdrCurve = null, hasLut3d: hasLut3dFlag = hasLut3d() } = opts
  // HDR → SDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq') && dstKey === 'sdr_bt709') {
    if (hasZscaleFlag && hasLut3dFlag) {
      return buildVividLutChain(srcKey, sdrCurve)
    }
    if (hasZscaleFlag) {
      return 'zscale=t=linear:npl=100,format=gbrpf32le,'
           + 'zscale=p=bt709,tonemap=hable:desat=0,'
           + 'zscale=t=bt709:m=bt709:r=tv'
    }
    return 'format=p010le,tonemap=hable:desat=0'
  }
  // SDR → HDR
  if (srcKey === 'sdr_bt709' && (dstKey === 'hdr_hlg' || dstKey === 'hdr_pq')) {
    const dstTransfer = dstKey === 'hdr_hlg' ? 'arib-std-b67' : 'smpte2084'
    return `zscale=t=${dstTransfer}:p=bt2020:m=bt2020nc`
  }
  // HDR ↔ HDR
  if ((srcKey === 'hdr_hlg' || srcKey === 'hdr_pq')
      && (dstKey === 'hdr_hlg' || dstKey === 'hdr_pq')) {
    const dstTransfer = dstKey === 'hdr_hlg' ? 'arib-std-b67' : 'smpte2084'
    return `zscale=t=${dstTransfer}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Shared filter helpers
// Extracted so sample-frame.js can import and call them without duplicating
// the filter-graph logic. Each helper returns { inputArgs, filterParts,
// newVideoLabel }. Callers append inputArgs to their inputs array and push
// filterParts into their filterParts array.
// ---------------------------------------------------------------------------

/**
 * The ONE place ffmpeg rotation filter SYNTAX lives. `@bycrux/timeline-core`'s
 * `toRotatedPixelBox` owns the NUMBERS (normalized degrees, the grown
 * axis-aligned bounding box, the centre-preserving top-left); this owns the
 * string that spends them. No `rotate=` appears in timeline-core, and no
 * geometry is re-derived here — the boundary runs exactly along that seam.
 *
 * Returns a chain fragment with a LEADING comma, or `''` when the box is not
 * rotated. The leading comma (rather than the trailing one `cropStep` /
 * `conversionStep` use below) is what lets all three call sites share one
 * helper: on the video path the rotate step lands AFTER `pad`, which is the
 * last filter before the output label, so there is nothing for a trailing
 * comma to precede.
 *
 * That shape is also what makes the no-rotation guarantee STRUCTURAL rather
 * than a promise. Every call site interpolates this into an otherwise
 * unmodified template literal, and concatenating `''` cannot alter a string,
 * so an item with rotation absent / 0 / 360 emits filters byte-identical to
 * the pre-rotation pipeline. Two frozen encode-args goldens depend on that.
 *
 * `format=yuva420p` is emitted INSIDE this helper — on the video path only,
 * and UNCONDITIONALLY when rotating — so it structurally cannot leak onto an
 * unrotated item. It is a defensive pin, not a load-bearing one: in the
 * production chain (`scale(decrease)` → `pad` → this step → `rotate`), `pad`
 * already leaves the stream alpha-capable, so the `c=black@0.0` corner fill
 * shows the canvas through either way (measured corner Y=150 against ffmpeg
 * 8.1.2, pinned or not). The pin still earns its place: explicitly stating
 * the format beats trusting filter-negotiation to keep doing the right
 * thing, and it is what saves a bare `yuv420p → rotate` chain with no
 * preceding `pad` from going opaque (measured Y=0 unpinned vs. Y=150 pinned
 * in that isolated shape). Same explicit-pin discipline as the
 * `format=rgb48le` before `lut3d` in buildVividLutChain, and for the same
 * class of reason: ffmpeg will pick a format that silently discards what the
 * next filter needs. The image and overlay paths need no pin — their chains
 * already carry alpha (every image fit chain runs through `format=rgba`;
 * the overlay input is pinned to `yuva420p`/`rgba` at its own `format=`
 * step).
 *
 * The angle is emitted as a DEGREE expression (`45*PI/180`), not a
 * pre-computed float radian. ffmpeg evaluates it to the identical double, and
 * the authored degrees stay legible in filter strings, render logs and
 * goldens.
 *
 * @param {{outW: number, outH: number, rotationDeg: number, isIdentity: boolean}} box
 *   — a `toRotatedPixelBox` result. Note that 180° is NOT identity: the box
 *   does not grow, but the pixels still have to turn.
 * @param {boolean} [alphaPin=false] — true on the video path only.
 * @returns {string} `''`, or `,[format=yuva420p,]rotate=…`
 */
/**
 * ANIMATED-ITEM GEOMETRY — the keyframed sibling of `toRotatedPixelBox`.
 *
 * Returns `null` for an item with no keyframes, which is what keeps the static
 * path byte-identical: every caller below branches on this being null and
 * otherwise emits exactly the strings it always has.
 *
 * ── Why the filter chain changes shape, and not just its numbers ────────────
 *
 * Three filters in the existing chain CANNOT accept a variable-size input, and
 * all three fail SILENTLY — no ffmpeg warning, roughly the right picture at
 * small deltas, visibly wrong at the extremes (measured; see the SP9d spike):
 *
 *   1. `rotate` configures against its first frame and mis-scales every
 *      resized frame after it. An animated ANGLE alone is fine; it is the
 *      changing frame SIZE that breaks it.
 *   2. The colour conversion (`zscale` + `lut3d`) does the same. That is the
 *      path every HDR source takes, i.e. the common one, not an edge case.
 *   3. `pad` exposes NO `t` and no `n` even at `eval=frame` — its whole
 *      vocabulary is geometric (`iw ih ow oh a sar dar x y`) — so it cannot be
 *      driven from a curve at all.
 *
 * So the animated chain keeps every size-sensitive filter on a CONSTANT frame
 * and does the varying resize afterwards. `scale` and `pad` still run at their
 * usual place in the order, just sized to the PEAK box the item ever reaches
 * rather than to its current one, and a second `scale` — the animated one —
 * follows the pad:
 *
 *     crop → scale(STATIC, peak box) → convert → pad(STATIC, peak box)
 *          → scale(ANIMATED)  [→ pad(peak, transparent) → rotate]  → overlay
 *
 * `pad` therefore still sits AFTER the conversion, which is the rule the
 * step-order comment in buildVideoItemFilterParts exists to protect: its bars
 * are synthesized black and must stay out of the LUT. And because that pad
 * brings the frame to the canvas's own aspect, the animated `scale` after it is
 * a plain uniform resize — no second fit, no second pad, and nothing for the
 * `t`-less `pad` to have to express.
 *
 * The cost is one extra resample on animated items only (peak box → current
 * box, always a downscale since the peak is by definition the largest). The
 * static path resamples once, and is untouched.
 *
 * @param {object} item     the timeline item
 * @param {'video'|'image'} kind
 * @param {number} vw       canvas width, pixels
 * @param {number} vh       canvas height, pixels
 * @param {number} timeOffset  ITEM-relative seconds at which ffmpeg's `t` is 0
 * @param {number} duration    segment duration, seconds
 * @param {(prop: string, info: object) => void} onCap  called per capped track
 * @returns {null | {
 *   peakW: number, peakH: number, hasRotation: boolean,
 *   rotOutW: number, rotOutH: number,
 *   boxWExpr: string, boxHExpr: string,
 *   xExpr: string, yExpr: string, angleExpr: string | null,
 * }}
 */
function animatedGeometry(item, kind, vw, vh, timeOffset, duration, onCap) {
  const tracks = item?.keyframes
  if (!Array.isArray(tracks) || tracks.length === 0) return null

  // Only the geometry props compile. `opacity` is deliberately absent: ffmpeg's
  // `colorchannelmixer aa` is a <double> and accepts no expression at all, so a
  // clip's opacity curve is IGNORED here and the static value is used instead.
  // That gap is a property of the tool, not an oversight — see docs/RENDER.md.
  const GEOMETRY_PROPS = ['offsetX', 'offsetY', 'scale', 'scaleX', 'scaleY', 'rotation']
  const animatedProps = tracks.filter(
    (tr) => tr && GEOMETRY_PROPS.includes(tr.prop) && Array.isArray(tr.points) && tr.points.length > 0,
  )
  if (animatedProps.length === 0) return null

  const staticGeom = geometryFor(item, kind)

  // Sample the resolved geometry across the segment to find the largest box the
  // item ever occupies, and the widest angle it ever reaches. Keyframe instants
  // are included explicitly because a cubic-bezier easing is monotone between
  // keyframes, so the extremes land ON them; the uniform grid is belt-and-braces
  // for a hand-authored track with an easing that is not.
  const probes = new Set([0, duration])
  for (let i = 0; i <= 120; i++) probes.add((duration * i) / 120)
  for (const tr of animatedProps) {
    for (const p of tr.points) {
      const local = p.t - timeOffset
      if (local >= 0 && local <= duration) probes.add(local)
    }
  }

  let peakW = 0
  let peakH = 0
  let maxAbsDeg = 0
  for (const localT of probes) {
    const g = geometryAt(item, kind, timeOffset + localT)
    const b = toPixelBox(g, vw, vh)
    if (b.width > peakW) peakW = b.width
    if (b.height > peakH) peakH = b.height
    const deg = Number.isFinite(g.rotation) ? Math.abs(g.rotation) : 0
    if (deg > maxAbsDeg) maxAbsDeg = deg
  }
  // A degenerate track (every sample zero-sized) has nothing to animate.
  if (!(peakW > 0) || !(peakH > 0)) return null

  /**
   * One property as an ffmpeg expression, or its static value as a literal.
   * Times are shifted so the compiled `t` is ffmpeg's `t` (0 at the start of
   * this segment) rather than the item-relative `t` the curve is authored in —
   * shifting the BREAKPOINTS rather than rewriting the emitted string keeps
   * this exact and avoids surgery on an expression we just built.
   */
  const exprFor = (prop, staticValue, unitsPerPixel) => {
    const tr = animatedProps.find((x) => x.prop === prop)
    if (!tr) return null
    const shifted = { prop, points: tr.points.map((p) => ({ ...p, t: p.t - timeOffset })) }
    const info = compileTrackExprInfo(shifted, { pixelTolerance: 0.25, unitsPerPixel })
    if (info.capped) onCap(prop, info)
    return info.expr ?? String(staticValue)
  }

  const lit = (v) => String(v)
  // scaleX/scaleY fall back to the uniform `scale` track, then to the static
  // per-axis value — mirroring geometryAt's own resolution order.
  const sExpr = exprFor('scale', staticGeom.scale, 1 / vw)
  const sxExpr = exprFor('scaleX', staticGeom.scaleX, 1 / vw) ?? sExpr ?? lit(staticGeom.scaleX)
  const syExpr = exprFor('scaleY', staticGeom.scaleY, 1 / vh) ?? sExpr ?? lit(staticGeom.scaleY)
  const oxExpr = exprFor('offsetX', staticGeom.offsetX, 100 / vw) ?? lit(staticGeom.offsetX)
  const oyExpr = exprFor('offsetY', staticGeom.offsetY, 100 / vh) ?? lit(staticGeom.offsetY)
  // Rotation's tolerance is converted against the item's PEAK size, per the
  // plan: the pixel error an angle error produces scales with the box's current
  // size, so referencing a fixed or first-frame size under-subdivides exactly
  // when the item is largest and the wobble is most visible. Degrees per pixel
  // at the peak radius.
  const peakDim = Math.max(peakW, peakH)
  const rotExpr = exprFor('rotation', staticGeom.rotation ?? 0, (180 / Math.PI) / (peakDim / 2))

  // `round(...)`, always. ffmpeg TRUNCATES a pixel option's expression toward
  // zero while toPixelBox uses Math.round, so a bare expression that lands a
  // hair under an integer costs a whole pixel against the preview. Pinned by
  // timeline-core's expr.ffmpeg test.
  const evenBox = (dim, sc) => `round(round(${dim}*(${sc}))/2)*2`
  const boxWExpr = evenBox(vw, sxExpr)
  const boxHExpr = evenBox(vh, syExpr)

  // Animating POSITION alone is nearly free — the overlay's x/y are already
  // evaluated per frame, so nothing else in the chain has to change. Only a
  // size or rotation curve forces the restructured chain (and its extra
  // resample), so the two cases are kept apart rather than lumped together.
  const sizeAnimates = animatedProps.some((tr) => tr.prop === 'scale' || tr.prop === 'scaleX' || tr.prop === 'scaleY')
  const rotationAnimates = animatedProps.some((tr) => tr.prop === 'rotation')
  const needsAnimatedChain = sizeAnimates || rotationAnimates
  // A rotate step is emitted on the animated chain whenever the item is turned
  // at all, animated or not: a STATIC angle over a resized input breaks exactly
  // the same way an animated one does.
  const emitRotate = needsAnimatedChain && maxAbsDeg > 0
  let rotOutW = peakW
  let rotOutH = peakH
  if (emitRotate) {
    // `rotate`'s ow/oh are CONFIG-TIME ONLY — `t` in them evaluates to nan and
    // the graph dies — so the grown box is reserved once, at the worst angle the
    // item reaches, and held for every frame.
    const a = (maxAbsDeg * Math.PI) / 180
    rotOutW = Math.round((Math.abs(peakW * Math.cos(a)) + Math.abs(peakH * Math.sin(a))) / 2) * 2
    rotOutH = Math.round((Math.abs(peakW * Math.sin(a)) + Math.abs(peakH * Math.cos(a))) / 2) * 2
  }

  // Composite position. Without rotation the overlay input IS the current box,
  // so its top-left is the box's own. With rotation the input is the frozen
  // rotOutW×rotOutH box, which has to be re-centred on the box centre every
  // frame — the expression sibling of toRotatedPixelBox's centre-preserving
  // `x = xPx - (outW - scaledW)/2`.
  const xPxExpr = `round(${vw}*(0.5*(1-(${sxExpr}))+(${oxExpr})/100))`
  const yPxExpr = `round(${vh}*(0.5*(1-(${syExpr}))+(${oyExpr})/100))`
  const xExpr = emitRotate ? `round(${xPxExpr}+(${boxWExpr})/2-${rotOutW}/2)` : xPxExpr
  const yExpr = emitRotate ? `round(${yPxExpr}+(${boxHExpr})/2-${rotOutH}/2)` : yPxExpr

  return {
    peakW, peakH, needsAnimatedChain, emitRotate, rotOutW, rotOutH,
    boxWExpr, boxHExpr, xExpr, yExpr, xPxExpr, yPxExpr,
    angleExpr: emitRotate
      ? (rotExpr ? `(${rotExpr})*PI/180` : `${staticGeom.rotation ?? 0}*PI/180`)
      : null,
  }
}

/**
 * Composite position for an item whose SIZE and ROTATION are static but whose
 * POSITION animates. The grown-box correction `toRotatedPixelBox` folds into
 * `box.x` is a constant here, so it is simply added to the moving top-left
 * rather than recomputed per frame.
 */
function staticBoxPosition(anim, box) {
  const dx = box.x - box.xPx
  const dy = box.y - box.yPx
  return {
    x: dx === 0 ? anim.xPxExpr : `round(${anim.xPxExpr}+${dx})`,
    y: dy === 0 ? anim.yPxExpr : `round(${anim.yPxExpr}+${dy})`,
  }
}

/**
 * The `[→ pad(peak, transparent) → rotate]` tail of an animated chain.
 *
 * Empty when the item never rotates. Otherwise it re-establishes a CONSTANT
 * frame size before `rotate` — which is the whole reason this exists, since
 * `rotate` mis-renders a resized input — by padding out to the peak box with a
 * TRANSPARENT fill. Transparent, not black: the item's own letterbox bars were
 * already synthesized by the static pad upstream, and painting more black here
 * would draw bars beyond the item's actual box.
 */
function animatedRotateStep(anim, alphaPin = false) {
  if (!anim.emitRotate) return ''
  return `,${alphaPin ? 'format=yuva420p,' : ''}`
       + `pad=${anim.peakW}:${anim.peakH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0:eval=frame,`
       + `rotate='${anim.angleExpr}':ow=${anim.rotOutW}:oh=${anim.rotOutH}:c=black@0.0`
}

/**
 * Warn, once per property, when a track could not be approximated within
 * tolerance. Task 2's compiler reports the cap on a return value, which proves
 * it noticed; this is the only place the information reaches an operator whose
 * export came out slightly coarse and who has no idea why.
 */
function warnIfCapped(item, kind) {
  return (prop, info) => {
    console.warn(
      `[montaj] ${kind} item ${item.id ?? item.src ?? '(unnamed)'}: '${prop}' keyframe curve `
      + `hit the ${info.segments}-segment cap; achieved ${info.maxError.toPrecision(3)} `
      + `vs a ${info.tolerance.toPrecision(3)} target (in ${prop} units). `
      + `The animation renders slightly coarser than the preview.`,
    )
  }
}

function rotateFilterStep(box, alphaPin = false) {
  if (box.isIdentity) return ''
  const pin = alphaPin ? 'format=yuva420p,' : ''
  return `,${pin}rotate=${box.rotationDeg}*PI/180:ow=${box.outW}:oh=${box.outH}:c=black@0.0`
}

// The geometry of an overlay whose transform is ALREADY baked into its capture:
// the identity. Built by `geometryFor` from an empty item rather than written
// out as an object literal, so it cannot drift from the defaults that function
// applies. Consumed only by buildOverlayFilterParts' keyframed branch.
const BAKED_OVERLAY_GEOMETRY = geometryFor({}, 'overlay')

/**
 * Build filter-graph parts for one image item.
 *
 * @param {object} item       — the image item from segment.items
 * @param {number} vw         — canvas width  (pixels)
 * @param {number} vh         — canvas height (pixels)
 * @param {number} idx        — ffmpeg input index for this item
 * @param {string} videoLabel — current composite label, e.g. '[canvas]'
 * @param {number} duration   — segment duration in seconds (used for -t)
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
// NOTE: item.speed is intentionally ignored here — a still image has no
// motion to time-scale, so speed is a no-op for image items (unlike video,
// where it re-times decoded frames).
export function buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration, segStart) {
  // Geometry comes from the shared resolver — see @bycrux/timeline-core's
  // src/geometry.js. This file used to carry its own copy of the formula; three
  // copies lived here and a fourth in the editor, which is what KNOWN-DIVERGENCES
  // D9 tracked. Equivalence is pinned by timeline-core's switchover sweep.
  // toRotatedPixelBox DELEGATES to toPixelBox for scaledW/scaledH, so those are
  // the same integers this line has always produced; it adds the bounding box a
  // rotated frame grows into (outW/outH) and the centre-preserving top-left to
  // composite that box at (box.x/box.y). At rotation absent/0/360 the grown box
  // IS the unrotated box, so box.x/box.y are exactly toPixelBox's x/y and every
  // string below is unchanged.
  const box = toRotatedPixelBox(geometryFor(item, 'image'), vw, vh)
  const { scaledW, scaledH } = box

  // ITEM-relative timeline seconds at the instant ffmpeg's `t` reads 0. The
  // input is `-loop 1 -t duration`, so PTS start at 0 and `t` runs 0..duration
  // in SEGMENT time — hence the shift is (segStart - item.start), the same
  // quantity the video path calls seekOffset. `segStart` is optional so
  // sample-frame.js's six-argument call keeps working; its pseudo-item never
  // carries `keyframes`, so the animated branch cannot engage there anyway.
  const imgOffset = segStart == null ? 0 : Math.max(0, segStart - (item.start ?? 0))
  const anim = animatedGeometry(item, 'image', vw, vh, imgOffset, duration, warnIfCapped(item, 'image'))

  const inputArgs = ['-loop', '1', '-t', String(duration), '-i', item.src]
  const filterParts = []

  // Fit the source image into its scaledW×scaledH box. Default 'cover' preserves
  // aspect ratio and fills the box (cropping overflow); 'contain' preserves AR and
  // letterboxes with transparency; 'fill' is the legacy stretch-to-box behavior
  // (does NOT preserve AR — kept only for explicit opt-in). Mirrors the AR-safe
  // treatment the video branch already applies via force_original_aspect_ratio.
  const fit = item.fit ?? 'cover'
  // When animated, the fit runs to the PEAK box and the varying resize is
  // appended after it. All three fits stay correct under that split because the
  // peak box and every animated box share the CANVAS's aspect ratio, so the
  // trailing resize is uniform and changes framing in none of them.
  const fitW = anim?.needsAnimatedChain ? anim.peakW : scaledW
  const fitH = anim?.needsAnimatedChain ? anim.peakH : scaledH
  let fitChain
  if (fit === 'contain') {
    fitChain = `scale=${fitW}:${fitH}:force_original_aspect_ratio=decrease,format=rgba,`
             + `pad=${fitW}:${fitH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
  } else if (fit === 'fill') {
    fitChain = `scale=${fitW}:${fitH},format=rgba`
  } else { // 'cover' (default)
    fitChain = `scale=${fitW}:${fitH}:force_original_aspect_ratio=increase,`
             + `crop=${fitW}:${fitH},format=rgba`
  }
  // No alpha pin on the rotate: all three fit chains already run through
  // `format=rgba`, so the transparent pad and `c=black@0.0` corners are
  // representable exactly as the static path assumes.
  const animStep = anim?.needsAnimatedChain
    ? `,scale=w='${anim.boxWExpr}':h='${anim.boxHExpr}':eval=frame${animatedRotateStep(anim, false)}`
    : ''
  // Rotate AFTER the fit chain, BEFORE setpts: the fit chain is what establishes
  // the scaledW×scaledH box rotation is defined against, and setpts is timing,
  // not geometry, so it neither cares nor should pay for the grown frame. No
  // alpha pin — all three fit chains above run through `format=rgba`, so the
  // `c=black@0.0` corners are already representable.
  filterParts.push(
    `[${idx}:v]${fitChain}${anim?.needsAnimatedChain ? animStep : rotateFilterStep(box)},setpts=PTS-STARTPTS[img${idx}]`
  )
  let src = `[img${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[imgop${idx}]`)
    src = `[imgop${idx}]`
  }
  // box.x/box.y, not the unrotated x/y: a rotated frame arrives here at
  // outW×outH, so compositing it at the unrotated top-left would translate it
  // by half the growth instead of turning it in place.
  // Opacity is NOT animated even when a curve exists — see the video path.
  const iPos = anim
    ? (anim.needsAnimatedChain ? { x: anim.xExpr, y: anim.yExpr } : staticBoxPosition(anim, box))
    : null
  filterParts.push(
    `${videoLabel}${src}overlay=` +
    `x=${iPos ? `'${iPos.x}'` : box.x}:y=${iPos ? `'${iPos.y}'` : box.y}` +
    `:shortest=0[iv${idx}]`
  )
  const newVideoLabel = `[iv${idx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Build filter-graph parts for one video clip item.
 * Does NOT include the audio extraction step — that stays in the caller.
 *
 * @param {object} item             — the video item from segment.items
 * @param {number} vw               — canvas width  (pixels)
 * @param {number} vh               — canvas height (pixels)
 * @param {number} idx              — ffmpeg input index for this item
 * @param {string} videoLabel       — current composite label, e.g. '[canvas]'
 * @param {object} opts
 * @param {number}  opts.segStart         — segment.start (seconds)
 * @param {number}  opts.duration         — segment duration (seconds)
 * @param {string}  opts.projectColorSpace — e.g. 'sdr_bt709'
 * @param {boolean} opts.zscaleAvailable  — whether ffmpeg has zscale
 * @param {boolean} [opts.lut3dAvailable] — whether ffmpeg has lut3d; omitted → probed
 * @param {string|null} [opts.sdrCurve]   — look curve id for the HDR→SDR LUT
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, opts) {
  const { segStart, duration, projectColorSpace, zscaleAvailable,
          lut3dAvailable, sdrCurve } = opts

  // Geometry comes from the shared resolver — see @bycrux/timeline-core's
  // src/geometry.js. This file used to carry its own copy of the formula; three
  // copies lived here and a fourth in the editor, which is what KNOWN-DIVERGENCES
  // D9 tracked. Equivalence is pinned by timeline-core's switchover sweep.
  // See the note on the image path: toRotatedPixelBox delegates for
  // scaledW/scaledH and adds the grown box plus its centre-preserving top-left.
  const box = toRotatedPixelBox(geometryFor(item, 'video'), vw, vh)
  const { scaledW, scaledH } = box

  const inPt = item.inPoint ?? 0
  const seekOffset = Math.max(0, segStart - item.start)
  // Per-clip playback speed (montaj/speed feature): at speed S the clip
  // consumes S× the source per timeline-second, so the seek advance and the
  // input trim window both scale by S. STRICT NO-OP at S undefined/1 — every
  // string below must stay byte-identical to the pre-speed pipeline (two
  // frozen encode-args goldens depend on it), so the `*speed` arithmetic only
  // runs when hasSpeed is true.
  const speed = item.speed
  const hasSpeed = speed != null && speed !== 1
  const actualIn = hasSpeed ? inPt + seekOffset * speed : inPt + seekOffset

  // `seekOffset` is ITEM-relative TIMELINE seconds at the instant ffmpeg's `t`
  // reads 0, which is exactly the base `Keyframe.t` is authored in — so it is
  // the shift the compiler needs, and it is speed-independent. Speed scales the
  // SOURCE seek (`actualIn`, above) because a 2x clip eats 2x the source per
  // timeline-second; it does not scale timeline time. `setpts` at the head of
  // the chain divides PTS by the speed, so every downstream filter's `t` is
  // already back in timeline seconds. Verified against real footage at 1x, 2x
  // and 0.5x: the animation lands identically at all three.
  const anim = animatedGeometry(item, 'video', vw, vh, seekOffset, duration, warnIfCapped(item, 'video'))

  // ProRes 4444 (.mov from remove-bg) has alpha — use format=auto
  const ovFmt = item.src.endsWith('.mov') ? ':format=auto' : ':format=yuv420'

  const itemColorSpace = detectFromTransfer(item.colorTransfer)
  const skipConversionForAlpha = item.remove_bg && item.nobg_src
  const conversionFilter = skipConversionForAlpha
    ? ''
    : buildColorConversionFilter(itemColorSpace, projectColorSpace, zscaleAvailable,
        { sdrCurve, hasLut3d: lut3dAvailable })
  const conversionStep = conversionFilter ? `${conversionFilter},` : ''

  // -err_detect ignore_err + -max_error_rate 1.0: tolerate broken audio
  // packets from iPhone .MOV sources (see encodeSegment for full comment).
  const inputArgs = [
    '-err_detect', 'ignore_err',
    '-max_error_rate', '1.0',
    '-ss', String(actualIn), '-t', String(hasSpeed ? duration * speed : duration), '-i', item.src,
  ]
  const filterParts = []

  // Optional source crop (clips workflow vertical reframe). Needs source pixel
  // dims; no-op without them. Even dims keep ffmpeg/x264 happy.
  let cropStep = ''
  const sc = item.sourceCrop
  if (sc && item.sourceWidth && item.sourceHeight) {
    const cw = Math.round(item.sourceWidth  * sc.w / 2) * 2  // even: x264 needs even dims
    const ch = Math.round(item.sourceHeight * sc.h / 2) * 2  // even: x264 needs even dims
    const cx = Math.round(item.sourceWidth  * sc.x)          // origin NOT even-rounded (offsets don't require it)
    const cy = Math.round(item.sourceHeight * sc.y)          // origin NOT even-rounded
    cropStep = `crop=${cw}:${ch}:${cx}:${cy},`
  }

  // STEP ORDER IS LOAD-BEARING: crop → scale → convert → pad → rotate
  // (SP6b T6; rotate added by SP9a-2).
  //
  // Geometry first. The conversion used to run at the head of this chain, which
  // meant tone-mapping every source pixel in float before throwing most of them
  // away — a 4K clip feeding a 1080 canvas paid ~9× the pixels it needed. crop
  // and scale are pure geometry (they resample, they don't reinterpret color),
  // so doing them first is color-neutral and the conversion then runs on canvas
  // -sized frames.
  //
  // pad stays AFTER the conversion, exactly as before. Its bars are synthesized
  // black, and synthesizing them post-conversion keeps them in the final SDR
  // domain — black in, black out. Move pad ahead of the conversion and those
  // bars get pushed through the LUT with everything else, which maps them to
  // whatever the grade does to 0,0,0 and tints the letterbox.
  //
  // force_divisible_by=2, and ONLY when a conversion follows: decrease-fit
  // computes the un-pinned dimension from the aspect ratio and will happily
  // return an odd one (a 320x180 source into a 360x640 box fits to 360x203).
  // zscale rejects odd dimensions on subsampled formats outright — "code 1027:
  // image dimensions must be divisible by subsampling factor" — and the whole
  // encode dies. This never bit before because the conversion ran ahead of
  // scale, on the decoder's always-even frame. Rounding is at most one pixel
  // and only on items that are being converted, which keeps every SDR render
  // (and the frozen encode-args goldens) byte-identical.
  //
  // rotate goes LAST, after pad, for two independent reasons.
  //
  // Geometrically it has to. Rotation is defined against the scaledW×scaledH
  // box the item occupies on the canvas, and it is `pad` that produces that
  // box — `scale=…:force_original_aspect_ratio=decrease` fits INSIDE it and
  // generally lands smaller. Rotating before pad would turn the decrease-fit
  // frame and then letterbox the result, i.e. rotate the wrong rectangle and
  // put the bars on the wrong axis.
  //
  // And it is the cheap place. rotate is the one geometry step that GROWS the
  // frame — at scale 1, 45° the bounding box is ~2.2× the pixels — so rotating
  // ahead of the conversion would hand every one of those extra pixels to the
  // LUT chain (rgb48le + lut3d + two zscales), which is by far the most
  // expensive stretch in this graph. Same instinct as the crop → scale →
  // convert ordering above: never make the color chain pay for pixels the
  // geometry chain could have settled first.
  const divisibleBy = conversionStep ? ':force_divisible_by=2' : ''
  // setpts time-compresses the sped-up source back to timeline-real-time: at
  // speed S the S× extra source seconds consumed above play out over 1/S the
  // time. A no-op (bare setpts=PTS-STARTPTS) at speed undefined/1.
  const ptsStep = hasSpeed ? `setpts=(PTS-STARTPTS)/${speed}` : 'setpts=PTS-STARTPTS'
  // The animated branch sizes scale+pad to the PEAK box instead of the current
  // one and appends the varying resize AFTER the pad, so the conversion and
  // `rotate` only ever see a constant frame size — see animatedGeometry's header
  // for why all three of them silently mis-render otherwise. The static branch
  // below is byte-for-byte what it has always been; two frozen goldens say so.
  filterParts.push(
    `[${idx}:v]${ptsStep},${cropStep}` +
    (anim?.needsAnimatedChain
      ? `scale=${anim.peakW}:${anim.peakH}:force_original_aspect_ratio=decrease${divisibleBy},` +
        `${conversionStep}` +
        `pad=${anim.peakW}:${anim.peakH}:(ow-iw)/2:(oh-ih)/2,` +
        `scale=w='${anim.boxWExpr}':h='${anim.boxHExpr}':eval=frame` +
        `${animatedRotateStep(anim, true)}`
      : `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease${divisibleBy},` +
        `${conversionStep}` +
        `pad=${scaledW}:${scaledH}:(ow-iw)/2:(oh-ih)/2${rotateFilterStep(box, true)}`) +
    `[vid${idx}]`
  )
  let src = `[vid${idx}]`
  if (Math.abs((item.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${src}colorchannelmixer=aa=${item.opacity}[vidop${idx}]`)
    src = `[vidop${idx}]`
  }
  // box.x/box.y, not the unrotated x/y — see the image path.
  // Opacity is NOT animated even when a curve exists: `colorchannelmixer aa` is
  // a <double> and accepts no expression, so the static value above stands and
  // the curve is ignored. Documented in docs/RENDER.md; pinned by a test.
  const vPos = anim
    ? (anim.needsAnimatedChain ? { x: anim.xExpr, y: anim.yExpr } : staticBoxPosition(anim, box))
    : null
  filterParts.push(
    `${videoLabel}${src}overlay=` +
    `x=${vPos ? `'${vPos.x}'` : box.x}:y=${vPos ? `'${vPos.y}'` : box.y}` +
    `${ovFmt}:shortest=0[iv${idx}]`
  )
  const newVideoLabel = `[iv${idx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Build filter-graph parts for one JSX overlay (rendered as WebM/MKV with alpha).
 *
 * @param {object} ov         — overlay descriptor from segment.overlays
 * @param {number} vw         — canvas width  (pixels)
 * @param {number} vh         — canvas height (pixels)
 * @param {number} ovIdx      — ffmpeg input index for this overlay
 * @param {string} videoLabel — current composite label
 * @param {number} segStart   — segment.start (seconds), used to compute seek offset
 * @param {number} duration   — segment duration (seconds)
 * @param {object} [opts]
 * @param {number} opts.fps — REQUIRED for stream overlays (see the guard below). The
 *   segment's own fps, the same value that generates the base canvas, so the overlay
 *   is re-stamped onto exactly the grid it will be composited against.
 * @param {string} [opts.inputFormatFlag='yuva420p'] — pixel-format conversion applied to
 *   the overlay input before scale/composite. Default `yuva420p` is the production
 *   render's setting — VP9 decoders may silently drop the alpha plane otherwise.
 *   Callers operating on already-alpha-bearing inputs (e.g. the `sample-frame.js`
 *   mini-composer, which feeds PNG screenshots not VP9) should pass `'rgba'`.
 * @param {string} [opts.compositeFormatFlag='yuv420'] — `format=` flag on the final
 *   overlay step. Default `yuv420` matches production (output is composited onto a
 *   yuv420 video chain). Callers building PNG output should pass `'auto'`.
 * @param {boolean} [opts.loopedInput=false] — when true, emit `-loop 1 -t <duration> -i`
 *   input args instead of the default `-ss <seek> -t <duration> -i` pair. Use for
 *   single-frame PNG overlay inputs (sample-frame.js's overlay path); leave false for
 *   VP9/MKV overlay segments coming from the production renderer chunk pipeline.
 * @returns {{ inputArgs: string[], filterParts: string[], newVideoLabel: string }}
 */
export function buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, segStart, duration, opts = {}) {
  const inputFormatFlag     = opts.inputFormatFlag     ?? 'yuva420p'
  const compositeFormatFlag = opts.compositeFormatFlag ?? 'yuv420'
  const loopedInput         = opts.loopedInput         ?? false

  // Stream overlays MUST declare the segment's fps. The FFV1-in-Matroska chunk
  // carries millisecond-rounded PTS (0.033/0.067/0.100 against the base
  // canvas's exact 0.033333/0.066667/0.100000), so framesync holds every third
  // frame unless the input is re-stamped onto the exact grid below. Defaulting
  // this to 30 would silently reintroduce that defect on any 24 or 60 fps
  // project — hence a throw, not a fallback.
  if (!loopedInput && !(opts.fps > 0)) {
    throw new Error('buildOverlayFilterParts: opts.fps is required for stream overlays')
  }

  const inputArgs = loopedInput
    ? ['-loop', '1', '-t', String(duration), '-i', ov.webmPath]
    : ['-ss', String(Math.max(0, segStart - ov.startSeconds)), '-t', String(duration), '-i', ov.webmPath]
  const filterParts = []

  // Overlay sizing: scale the overlay from its design canvas (always rendered at
  // 1080 on the short edge — see render.js) to the actual output canvas (vw×vh),
  // times the user scale. The target is derived from the OUTPUT dimensions, not
  // by multiplying the design size by a design→output ratio. This is what lets an
  // overlay fit ANY output resolution — 4K upscale, sub-1080 downscale, or a
  // non-integer multiple (e.g. 1440p). The old design→output multiplier assumed
  // output ≥ 1080 and an integer multiple, so on a smaller canvas it left the
  // 1080-design overlay at full size and the compositor cropped it instead of
  // shrinking it. Even-rounded — yuv420/yuva420 encoders reject odd dimensions.
  // Mirrors the image/video item path (buildImage/VideoItemFilterParts), which
  // already sizes to round(vw * scale / 2) * 2.
  //
  // ── Keyframed overlays are already positioned (SP9b T2.3) ─────────────────
  //
  // This filter graph places an overlay ONCE for the whole segment; there is no
  // per-frame hook in it. So an ANIMATED overlay is positioned somewhere that
  // does have one — the Puppeteer page — where the shim wraps the component in a
  // full-canvas layer carrying `geometryAt(item,'overlay',frame/fps)` as a CSS
  // transform (bundle.js `generateShim`). By the time the capture reaches this
  // function, offset/scale/rotation/opacity are IN THE PIXELS, and the only
  // correct thing left to do is drop the (already design-canvas-sized) frame
  // onto the output canvas unchanged.
  //
  // "Unchanged" is spelled as the IDENTITY geometry rather than as hand-written
  // numbers, so it inherits the even-pixel rounding (`round(vw/2)*2`) every
  // other path here uses, and `rotateFilterStep` sees an identity box and emits
  // nothing — a keyframed overlay must NOT rotate twice.
  //
  // Applying `geometryFor` here as well would DOUBLE-apply the transform: a
  // half-scaled, animated overlay would come out quarter-sized.
  const keyframed = Array.isArray(ov.keyframes) && ov.keyframes.length > 0
  const ovBox = toRotatedPixelBox(keyframed ? BAKED_OVERLAY_GEOMETRY : geometryFor(ov, 'overlay'), vw, vh)
  const { scaledW: targetW, scaledH: targetH } = ovBox

  // Force yuva420p (or caller-specified format) — VP9 decoders may silently drop
  // the alpha plane on the production path; PNG-based callers pass 'rgba' to
  // avoid an unnecessary colorspace bounce.
  const ptsPin = loopedInput ? '' : `,setpts=N/(${opts.fps}*TB)`
  filterParts.push(`[${ovIdx}:v]format=${inputFormatFlag}${ptsPin}[ovfmt${ovIdx}]`)
  let ovSrc = `[ovfmt${ovIdx}]`

  // Scale design-canvas → output-canvas (× user scale). When the output already
  // matches the design canvas at scale 1 this is an identity scale (1080→1080),
  // which ffmpeg fast-paths.
  // Rotate AFTER that scale — the design→output scale is what establishes the
  // targetW×targetH box rotation turns within. No alpha pin needed here: the
  // `format=${inputFormatFlag}` step above already put this chain in yuva420p
  // (or rgba for the PNG callers), so `c=black@0.0` is representable.
  filterParts.push(`${ovSrc}scale=${targetW}:${targetH}${rotateFilterStep(ovBox)}[ovsc${ovIdx}]`)
  ovSrc = `[ovsc${ovIdx}]`

  // Item-level opacity, in the same position and the same shape the image path
  // (buildImageItemFilterParts) and video path (buildVideoItemFilterParts) have
  // always used it: after the geometry chain, before the composite.
  //
  // This was MISSING here until SP9b, and missing in two places at once — this
  // function had no opacity term at all, and render.js never stamped `opacity`
  // onto the descriptor to begin with. A translucent overlay therefore looked
  // translucent in the editor preview and rendered fully opaque. Both ends are
  // fixed now. Unrelated to keyframes; it was simply a gap.
  //
  // The epsilon guard is the sibling paths' guard verbatim, and it is
  // load-bearing beyond tidiness: opacity 1 (and absent) must emit NOTHING, so
  // every overlay that does not set opacity keeps a byte-identical filter graph
  // and the frozen render goldens stay valid.
  //
  // NOT applied to a keyframed overlay: the shim already baked opacity into the
  // capture as CSS (bundle.js `generateShim`), so a second multiply here would
  // square it — 0.5 would render at 0.25. The two paths are mutually exclusive
  // by construction, and the alpha is definitely present either way because the
  // `format=${inputFormatFlag}` step above pinned this chain to yuva420p/rgba.
  if (!keyframed && Math.abs((ov.opacity ?? 1) - 1) > 0.001) {
    filterParts.push(`${ovSrc}colorchannelmixer=aa=${ov.opacity}[ovop${ovIdx}]`)
    ovSrc = `[ovop${ovIdx}]`
  }

  // ovBox.x/ovBox.y is the top-left of the GROWN box; identical to the
  // unrotated top-left whenever the overlay is not rotated. `overlay` accepts
  // negative coordinates, and a rotated overlay near an edge legitimately
  // produces them — do not clamp.
  filterParts.push(
    `${videoLabel}${ovSrc}overlay=x=${ovBox.x}:y=${ovBox.y}:format=${compositeFormatFlag}:shortest=0[vov${ovIdx}]`
  )
  const newVideoLabel = `[vov${ovIdx}]`

  return { inputArgs, filterParts, newVideoLabel }
}

/**
 * Pitch-preserving time-compression chain for a sped-up clip's audio.
 * ffmpeg's `atempo` filter accepts a per-instance factor in [0.5, 2.0] only —
 * outside that range it must be chained, each instance's factor still within
 * bounds, so their product equals the requested speed. Preserves pitch, unlike
 * scaling PTS directly (which is how the video side re-times, but would
 * chipmunk/slow-motion-drone the audio).
 *
 * @param {number} speed — clip playback speed, e.g. 4 or 0.25
 * @returns {string} e.g. speed=4 -> 'atempo=2,atempo=2'; speed=0.25 -> 'atempo=0.5,atempo=0.5'
 */
function atempoChain(speed) {
  const factors = []
  let r = speed
  while (r > 2.0) { factors.push(2.0); r /= 2.0 }
  while (r < 0.5) { factors.push(0.5); r *= 2.0 }
  factors.push(r)
  return factors.map((f) => `atempo=${f}`).join(',')
}

/**
 * How far through its crossfade this item is at BOTH ends of one segment, or
 * null when it is not crossfading here.
 *
 * `item.crossfade` (stamped by render.js's collectAllItems) carries the PAIR'S
 * SPAN in timeline seconds — `{ role, start, end }` — never a progress value,
 * and the progress is derived here instead. That split is forced, not stylistic:
 * `segment-plan.js`'s `activeIn` hands every segment the SAME item objects (it
 * "preserves input order and object identity"), so one item is shared by every
 * segment it is active in and a per-segment number has nowhere to live on it.
 *
 * Deriving it here is also what gates the fade correctly. The outgoing clip
 * carries its `crossfade` through every earlier segment too, and `p0 === p1`
 * there — so a segment sitting outside the span reads as "not transitioning"
 * and emits exactly the graph it always did, rather than fading a clip to
 * silence long before the overlap begins.
 *
 * @param {object} [item]
 * @param {number} segStart
 * @param {number} segEnd
 * @returns {{ role: 'from' | 'to', p0: number, p1: number } | null}
 */
function crossfadeIn(item, segStart, segEnd) {
  const cf = item?.crossfade
  if (!cf) return null
  const p0 = transitionProgress(cf, segStart)
  const p1 = transitionProgress(cf, segEnd)
  if (!(p1 > p0)) return null
  return { role: cf.role, p0, p1 }
}

/**
 * Match every outgoing item with the incoming one it is actually paired with,
 * and return the items reordered so each matched partner sits IMMEDIATELY
 * AFTER its own outgoing item.
 *
 * ── WHY THIS EXISTS: THE TWO HALVES DO NOT ARRIVE ADJACENT ─────────────────
 *
 * They do not even arrive in document order. `compose.js` merges its two
 * collections as `[...imageItems, ...videoItems]` and `planSegments`
 * stable-sorts that by `trackIdx` ONLY, so two clips sharing a track keep the
 * images-before-videos order the merge imposed (KNOWN-DIVERGENCES D7). A
 * video → image transition therefore reaches the encoder with the INCOMING
 * item FIRST. Read the partner off `items[ii + 1]` and that pair finds no
 * incoming item at all: the export hard-cuts while the preview,
 * `sample-frame.js` and the audio ramp all crossfade. Worse, when some
 * unrelated item happens to sit at `ii + 1` — the incoming half of a DIFFERENT
 * pair, on a different track — position-matching adopts it and splits the
 * canvas around a pair that does not exist.
 *
 * ── WHAT IDENTIFIES A PAIR: THE SPAN, PLUS THE TRACK ───────────────────────
 *
 * `render.js` stamps the identical `{ start, end }` on both halves as it walks
 * `transitionPairs`, so the span is the pair's NAME — the one fact both sides
 * share and nobody else does. The track is the other half of the rule because
 * crossfades are derived PER TRACK: two items on different tracks are stacked,
 * not sequenced, so blending them is meaningless even when their spans
 * coincide (which, for two transitions running at the same instant, they do).
 * Array position identifies nothing at all.
 *
 * The search runs over the WHOLE array rather than forward from the outgoing
 * item, because in front of it is exactly where the partner is most often
 * found — see the merge order above.
 *
 * ── REORDERING IS SAFE FOR Z-ORDER ─────────────────────────────────────────
 *
 * `planSegments` hands this an array already sorted ascending by `trackIdx`,
 * and a pair shares a track, so every item BETWEEN the two halves shares that
 * track too. The permutation is contained inside a single track's group —
 * where the order was already the arbitrary images-then-videos artifact of the
 * merge and never a meaningful z-order. Nothing moves across tracks, so the
 * layering the segment renders is untouched. Reordering here (rather than
 * matching at the branch) is also what keeps the compositing correct when a
 * third item on the same track sits between the two halves: it would otherwise
 * composite onto ONE branch of the split and vanish from the other.
 *
 * @param {object[]} items — one segment's visual items, trackIdx-ascending
 * @param {number} segStart
 * @param {number} segEnd
 * @returns {{ items: object[], partnerOf: Map<object, object>, paired: Set<object> }}
 *   `partnerOf` is keyed by outgoing item; `paired` holds BOTH halves of every
 *   matched pair, and is what gates the audio ramp.
 */
function matchCrossfadePairs(items, segStart, segEnd) {
  const partnerOf = new Map()
  const paired = new Set()
  for (const from of items) {
    if (crossfadeIn(from, segStart, segEnd)?.role !== 'from') continue
    const span = from.crossfade
    // `!paired.has(c)` keeps two simultaneous transitions from claiming the
    // same incoming item; missing trackIdx reads as 0, matching timeline-core's
    // `byTrackIdx` (segment-plan.js's sort comparator).
    const to = items.find((c) =>
      !paired.has(c) &&
      (c.trackIdx ?? 0) === (from.trackIdx ?? 0) &&
      c.crossfade?.start === span.start &&
      c.crossfade?.end === span.end &&
      crossfadeIn(c, segStart, segEnd)?.role === 'to')
    if (!to) continue
    partnerOf.set(from, to)
    paired.add(from)
    paired.add(to)
  }
  // The overwhelmingly common case: nothing is transitioning here. Return the
  // caller's own array so a segment with no pair is byte-identical to one from
  // a project that has no transition anywhere.
  if (partnerOf.size === 0) return { items, partnerOf, paired }

  // Stable: every item keeps its place except a matched incoming one, which is
  // lifted out and re-inserted directly behind its own outgoing item.
  const lifted = new Set(partnerOf.values())
  const ordered = []
  for (const item of items) {
    if (lifted.has(item)) continue
    ordered.push(item)
    const to = partnerOf.get(item)
    if (to) ordered.push(to)
  }
  return { items: ordered, partnerOf, paired }
}

/**
 * @param {object} segment — from planSegments(); may carry a colorSpace key
 *   (project working color space). Defaults to sdr_bt709 when missing.
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {boolean} [opts._dryRun] — return { inputs, filterParts, args } without executing
 * @param {string|null} [opts.sdrCurve] — look curve id for any HDR→SDR item
 *   conversion in this segment; null/omitted uses the master look.
 * @returns {string | object} outputPath, or dry-run result
 */
export async function encodeSegment(segment, outputPath, opts = {}) {
  const { start, end, overlays, vw, vh, fps } = segment
  // Pair up the crossfading items BEFORE anything is emitted. `items` is the
  // reordered array from here down, so every "the incoming item follows the
  // outgoing one" assumption below is true by construction rather than by
  // luck — see matchCrossfadePairs for why the raw order cannot be trusted.
  const { items, partnerOf, paired } = matchCrossfadePairs(segment.items, start, end)
  // When an opaque overlay covers this segment, the overlay replaces the frame
  // but the underlying items still contribute their AUDIO. opaqueVideo gates the
  // VIDEO compositing of items only — never their audio. Defaults to false so
  // pre-existing callers/tests (which don't set it) keep their behaviour.
  const opaqueVideo = segment.opaqueVideo ?? false
  const duration = end - start
  const projectColorSpace = segment.colorSpace ?? DEFAULT_COLOR_SPACE
  const spec = specFor(projectColorSpace)
  // Dry-run pins both probes to true so the golden capture never depends on the
  // host's ffmpeg build (see encode-args-golden.test.mjs's determinism note).
  const zscaleAvailable = opts._dryRun ? true : hasZscale()
  const lut3dAvailable  = opts._dryRun ? true : hasLut3d()
  const sdrCurve = opts.sdrCurve ?? null

  if (!opts._dryRun) mkdirSync(dirname(outputPath), { recursive: true })

  const inputs = []
  const filterParts = []
  let videoLabel
  const audioLabels = []
  let inputIdx = 0

  // --- Step 1: Black canvas base (always present — items layer on top) ---
  // Canvas format follows the project's working pix_fmt so item layers can
  // composite without forced bit-depth conversion.
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${vw}x${vh}:rate=${fps}:duration=${duration}`)
  filterParts.push(`[0:v]format=${spec.outputPixFmt}[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // --- Step 2: Visual items layered in trackIdx order (lower = background) ---
  // The half-built crossfade, live only between the outgoing item and its
  // matched partner — which the pre-pass has already placed immediately after
  // it. Carries that partner so the blend closes on the item it opened for and
  // not merely on the next `to` to come along. Null everywhere else.
  let pendingBlend = null
  for (let ii = 0; ii < items.length; ii++) {
    const item = items[ii]
    const idx  = inputIdx

    // ── Clip crossfade ──────────────────────────────────────────────────
    //
    // Split the running canvas, composite the OUTGOING item down one branch
    // and the INCOMING one down the other, then blend the two finished frames.
    //
    // Blending the composited FRAMES (rather than alpha-ramping the incoming
    // item's layer) is what makes this exact: both branches share the same
    // background, so the background cancels out of the mix and what is left is
    // a straight lerp between the two pictures — no dip toward black, and it
    // works whether the items are full-frame or small boxes.
    //
    // `blend` and not `xfade`: xfade can only run a full 0->1 ramp, and a
    // segment gets a PARTIAL slice of the span whenever an overlay or caption
    // boundary lands strictly inside the overlap. `blend`'s all_expr takes the
    // sub-range directly, so there is one code path and no boundary surgery.
    // Its per-pixel cost was measured before this was committed — see the
    // plan's Spike Results.
    //
    // Do NOT "optimize" this to xfade later on its headline 1.10-1.12x. That
    // number is not one cheap filter: xfade refuses 4:2:0 and forces
    // yuva420p -> yuva444p on BOTH branches plus one conversion back to
    // yuv420p10le — three extra full-frame conversions this path never incurs
    // — and it still cannot express a partial ramp, which is the whole reason
    // the design does not use it.
    //
    // Colour: each branch has already been through its own per-item conversion
    // inside buildVideoItemFilterParts, so both sides are in the project's
    // working colour space by the time they meet here. Blending BEFORE that
    // conversion would mix two different transfer curves.
    //
    // The partner is the one `matchCrossfadePairs` matched by SPAN + TRACK, not
    // whatever sits at `items[ii + 1]`. The two halves reach this loop in an
    // order that is neither document order nor adjacency (compose merges
    // `[...imageItems, ...videoItems]`, sorted by trackIdx only), so a
    // positional read blends the wrong pair or no pair at all — the full
    // argument is on that function.
    const xf = crossfadeIn(item, start, end)
    const opensCrossfade = !opaqueVideo && partnerOf.has(item)
    if (opensCrossfade) {
      filterParts.push(`${videoLabel}split=2[xfa${idx}][xfb${idx}]`)
      pendingBlend = { idx, p0: xf.p0, p1: xf.p1, fromOut: null, to: partnerOf.get(item) }
      videoLabel = `[xfa${idx}]`
    }

    if (isImageItem(item)) {
      // Under an opaque overlay the frame is fully covered and images carry no
      // audio, so an image item contributes nothing here — skip it entirely
      // (no input, no inputIdx bump).
      if (opaqueVideo) continue
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildImageItemFilterParts(item, vw, vh, idx, videoLabel, duration, start)
      inputs.push(...inputArgs)
      filterParts.push(...fp)
      videoLabel = newVideoLabel
    } else {
      // Video clip
      // Per-item color conversion: when the source's color space differs from
      // the project's, inject the conversion filter (tonemap / inverse-stretch /
      // HDR cross). item.colorTransfer is stamped during render.js's videoItems
      // collection pass — no per-segment ffprobe.
      //
      // EXCEPTION: skip color conversion for remove_bg items. Their `src` is a
      // ProRes 4444 alpha file (yuva422p10le / yuva444p10le) and zscale (libzimg)
      // does not accept alpha pixel formats — the pipeline errors out with
      // "Generic error in an external library / Could not open encoder before
      // EOF". Splitting alpha from YUV, converting YUV through zscale, then
      // recombining is doable but complex; for v1 we accept that bg-removed
      // SDR content composites into HDR canvas as-is. The segment output is
      // still tagged HLG/PQ at the container level, so players treat the cutout
      // pixels as SDR-on-HDR-canvas (slightly lifted highlights but watchable).
      // Sources that aren't bg-removed go through the normal conversion path.
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildVideoItemFilterParts(item, vw, vh, idx, videoLabel, {
          segStart: start,
          duration,
          projectColorSpace,
          zscaleAvailable,
          lut3dAvailable,
          sdrCurve,
        })
      // The input (carrying its -ss/-t window) is ALWAYS added so the clip's
      // audio is available to Step 5. Its VIDEO is composited only when the
      // frame is NOT covered by an opaque overlay — opaque replaces the picture,
      // it must not silence the voiceover underneath.
      inputs.push(...inputArgs)
      if (!opaqueVideo) {
        filterParts.push(...fp)
        videoLabel = newVideoLabel
      }

      // Audio from ALL unmuted video items — collected here, mixed in Step 5.
      // Runs regardless of opaqueVideo so audio survives full-screen animations.
      // item.hasAudio, when stamped (render.js pre-probes once per unique
      // source — see the audioCache loop), wins over the per-segment check.
      // Otherwise: in dry-run mode, skip the ffprobe check (file may not
      // exist) and assume audio present.
      if (!item.muted && (item.hasAudio ?? (opts._dryRun || fileHasAudio(item.src)))) {
        const vol = item.volume ?? 1.0
        const aLabel = `a${idx}`
        // atrim=0:${duration} makes the per-segment sample count exact and
        // explicit in the filter chain, rather than implicit in ffmpeg's
        // -accurate_seek + -t behaviour. Matches the anullsrc path which
        // already does this, and pairs with the PCM codec (no AAC framing
        // means no rounding to absorb a stray trailing sample).
        //
        // Per-clip speed (S !== 1): the input above was trimmed to S× the
        // segment duration of source seconds (see buildVideoItemFilterParts),
        // so atrim's window widens to match, and atempoChain time-compresses
        // that S× window back down to `duration` output seconds — pitch
        // preserved, unlike scaling PTS the way the video side does. atrim
        // stays BEFORE asetpts either way: it locks the sample range against
        // the input's own (seek-based) PTS, not the zero-based PTS asetpts
        // produces.
        const speed = item.speed
        const hasSpeed = speed != null && speed !== 1
        // The picture crossfades; the sound must too, or the overlap plays both
        // clips at full level. Same shape as mix-audio.js's per-track fade, and
        // it runs even under an opaque overlay — opaque replaces the picture,
        // never the voiceover.
        //
        // NOT `afade`: a segment gets a PARTIAL slice of the transition span
        // whenever an overlay or caption boundary lands strictly inside the
        // overlap (same reason the video ramp above uses `blend` and not
        // `xfade`), and `afade` cannot express a partial ramp — it anchors the
        // fade at `st=0` and rejects a negative `st` outright (verified:
        // "Value -0.500000 for parameter 'st' out of range"), so there is no
        // way to tell it "this segment's slice of the fade already began
        // before t=0". Instead this mirrors the video's own `p0 + k*T` ramp
        // (see `prog` above) with a `volume` time expression: `afade`'s
        // default curve is `tri` (linear), so this produces the identical
        // ramp `afade` did for the old full-span case and the correct
        // sub-range ramp for a partial one.
        //
        // Placed after `volume` and before `aformat` so it shapes the item's own
        // level and the existing `amix` then sums two complementary ramps. After
        // `atempoChain` too, on the sped-up branch: by that point the audio has
        // already been time-compressed back to `duration` output seconds, which
        // is the clock this expression's `t` is measured in.
        //
        // Gated on the PAIR, not on this item's own `crossfade` field: an item
        // whose partner could not be matched is not transitioning, whatever its
        // field says, and its picture hard-cuts. Duck its sound anyway and the
        // two disagree about whether a transition is happening — the same fault
        // the partial-segment ramp above fixes, in a different direction (there
        // the ramp had the wrong SHAPE; here it should not exist at all). Note
        // this is the pair and NOT `opensCrossfade`: an opaque overlay replaces
        // the picture, so the blend is skipped while the voiceover underneath
        // still crossfades, and `paired` is deliberately blind to that flag.
        let fade = ''
        if (xf && paired.has(item)) {
          const k = (xf.p1 - xf.p0) / duration
          const aprog = xf.p0 === 0 ? `${k}*t` : `${xf.p0}+${k}*t`
          fade = xf.role === 'from'
            ? `,volume='1-(${aprog})':eval=frame`
            : `,volume='${aprog}':eval=frame`
        }
        const audioFilter = hasSpeed
          ? `[${idx}:a:0]atrim=0:${duration * speed},asetpts=PTS-STARTPTS,${atempoChain(speed)},volume=${vol}${fade},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`
          : `[${idx}:a:0]atrim=0:${duration},asetpts=PTS-STARTPTS,volume=${vol}${fade},aformat=channel_layouts=stereo:sample_rates=48000[${aLabel}]`
        filterParts.push(audioFilter)
        audioLabels.push(`[${aLabel}]`)
      }
    }

    if (opensCrossfade) {
      // Park the outgoing branch's finished frame and send the incoming item
      // down the other half of the split.
      pendingBlend.fromOut = videoLabel
      videoLabel = `[xfb${pendingBlend.idx}]`
    } else if (pendingBlend?.to === item) {
      // Closes on the MATCHED partner by identity — not on the next item that
      // happens to be a `to`. The pre-pass has already made these the same item,
      // and keeping the identity check means a future change to the ordering
      // cannot silently resurrect the cross-track mismatch.
      //
      // ── The EXPRESSION FORM IS LOAD-BEARING (measured, Task 1) ───────────
      //
      // Emit `A+(B-A)*p`, NEVER the algebraically identical `A*(1-p)+B*p`.
      // On a real 4K HDR overlap segment the literal form costs 1.86-2.01x the
      // hard-cut baseline — straddling this feature's 2x gate — while the folded
      // form costs 1.35-1.49x and produces BYTE-IDENTICAL output (verified
      // per-pixel over the whole 8.3 MP frame: max|diff| = 0). `blend` evaluates
      // all_expr per pixel per plane, so one fewer multiply and one fewer
      // subtract per pixel is worth ~0.5x of baseline. Fold the coefficients in
      // JS at graph-build time; do not make ffmpeg do arithmetic it can't hoist.
      //
      // `A` is the FIRST input — verified against ffmpeg, not assumed — so the
      // outgoing branch goes first and the expression lands on it at p=0 and on
      // the incoming one at p=1.
      const { idx: xfIdx, p0, p1, fromOut } = pendingBlend
      // p(T) = p0 + k*T over this segment's own clock. The p0 === 0 case (the
      // common one — a segment covering the whole overlap) drops a term.
      const k = (p1 - p0) / duration
      const prog = p0 === 0 ? `${k}*T` : `${p0}+${k}*T`
      filterParts.push(`${fromOut}${videoLabel}blend=all_expr='A+(B-A)*(${prog})'[xf${xfIdx}]`)
      videoLabel = `[xf${xfIdx}]`
      pendingBlend = null
    }
    inputIdx++
  }

  // --- Step 3: Overlay + caption inputs (captions already sorted last by planSegments) ---
  for (const ov of overlays) {
    const ovIdx = inputIdx
    const { inputArgs, filterParts: fp, newVideoLabel } =
      buildOverlayFilterParts(ov, vw, vh, ovIdx, videoLabel, start, duration, { fps })
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
  }

  // --- Step 4: Per-frame color metadata stamping (per project color space) ---
  filterParts.push(`${videoLabel}${spec.setparams}[vout]`)
  videoLabel = '[vout]'

  // --- Step 5: Audio ---
  //
  // Build the final audioLabel. Three cases:
  //   - No video items contributed audio → silent stereo 48kHz via anullsrc.
  //   - Exactly one source            → use it directly.
  //   - Multiple sources               → amix them, preserving per-item volumes
  //                                      (normalize=0).
  //
  // The encoder always runs (PCM s16le — see Step 6 for the rationale). There
  // is no stream-copy fast path: the previous fast path bypassed the encoder
  // for single-audioclean-vol=1 segments and was the source of an audible pop
  // at every intra-clip segment boundary, because input seek aligned to the
  // nearest AAC frame (up to ~21ms early) and the concat demuxer dropped the
  // per-segment edit list when re-encoding audio. Always encoding to PCM here
  // removes the per-segment AAC framing/priming/edit-list class of artifacts;
  // any residual seam discontinuity is bounded by the source AAC decoder's
  // per-process seek precision (empirically ~500-unit sample delta vs ~2400
  // pre-fix on the same boundaries), not by the encoder/container.
  let audioLabel
  if (audioLabels.length === 0) {
    inputs.push('-f', 'lavfi', '-i', `anullsrc=cl=stereo:r=48000`)
    filterParts.push(`[${inputIdx}:a]atrim=0:${duration},asetpts=PTS-STARTPTS[sil]`)
    audioLabel = '[sil]'
    inputIdx++
  } else if (audioLabels.length === 1) {
    audioLabel = audioLabels[0]
  } else {
    const mixInput = audioLabels.join('')
    filterParts.push(`${mixInput}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`)
    audioLabel = '[amixed]'
  }

  // --- Step 6: Encode ---
  // Encoder, encoder params, output pix_fmt, and stream-level color metadata
  // are all driven by the project's color space spec.
  // Per-segment audio is PCM s16le, NOT AAC. AAC framing (~21ms per frame),
  // encoder priming (~2112 samples per encode), and MP4 edit-list metadata
  // do not survive ffmpeg's concat demuxer cleanly when audio is decoded for
  // re-encode at concat — see the audio-pop bug noted in the CHANGELOG. PCM
  // has none of those per-segment encoder/container properties, so the seam
  // artifacts collapse into the much smaller residual from the source AAC
  // decoder's seek precision across independent ffmpeg processes (~10× less
  // than the prior artifact in measurements). The concat step in compose.js
  // re-encodes the joined PCM stream to AAC once, end-to-end — that single
  // AAC encode is the only one in the pipeline now.
  //
  // The previous `aac_at`-under-libx265-4K-concurrent-encode corruption issue
  // (which the deleted stream-copy fast path worked around) is also resolved
  // by this change in principle: aac_at is no longer invoked at all, and the
  // end-of-pipeline native-`aac` encode at concat runs after every libx265
  // process has exited. That claim is asserted, not empirically reverified —
  // if the corruption pattern recurs at the concat re-encode, it's a separate
  // follow-up rather than a regression of this fix.
  const audioArgs = ['-map', audioLabel, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
  const args = [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', videoLabel,
    ...audioArgs,
    '-c:v', spec.encoder, ...spec.encoderArgs, '-pix_fmt', spec.outputPixFmt,
    ...spec.outputColorArgs,
    // A Dolby Vision source (e.g. an iPhone HDR clip) carries a DV RPU, and
    // nothing upstream strips it: its side data propagates through the filter
    // graph into libx265, which re-emits the RPU in-band (HEVC NAL type 62), and
    // the MP4 muxer then dies with "Error submitting a packet to the muxer: Not
    // yet implemented in FFmpeg, patches welcome". Montaj outputs HDR10/HLG,
    // never Dolby Vision, so the RPU is unwanted — dropping NAL 62 before the
    // muxer leaves plain HEVC (the HDR10 mastering-display / content-light SEI,
    // NAL 39/40, are untouched). No-op on a non-DV or non-HEVC stream.
    ...(/265|hevc/i.test(spec.encoder) ? ['-bsf:v', 'filter_units=remove_types=62'] : []),
    '-g', String(fps), '-keyint_min', String(fps),
    '-t', String(duration),
    '-movflags', '+faststart',
    outputPath,
  ]

  if (opts._dryRun) return { inputs, filterParts, args }

  const result = await runFfmpeg(args, FFMPEG_TIMEOUT_MS)

  if (result.stderr) logFfmpegStderr(result.stderr)

  if (result.status !== 0) {
    throw new Error(`ffmpeg segment encode failed (${start.toFixed(2)}-${end.toFixed(2)}s):\n${(result.stderr || '').slice(-500)}`)
  }

  return outputPath
}

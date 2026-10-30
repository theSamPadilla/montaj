#!/usr/bin/env node
/**
 * sample-frame.js — Single-frame preview tools for overlay JSX and composed project frames.
 *
 * Exports:
 *   sampleOverlay({ componentPath, props, frame, fps, width, height, googleFonts, measure, outPath })
 *     → { pngPath, measurements? }
 *   sampleFrame({ projectJson, atSeconds, outPath })
 *     → { pngPath }
 *   sampleScene({ projectJson, scene, atSeconds, outPath })
 *     → { pngPath }   one 3D alone, atSeconds into it
 *
 * CLI:
 *   node sample-frame.js --mode overlay --component <path> [--frame N] [--fps N]
 *     [--width W] [--height H] [--props '{...}'] [--google-fonts font1,font2]...
 *   --google-fonts may repeat, and each value may be a comma list or a JSON
 *   array; google-fonts.js reads them all (§140).
 *     [--measure] --out <path>
 *
 *   node sample-frame.js --mode frame --project <path> --at <seconds> --out <path>
 *     [--clamp-to-end]  past the end: sample the last frame, write <out>.clamped.json
 *     [--scene <id>]    one 3D alone, --at seconds into it ('' is the project's own)
 *     [--no-captions]   the frame without the captions overlay (to read the picture under a caption)
 *   --at may repeat (2+) with --frames-dir <dir> instead of --out: one process renders every
 *   time in order to <dir>/f_0000.png, f_0001.png, ... and prints one path per line.
 *
 * stdout: absolute PNG path (or JSON with measurements if --mode overlay --measure)
 * stderr: progress lines prefixed [montaj sample]
 * exit 0 success, exit 1 failure
 */
import puppeteer from 'puppeteer'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, copyFileSync, rmSync, renameSync } from 'fs'
import { resolve, join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { createHash } from 'crypto'

import { bundleComponent, cleanupBundle, resolveFilePath } from './bundle.js'
import { overlayPageLaunchOptions, installPageGuard, prefetchPropsUrls } from './page-guard.js'
import { fontLoadFailure, fontFailureWarning } from './google-fonts.js'
import { threeFrameRetry, isThreeFrameBlank } from './three-frame.js'
import { isMain as isMainModule } from './is-main.js'
import { toFileHref, propFilePath } from './file-url.js'
import { pMap } from './p-map.js'
import { FFMPEG } from './ffmpeg-bin.js'
import { ffSeconds } from './ff-seconds.js'
import { finiteNumber, positiveNumber, frameSize } from './filter-number.js'
import { ffmpegErrorTail } from './ffmpeg-error.js'
import { externalizeFilterGraph } from './filter-script.js'
import { isHdr } from './color-space.js'
import { sdrLayerFor, gradeKeyFor, probeMedia } from './sdr-layer.js'
import { curveIds, lutPath, MASTER_LOOK } from './look.js'
import {
  buildImageItemFilterParts,
  buildVideoItemFilterParts,
  buildOverlayFilterParts,
  buildVividLutChain,
  buildCutoutGradeFilter,
  UNTAGGED_AS_BT709_VF,
  hasZscale,
  hasLut3d,
  SEEK_PREROLL_S,
} from './encode-segment.js'
import { writeItemMask } from './item-mask.js'
import { resolveAt, sourceWindow, opaqueReplacesPicture, isFullCanvasPlacement, opacityAt, maskAt, blendModeOf, trackLayerPositions, RESOLVER_VERSION } from '@bycrux/timeline-core'
import { enabledTrackItems, trackItems, withEnabledItemTracks } from './project-tracks.js'
import { captionOverlayFields } from './caption-spec.js'
import { materializeScene3d, Scene3dError, SCENE3D_SRC } from './scene3d.js'
import { resolveProjectSrc, resolveDerivedSrc } from './project-paths.js'

/**
 * The pre-SP6b Hable chain: the ONLY place this file tonemaps with Hable, used
 * only when ffmpeg lacks zscale or lut3d (buildSampleGradeVf's else arm).
 * tests/test_sample_steps.py scans for exactly that.
 */
const HABLE_FALLBACK_VF = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,'

/**
 * Inline HDR -> SDR grade for a camera-origin layer, ending in rgb24 (the PNG
 * encoder rejects yuv420p). The healthy path is the render's own
 * buildVividLutChain.
 */
export function buildSampleGradeVf(key, sdrCurve = null) {
  if (hasZscale() && hasLut3d()) {
    return `${buildVividLutChain(key, sdrCurve)},format=rgb24`
  } else {
    return `${HABLE_FALLBACK_VF}format=rgb24`
  }
}

/**
 * Graph for a remove_bg cutout (untagged ProRes 4444 alpha holding HLG/PQ
 * signal in BT.601 YUV). zscale takes no alpha format, so the colour is graded
 * on a split and the matte merged back, ending in rgba. The grade is the
 * export's own buildCutoutGradeFilter (which declares the file BT.601), so the
 * still and the export cannot drift.
 */
export function buildCutoutSampleVf(key, sdrCurve = null) {
  const grade = buildCutoutGradeFilter(key, hasZscale(), { sdrCurve, hasLut3d: hasLut3d() })
  return `split=2[c][a];[a]alphaextract[al];[c]${grade},format=yuv444p[cg];[cg][al]alphamerge,format=rgba`
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const isMain = isMainModule(import.meta.url, process.argv[1])

// Absolute directory holding a vendored fonts.css — same env var and same
// "configuration, never project data" contract as render.js's MONTAJ_FONTS_DIR
// (see that file, and bundleComponent's doc in bundle.js). Read directly here
// rather than threaded through as a parameter: this file has no caller that
// already carries app configuration down to it (sampleOverlay is invoked both
// from this file's own CLI and from sampleFrame()'s internal overlay loop
// below), so matching render.js's module-scope env idiom covers both call
// paths at once instead of requiring a new plumbing argument on each. Unset →
// '', which bundleComponent's own default already treats as "no base".
const MONTAJ_FONTS_DIR = process.env.MONTAJ_FONTS_DIR || ''

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

const CACHE_DIR = join(tmpdir(), 'montaj-sample-cache')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
const OVERLAY_CONCURRENCY = 4
const SHORT_EDGE_TARGET = 1080

/**
 * Bump when a change alters the pixels a sampled frame shows for the same
 * project file, so the 24 h on-disk cache cannot serve the old picture. It keys
 * both caches: the composited frame (`buildFrameCacheKey`) and the per-overlay
 * PNG (`buildOverlayCacheKey`, from 5 on).
 * 2: PV42, HDR projects grade each clip by its own origin.
 * 3: PV42 review, an untagged SDR clip in an HDR project is read as BT.709.
 * 4: PV42 acceptance, an untagged proxy is read as BT.709.
 * 5: PV50, an overlay remounts once its webfont loads, so text it positions by
 *    measuring is no longer placed with fallback metrics. Unconditional: it
 *    must not rely on another change's key edit landing in the same release.
 * 6: PV54, an overlay reads nothing outside the allowed folders. A PNG cached
 *    before could hold what it read there, and must not be served again.
 * 7: PV55, a still's `sourceCrop` (static or keyframed) is applied in samples.
 *    A frame cached before holds the UNCROPPED image. RESOLVER_VERSION 5 does
 *    not retire it: that bump shipped in 5.7.0, before samples cropped, so
 *    5.7.0 and 5.8.0 wrote uncropped frames under it.
 * 8: an image a prop names by a host's files URL (`/api/files?path=`, as the
 *    editor preview loads it) is drawn. A PNG cached before holds it blank.
 * 9: PL22, a capture waits for every image on the page (page-guard.js
 *    settleImages). A PNG cached before may hold an image that mounted on the
 *    sampled frame as an empty window, and was served again for the same props.
 * 10: graphics white in HDR projects moved from 900 to 800 nits
 *    (hdr-graphics.js GRAPHICS_WHITE_NITS). Defensive only: samples composite
 *    in SDR (overlays as sRGB PNGs over footage graded to SDR) and never pass
 *    through hdr-graphics.js, so no cached pixel depended on the HDR white.
 *    The later 300-nit white for graphics without footage (POSTLAUNCH §47,
 *    since removed: one 800-nit white) needed no bump for the same reason.
 * 11: an opaque overlay hides the footage only when it covers the whole canvas
 *    (timeline-core `opaqueReplacesPicture`). A frame cached before holds black
 *    around a scaled one.
 * 12: PL85.1, a 3D canvas is drawn after r3f has rendered the sampled frame,
 *    and a frame it did not draw is retried or fails (three-frame.js). A PNG
 *    cached before may hold the canvas blank, or frame 0's scene for a later
 *    frame.
 * 13: §59, a sampled frame draws the captions (caption-spec.js, the export's
 *    own caption overlay). A frame cached before holds none.
 * 14: §244, a translated caption segment (`lang` + `translationOf`) draws as
 *    a plain line stacked under its caption, in every style. A frame cached
 *    before holds it drawn the old way (nothing in word-by-word, pop and
 *    accent; a row of its own elsewhere), and the frame key does not see the
 *    caption templates.
 * 15: §309, an opaque overlay hides the footage only where it is at full
 *    opacity. A frame cached before holds black under one mid-fade.
 * 16: §308 P3, clips and overlays stack by track in the editor's order, and an
 *    opaque overlay hides only what is below it. A frame cached before holds
 *    every overlay over every image, and black under an image above a cover.
 * 17: §558, an overlay's measurement holds each text's own extent (a Range
 *    over its contents, with its element box) and `spills` (it overflows its
 *    own box). A measurement cached before holds the element box only, which
 *    hides text running out of it.
 * 18: §558, `spills` allows a glyph rising 30% of the font size past a tight
 *    line-height. 17 was never released, but its entries were cached on the
 *    machine that built it, and they call such a heading spilled.
 * 19: §558, the text extent is the element's own text nodes only (a positioned
 *    child or a zero-width wrapper is not its text), and it widens the box
 *    up or down only past that same 30% slack, so a tight heading at top 0 is
 *    not off the frame. 18's entries call it off by the glyph's rise.
 * 20: a full-canvas overlay measured fully opaque hides the footage below it,
 *    flagged `opaque` or not. A frame cached before took the footage through
 *    the composite's yuv420 round trip, a few levels off the culled frame.
 * 21: PL89f, each text also holds `glyphs` (its own text's extent, apart from
 *    its box) and `fellBack` (its face did not load). 20's entries hold
 *    neither, so a full-width centred title reads as inside the margin.
 * 22: PL89g, each text also holds `color` and `plate` (an opaque background
 *    behind it in the overlay), which look reads its contrast against. 21's
 *    entries hold neither, so every label would go unchecked.
 * 23: PL89j, each text also holds `opacity` (its own and its ancestors'),
 *    which look blends its fill by. 22's entries hold none, so a label drawn
 *    dim reads as full strength.
 * 24: §616, a clip's opacity track, mask and blend mode show in the still (the
 *    sampled opacity, the mask cut, the blend). 23's entries hold such a clip
 *    at its static opacity, whole and normally composited.
 *
 * PV49 (the `.inputs.json` manifest, see "Input manifests" below) needs no
 * bump of its own: a cached PNG with no manifest is a miss, which already
 * retires every entry written before PV49. 5 above is PV50's and stands on
 * its own, as its note says; the two do not depend on each other. A further
 * bump would only rekey what this build writes, for no pixel change.
 */
const SAMPLE_CACHE_VERSION = 24

// The still's composite canvas (`format=rgba`), which a blend mode converts from and back to.
const SAMPLE_CANVAS_PIX_FMT = 'rgba'

// PL89: the most overlay pages a sampling session keeps open (createSampleSession).
export const SESSION_MAX_PAGES = 4
// PL89g: the longest one overlay's measure may take in measureOverlays before its browser is dropped and the rest go on
// in a new one.
export const MEASURE_JOB_TIMEOUT_MS = 60_000
// PL89: the longest one frame of a session may take before it is sampled alone instead (sampleInSessions). A 3D frame
// over overlays takes about 8 s; a capture that never returns otherwise waits out the 300 s protocolTimeout.
export const SESSION_FRAME_TIMEOUT_MS = 60_000
// PL89f: the longest a session's close waits on one page or browser (then the browser is killed).
export const SESSION_CLOSE_CAP_MS = 10_000
// PL89c: a sheet's frames run in up to this many lanes side by side, each its own session (its own browser, so its own
// front page): 17 and 19 times over 12 overlays and a 3D took about 130 s each in one session.
export const SHEET_LANES = 4
/** The lanes for `count` frames: one per three frames, at least 1, at most SHEET_LANES. */
export const lanesFor = (count) => Math.min(SHEET_LANES, Math.max(1, Math.floor(count / 3)))

// ---------------------------------------------------------------------------
// Input manifests
// ---------------------------------------------------------------------------
// A cache key that hashes only the entry file's mtime cannot see an edit to a
// file the overlay IMPORTS. Rebuilding the import graph on every lookup would
// cost an esbuild pass per overlay even on a hit, so instead the miss path
// records the graph: `<key>.inputs.json` holds `[[path, mtimeMs], ...]` for
// every bundle input and every absolute file path in props. A lookup is a hit
// only when the PNG AND the manifest exist AND every recorded mtime still
// matches. The graph cannot change without editing a file already in it, so
// that is exact for the user's recorded files. It is NOT exact for changes to
// resolution: a new file that shadows an import's resolution (a `helper.ts`
// added beside `helper.js` behind an extensionless import) is not seen, nor is
// a tsconfig or package.json edit, nor a props asset that was missing when the
// entry was recorded. Engine changes need a SAMPLE_CACHE_VERSION bump (which
// reaches both keys). A missing recorded file is a miss, and a PNG with no
// manifest is a miss (which retires every pre-PV49 entry).

/** Files `props` names (propFilePath) that exist, walked the way bundle.js's rewritePathsToFileUrls finds them. */
export function collectPropFilePaths(value, out = new Set()) {
  if (typeof value === 'string') {
    const file = propFilePath(value)
    const resolved = file === null ? null : resolveFilePath(file)
    try { if (resolved && statSync(resolved).isFile()) out.add(resolved) } catch { /* gone */ }
  } else if (Array.isArray(value)) {
    for (const v of value) collectPropFilePaths(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPropFilePaths(v, out)
  }
  return out
}

/** `[[path, mtimeMs], ...]` for the paths that can be stat-ed now, sorted and deduped. */
export function statInputs(paths) {
  const out = []
  for (const p of [...new Set(paths)].sort()) {
    try { out.push([p, statSync(p).mtimeMs]) } catch { /* vanished: nothing to record */ }
  }
  return out
}

/**
 * Union of several `[[path, mtimeMs]]` lists. A path recorded with two
 * different mtimes changed while the frame was being sampled; it is recorded as
 * -1, which no file has, so the entry can never validate.
 */
export function mergeInputs(lists) {
  const m = new Map()
  for (const list of lists) {
    for (const [p, t] of list ?? []) {
      m.set(p, m.has(p) && m.get(p) !== t ? -1 : t)
    }
  }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** Write a manifest atomically (temp file, then rename). */
export function writeInputsManifest(file, entries) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, file)
}

/**
 * Read a manifest and check every recorded mtime against disk.
 * @returns {Array<[string, number]> | null} the entries when the manifest
 *   exists, parses and every file still has its recorded mtime; null otherwise
 *   (no manifest, unreadable, a file missing or changed).
 */
export function readValidInputsManifest(file) {
  let entries
  try { entries = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  if (!Array.isArray(entries)) return null
  for (const e of entries) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'number') return null
    try { if (statSync(e[0]).mtimeMs !== e[1]) return null } catch { return null }
  }
  return entries
}

// Transfer of the file actually decoded, probed once per path per process.
const transferCache = new Map()
function decodedTransferOf(path) {
  if (!transferCache.has(path)) transferCache.set(path, probeMedia(path).transfer)
  return transferCache.get(path)
}
// SEEK_PREROLL_S (imported above, shared with the segment encoder's video
// items since PV48) is the accurate-decode window for the two-stage frame seek
// below. A coarse `-ss` before `-i` jumps to the nearest keyframe near the
// target (near-instant, no decode), then this many seconds are decoded
// accurately after `-i` to land on the exact frame. Bounds the decode to
// ~PREROLL + one GOP regardless of how deep into a clip the sample sits,
// instead of decoding from t=0 every time.

// When previewing a single overlay frame we don't know the item's real on-screen
// length. Overlays commonly fade OUT over the final ~15 frames keyed to the
// `duration` global; if `duration === frame + 1` (the old default) every sampled
// frame renders at the overlay's dying edge and looks faded/washed out. Default
// to a generous tail past the sampled frame so end-of-life animations never fire
// on a standalone preview. Callers that DO know the real length (sampleFrame, and
// the CLI --duration flag) pass it explicitly for a WYSIWYG result.
const PREVIEW_TAIL_FRAMES = 600

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (isMain) {
  const argv = process.argv.slice(2)

  if (!argv.length || argv.includes('--help')) {
    process.stderr.write(
      'Usage:\n' +
      '  sample-frame.js --mode overlay --component <path> [--frame N] [--fps N]\n' +
      '    [--width W] [--height H] [--props \'...\'] [--google-fonts f1,f2]\n' +
      '    [--duration N] [--measure] --out <path>\n' +
      '  sample-frame.js --mode frame --project <path> --at <seconds> [--sdr-curve <id>]\n' +
      '    --out <path> [--clamp-to-end]\n' +
      '  sample-frame.js --mode frame --project <path> --scene <id> --at <seconds into it>\n' +
      '    --out <path>   one 3D alone; --scene \'\' is the project\'s own\n' +
      '  sample-frame.js --mode frame --project <path> --at <seconds> --no-captions --out <path>\n' +
      '  sample-frame.js --mode frame --project <path> --at <s> --at <s> ... --frames-dir <dir>\n' +
      '  sample-frame.js --mode measure --jobs <file.json> [--lanes N]\n' +
      '  sample-frame.js --mode overlay-strip --component <path|engine:scene3d> --times \'[0,1,2]\' --duration <frames> [--project-dir <dir>]\n' +
      '    [--fps N] [--width W] [--height H] [--props \'...\'] [--google-fonts f1,f2] [--deadline-ms N]\n' +
      '    --tile-width N --out-dir <dir>   one browser, one small PNG per time (t_0000.png...)\n'
    )
    process.exit(1)
  }

  let mode          = null
  // overlay args
  let componentArg  = null
  let frameArg      = 0
  let fpsArg        = 30
  let widthArg      = 1080
  let heightArg     = 1920
  let propsArg      = {}
  let googleFontsArg = []
  let measureArg    = false
  let durationArg   = null
  // frame args
  let projectArg    = null
  let atArg         = null
  const atArgs      = []
  let framesDirArg  = null
  let sdrCurveArg   = null
  let preferProxyArg = false
  let noCaptionsArg  = false
  let rawArg        = false
  let clampToEndArg = false
  let maxShortEdgeArg = null
  let sceneArg      = null
  // shared
  let outArg        = null
  let jobsArg       = null
  let projectDirArg = null
  let lanesArg      = null
  let timesArg      = null
  let tileWidthArg  = null
  let outDirArg     = null
  let deadlineMsArg = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode')         { mode          = argv[++i]; continue }
    if (a === '--component')    { componentArg  = argv[++i]; continue }
    if (a === '--frame')        { frameArg      = parseInt(argv[++i], 10); continue }
    if (a === '--duration')     { durationArg   = parseInt(argv[++i], 10); continue }
    if (a === '--fps')          { fpsArg        = parseInt(argv[++i], 10); continue }
    if (a === '--width')        { widthArg      = parseInt(argv[++i], 10); continue }
    if (a === '--height')       { heightArg     = parseInt(argv[++i], 10); continue }
    if (a === '--props')        { try { propsArg = JSON.parse(argv[++i]) } catch { fail('invalid_props', `--props is not valid JSON`) }; continue }
    if (a === '--google-fonts') { googleFontsArg.push(argv[++i]); continue }
    if (a === '--measure')      { measureArg    = true; continue }
    if (a === '--project')      { projectArg    = argv[++i]; continue }
    if (a === '--at')           { atArg         = parseFloat(argv[++i]); atArgs.push(atArg); continue }
    if (a === '--frames-dir')   { framesDirArg  = argv[++i]; continue }
    if (a === '--sdr-curve')    { sdrCurveArg   = argv[++i]; continue }
    if (a === '--clamp-to-end') { clampToEndArg = true; continue }
    if (a === '--prefer-proxy') { preferProxyArg = true; continue }
    if (a === '--max-short-edge') { maxShortEdgeArg = Number(argv[++i]); continue }
    if (a === '--no-captions')  { noCaptionsArg  = true; continue }
    if (a === '--raw')          { rawArg = true; continue }
    if (a === '--scene')        { sceneArg      = argv[++i] ?? null; if (sceneArg === null) fail('missing_argument', '--scene needs a 3D id, or \'\' for the project\'s own'); continue }
    if (a === '--out')          { outArg        = argv[++i]; continue }
    if (a === '--jobs')         { jobsArg       = argv[++i]; continue }
    if (a === '--project-dir')  { projectDirArg = argv[++i]; continue }
    if (a === '--lanes')        { lanesArg      = parseInt(argv[++i], 10); continue }
    if (a === '--times')        { try { timesArg = JSON.parse(argv[++i]) } catch { fail('invalid_times', '--times is not valid JSON') }; continue }
    if (a === '--tile-width')   { tileWidthArg  = parseInt(argv[++i], 10); continue }
    if (a === '--out-dir')      { outDirArg     = argv[++i]; continue }
    if (a === '--deadline-ms')  { deadlineMsArg = parseInt(argv[++i], 10); continue }
  }

  if (!mode) fail('missing_argument', '--mode overlay|frame|measure is required')
  const manyTimes = mode === 'frame' && atArgs.length > 1
  if (manyTimes && !framesDirArg) fail('missing_argument', '--frames-dir <dir> is required with several --at')
  if (!outArg && !manyTimes && mode !== 'measure' && mode !== 'overlay-strip') fail('missing_argument', '--out <path> is required')

  // Validate against the manifest here rather than letting look.js throw deep
  // inside the extract: a typo'd curve id should be a clean CLI error, not a
  // stack trace half a pipeline in.
  if (sdrCurveArg !== null && !curveIds().includes(sdrCurveArg)) {
    fail('invalid_sdr_curve',
      `--sdr-curve '${sdrCurveArg}' is not a known look curve. `
      + `Expected one of ${JSON.stringify(curveIds())}.`)
  }

  if (mode === 'overlay') {
    if (!componentArg) fail('missing_argument', '--component <path> is required for --mode overlay')
    sampleOverlay({
      componentPath: resolve(componentArg),
      props: propsArg,
      frame: frameArg,
      fps: fpsArg,
      width: widthArg,
      height: heightArg,
      googleFonts: googleFontsArg,
      measure: measureArg,
      durationFrames: durationArg,
      outPath: resolve(outArg),
    }).then(result => {
      if (measureArg) {
        process.stdout.write(JSON.stringify({ pngPath: result.pngPath, measurements: result.measurements, ...(result.warnings?.length ? { warnings: result.warnings } : {}) }) + '\n')
      } else {
        process.stdout.write(result.pngPath + '\n')
      }
    }).catch(err => {
      if (err.sampleError) {
        process.stderr.write(JSON.stringify({ error: err.sampleError, message: err.message }) + '\n')
      } else {
        process.stderr.write(JSON.stringify({ error: 'sample_failed', message: err.message }) + '\n')
      }
      process.exit(1)
    })
  } else if (mode === 'frame') {
    if (!projectArg) fail('missing_argument', '--project <path> is required for --mode frame')
    if (atArg == null) fail('missing_argument', '--at <seconds> is required for --mode frame')
    const sampleAt = (at, outPath, session = null) => sceneArg !== null
      ? sampleScene({
        projectJson: resolve(projectArg),
        scene: sceneArg,
        atSeconds: at,
        outPath,
        sdrCurve: sdrCurveArg,
      })
      : (rawArg ? sampleRawFrame : sampleFrame)({
        projectJson: resolve(projectArg),
        atSeconds: at,
        outPath,
        sdrCurve: sdrCurveArg,
        preferProxy: preferProxyArg,
        noCaptions: noCaptionsArg,
        clampToEnd: clampToEndArg,
        ...(projectDirArg ? { projectDir: resolve(projectDirArg) } : {}),
        ...(rawArg ? {} : { session, maxShortEdge: maxShortEdgeArg }),
      })
    // Several times: one process, one frame file per time in the order given, one path per line.
    // PL89: one session for all of them (createSampleSession): one browser, each overlay page loaded once.
    const sampled = manyTimes
      ? (async () => {
        const dir = resolve(framesDirArg)
        mkdirSync(dir, { recursive: true })
        const outPaths = atArgs.map((_, k) => join(dir, `f_${String(k).padStart(4, '0')}.png`))
        const got = sceneArg !== null
          ? await sampleScenes({ projectJson: resolve(projectArg), scene: sceneArg, times: atArgs, outPaths, sdrCurve: sdrCurveArg })
          : await sampleInSessions({ count: atArgs.length, label: (k) => atArgs[k], lanes: lanesFor(atArgs.length), sampleWith: (k, session) => sampleAt(atArgs[k], outPaths[k], session) })
        return { pngPath: got.map((r) => r.pngPath).join('\n') }
      })()
      : sampleAt(atArg, resolve(outArg))
    sampled.then(result => {
      // PL89f: then exit, so a browser handle left open somewhere can never hold the step (and the app's call) open.
      process.stdout.write(result.pngPath + '\n', () => process.exit(0))
    }).catch(err => {
      // A 3D item's refusal keeps its own code (render/scene3d.js), so `--scene nope` answers scene3d_scene_missing.
      const error = isThreeFrameBlank(err) ? 'three_frame_blank' : err instanceof Scene3dError ? err.code : 'sample_failed'
      process.stderr.write(JSON.stringify({ error, message: err.message }) + '\n')
      process.exit(1)
    })
  } else if (mode === 'overlay-strip') {
    if (!componentArg) fail('missing_argument', '--component <path> is required for --mode overlay-strip')
    if (!outDirArg) fail('missing_argument', '--out-dir <dir> is required for --mode overlay-strip')
    if (!Array.isArray(timesArg) || !timesArg.length || !timesArg.every(Number.isFinite)) fail('invalid_times', '--times is a non-empty JSON list of seconds')
    if (!Number.isFinite(durationArg) || durationArg < 1) fail('missing_argument', '--duration <frames> is required for --mode overlay-strip')
    if (!Number.isFinite(tileWidthArg) || tileWidthArg < 1) fail('missing_argument', '--tile-width is required for --mode overlay-strip')
    // A 3D item's strip (`--component engine:scene3d`, its props and --project-dir): the host's stage, with the
    // scene in its props, exactly as an export materializes it.
    const projectDir = projectDirArg ? resolve(projectDirArg) : null
    let strip
    try {
      strip = componentArg === SCENE3D_SRC
        ? scene3dStripSource(propsArg, projectDir)
        : { componentPath: resolve(componentArg), props: propsArg }
    } catch (err) {
      process.stderr.write(JSON.stringify({ error: err instanceof Scene3dError ? err.code : 'sample_failed', message: err.message }) + '\n')
      process.exit(1)
    }
    // Past the deadline the session closes its Chromium and the process exits 1 on its own: the caller's
    // timeout would kill it, and on Windows a killed node leaves its browser running. The backstop exit covers a
    // close that hangs.
    if (deadlineMsArg > 0) setTimeout(() => process.exit(1), deadlineMsArg + 10_000).unref()
    sampleOverlayStrip({
      deadlineMs: deadlineMsArg,
      componentPath: strip.componentPath,
      props: strip.props,
      projectDir,
      times: timesArg,
      fps: fpsArg,
      durationFrames: durationArg,
      width: widthArg,
      height: heightArg,
      googleFonts: googleFontsArg,
      tileWidth: tileWidthArg,
      outDir: resolve(outDirArg),
    }).then(result => {
      process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0))
    }).catch(err => {
      process.stderr.write(JSON.stringify({ error: err.sampleError || 'sample_failed', message: err.message }) + '\n')
      process.exit(1)
    })
  } else if (mode === 'measure') {
    // PL89g: look's pass, every overlay in one call. --jobs: a JSON file of [{component, props, frame, fps, width, height,
    // googleFonts, duration, out}]; stdout: {results, browsers}.
    if (!jobsArg) fail('missing_argument', '--jobs <file> is required for --mode measure')
    let jobs
    try { jobs = JSON.parse(readFileSync(resolve(jobsArg), 'utf8')) } catch { fail('invalid_jobs', '--jobs is not a readable JSON list') }
    if (!Array.isArray(jobs)) fail('invalid_jobs', '--jobs is a JSON list of overlays to measure')
    measureOverlays(jobs.map((j) => ({
      componentPath: resolve(j.component), props: j.props || {}, frame: j.frame || 0, fps: j.fps || 30, width: j.width || 1080,
      height: j.height || 1920, googleFonts: j.googleFonts || [], durationFrames: j.duration ?? null, outPath: resolve(j.out),
    })), { lanes: lanesArg || 3 }).then((out) => {
      process.stdout.write(JSON.stringify(out) + '\n')
    }).catch((err) => {
      process.stderr.write(JSON.stringify({ error: 'sample_failed', message: err.message }) + '\n')
      process.exit(1)
    })
  } else {
    fail('invalid_mode', `--mode must be 'overlay', 'frame', 'measure' or 'overlay-strip', got '${mode}'`)
  }
}

// ---------------------------------------------------------------------------
// sampleOverlay
// ---------------------------------------------------------------------------

/**
 * PL89: one sampling session for several frames in one call (--frames-dir). One browser per kind of launch, and
 * each overlay page (one component with one set of props) bundled and loaded once, kept open, then only set to each
 * frame and captured. Pages open at once, but captures run one at a time, each with its page brought to the front
 * first (a page behind another tab gets no animation frames). A page that fails is closed and the next use opens a new one.
 * At most `maxPages` stay open (each 3D page holds a WebGL context, and Chromium drops the oldest past about 16, which
 * blanks later frames): opening one more closes the least recently used once its uses finish.
 * close() closes every page and browser and removes the bundles.
 */
export function createSampleSession({ maxPages = SESSION_MAX_PAGES, closeCapMs = SESSION_CLOSE_CAP_MS } = {}) {
  const browsers = new Map()
  // PL89f: once closed or aborted, a session opens nothing more: a capture stuck past the frame limit runs on and
  // would otherwise launch a browser into a session nobody closes again, holding the process open.
  let ended = false
  const refuse = () => { throw new Error('sampling session closed') }
  // Never waits forever on a page or browser that will not close.
  const capped = (p) => {
    let timer
    return Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => { timer = setTimeout(r, closeCapMs) })]).finally(() => clearTimeout(timer))
  }
  // In use order, least recently used first.
  const pages = new Map()
  const evicting = []
  // The captures in flight, one at a time (sample).
  let captures = Promise.resolve()
  // Closing never throws: it runs on a failure, whose own error is the one to report.
  const drop = (held) => held.ready.then(async (ctx) => {
    await capped(ctx.page.close())
    try {
      cleanupBundle(ctx.workDir)
    } catch { /* a bundle folder already gone */ }
  }, () => {})
  return {
    /** How many browsers this session started (PL89g: measureOverlays reports it). */
    launched() {
      return browsers.size
    },
    /** The browser for `key` (a kind of launch), started with `launch` the first time. */
    browserFor(key, launch) {
      if (ended) refuse()
      if (!browsers.has(key)) browsers.set(key, launch())
      return browsers.get(key)
    },
    async sample(key, open, capture) {
      if (ended) refuse()
      let held = pages.get(key)
      if (held) {
        pages.delete(key)
      } else {
        held = { ready: open(), tail: Promise.resolve() }
        while (pages.size >= maxPages) {
          const [oldKey, old] = pages.entries().next().value
          pages.delete(oldKey)
          evicting.push(old.tail.then(() => drop(old)))
        }
      }
      pages.set(key, held)
      const run = held.tail.then(async () => {
        const ctx = await held.ready
        // A page behind another tab gets no animation frames, so its capture never returns. One frame's overlays are
        // sampled several at once, and only one page of a browser is in front: captures take turns, each in front.
        const turn = captures.then(async () => {
          await ctx.page.bringToFront()
          ctx.pageErrors.length = 0
          return { ctx, shot: await capture(ctx) }
        })
        captures = turn.catch(() => {})
        return turn
      })
      held.tail = run.catch(() => {})
      try {
        return await run
      } catch (err) {
        if (pages.get(key) === held) {
          pages.delete(key)
          await drop(held)
        }
        throw err
      }
    },
    async close() {
      ended = true
      const open = [...pages.values()]
      pages.clear()
      for (const held of open) await capped(drop(held))
      await capped(Promise.all(evicting.splice(0)))
      for (const b of browsers.values()) {
        await b.then(async (x) => {
          await capped(x.close())
          x.process?.()?.kill('SIGKILL')
        }).catch(() => {})
      }
      browsers.clear()
    },
    /** For a session with a capture stuck in it: the browsers go first, which fails what is stuck; then the bundles. */
    async abort() {
      ended = true
      const open = [...pages.values()]
      pages.clear()
      evicting.length = 0
      for (const b of browsers.values()) {
        await b.then(async (x) => {
          await capped(x.close())
          x.process?.()?.kill('SIGKILL')
        }).catch(() => {})
      }
      browsers.clear()
      for (const held of open) held.ready.then((ctx) => { try { cleanupBundle(ctx.workDir) } catch { /* already gone */ } }, () => {})
    },
  }
}

/**
 * PL89: frames `order` (indices, default 0..count-1) through sampling sessions, so a sheet always comes back: in the
 * order given (split into `lanes` contiguous runs side by side, each with its own sessions), a session shared until a
 * frame fails or takes over `frameTimeoutMs`. That frame's session is aborted (a
 * stuck page goes with its browser), the frame is sampled alone (`sampleWith(k, null)`), and the frames after it get a
 * new session. Only a frame that fails alone too fails the call, named by `label(k)` seconds. Results by index.
 */
export async function sampleInSessions({ count, sampleWith, order = [...Array(count).keys()], label = (k) => k, newSession = () => createSampleSession(), frameTimeoutMs = SESSION_FRAME_TIMEOUT_MS, lanes = 1 }) {
  const out = new Array(count)
  // PL89c: contiguous runs of the order, one per lane, side by side; each lane is the sequence below with its own session.
  const n = Math.max(1, Math.min(lanes, order.length))
  const size = Math.ceil(order.length / n)
  const runs = Array.from({ length: n }, (_, i) => order.slice(i * size, (i + 1) * size)).filter((r) => r.length)
  if (runs.length > 1) log(`sampling ${order.length} frames in ${runs.length} lanes`)
  // PL89f: every lane settles (and closes its session) before a failure propagates, so none is left open.
  const settled = await Promise.allSettled(runs.map((run) => sampleLane(run)))
  const failed = settled.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
  return out

  async function sampleLane(run) {
    let session = newSession()
    try {
      for (const k of run) {
        let timer
        const inSession = Promise.resolve().then(() => sampleWith(k, session))
        inSession.catch(() => {}) // past the timeout its failure is no one's
        const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`slower than ${frameTimeoutMs / 1000} s`)), frameTimeoutMs) })
        try {
          out[k] = await Promise.race([inSession, slow])
          continue
        } catch (err) {
          log(`frame at ${label(k)}s in the shared session: ${err.message}; sampling it alone`)
          await session.abort()
          session = newSession()
        } finally {
          clearTimeout(timer)
        }
        try {
          out[k] = await sampleWith(k, null)
        } catch (err) {
          err.message = `at ${label(k)}s: ${err.message}`
          throw err
        }
      }
    } finally {
      await session.close()
    }
  }
}

/**
 * PL89: an overlay's page, bundled, loaded and mounted, ready for captureOverlay: { browser, page, guard, pageErrors,
 * fontFailures, workDir, recordedInputs }. With a session the browser is the session's (createSampleSession) and stays
 * open; without one it is this page's own, and the caller closes it. On a failure what it opened is closed.
 */
async function openOverlayPage({ componentPath, props, fps, effectiveDuration, width, height, googleFonts, projectDir, session = null, deviceScaleFactor = 1 }) {
  const { htmlPath, workDir, inputs: bundleInputs, boundary, needsGoogleFonts } = await bundleComponent({
    componentPath,
    props,
    fps,
    durationFrames: effectiveDuration,
    width,
    height,
    googleFonts,
    fontsBaseDir: MONTAJ_FONTS_DIR,
    projectDir,
  })
  // Record mtimes now, right after the bundle. A file edited DURING the bundle
  // (after esbuild read it, before this stat) is recorded with its new mtime
  // against pixels built from the old text: a small window, accepted. A file
  // edited after this point is recorded old, so the next lookup misses.
  const recordedInputs = statInputs([...bundleInputs, componentPath, ...collectPropFilePaths(props)])

  let browser = null
  let page = null
  try {
    // The props' http(s) URLs, fetched by Node before the page loads; the page
    // is served from this and reaches nothing itself (page-guard.js). One the
    // page asks for and could not be fetched fails the sample, below.
    const propsCache = await prefetchPropsUrls(boundary.urls)

    // Every overlay page's flags (page-guard.js), --disable-dev-shm-usage
    // included: the container's 64MB /dev/shm crashes Chromium on heavy pages.
    const launch = () => puppeteer.launch(overlayPageLaunchOptions({ needsGoogleFonts, disableWebSecurity: true }))
    browser = session ? await session.browserFor(needsGoogleFonts ? 'fonts' : 'plain', launch) : await launch()

    page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor })

    // Before the page loads: what it may read, and that it sends nothing out.
    const guard = await installPageGuard(page, { boundary, propsCache, needsGoogleFonts })

    // Capture page errors so we can surface them on failure. Chromium's console
    // line for a request the guard blocked is not one: the guard logs the block,
    // and the overlay's own fallback is what the sample shows.
    const pageErrors = []
    // §140: a family Google refuses, or a font the network cannot fetch, is a
    // warning, not a page error: the overlay draws with its fallback font.
    const fontFailures = new Set()
    page.on('pageerror', err => pageErrors.push(err.message))
    page.on('console', msg => {
      if (msg.type() !== 'error' || guard.isBlockNoise(msg)) return
      const font = fontLoadFailure({ type: msg.type(), text: msg.text(), url: msg.location()?.url })
      if (!font) { pageErrors.push(msg.text()); return }
      if (!fontFailures.has(font)) { fontFailures.add(font); log(fontFailureWarning([font])) }
    })

    // networkidle0 is critical for font loading — fonts are not loaded until
    // React commits to DOM, and we need the woff2 fetches to complete before
    // we measure text layout.
    await page.goto(toFileHref(htmlPath), { waitUntil: 'networkidle0' })

    // Verify the component mounted
    const ready = await page.evaluate(() => typeof window.__setFrame === 'function')
    if (!ready) {
      const errDetail = pageErrors.length ? pageErrors.join(' | ') : 'no JS errors captured'
      const err = new Error(`window.__setFrame not initialized: ${errDetail}`)
      err.sampleError = 'overlay_eval_failed'
      throw err
    }
    return { browser, page, guard, pageErrors, fontFailures, workDir, recordedInputs }
  } catch (err) {
    if (page && session) await page.close().catch(() => {})
    if (browser && !session) await browser.close()
    cleanupBundle(workDir)
    throw err
  }
}

/**
 * PL89: one frame of an open overlay page (openOverlayPage) to `outPath`: { measurements, degraded, warnings }.
 */
async function captureOverlay({ page, guard, pageErrors, fontFailures, componentPath, frame, measure, width, height, outPath }) {
  let measurements = undefined
  // A sample the page guard blocked anything in is not cached: what it shows
  // may depend on things outside the cache key (the workspace, the network).
  // Nor is one captured with an image still loading: it may be missing it.
  let degraded = false
  // §140: what the caller should know although the sample succeeded.
  const warnings = []
  // Commit React render at the requested frame.
  // Note: __setFrame is always defined (it's in the shim), but calling it
  // may trigger a React re-render that throws (e.g. a broken component).
  // Such throws manifest as page errors, not as a rejected promise from
  // page.evaluate, so we must check pageErrors afterwards.
  // A 3D canvas that did not draw the frame is set again, then the sample
  // fails as three_frame_blank (three-frame.js), never a blank 3D sample.
  const threeRetry = threeFrameRetry({ page, frame, overlay: basename(componentPath), log, pageErrors })
  let three = await threeRetry.set()

  // Check immediately after __setFrame invocation for render errors.
  // If the component throws during React reconciliation, it shows up here
  // rather than causing waitForFunction to throw.
  if (pageErrors.length > 0) {
    const errMsg = pageErrors.join(' | ')
    const err = new Error(`overlay render error: ${errMsg}`)
    err.sampleError = 'overlay_eval_failed'
    throw err
  }

  // Wait until DOM attribute confirms the frame has been committed.
  // If the component threw during render, waitForFunction will time out —
  // but we already checked above and would have thrown by now.
  try {
    await page.waitForFunction(
      f => document.documentElement.dataset.renderedFrame === String(f),
      { timeout: 10000 },
      frame,
    )
  } catch (waitErr) {
    // If we timed out waiting for the frame to render, check if there are
    // page errors that explain why
    if (pageErrors.length > 0) {
      const err = new Error(`overlay render failed: ${pageErrors.join(' | ')}`)
      err.sampleError = 'overlay_eval_failed'
      throw err
    }
    throw waitErr
  }

  // An image the props name with no extension is fetched when the page asks
  // for it: wait for it before capturing (page-guard.js settleOnDemand; at
  // once when the props name none).
  await guard.settleOnDemand()
  // And for every image on the page: an overlay that mounts one only from a
  // later frame inserts it in the commit just made (page-guard.js
  // settleImages). Capped; whatever is still loading is named here.
  const imagesMissed = await guard.settleImages()

  // Double rAF: first fires after layout+paint, second after compositor flush
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

  // Measure DOM if requested
  if (measure) {
    measurements = await page.evaluate((canvasW, canvasH) => {
      const texts = []
      const probe = document.createElement('canvas').getContext('2d')   // measures a face, for fellBack

      // Walk all elements in document body
      function walk(el) {
        // Skip script/style/head nodes
        const tag = el.tagName
        if (!tag || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') return

        const text = el.textContent?.trim() ?? ''
        if (text.length > 0) {
          // Check if this element itself has direct text content
          // (i.e. it's a leaf text-bearing node or has immediate text)
          let hasDirectText = false
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
              hasDirectText = true
              break
            }
          }

          if (hasDirectText) {
            const style = window.getComputedStyle(el)
            // §558: the text's own extent, not only its element's box: text that spills out of a fixed-width
            // or nowrap box (or is cut by overflow:hidden on its own element) lies outside the element's rect.
            // The box measured is the union of the two; `spills` says the text overflows its own box.
            const elRect = el.getBoundingClientRect()
            // the element's own text nodes only: a positioned child is measured as its own element
            let tl = Infinity, tt = Infinity, tr = -Infinity, tb = -Infinity
            for (const child of el.childNodes) {
              if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue
              const range = document.createRange()
              range.selectNodeContents(child)
              for (const r of range.getClientRects()) {
                if (r.width <= 0 && r.height <= 0) continue
                tl = Math.min(tl, r.left); tt = Math.min(tt, r.top); tr = Math.max(tr, r.right); tb = Math.max(tb, r.bottom)
              }
            }
            const hasText = tl < tr || tt < tb
            // a glyph rising a little past a tight line-height (1.05 on a big heading) is not text lost: up and
            // down the text widens the box (and counts as spilling) only past 30% of the font size, across 1 px
            const fontPx = parseFloat(window.getComputedStyle(el).fontSize) || 16
            const slackY = Math.max(2, fontPx * 0.3)
            const left   = hasText && tl < elRect.left - 1 ? tl : elRect.left
            const right  = hasText && tr > elRect.right + 1 ? tr : elRect.right
            const top    = hasText && tt < elRect.top - slackY ? tt : elRect.top
            const bottom = hasText && tb > elRect.bottom + slackY ? tb : elRect.bottom
            const bboxX = left
            const bboxY = top
            const bboxW = right - left
            const bboxH = bottom - top
            const spills = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + slackY

            const overflowLeft   = Math.max(0, -bboxX)
            const overflowRight  = Math.max(0, bboxX + bboxW - canvasW)
            const overflowTop    = Math.max(0, -bboxY)
            const overflowBottom = Math.max(0, bboxY + bboxH - canvasH)

            // Walk parent chain to find first ancestor with overflow clipping.
            //
            // Filter out ancestors whose bbox fills (or exceeds) the viewport.
            // The React shim's mount wrapper and the document body typically
            // have overflow set AND span the full viewport — flagging them as
            // a "clippingAncestor" gives false positives on every overlay
            // element. The intentional-clip case the skill teaches agents to
            // recognise is an ancestor SMALLER than the viewport (e.g. an
            // animation container with a fixed window the children animate
            // through). Only those count.
            let clippingAncestor = null
            let parent = el.parentElement
            while (parent && parent !== document.documentElement) {
              const pStyle = window.getComputedStyle(parent)
              const overflowX = pStyle.overflowX
              const overflowY = pStyle.overflowY
              if (overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto' ||
                  overflowY === 'hidden' || overflowY === 'clip' || overflowY === 'auto') {
                const pRect = parent.getBoundingClientRect()
                // Skip viewport-spanning wrappers — they're not intentional clips.
                const spansViewport = pRect.width  >= canvasW - 0.5
                                   && pRect.height >= canvasH - 0.5
                                   && pRect.x <= 0.5 && pRect.y <= 0.5
                if (!spansViewport) {
                  clippingAncestor = {
                    tag: parent.tagName,
                    className: parent.className || '',
                    bbox: { x: pRect.x, y: pRect.y, w: pRect.width, h: pRect.height },
                  }
                  break
                }
              }
              parent = parent.parentElement
            }

            // PL89e: the face the text names did not load and its stack names no generic family, so it draws in
            // the default serif (the ring's bare "JetBrains Mono" drew in Times). A face that did not load measures
            // the same as the fallback it sits in front of, for monospace and for serif alike.
            const faces = style.fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
            const generic = faces.some((f) => /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+|-apple-system|blinkmacsystemfont)$/i.test(f))
            const width = (font) => { probe.font = font; return probe.measureText('Hamburgefonstiv 0123 WMil').width }
            const missing = (f) => width(`40px "${f}", monospace`) === width('40px monospace') && width(`40px "${f}", serif`) === width('40px serif')
            const fellBack = !generic && faces.length > 0 && faces.every(missing)

            // PL89g: what look reads a text against: an opaque background behind it inside the overlay (its plate),
            // else the picture under the overlay. Transparent and translucent fills are not a plate.
            let plate = null
            for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
              const bg = window.getComputedStyle(p).backgroundColor
              const m = /rgba?\(([^)]+)\)/.exec(bg || '')
              const parts = m ? m[1].split(/[,\s/]+/).filter(Boolean) : []
              const alpha = parts.length > 3 ? parseFloat(parts[3]) : (m ? 1 : 0)
              if (alpha >= 0.8) { plate = `rgb(${parts.slice(0, 3).join(', ')})`; break }
            }
            // PL89j: how strongly the text is drawn: its own and its ancestors' opacity (a label dimmed until its
            // state comes is ink at 0.32, which its colour alone does not say)
            let opacity = 1
            for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
              const o = parseFloat(window.getComputedStyle(p).opacity)
              if (Number.isFinite(o)) opacity *= o
            }

            texts.push({
              text: text.slice(0, 200),
              tag: el.tagName,
              color: style.color,
              plate,
              opacity: Math.round(opacity * 1000) / 1000,
              fontFamily: style.fontFamily,
              fellBack,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              position: style.position,
              transform: style.transform,
              bbox: { x: bboxX, y: bboxY, w: bboxW, h: bboxH },
              // PL89f: the text's own extent, apart from its box. A centred title in a full-width box measures the
              // whole width as its box; the zone checks (margin, captions, the apps' controls) read the glyphs.
              glyphs: hasText ? { x: tl, y: tt, w: tr - tl, h: tb - tt } : null,
              spills,
              overflow: {
                left:   overflowLeft,
                right:  overflowRight,
                top:    overflowTop,
                bottom: overflowBottom,
              },
              clippingAncestor,
            })
          }
        }

        // Recurse into children
        for (const child of el.children) {
          walk(child)
        }
      }

      walk(document.body)

      const anyOverflow = texts.some(t =>
        t.overflow.left > 0 || t.overflow.right > 0 ||
        t.overflow.top > 0  || t.overflow.bottom > 0
      )

      return {
        viewport: { w: canvasW, h: canvasH },
        anyOverflow,
        texts,
      }
    }, width, height)
  }

  // A props image the page asked for and could not get fails the sample,
  // naming it, rather than sampling without it.
  try {
    guard.assertPropsServed()
  } catch (err) {
    err.sampleError = 'props_fetch_failed'
    throw err
  }
  // An image still loading at capture (past the cap, or inserted after the
  // wait) keeps this sample out of the cache, so a blank is never served again.
  const imagesLoading = imagesMissed.length > 0 || await page.evaluate(() =>
    [...document.images].some(img => img.loading !== 'lazy' && !img.complete))
  degraded = guard.blocked.size > 0 || imagesLoading || fontFailures.size > 0
  if (fontFailures.size > 0) warnings.push(fontFailureWarning(fontFailures))

  // Screenshot — transparent PNG (omitBackground: true matches the renderer)
  mkdirSync(dirname(outPath), { recursive: true })
  await page.screenshot({ path: outPath, omitBackground: true })
  // A 3D canvas that lost its drawing during the capture (a lost WebGL
  // context, a resize): draw it again and capture again, bounded.
  for (let lost; (lost = await threeRetry.lost(three)); ) {
    threeRetry.failed(lost)
    three = await threeRetry.set()
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.screenshot({ path: outPath, omitBackground: true })
  }
  return { measurements, degraded, warnings }
}

/**
 * PL89g: measure several overlays in one call (look's pass): `jobs` are sampleOverlay's arguments, each measured on its
 * own page, the jobs split into `lanes` contiguous runs side by side, each run in one browser (a sampling session).
 * look measured each overlay in its own process with its own Chromium: 9 overlays were 9 launches, 3 at a time. One
 * that fails or takes over `jobTimeoutMs` answers {error, message} alone (a stuck one's browser is dropped and the run
 * goes on in a new one); the rest are measured. Answers {results: [{measurements, warnings?} | {error, message}],
 * browsers: how many were started}.
 */
export async function measureOverlays(jobs, { lanes = 3, jobTimeoutMs = MEASURE_JOB_TIMEOUT_MS, newSession = () => createSampleSession() } = {}) {
  const results = new Array(jobs.length)
  const n = Math.max(1, Math.min(lanes, jobs.length))
  const size = Math.ceil(jobs.length / n)
  let browsers = 0
  const lane = async (from, to) => {
    let session = newSession()
    try {
      for (let k = from; k < to; k++) {
        let timer
        const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`measure took over ${jobTimeoutMs / 1000} s`), { sampleError: 'timeout' })), jobTimeoutMs) })
        try {
          const r = await Promise.race([sampleOverlay({ ...jobs[k], measure: true, session }), stuck])
          results[k] = { measurements: r.measurements || {}, ...(r.warnings?.length ? { warnings: r.warnings } : {}) }
        } catch (err) {
          results[k] = { error: err.sampleError || 'sample_failed', message: String(err.message || err).slice(0, 300) }
          if (err.sampleError === 'timeout') {
            browsers += session.launched()
            await session.abort()
            session = newSession()
          }
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      browsers += session.launched()
      await session.close()
    }
  }
  const runs = []
  for (let from = 0; from < jobs.length; from += size) runs.push(lane(from, Math.min(jobs.length, from + size)))
  await Promise.all(runs)
  return { results, browsers }
}

/**
 * Render one overlay JSX at one frame position to a PNG.
 *
 * @param {object} opts
 * @param {string}   opts.componentPath  Absolute path to the .jsx file
 * @param {object}   [opts.props]        Props to pass
 * @param {number}   [opts.frame]        Frame number (default 0)
 * @param {number}   [opts.fps]          Frames per second (default 30)
 * @param {number}   [opts.width]        Canvas width (default 1080)
 * @param {number}   [opts.height]       Canvas height (default 1920)
 * @param {string[]} [opts.googleFonts]  Google Fonts entries
 * @param {boolean}  [opts.measure]      If true, walk DOM and return measurements
 * @param {string}   opts.outPath        Where to write the PNG (required)
 * @param {string}   [opts.projectDir]   The project's directory, a root of the
 *   read boundary (overlay-build.js); sampleFrame passes it
 * @returns {Promise<{ pngPath: string, measurements?: object }>}
 *
 * Takes no `fontsBaseDir` parameter — it reads the module-scope
 * `MONTAJ_FONTS_DIR` constant (resolved once from `process.env` at import
 * time) instead. That's fine under today's spawn-per-call model (this file's
 * own CLI, and `steps/render/sample_overlay.py`, both start a fresh process
 * per sample), but it means an in-process caller cannot vary the fonts base
 * per call — the value is fixed for the life of the process.
 */
export async function sampleOverlay({
  componentPath,
  props = {},
  frame = 0,
  fps = 30,
  width = 1080,
  height = 1920,
  googleFonts = [],
  measure = false,
  durationFrames = null,
  outPath,
  projectDir = null,
  session = null,
}) {
  if (!outPath) throw Object.assign(new Error('outPath is required'), { sampleError: 'missing_argument' })
  if (!componentPath) throw Object.assign(new Error('componentPath is required'), { sampleError: 'missing_argument' })

  // Resolve the `duration` global handed to the overlay. When the caller knows
  // the item's real length they pass it (WYSIWYG, incl. fade-in/out); otherwise
  // default to a tail past the sampled frame so end-of-life fades don't fire.
  const effectiveDuration = durationFrames != null
    ? Math.max(1, durationFrames)
    : frame + PREVIEW_TAIL_FRAMES

  // GC cache on every call
  gcCache()

  // Build cache key
  const cacheKey = buildOverlayCacheKey(componentPath, props, frame, width, height, googleFonts, measure, effectiveDuration, MONTAJ_FONTS_DIR)
  const cachePng = join(CACHE_DIR, `${cacheKey}.png`)
  const cacheJson = join(CACHE_DIR, `${cacheKey}.json`)
  const cacheInputs = join(CACHE_DIR, `${cacheKey}.inputs.json`)

  // Cache hit: the PNG exists and every file it was rendered from is unchanged.
  // The inputs come from the manifest, so sampleFrame can take their union.
  const hitInputs = existsSync(cachePng) ? readValidInputsManifest(cacheInputs) : null
  if (hitInputs) {
    log(`cache hit for ${basename(componentPath)} frame ${frame}`)
    mkdirSync(dirname(outPath), { recursive: true })
    copyFileSync(cachePng, outPath)
    if (measure && existsSync(cacheJson)) {
      const measurements = JSON.parse(readFileSync(cacheJson, 'utf8'))
      return { pngPath: outPath, measurements, inputs: hitInputs }
    }
    return { pngPath: outPath, inputs: hitInputs }
  }

  log(`sampling overlay ${basename(componentPath)} at frame ${frame}${measure ? ' (measure)' : ''}`)

  // PL89: in a session (several times in one call), an overlay's page is bundled and loaded once and kept open; each
  // later time only sets its frame and captures. A measure never shares a page.
  const sessionKey = session && !measure ? JSON.stringify([componentPath, props, fps, effectiveDuration, width, height, googleFonts, projectDir]) : null
  // PL89g: a measure in a session (measureOverlays) gets its own page but the session's browser, which stays open.
  const shareBrowser = Boolean(session && measure)
  const open = () => openOverlayPage({ componentPath, props, fps, effectiveDuration, width, height, googleFonts, projectDir, session: sessionKey || shareBrowser ? session : null })
  const capture = (ctx) => captureOverlay({ ...ctx, componentPath, frame, measure, width, height, outPath })
  let recordedInputs
  let shot
  try {
    if (sessionKey) {
      const got = await session.sample(sessionKey, open, capture)
      recordedInputs = got.ctx.recordedInputs
      shot = got.shot
    } else {
      const ctx = await open()
      try {
        recordedInputs = ctx.recordedInputs
        shot = await capture(ctx)
        await ctx.page.close()
      } finally {
        if (shareBrowser) await ctx.page.close().catch(() => {})
        else await ctx.browser.close()
        cleanupBundle(ctx.workDir)
      }
    }
  } catch (err) {
    // Re-surface page errors as structured error if __setFrame wasn't available
    if (!err.sampleError && err.message) {
      err.sampleError = isThreeFrameBlank(err) ? 'three_frame_blank' : 'overlay_eval_failed'
    }
    throw err
  }
  const { measurements, degraded, warnings } = shot

  // Write to cache
  if (!degraded) try {
    mkdirSync(CACHE_DIR, { recursive: true })
    // Manifest goes first out and last in: a reader that sees the new PNG
    // beside the old manifest would validate stale pixels.
    rmSync(cacheInputs, { force: true })
    copyFileSync(outPath, cachePng)
    if (measure && measurements !== undefined) {
      writeFileSync(cacheJson, JSON.stringify(measurements))
    }
    writeInputsManifest(cacheInputs, recordedInputs)
  } catch (e) {
    // Cache write failure is non-fatal
    log(`WARNING: cache write failed: ${e.message}`)
  }

  if (measure) {
    return { pngPath: outPath, measurements, inputs: recordedInputs, degraded, warnings }
  }
  return { pngPath: outPath, inputs: recordedInputs, degraded, warnings }
}

/** The frame each strip time shows: seconds to frames at `fps`, inside the overlay's `durationFrames`. */
export function stripFrames(times, fps, durationFrames) {
  return times.map((t) => Math.min(Math.max(0, Math.round(t * fps)), Math.max(0, durationFrames - 1)))
}

/**
 * A 3D item's strip source: the item `{ src: engine:scene3d, props }` materialized as an export does it
 * (render/scene3d.js materializeScene3d), so the component is the host's stage (MONTAJ_SCENE3D_STAGE) and the props
 * gain the scene (`sceneFile`, `sceneJson`). Throws Scene3dError naming what is missing.
 */
export function scene3dStripSource(props, projectDir, opts) {
  const item = { type: 'overlay', src: SCENE3D_SRC, start: 0, end: 1, props: { ...(props || {}) } }
  materializeScene3d({ tracks: [[item]] }, projectDir, opts)
  return { componentPath: item.src, props: item.props }
}

/**
 * Filmstrip of an overlay: one small PNG per time, from ONE browser and ONE page (bundled and mounted once), painted
 * at tile size (deviceScaleFactor = tileWidth / width, never the full canvas scaled down). Writes
 * outDir/t_0000.png... in the order of `times`; touches no sample cache. Returns { pngs, tileWidth, tileHeight, inputs }
 * where inputs are the files the overlay was built from ([[path, mtimeMs]]).
 */
/**
 * `work` raced against `ms` milliseconds: past it, rejects with sampleError 'timeout' (the caller's finally then
 * closes what it opened). `ms` absent or not positive: `work` as it is.
 */
export async function withDeadline(work, ms) {
  if (!(ms > 0)) return work
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Overlay strip passed its ${ms} ms deadline`), { sampleError: 'timeout' })), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
    work.catch(() => {})
  }
}

export async function sampleOverlayStrip({ componentPath, props = {}, times, fps = 30, durationFrames, width = 1080, height = 1920, googleFonts = [], tileWidth, outDir, projectDir = null, deadlineMs = null }) {
  if (!componentPath) throw Object.assign(new Error('componentPath is required'), { sampleError: 'missing_argument' })
  const scale = tileWidth / width
  const frames = stripFrames(times, fps, durationFrames)
  mkdirSync(outDir, { recursive: true })
  const key = JSON.stringify([componentPath, props, fps, durationFrames, width, height, googleFonts, projectDir, 'strip'])
  const session = createSampleSession()
  const pngs = []
  let inputs = []
  try {
    const open = () => openOverlayPage({ componentPath, props, fps, effectiveDuration: Math.max(1, durationFrames), width, height, googleFonts, projectDir, session, deviceScaleFactor: scale })
    await withDeadline((async () => {
      for (let k = 0; k < frames.length; k++) {
        const outPath = join(outDir, `t_${String(k).padStart(4, '0')}.png`)
        try {
          const got = await session.sample(key, open, (ctx) => captureOverlay({ ...ctx, componentPath, frame: frames[k], measure: false, width, height, outPath }))
          inputs = got.ctx.recordedInputs
        } catch (err) {
          if (!err.sampleError && err.message) err.sampleError = isThreeFrameBlank(err) ? 'three_frame_blank' : 'overlay_eval_failed'
          throw err
        }
        pngs.push(outPath)
      }
    })(), deadlineMs)
  } finally {
    await session.close()
  }
  return { pngs, tileWidth, tileHeight: Math.round(height * scale), inputs }
}

/**
 * Whether every pixel of a PNG has alpha 255, read with the bundled ffmpeg
 * (the minimum of the alpha plane). A PNG with no alpha channel is opaque.
 * Any failure to read it answers false: the footage is then decoded as before.
 */
function pngFullyOpaque(pngPath) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', pngPath, '-vf',
    'format=rgba,alphaextract,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
    '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return false
  return /lavfi\.signalstats\.YMIN=255\b/.test(r.stdout)
}

// ---------------------------------------------------------------------------
// sampleFrame
// ---------------------------------------------------------------------------

/**
 * Render the full composited frame at a specific timestamp.
 *
 * @param {object} opts
 * @param {object|string} opts.projectJson  Parsed project.json or absolute path to it
 * @param {number}        opts.atSeconds    Timestamp to sample
 * @param {string}        opts.outPath      Where to write the output PNG
 * @param {string|null}   [opts.sdrCurve]   Look curve id for the HDR→SDR grade;
 *   null uses the master look. Ignored on SDR projects (nothing is converted).
 * @param {boolean}       [opts.noCaptions] Leave the captions overlay out, so the frame shows the picture under a caption.
 * @param {string|null}   [opts.projectDir] The project's folder, for a parsed
 *   `projectJson`: relative paths and 3D items resolve against it. A path
 *   `projectJson` brings its own.
 * @returns {Promise<{ pngPath: string }>}
 */
export async function sampleFrame({
  projectJson,
  atSeconds,
  outPath,
  sdrCurve = null,
  preferProxy = false,
  noCaptions = false,
  clampToEnd = false,
  projectDir: projectDirOpt = null,
  session = null,
  maxShortEdge = null,
}) {
  if (!outPath) throw new Error('outPath is required')
  if (atSeconds == null) throw new Error('atSeconds is required')

  // A sidecar describes ONE render; an old one must never outlive its frame.
  const clampedSidecar = `${outPath}.clamped.json`
  rmSync(clampedSidecar, { force: true })

  // GC cache on every call
  gcCache()

  // Resolve projectJson: accept path string or parsed object
  let projectPath = null
  let project = null
  if (typeof projectJson === 'string') {
    projectPath = resolve(projectJson)
    if (!existsSync(projectPath)) throw new Error(`project.json not found: ${projectPath}`)
    project = JSON.parse(readFileSync(projectPath, 'utf8'))
  } else {
    project = projectJson
  }
  // §239: a scene item (src `engine:scene3d`) becomes the plain overlay of the host's stage before the cache key reads
  // the overlay sources, so an edited stage or scene misses. Needs the project's folder, so only a project given by path.
  // PL89g: a projectDir given wins over the file's folder (look's backdrop project is kept in the samples folder).
  materializeScene3d(project, projectDirOpt || (projectPath ? dirname(projectPath) : null))

  // Opt-in: a time at or past the end samples the last frame instead of
  // failing. Done before the cache key so the clamped time is what is cached.
  if (clampToEnd) {
    const c = clampAtToEnd(atSeconds, getTotalDurationSeconds(project), project.settings?.fps ?? 30)
    if (c.clamped) {
      atSeconds = c.at
      writeFileSync(clampedSidecar, JSON.stringify({ requested: c.requested, at: c.at, end: c.end }))
    }
  }

  // Cache key
  // PL89c: a sheet's frame at the design canvas is its own entry, never a full-size sample's.
  const cap = Number.isFinite(maxShortEdge) && maxShortEdge > 0 ? Math.round(maxShortEdge) : null
  const cacheKey = buildFrameCacheKey(projectPath, project, atSeconds, sdrCurve, preferProxy, SAMPLE_CACHE_VERSION, cap, noCaptions)
  const cachePng = join(CACHE_DIR, `${cacheKey}.png`)
  const cacheInputs = join(CACHE_DIR, `${cacheKey}.inputs.json`)

  // The key covers each overlay's own file; the manifest covers everything they
  // import and every props asset. No manifest is a miss.
  if (existsSync(cachePng) && readValidInputsManifest(cacheInputs)) {
    log(`cache hit for frame at t=${atSeconds}`)
    mkdirSync(dirname(outPath), { recursive: true })
    copyFileSync(cachePng, outPath)
    return { pngPath: outPath }
  }

  // Resolve relative paths in project
  const projectDir = projectDirOpt || (projectPath ? dirname(projectPath) : null)
  const resolvedProject = deepClone(project)
  if (projectDir) {
    resolveProjectPaths(resolvedProject, projectDir)
  }

  const settings = resolvedProject.settings ?? {}
  const fps = settings.fps ?? 30
  const projectColorSpace = settings.colorSpace ?? 'sdr_bt709'

  // Canvas math — same as render.js
  const aspectW = settings.resolution?.[0] ?? 1080
  const aspectH = settings.resolution?.[1] ?? 1920
  const aspectRatio = SHORT_EDGE_TARGET / Math.min(aspectW, aspectH)
  const renderWidth  = Math.round(aspectW * aspectRatio / 2) * 2
  const renderHeight = Math.round(aspectH * aspectRatio / 2) * 2
  let actualWidth  = settings.resolution?.[0] ?? renderWidth
  let actualHeight = settings.resolution?.[1] ?? renderHeight
  // PL89c: a sheet's frames composite at most at `maxShortEdge` (the design canvas the overlays render at), not a 4K
  // project's own size; a single sample keeps it.
  if (cap && Math.min(actualWidth, actualHeight) > cap) {
    const k = cap / Math.min(actualWidth, actualHeight)
    actualWidth = Math.round(actualWidth * k / 2) * 2
    actualHeight = Math.round(actualHeight * k / 2) * 2
  }

  // Validate timestamp
  const totalDuration = getTotalDurationSeconds(resolvedProject)
  if (totalDuration > 0 && atSeconds > totalDuration) {
    throw new Error(
      `Requested timestamp ${atSeconds} is past project end ${totalDuration}`,
    )
  }

  log(`sampling frame at t=${atSeconds}s (${actualWidth}×${actualHeight}, colorSpace=${projectColorSpace})`)

  // Collect active items via the shared resolver — the single source of truth
  // for "what's on screen at time T", also used by render.js/segment-plan.js and
  // the editor preview. The 'render' variant matches production exactly:
  // normalizedSrc rebase, nobg_src precedence, and the sourceCrop/fit forwarding
  // below all key off `resolveAt`'s per-item `window`/`geometry`. `containsTime`
  // (start <= atSeconds < end) is the same half-open predicate this file always
  // used — the LATER clip wins an exact boundary tie.
  const scene = resolveAt(withEnabledItemTracks(resolvedProject), atSeconds, { variant: 'render' })

  // §308 P3: video, image and overlay items composite as ONE bottom-to-top
  // stack, by track in the editor's order (timeline-core `trackLayerPositions`:
  // every track holding video first), a track's clips before its overlays,
  // each kind in document order, the captions last: the export's own order
  // (segment-plan.js `layers`). Until 5.33.3 every overlay went on top of every
  // clip, whatever their tracks, so an image on a track above an overlay showed
  // in the editor and in no sample.
  const visualItems  = scene.items.filter(ri => ri.kind === 'video' || ri.kind === 'image')
  const overlayItems = scene.items.filter(ri => ri.kind === 'overlay')
  const videoCount = visualItems.filter(ri => ri.kind === 'video').length
  const imageCount = visualItems.length - videoCount
  const layerOf = trackLayerPositions(trackItems(resolvedProject))
  const layerTrackOf = ri => layerOf[ri.trackIdx] ?? ri.trackIdx
  const stack = [
    ...visualItems.map((ri, i) => ({ ri, kind: 0, i })),
    ...overlayItems.map((ri, i) => ({ ri, kind: 1, i })),
  ].sort((a, b) => layerTrackOf(a.ri) - layerTrackOf(b.ri) || a.kind - b.kind || a.i - b.i)

  // An opaque overlay replaces the picture underneath it. Production
  // (segment-plan.js/encode-segment.js) keeps the covered items around anyway so
  // their AUDIO still reaches the mix — irrelevant for a still frame, so the
  // analogue here is simpler: don't composite a video/image item the overlay
  // covers. See KNOWN-DIVERGENCES.md "opaque-in-preview".
  // Only one over the whole canvas counts (`opaqueReplacesPicture`, the rule
  // export and the editor read): a scaled one leaves the footage drawn. And
  // only at full opacity at this instant (§309): mid-fade the footage shows.
  // And only what is BELOW the topmost such overlay (§308 P3): an image stacked
  // over it is drawn.
  let coverAt = -1
  for (let k = stack.length - 1; k >= 0 && coverAt < 0; k--) {
    if (stack[k].kind === 1 && opaqueReplacesPicture(stack[k].ri.item, stack[k].ri.seek)) coverAt = k
  }
  const culledBelow = (k) => new Set(stack.slice(0, Math.max(0, k)).filter(e => e.kind === 0).map(e => e.ri))
  let culled = culledBelow(coverAt)
  const hasOpaque = culled.size > 0

  log(`active items: ${videoCount} video, ${imageCount} image` +
      `${hasOpaque ? ' (hidden by opaque overlay)' : ''}, ${overlayItems.length} overlay`)

  // --- Step 1: Render overlay PNGs in parallel (cap=4) ---
  // Each overlay PNG has transparent background, same design resolution as canvas
  const overlayInputLists = []
  // Any overlay sample the page guard blocked something in: the frame is not
  // cached either (sampleOverlay's `degraded`).
  let degraded = false
  const overlayPngs = await pMap(overlayItems, async (ri) => {
    const ov = ri.item
    // ri.seek is the resolver's elapsed-since-start for a non-video item —
    // max(0, atSeconds - ov.start) — identical to the frame math this file
    // always used, just computed once by the resolver instead of by hand.
    const overlayFrame = Math.round(ri.seek * fps)
    // Pass the item's real on-screen length so the composited frame is WYSIWYG —
    // an overlay sampled near its own start/end shows its true fade-in/out state.
    const overlayDurationFrames = Math.max(1, Math.round((ov.end - ov.start) * fps))
    const tmpOverlayOut = join(tmpdir(), `montaj-sample-ov-${randomHex()}.png`)
    const result = await sampleOverlay({
      componentPath: ov.src,
      props: ov.props ?? {},
      frame: overlayFrame,
      fps,
      width: renderWidth,
      height: renderHeight,
      googleFonts: ov.googleFonts ?? [],
      measure: false,
      durationFrames: overlayDurationFrames,
      outPath: tmpOverlayOut,
      projectDir,
      session,
    })
    overlayInputLists.push(result.inputs)
    if (result.degraded) degraded = true
    return {
      // Shape expected by buildOverlayFilterParts: webmPath, startSeconds, offsetX, offsetY, scale/scaleX/scaleY
      //
      // NEVER add `keyframes` (or spread `ov`) here, and never `...ri.geometry`
      // it either. This descriptor is deliberately a flat list of ALREADY-SAMPLED
      // scalars: `ri.geometry` is `geometryAt(item, kind, ri.seek)` (see
      // @bycrux/timeline-core/src/activation.js), so an animated overlay's values
      // below are its values at THIS instant, and one instant is all a still
      // frame has. buildOverlayFilterParts must therefore take its ORDINARY
      // path and position this PNG statically at exactly that sampled geometry —
      // which is the right answer for a single frame, and is why this path needs
      // no bake.
      //
      // A leaked `keyframes` key would flip it onto the baked branch (full-canvas
      // scale, overlay=0:0) while `sampleOverlay` above renders an UN-baked
      // capture — bundleComponent is called with no geometry at all — so the
      // Export dialog's preview would silently lose every overlay's position.
      // Pinned by test/sample-frame.test.mjs.
      webmPath:     result.pngPath,
      startSeconds: ov.start,
      offsetX:      ri.geometry.offsetX,
      offsetY:      ri.geometry.offsetY,
      scale:        ri.geometry.scale,
      // `ri.geometry` is a full `Geometry`, so these two are always present and
      // already equal to `scale` on a uniform item — no `??` chain needed here,
      // unlike the raw-item sites in render.js. Forwarding them is what lets
      // buildOverlayFilterParts size a stretched overlay for the Export
      // dialog's still the same way the production compose does.
      scaleX:       ri.geometry.scaleX,
      scaleY:       ri.geometry.scaleY,
      rotation:     ri.geometry.rotation,
      // Forwarded for the same reason the image and video pseudo-items below
      // forward it (`opacity: ri.geometry.opacity`, Step 3): overlays were the
      // one kind that did not, back when buildOverlayFilterParts had no opacity
      // term to forward it TO. It has one now, so leaving this off would make
      // the Export dialog the only surface still rendering overlays fully
      // opaque — the divergence, just moved.
      //
      // Sampled, like every other value here, so a keyframed opacity fade shows
      // its true state at this instant.
      opacity:      ri.geometry.opacity,
      opaque:       ov.opaque ?? false,
    }
  }, OVERLAY_CONCURRENCY)

  // A full-canvas overlay at full opacity whose rendered PNG is opaque in every
  // pixel hides what is below it just as an `opaque` one does, flagged or not
  // (a 3D scene's backdrop, a full-screen card). The alpha is measured on the
  // PNG. The frame is the one an `opaque` overlay gives (SAMPLE_CACHE_VERSION 20).
  // MONTAJ_SAMPLE_NO_COVER_SKIP=1 turns this off: a seam for the comparison test
  // only; the `opaque` cull above stays.
  if (process.env.MONTAJ_SAMPLE_NO_COVER_SKIP !== '1') {
    for (let k = stack.length - 1; k > coverAt; k--) {
      const e = stack[k]
      if (e.kind !== 1) continue
      if (!stack.slice(0, k).some(b => b.kind === 0)) break
      if (!isFullCanvasPlacement(e.ri.item) || opacityAt(e.ri.item, e.ri.seek) !== 1) continue
      if (!pngFullyOpaque(overlayPngs[e.i].webmPath)) continue
      coverAt = k
      const before = culled.size
      culled = culledBelow(coverAt)
      if (culled.size > before) log('footage hidden by an overlay measured fully opaque (alpha 255 everywhere)')
      break
    }
  }

  // §59: the captions, drawn as the export draws them (caption-spec.js, the
  // `captions` segment render.js composites after every overlay): one overlay
  // over the whole film, sampled at this instant, on top. Without it the
  // user's AI checked a captioned project without ever seeing a caption.
  const caption = noCaptions ? null : captionOverlayFields(resolvedProject.captions)
  if (caption) {
    const result = await sampleOverlay({
      componentPath: caption.componentPath,
      props: caption.props,
      frame: Math.round(atSeconds * fps),
      fps,
      width: renderWidth,
      height: renderHeight,
      googleFonts: caption.googleFonts,
      measure: false,
      durationFrames: Math.max(1, Math.round(totalDuration * fps)),
      outPath: join(tmpdir(), `montaj-sample-captions-${randomHex()}.png`),
      projectDir,
      session,
    })
    overlayInputLists.push(result.inputs)
    if (result.degraded) degraded = true
    overlayPngs.push({
      webmPath: result.pngPath, startSeconds: 0,
      offsetX: 0, offsetY: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, opaque: false,
    })
  }

  // --- Step 2: Extract video frames via accurate seek ---
  // For HDR projects: apply tonemap inline during extraction so the extracted
  // PNG is already in sRGB BT.709. This avoids the "no path between colorspaces"
  // error that zscale throws when applied to the composite output — the overlay
  // filter drops colorspace metadata (format=rgba strips tags), and zscale can't
  // figure out the conversion path on the resulting canvas.
  //
  // For SDR projects: extract as-is (no vf filter).
  const hdrProject = isHdr(projectColorSpace)
  const workDir = join(tmpdir(), `montaj-sample-frame-${randomHex()}`)
  mkdirSync(workDir, { recursive: true })

  // ResolvedItem -> extracted-frame PNG path, so Step 3 can look up each video
  // item's frame while walking the stack. Skipped for an item an opaque
  // overlay covers — nothing composites that frame anyway (see `culled`
  // above), so there's no point paying for the ffmpeg extraction.
  const videoFramePaths = new Map()

  let vi = 0
  for (const ri of visualItems) {
    if (ri.kind !== 'video' || culled.has(ri)) continue
    // window = sourceWindow(item, 'render') — src is already the resolver's
    // choice (normalizedSrc/nobg_src/original) with in/outPoint rebased for a
    // normalizedSrc cache. Use normalized/audioclean cached file if present and
    // fresh on top of that (read-only — never triggers normalization).
    let window = ri.window
    // Fast-preview path: decode the clip's SDR proxy instead of the master
    // when `preferProxy` is set and one exists. The proxy is full-source (the
    // item's own coords, no normalizedSrc rebase) and already SDR, so it needs
    // the ORIGINAL-coords seek and NO tone-map (both handled below). Decided
    // per clip: a clip with no proxy quietly falls back to the master.
    const item = ri.item
    // A remove_bg item with a nobg_src is the exception: the proxy is the raw
    // clip (background still in), so it decodes the cutout, as the render does.
    const useProxy = shouldUseProxy(item, preferProxy, existsSync)

    // PV42: in an HDR project each layer is graded by its ORIGIN, decided by
    // sdr-layer.js and nothing else here. An SDR-origin layer (screen
    // recording, download, or a marked conversion of one) is decoded as
    // authored from its original; its `src` may differ from the resolver's
    // pick, so the window is re-resolved for the layer's item. The proxy is
    // SDR and ungraded, so a proxy decode skips all of it. SDR projects never
    // reach this: no provenance probe, no change in output.
    let layer = null
    let seekOffsetFromRi = 0
    if (hdrProject && !useProxy) {
      layer = sdrLayerFor(item)
      window = sourceWindow(layer.item, 'render')
      // ri.seek is inPoint + speed * elapsed (== seekTime), so this offset is
      // already speed-scaled SOURCE seconds; do not multiply by speed again.
      seekOffsetFromRi = ri.seek - ri.window.inPoint
    }
    const src = useProxy
      ? item.proxySrc
      : resolveVideoSource(window.src, { sdrOrigin: layer !== null && !layer.grade && !layer.cutoutKey })
    // ri.seek is the resolver's seekTime (speed-aware), but rebased for a
    // normalizedSrc cache. The proxy is un-rebased, so recompute in the item's
    // own source coords (still speed-aware) when using it.
    const seekTime = useProxy
      ? (item.inPoint ?? 0) + (item.speed ?? 1) * Math.max(0, atSeconds - item.start)
      : (layer ? window.inPoint + seekOffsetFromRi : ri.seek)
    const framePng = join(workDir, `video-${vi}.png`)

    log(`extracting video frame at t=${seekTime.toFixed(3)}s from ${src ? basename(src) : '(no src)'}${useProxy ? ' (proxy)' : ''}`)

    // Two-stage seek: fast + still frame-accurate. A coarse `-ss` BEFORE `-i`
    // jumps to the nearest keyframe at/before the target without decoding
    // anything, then a short `-ss` AFTER `-i` accurately decodes only the
    // remainder from that keyframe to the exact frame. The old form (`-ss`
    // after `-i` alone) decoded the clip from t=0 to the target — ~5–10s on a
    // long HEVC clip, paid on every preview sample (the render modal fires
    // three: a cover plus one per SDR curve). This bounds the decode to
    // ~SEEK_PREROLL_S (+ one GOP) no matter how deep the sample sits, with no
    // loss of accuracy: the fine seek always decodes forward from a real
    // keyframe to the requested frame.
    const seek = Math.max(0, seekTime)
    const fastSeek = Math.max(0, seek - SEEK_PREROLL_S)
    const fineSeek = seek - fastSeek
    const ffmpegExtractArgs = [
      '-y', '-v', 'error',
      ...(Number(ffSeconds(fastSeek)) > 0 ? ['-ss', ffSeconds(fastSeek)] : []),
      '-i', src,
      '-ss', ffSeconds(fineSeek), // §478: seek - fastSeek can leave a 1e-15 residue, which String() wrote as "1e-15"
    ]

    // Filter chain: the optional source crop (clips workflow vertical reframe)
    // THEN the HDR→SDR conversion — the geometry-first order
    // encode-segment.js's buildVideoItemFilterParts uses, and for its reason
    // (see the step-order note there): cropping first means the conversion
    // only pays for pixels that survive. The crop is a no-op without both
    // sourceWidth/sourceHeight, matching that function's own gate — see
    // KNOWN-DIVERGENCES.md "sourcecrop-missing-dims-silent-drop".
    //
    // There is no scale/pad step here: this extract produces one full-size
    // source frame, and buildImageItemFilterParts does the canvas fit when the
    // frame is composited (Step 3). So nothing is ever padded before the
    // conversion, which is the property encode-segment's ordering protects.
    const vfParts = []
    const crop = sourceCropFilter(ri.geometry, useProxy)
    if (crop) vfParts.push(crop)
    // The proxy is ungraded SDR. One built from an untagged source by an older
    // montaj is untagged too, and ffmpeg would decode it as BT.601 where the
    // export reads its source as BT.709. Read it as the export does, in HDR and
    // SDR projects alike; a tagged proxy (every new one) is left alone.
    if (useProxy && decodedTransferOf(src) === 'unknown') vfParts.unshift(UNTAGGED_AS_BT709_VF)
    if (layer) {
      // Grade HLG/PQ -> SDR BT.709 inline, through the same Montaj Vivid LUT
      // the render and the proxies use, ONLY when sdr-layer.js says so for
      // the transfer of the file actually decoded (probed once per path).
      // Mirrors encode-segment.js's buildVividLutChain, the builder the
      // segment encoder calls.
      //
      // The chain ends in rgb24, NOT yuv420p: this frame is encoded straight
      // to PNG and ffmpeg's png encoder only accepts rgb24/rgba/gray/pal8
      // family formats; yuv420p made the encoder fail outright.
      //
      // A cutout (remove_bg + nobg_src) is an untagged alpha file: zscale
      // takes no alpha format, so its colour is graded on a split and the
      // alpha is merged back, ending in rgba.
      //
      // lut3d can be missing from an older ffmpeg build, so a graded layer
      // falls back to the pre-SP6b Hable chain and says so once per extract.
      const isCutout = !!(item.remove_bg && item.nobg_src)
      const key = gradeKeyFor(layer, isCutout ? null : decodedTransferOf(src))
      if (key) {
        if (!(hasZscale() && hasLut3d())) {
          log('WARNING: ffmpeg lacks zscale and/or lut3d — sampling with the legacy '
            + 'Hable tonemap; this frame will NOT match the render. Run `montaj doctor`.')
        }
        vfParts.push(isCutout ? buildCutoutSampleVf(key, sdrCurve) : buildSampleGradeVf(key, sdrCurve))
      }
      // An untagged SDR clip is read as BT.709 by the HDR export (its stretch),
      // where ffmpeg's own default would decode it as BT.601. Only this block
      // is HDR-only, so SDR projects stay byte-identical.
      else if (!isCutout && decodedTransferOf(src) === 'unknown') vfParts.unshift(UNTAGGED_AS_BT709_VF)
    }
    if (vfParts.length) ffmpegExtractArgs.push('-vf', vfParts.join(','))

    ffmpegExtractArgs.push('-frames:v', '1', '-update', '1', framePng)

    const result = spawnSync(FFMPEG, ffmpegExtractArgs, { encoding: 'utf8', timeout: 60_000 })

    if (result.status !== 0) {
      throw new Error(`ffmpeg video frame extract failed: ${ffmpegErrorTail(result.stderr)}`)
    }

    videoFramePaths.set(ri, framePng)
    vi++
  }

  // --- Step 3: Build composite ffmpeg command ---
  // Using the three shared helpers from encode-segment.js

  // Duration for filter purposes — 1 frame is enough
  const duration = 1 / fps

  const inputs = []
  const filterParts = []
  const maskJobs = []   // the mask files the clips above need, written before ffmpeg runs
  let videoLabel
  let inputIdx = 0

  // Black canvas base
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${frameSize(actualWidth, actualHeight)}:rate=${positiveNumber(fps, 'settings.fps')}:duration=${ffSeconds(duration)}`)
  filterParts.push(`[0:v]format=rgba[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // Overlay PNGs — call the shared buildOverlayFilterParts helper with PNG-tuned opts.
  // Same positioning/scale math as the production renderer; we override the
  // VP9-specific format flags (rgba input, auto composite output) and switch the
  // input args to looped-still mode since PNGs are single frames, not seekable
  // video. This keeps sample and production paths from drifting on overlay math.
  const compositeOverlay = (ov) => {
    const { inputArgs, filterParts: fp, newVideoLabel } = buildOverlayFilterParts(
      ov, actualWidth, actualHeight, inputIdx, videoLabel,
      0,         // segStart: PNG overlays are not seeked (loopedInput=true), so ignored
      duration,
      { inputFormatFlag: 'rgba', compositeFormatFlag: 'auto', loopedInput: true },
    )
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
  }

  // Video + image items both composite through buildImageItemFilterParts — a
  // video's extracted frame is a PNG by this point, same as an image item's own
  // file.
  const compositeClip = (ri) => {
    // ── The opacity rule, for EVERY clip kind ────────────────────────────
    //
    // Computed once, above the branch, because it is ONE decision that both
    // the video and the image descriptor must make identically. It used to
    // live inside the video branch with the image branch deferring to it by
    // comment — and the image branch then quietly failed to apply the
    // transition half of the rule at all.
    //
    // SAMPLED opacity (§616). `ri.geometry` is `geometryAt(...)`, so
    // `.opacity` is the curve's value at this instant, and the export now
    // fades a clip by that same curve (encode-segment.js's keyframed opacity
    // mixer, sampled at the segment's fps), so the still shows what the
    // export shows at this instant. It used to read the static scalar,
    // because the export could not fade a clip at all (SP9d T6: ffmpeg's
    // `colorchannelmixer aa` takes no expression) and honouring the curve
    // would have made the Export dialog's still show a fade the file never
    // had. `opacityAt` is the one reading of the curve for both. Geometry
    // (position, scale, rotation) is SAMPLED in the descriptors below for the
    // same reason. The mask and the blend mode are sampled too (`maskAt`):
    // the descriptor carries the resolved mask and NO keyframes, so the
    // builder takes its literal path and the still mask is one frame.
    //
    // A TRANSITION is not an exception to that rule but another application
    // of it (T12): the export genuinely blends a transitioning pair now
    // (encode-segment.js's `blend` branch, T8), so a still caught
    // mid-transition must show the blend too, or it would be lying about the
    // one thing this whole file exists to get right. This applies to IMAGE
    // clips as much as video ones: `crossfadesAt` pushes both kinds into its
    // `clips` array, and `encode-segment.js` evaluates `opensCrossfade` and
    // emits the split BEFORE its `isImageItem` branch, so the export really
    // does dissolve an image pair.
    //
    // ONLY THE INCOMING SIDE RAMPS. The OUTGOING side keeps its own full
    // opacity — factor 1, not `1-p`. That looks wrong and is not, and the
    // reason is the compositing model:
    //
    //   - The EXPORT is a SPLIT-AND-LERP compositor. encode-segment.js
    //     splits the running canvas, composites the outgoing item down one
    //     branch and the incoming one down the other — each at its OWN full
    //     opacity — and then lerps the two finished frames with
    //     `blend=all_expr='A+(B-A)*p'`, i.e. `(1-p)*from + p*to`.
    //   - THIS file is a SEQUENTIAL source-over compositor: each item is
    //     layered onto the one running canvas in turn (the
    //     buildImageItemFilterParts loop below). Painting `from` at 1 and
    //     then `to` at alpha p gives exactly `p*to + (1-p)*from` — the same
    //     lerp, reached by a different route.
    //
    // Feeding the symmetric `1-p` / `p` pair into a SEQUENTIAL stack does NOT
    // reproduce the lerp; it yields `p*to + (1-p)^2*from + p(1-p)*bg`, which
    // at p=0.5 lands the outgoing clip at QUARTER weight and leaks the
    // background through the middle of the transition.
    //
    // The shared reference for the sequential form is
    // `createCanvasPainter.paintBlend` (editor/src/engine/index.ts):
    // `globalAlpha = 1` for `from`, then `globalAlpha = p` for `to`. The DOM
    // preview (editor's video/preview/OverlayItemsLayer.tsx) is the same kind
    // of compositor and reads the same factor. All three land on one picture.
    // Do not "restore" the symmetric form here — it is the obvious-looking
    // wrong answer for this compositor.
    //
    // `ri.crossfade` is CLIPS-ONLY and already `null` outside an overlap
    // (@bycrux/timeline-core/src/activation.js's `ItemCrossfade`), so the
    // factor is 1 — a no-op — everywhere this pin used to apply
    // unconditionally.
    // `localT` is the item-relative time `ri.geometry` was sampled at (resolveItem's `elapsed`).
    const localT = Math.max(0, atSeconds - (ri.item.start ?? 0))
    const opacity = opacityAt(ri.item, localT) * (ri.crossfade?.role === 'to' ? ri.crossfade.p : 1)

    let pseudoItem
    if (ri.kind === 'video') {
      const framePng = videoFramePaths.get(ri)
      if (!framePng) return // defensive — every video RI drawn got a frame extracted above
      // Treat the extracted video frame as an image item — it's a PNG at this point.
      //
      // NEVER add `keyframes` here, and never spread `ri.geometry` or the
      // source item in wholesale. Same discipline as the overlay descriptor
      // above (see its "NEVER add `keyframes`" note), but now load-bearing for
      // a second reason: since SP9d, buildImageItemFilterParts branches on
      // `Array.isArray(item.keyframes) && item.keyframes.length > 0` and, when
      // true, compiles the curves into piecewise-linear ffmpeg expressions.
      // This descriptor is a flat list of ALREADY-SAMPLED scalars — a still
      // frame has exactly one instant — so leaving `keyframes` off is what
      // keeps the sampler on the exact, non-approximated literal path. A
      // future edit that "helpfully" forwards them would silently swap those
      // exact values for the render approximation, in the one surface whose
      // whole job is to show precisely what a given instant looks like.
      pseudoItem = {
        src:      framePng,
        scale:    ri.geometry.scale,
        // Beside `scale`, for the same reason the overlay descriptor above
        // carries them: buildImageItemFilterParts re-resolves this pseudo-item
        // through `geometryFor`, which reads the per-axis pair first. Drop
        // them and a stretched video reverts to a uniform box in the Export
        // dialog's still while the preview shows it stretched.
        scaleX:   ri.geometry.scaleX,
        scaleY:   ri.geometry.scaleY,
        offsetX:  ri.geometry.offsetX,
        offsetY:  ri.geometry.offsetY,
        rotation: ri.geometry.rotation,
        opacity, // the shared rule — see the note above the branch
        // TRAP: buildImageItemFilterParts defaults to 'cover' when fit is
        // omitted, which CROPS the frame to fill its box. Production video is
        // ALWAYS contain-fit — buildVideoItemFilterParts' own scale step uses
        // force_original_aspect_ratio=decrease unconditionally, never reading
        // item.fit at all (see @bycrux/timeline-core/src/geometry.js's fit
        // note). Forwarding sourceCrop above without ALSO forcing 'contain'
        // here would silently drag the wrong (image) fit rule onto a video
        // frame and crop content the crop step didn't already remove.
        fit: 'contain',
      }
    } else {
      pseudoItem = {
        src:      ri.item.src,
        scale:    ri.geometry.scale,
        scaleX:   ri.geometry.scaleX, // see the video branch above
        scaleY:   ri.geometry.scaleY,
        offsetX:  ri.geometry.offsetX,
        offsetY:  ri.geometry.offsetY,
        rotation: ri.geometry.rotation,
        opacity, // the shared rule — see the note above the branch
        fit:      ri.geometry.fit, // image's own tri-state, default 'cover'
        // PV55: the crop at THIS instant (geometryAt samples a keyframed one and
        // resolves its fit to 'cover', carried by `fit` above). Applied before
        // the fit exactly as the export applies it. Never `keyframes`: see the
        // video branch's note above.
        sourceCrop: ri.geometry.sourceCrop,
      }
    }
    // The mask, resolved at this instant (no keyframes: see the note above), and
    // the blend mode; both ride the descriptor like the other sampled scalars.
    const mask = maskAt(ri.item, localT)
    if (mask) pseudoItem.mask = mask
    const blend = blendModeOf(ri.item)
    if (blend !== 'normal') pseudoItem.blendMode = blend
    // `maskBase` goes in workDir, which the cleanup below removes whole. The
    // builder draws no mask without one. The canvas is RGBA and the extracted
    // frames are already BT.709 (see the note after the stack), so a blend
    // converts with the BT.709 matrix.
    const { inputArgs, filterParts: fp, newVideoLabel, maskInputArgs, maskJobs: jobs } =
      buildImageItemFilterParts(pseudoItem, actualWidth, actualHeight, inputIdx, videoLabel, duration, undefined,
        { fps, maskBase: join(workDir, `mask-${inputIdx}`), matrix: 'bt709', canvasPixFmt: SAMPLE_CANVAS_PIX_FMT })
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
    // The mask file is the next input, so the next layer starts one past it.
    if (maskInputArgs) {
      inputs.push(...maskInputArgs)
      maskJobs.push(...jobs)
      inputIdx++
    }
  }

  // The stack, bottom to top (§308 P3, see `stack` above); a clip an opaque
  // overlay covers is skipped. Then the captions (the last of overlayPngs),
  // always on top.
  for (const layer of stack) {
    if (layer.kind === 1) compositeOverlay(overlayPngs[layer.i])
    else if (!culled.has(layer.ri)) compositeClip(layer.ri)
  }
  for (const ov of overlayPngs.slice(overlayItems.length)) compositeOverlay(ov)

  // Note: HDR tonemap is applied during video frame extraction (Step 2 above),
  // not here. Applying zscale to the composite output causes "no path between
  // colorspaces" because format=rgba in the overlay chain drops colorspace tags.
  // The extracted video frames are already in sRGB BT.709 for HDR projects.

  // The masks are files the composite reads as inputs: write them first.
  await Promise.all(maskJobs.map((job) => writeItemMask(job)))

  // Write output PNG
  mkdirSync(dirname(outPath), { recursive: true })

  const ffmpegArgs = [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', videoLabel,
    '-frames:v', '1',
    '-update', '1',
    outPath,
  ]

  log(`compositing frame (${actualWidth}×${actualHeight})`)
  // The graph reaches ffmpeg as a file in workDir (WIN1b: Windows caps a command
  // line at 32,767 characters). Removed here on every way out of the spawn.
  let compResult
  const script = externalizeFilterGraph(ffmpegArgs, workDir)
  try {
    compResult = spawnSync(FFMPEG, script.args, {
      encoding: 'utf8',
      timeout: 120_000,
    })
  } finally {
    script.cleanup()
  }

  if (compResult.status !== 0) {
    throw new Error(`ffmpeg composite failed:\n${ffmpegErrorTail(compResult.stderr)}`)
  }

  // Cleanup temp files
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
  for (const ov of overlayPngs) {
    try { rmSync(ov.webmPath, { force: true }) } catch {}
  }

  // Write to cache
  if (!degraded) try {
    mkdirSync(CACHE_DIR, { recursive: true })
    rmSync(cacheInputs, { force: true })
    copyFileSync(outPath, cachePng)
    writeInputsManifest(cacheInputs, mergeInputs(overlayInputLists))
  } catch (e) {
    log(`WARNING: cache write failed: ${e.message}`)
  }

  return { pngPath: outPath }
}

/**
 * §308: one 3D alone, over the project's whole frame, `atSeconds` into the 3D,
 * so the AI can check a 3D that no timeline item shows (yet). `scene` is the id
 * of a 3D saved under `models/scenes/<id>/`, and the empty string is the
 * project's own (`models/active.json`): ids are free, so no id can mean that.
 *
 * Drawn as the export draws a 3D item: a one-frame project at the project's
 * settings (resolution, fps, colour space) holding one full-canvas 3D item
 * whose in point is `atSeconds`, sampled at its first frame, so the 3D time is
 * exact and not rounded to a frame. A 3D that is not saved fails naming it,
 * as on the timeline (render/scene3d.js).
 *
 * @param {object} opts
 * @param {string} opts.projectJson  Absolute path to project.json (its 3D lives beside it)
 * @param {string} opts.scene        The 3D's id, or '' for the project's own
 * @param {number} opts.atSeconds    Seconds into the 3D
 * @param {string} opts.outPath
 * @param {string|null} [opts.sdrCurve]
 * @returns {Promise<{ pngPath: string }>}
 */
export async function sampleScene({ projectJson, scene, atSeconds, outPath, sdrCurve = null }) {
  if (typeof projectJson !== 'string') throw new Error('a 3D is sampled from its project.json path')
  if (typeof scene !== 'string') throw new Error('scene must be a 3D id, or an empty string for the project\'s own')
  if (typeof atSeconds !== 'number' || !Number.isFinite(atSeconds) || atSeconds < 0) {
    throw new Error(`--at must be 0 or more seconds into the 3D (got ${atSeconds})`)
  }
  const projectPath = resolve(projectJson)
  if (!existsSync(projectPath)) throw new Error(`project.json not found: ${projectPath}`)
  const { settings = {} } = JSON.parse(readFileSync(projectPath, 'utf8'))
  const fps = settings.fps ?? 30
  const alone = {
    settings,
    tracks: [[{
      type: 'overlay', src: SCENE3D_SRC, start: 0, end: 1 / fps,
      props: { ...(scene === '' ? {} : { scene }), inPoint: atSeconds },
    }]],
    audio: { tracks: [] },
  }
  return sampleFrame({ projectJson: alone, projectDir: dirname(projectPath), atSeconds: 0, outPath, sdrCurve })
}

/**
 * PL89: sampleScenes' project: the 3D alone as one item from 0 to the last time's frame, inPoint 0, so each time is a
 * frame of it; `frames` (each time on the frame grid), `fps`, and `order`, the times' indexes in time order (a 3D that
 * carries state from frame to frame then only moves forward).
 */
export function scenesAlone({ settings = {}, scene, times }) {
  const fps = settings.fps ?? 30
  const frames = times.map((t) => Math.round(t * fps))
  const alone = {
    settings,
    tracks: [[{
      type: 'overlay', src: SCENE3D_SRC, start: 0, end: (Math.max(...frames) + 1) / fps,
      props: { ...(scene === '' ? {} : { scene }), inPoint: 0 },
    }]],
    audio: { tracks: [] },
  }
  const order = times.map((_, k) => k).sort((a, b) => frames[a] - frames[b] || a - b)
  return { alone, frames, fps, order }
}

/**
 * PL89: several times of one 3D alone, in one session: [{ pngPath, ... }] in the order of `times`. The 3D's item starts
 * at 0 and runs to the last time, so every time shares one page and is a frame of it: a time lands on the project's
 * frame grid (within half a frame), as an export shows it. One time is sampleScene's, exact.
 */
export async function sampleScenes({ projectJson, scene, times, outPaths, sdrCurve = null, newSession, frameTimeoutMs }) {
  if (typeof projectJson !== 'string') throw new Error('a 3D is sampled from its project.json path')
  if (typeof scene !== 'string') throw new Error('scene must be a 3D id, or an empty string for the project\'s own')
  for (const t of times) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new Error(`--at must be 0 or more seconds into the 3D (got ${t})`)
  }
  const projectPath = resolve(projectJson)
  if (!existsSync(projectPath)) throw new Error(`project.json not found: ${projectPath}`)
  const { settings = {} } = JSON.parse(readFileSync(projectPath, 'utf8'))
  const { alone, frames, fps, order } = scenesAlone({ settings, scene, times })
  return sampleInSessions({
    count: times.length,
    order,
    label: (k) => times[k],
    sampleWith: (k, session) => sampleFrame({ projectJson: alone, projectDir: dirname(projectPath), atSeconds: frames[k] / fps, outPath: outPaths[k], sdrCurve, session }),
    ...(newSession ? { newSession } : {}),
    ...(frameTimeoutMs ? { frameTimeoutMs } : {}),
    lanes: lanesFor(times.length),
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the best available cached file for `src` (audioclean > normalized >
 * as-is). `src` is whatever @bycrux/timeline-core's `sourceWindow` already
 * chose (original / normalizedSrc / nobg_src) — this layers a further,
 * sample-frame-only, read-only cache-freshness check on top of that choice; it
 * never triggers normalization itself.
 */
function resolveVideoSource(src, { sdrOrigin = false } = {}) {
  if (!src) return src
  // Check for _audioclean variant (read-only — don't trigger normalization)
  const audiocleanPath = src.replace(/(\.\w+)$/, '_audioclean.mp4')
  if (existsSync(audiocleanPath)) {
    try {
      const srcStat  = statSync(src)
      const outStat  = statSync(audiocleanPath)
      if (outStat.mtimeMs >= srcStat.mtimeMs) return audiocleanPath
    } catch { /* fall through */ }
  }
  // An SDR-origin layer is shown as authored: its HDR conversion (a
  // _normalized_hdr_* sibling) is only a cache and must never be picked up.
  if (sdrOrigin) return src
  // Check for _normalized_<colorSpace>[_<look>] variants. We don't know the
  // project's colorSpace here, so match by pattern: <stem>_normalized_*.mp4.
  //
  // When a look-tagged sibling (SP6b Task T3 — this master was produced by
  // tone-mapping an HDR source through the Montaj Vivid LUT, see
  // lib.normalize.normalized_output_path) and an untagged one are BOTH fresh,
  // prefer the tagged one. That's the newer naming scheme's output and
  // reflects the current graded master; an untagged sibling passing the same
  // freshness check is exactly the stale-leftover case (pre-T3 file, or a
  // color-space re-detect) this preference exists to route around.
  const srcDir  = dirname(src)
  const srcBase = basename(src, extname(src))
  const knownLooks = curveIds()
  let bestPath = null
  let bestTagged = false
  try {
    for (const name of readdirSync(srcDir)) {
      if (!name.startsWith(srcBase + '_normalized_') || !name.endsWith('.mp4')) continue
      const normPath = join(srcDir, name)
      try {
        const srcStat = statSync(src)
        const outStat = statSync(normPath)
        if (outStat.mtimeMs < srcStat.mtimeMs) continue
      } catch { continue /* skip: stat failed */ }
      const stem = name.slice(0, -'.mp4'.length)
      const tagged = knownLooks.some((look) => stem.endsWith(`_${look}`))
      if (bestPath === null || (tagged && !bestTagged)) {
        bestPath = normPath
        bestTagged = tagged
      }
    }
  } catch { /* directory not readable — fall through */ }
  return bestPath ?? src
}

/** Resolve relative src paths to absolute, mirroring render.js::resolveProjectPaths. */
function resolveProjectPaths(projectJson, projectDir) {
  for (const track of trackItems(projectJson)) {
    for (const item of track ?? []) {
      if (item.src) item.src = resolveProjectSrc(item.src, projectDir)
      // proxySrc is resolved too so the fast-preview path (preferProxy) can
      // reach it; it is full-source (no window/rebase), same as `src`.
      if (item.proxySrc) item.proxySrc = resolveProjectSrc(item.proxySrc, projectDir)
      // Read in place of src, as in render.js (§563).
      for (const field of ['nobg_src', 'normalizedSrc']) {
        if (item[field]) item[field] = resolveDerivedSrc(item[field], projectDir, field)
      }
    }
  }
  for (const track of projectJson.audio?.tracks ?? []) {
    if (track.src) track.src = resolveProjectSrc(track.src, projectDir)
  }
}

/** The source-crop filter for one video item's frame extract, or null when the item has no crop (or not both
 *  source dimensions). The proxy form splices the crop fractions into ffmpeg expressions as text, so each must be
 *  a finite number (§563). */
export function sourceCropFilter(geometry, useProxy) {
  const sc = geometry.sourceCrop
  if (!(sc && geometry.sourceWidth && geometry.sourceHeight)) return null
  if (useProxy) {
    // The proxy is smaller than the master, so a crop in master pixels
    // falls outside it. Same rounding as below, from the decoded size.
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => finiteNumber(sc[k], `sourceCrop.${k}`))
    const cw = `2*round(iw*${w}/2)`   // even: x264 needs even dims
    const ch = `2*round(ih*${h}/2)`
    return `crop=w=${cw}:h=${ch}:x=round(iw*${x}):y=round(ih*${y})`
  }
  const cw = Math.round(geometry.sourceWidth  * sc.w / 2) * 2  // even: x264 needs even dims
  const ch = Math.round(geometry.sourceHeight * sc.h / 2) * 2  // even: x264 needs even dims
  const cx = Math.round(geometry.sourceWidth  * sc.x)          // origin NOT even-rounded
  const cy = Math.round(geometry.sourceHeight * sc.y)          // origin NOT even-rounded
  return `crop=${cw}:${ch}:${cx}:${cy}`
}

/**
 * Where to sample when a requested time may be past the project's end. The
 * visibility test is half-open (start <= t < end), so the last frame is
 * `end - 1/fps`, floored at 0. Times before the end come back unchanged.
 *
 * @returns {{ clamped: boolean, requested: number, at: number, end: number }}
 */
export function clampAtToEnd(at, end, fps = 30) {
  if (!(end > 0) || at < end) return { clamped: false, requested: at, at, end }
  return { clamped: true, requested: at, at: Math.max(0, end - 1 / fps), end }
}

/** Total project duration in seconds. */
function getTotalDurationSeconds(projectJson) {
  // Enabled tracks only, matching render.js — a sampled frame must agree with
  // the export about where the project ends.
  const allItems = enabledTrackItems(projectJson).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map(i => i.end ?? 0))
}

/**
 * Build a content-hash cache key for sampleOverlay.
 *
 * `fontsBaseDir` MUST be part of this key. This cache (CACHE_DIR, above) lives
 * under the system `tmpdir()` — NOT under `$HOME` — with a 24h TTL, and it
 * survives across process invocations: `steps/render/sample_overlay.py` spawns
 * this script fresh per sample rather than importing it, so every sample is a
 * new process hitting the same on-disk cache. Two things follow from that:
 *   1. Sampling the same overlay once with MONTAJ_FONTS_DIR set and once unset
 *      (or set to a different base), within the TTL, must produce DIFFERENT
 *      keys — otherwise the second call gets a cache hit and silently serves a
 *      PNG rendered under the OTHER font configuration.
 *   2. Because the cache directory is outside `$HOME`, this repo's scratch-HOME
 *      QA procedure (see montaj-app's CLAUDE.md) does not isolate it — a prior
 *      Electron-shell run and a later plain-CLI run on the same machine share
 *      this cache and can cross-contaminate silently.
 * So the fonts base's actual VALUE is folded into the hashed input below,
 * exactly like `googleFonts` — not a boolean "was a base set" flag, which
 * would re-collide the moment anyone points it at a second directory.
 *
 * The fold is appended ONLY when `fontsBaseDir` is truthy, rather than always
 * joined in as another `|`-delimited field, so that the unset case (every OSS
 * caller, and every caller before this parameter existed) produces the exact
 * same raw string — and therefore the exact same key — as before this field
 * was added. Existing cache entries for users who never set the var do not go
 * stale. Pinned by test/sample-frame.test.mjs.
 *
 * `version` (SAMPLE_CACHE_VERSION) is appended always. This is the key for the
 * per-overlay PNG, and a frame-key miss re-composites through it, so a bump
 * that reached only `buildFrameCacheKey` would re-serve the old overlay pixels.
 * PV50 changed the render shim, not the user's component, so the component's
 * mtime did not move either. Only the version retires those entries.
 */
function buildOverlayCacheKey(componentPath, props, frame, width, height, googleFonts, measure, durationFrames, fontsBaseDir = '',
                              version = SAMPLE_CACHE_VERSION) {
  let mtime = '0'
  try { mtime = String(statSync(componentPath).mtimeMs) } catch {}
  const raw = [
    `${componentPath}:${mtime}`,
    JSON.stringify(props),
    String(frame),
    String(width),
    String(height),
    googleFonts.join(','),
    measure ? 'measure' : '',
    String(durationFrames),
  ].join('|') + (fontsBaseDir ? `|fontsBaseDir:${fontsBaseDir}` : '') + `|sample-v${version}`
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Absolute, deduplicated, sorted `path:mtimeMs` entries for every
 * `type: "overlay"` item's `src` in the project — the component
 * `buildFrameCacheKey` was missing (T6, 2026-09-27 motion-film-craft plan).
 *
 * Uses `trackItems(project)` — the same shape-tolerant iterator
 * `resolveProjectPaths` uses below — so object-shape and array-shape `tracks`
 * both work. A relative `src` is resolved against `dirname(projectPath)`,
 * mirroring `resolveProjectPaths`'s own rebase; when no `projectPath` was
 * given (the caller passed a parsed project object directly, as several
 * existing tests and RenderModal-style previews do) there is no directory to
 * resolve a relative path against, so only an already-absolute `src`
 * resolves to a real file — a relative one, and any path that no longer
 * exists, falls through to the `0` below rather than throwing. That
 * degrades a bad/missing path to "always a cache miss", not a crash.
 *
 * @param {object} project
 * @param {string | null} projectPath
 * @returns {string} sorted, comma-joined `path:mtimeMs` entries (empty string
 *   when the project has no overlay items)
 */
function overlaySourceCacheComponent(project, projectPath) {
  const projectDir = projectPath ? dirname(projectPath) : null
  const paths = new Set()
  for (const track of trackItems(project)) {
    for (const item of track ?? []) {
      if (item?.type !== 'overlay' || !item.src) continue
      paths.add(
        item.src.startsWith('/')
          ? item.src
          : (projectDir ? resolve(projectDir, item.src) : item.src),
      )
    }
  }
  return [...paths].sort().map(p => {
    let mtime = '0'
    try { mtime = String(statSync(p).mtimeMs) } catch {}
    return `${p}:${mtime}`
  }).join(',')
}

/**
 * Build a content-hash cache key for sampleFrame.
 *
 * Folds in every overlay item's resolved `src` mtime (see
 * `overlaySourceCacheComponent`, immediately above) so that editing an
 * overlay JSX — without touching `project.json` itself — busts this key
 * instead of serving a stale cached PNG for up to `CACHE_TTL_MS` (24h). Before
 * this fix, only `project.json`'s own mtime (or, with no `projectPath`, its
 * JSON) was hashed, and `sampleFrame` returns the cached PNG **before** it
 * ever reaches the per-overlay `sampleOverlay` calls — so a re-sample after
 * editing only the overlay JSX served yesterday's pixels for a day, which
 * breaks visual verification and lets a stale frame fool `sample_diff`'s pop
 * scan. Adding this component changes every existing cache entry's key, so
 * previously-cached frames become one-time misses; that's acceptable — this
 * cache is a same-machine speed optimization, not a correctness dependency.
 *
 * Deliberately out of scope, same as before this fix: image/video item `src`
 * edits and `MONTAJ_FONTS_DIR` are still absent from this key (see
 * `buildOverlayCacheKey`'s own doc comment for why fonts base belongs in the
 * per-overlay-render key instead).
 */
function buildFrameCacheKey(projectPath, project, atSeconds, sdrCurve = null, preferProxy = false,
                            version = SAMPLE_CACHE_VERSION, maxShortEdge = null, noCaptions = false) {
  let mtime = '0'
  if (projectPath) {
    try { mtime = String(statSync(projectPath).mtimeMs) } catch {}
  } else {
    mtime = JSON.stringify(project)
  }
  const colorSpace = project?.settings?.colorSpace ?? 'sdr_bt709'
  const overlaySources = overlaySourceCacheComponent(project, projectPath)
  // Salted with the resolver's own version so a semantic change in
  // @bycrux/timeline-core (e.g. this T9 alignment) invalidates any frame cached
  // by the pre-alignment logic instead of silently serving it back.
  //
  // MASTER_LOOK and the requested curve are in the key for the same reason
  // (SP6b decision 10): the PNG's colors come out of a .cube, so a look bump —
  // or two curves sampled at the same timestamp for the RenderModal's
  // side-by-side thumbnails — must not collide. Without them a LUT change would
  // serve the pre-change frame back forever, since nothing else in the key
  // moves when the manifest does.
  const raw = [RESOLVER_VERSION, `sample-v${version}`, mtime, String(atSeconds), colorSpace,
               MASTER_LOOK, sdrCurve ?? MASTER_LOOK, preferProxy ? 'proxy' : 'master',
               overlaySources, ...(maxShortEdge ? [`short-${maxShortEdge}`] : []), ...(noCaptions ? ['no-captions'] : [])].join('|')
  return createHash('sha256').update(raw).digest('hex')
}

/** Scan cache dir and delete entries older than CACHE_TTL_MS. Safe to fail silently. */
function gcCache() {
  try {
    if (!existsSync(CACHE_DIR)) return
    const now = Date.now()
    for (const name of readdirSync(CACHE_DIR)) {
      try {
        const full = join(CACHE_DIR, name)
        const st   = statSync(full)
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          rmSync(full, { force: true })
        }
      } catch { /* skip */ }
    }
  } catch { /* permissions issue — don't break sampling */ }
}

/** Deep-clone a JSON-serializable object. */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/** Hex random string for temp file names. */
function randomHex() {
  return Math.random().toString(16).slice(2, 10)
}

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj sample]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

// Exported purely for unit testing (no ffmpeg/puppeteer involved) — mirrors
// render.js's bottom export list for its own filesystem-only helpers.
// buildFrameCacheKey is here so the look/curve components (SP6b decision 10)
// can be asserted directly: proving it through rendered pixels only works for
// colors where two cubes happen to disagree, which is not a property a cache
// test should depend on. buildOverlayCacheKey is here for the same reason,
// for its fontsBaseDir component: two different bases render pixel-identical
// text in this test's fixtures (no fonts.css asset to actually diverge on),
// so the property under test — different key for different base, same key
// for unset vs. the pre-fontsBaseDir key — has to be asserted on the key
// itself, not inferred from rendered output.
/**
 * Whether `--prefer-proxy` decodes the item's proxy. Never for a cutout
 * (remove_bg + nobg_src): the proxy still has the background the render removes.
 * Costs a heavier decode (ProRes 4444 alpha) on those items; correctness wins.
 */
function shouldUseProxy(item, preferProxy, exists) {
  if (!preferProxy || !item.proxySrc) return false
  if (item.remove_bg && item.nobg_src) return false
  return !!exists(item.proxySrc)
}

/**
 * The topmost video item of a resolved scene (the one the picture shows, by the
 * editor's track order), or null. Pure: the raw sampler's source choice.
 */
export function pickRawVideo(items, layerOf = {}) {
  const videos = items.filter(ri => ri.kind === 'video')
  if (!videos.length) return null
  const layer = ri => layerOf[ri.trackIdx] ?? ri.trackIdx
  return videos.reduce((top, ri) => (layer(ri) >= layer(top) ? ri : top))
}

/** Source seconds under timeline time `at` for a clip, in its own file's coordinates. */
export function rawSeekSeconds(item, at) {
  return Math.max(0, (item.inPoint ?? 0) + (item.speed ?? 1) * Math.max(0, at - item.start))
}

/**
 * RAW sample: the untouched SOURCE frame under the playhead. Same clip choice as
 * sampleFrame (resolveAt, topmost video), but the clip's ORIGINAL file is decoded
 * directly with ffmpeg: no crop, zoom/transform, fit, grade, images, overlays or
 * captions, and no browser. Source resolution and colour as stored (an HDR source
 * is not tone-mapped). With no video at `atSeconds` the frame is black at project size.
 */
export async function sampleRawFrame({ projectJson, atSeconds, outPath, clampToEnd = false, projectDir: projectDirOpt = null }) {
  if (!outPath) throw new Error('outPath is required')
  if (atSeconds == null) throw new Error('atSeconds is required')
  let projectPath = null
  let project = projectJson
  if (typeof projectJson === 'string') {
    projectPath = resolve(projectJson)
    if (!existsSync(projectPath)) throw new Error(`project.json not found: ${projectPath}`)
    project = JSON.parse(readFileSync(projectPath, 'utf8'))
  }
  const projectDir = projectPath ? dirname(projectPath) : projectDirOpt
  const resolved = deepClone(project)
  if (projectDir) resolveProjectPaths(resolved, projectDir)
  const fps = resolved.settings?.fps ?? 30
  if (clampToEnd) atSeconds = clampAtToEnd(atSeconds, getTotalDurationSeconds(resolved), fps).at
  const total = getTotalDurationSeconds(resolved)
  if (total > 0 && atSeconds > total) throw new Error(`Requested timestamp ${atSeconds} is past project end ${total}`)

  const scene = resolveAt(withEnabledItemTracks(resolved), atSeconds, { variant: 'render' })
  const ri = pickRawVideo(scene.items, trackLayerPositions(trackItems(resolved)))
  mkdirSync(dirname(outPath), { recursive: true })
  let args
  if (ri && ri.item.src) {
    const seek = rawSeekSeconds(ri.item, atSeconds)
    const fast = Math.max(0, seek - SEEK_PREROLL_S)
    log(`raw: decoding ${basename(ri.item.src)} at source t=${seek.toFixed(3)}s`)
    args = ['-y', '-v', 'error', ...(Number(ffSeconds(fast)) > 0 ? ['-ss', ffSeconds(fast)] : []),
      '-i', ri.item.src, '-ss', ffSeconds(seek - fast), '-frames:v', '1', '-update', '1', outPath]
  } else {
    const [w, h] = resolved.settings?.resolution ?? [1080, 1920]
    log('raw: no video under this time, writing a black frame')
    args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${frameSize(w, h)}`, '-frames:v', '1', '-update', '1', outPath]
  }
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg raw frame extract failed: ${ffmpegErrorTail(r.stderr)}`)
  return { pngPath: outPath }
}


export { shouldUseProxy, resolveVideoSource, buildFrameCacheKey, buildOverlayCacheKey, SAMPLE_CACHE_VERSION }

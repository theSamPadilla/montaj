// render/segment-cache.js
/**
 * A re-export reuses the 3D chunks it already encoded (ea and Sam, 2026-11-15). An export of 73 3D shots takes the
 * better part of an hour, and a Mac that sleeps or a render that is stopped used to throw all of it away: Export again
 * started from zero. Now every 3D chunk that encodes is kept, keyed on its inputs, and the next export renders only
 * the chunks whose inputs changed or that were never finished. That is also how an export resumes.
 *
 * Only 3D chunks (memory.js isScene3dSegment). Captions, titles and 2D overlays are cheap to capture and change
 * often, so they never touch the cache.
 *
 * WHERE. `<project>/render/segment-cache/`, inside the project folder, so deleting the project deletes it. render.js
 * wipes `render/segments/` at every start; this folder is never wiped with it, nor by a disk-full failure.
 *
 * ENTRIES. One per 3D chunk: `<key>.mkv` (the chunk's FFV1, exactly as renderer.js renderChunk encoded it) and
 * `<key>.json` (its manifest: the key, its frame count, the stream ffprobe found in it when it was kept, its read set,
 * and the key's fields for whoever debugs a miss). An entry without a manifest is not an entry. Writes are atomic: the
 * chunk is cloned in as `<key>.mkv.tmp.<pid>` (COPYFILE_FICLONE, which shares the blocks on APFS) and renamed, then the
 * manifest is written the same way, last. A write that fails (a full disk) is one log line, never a failed render.
 *
 * THE KEY. sha256 of the canonical JSON (keys sorted) of keyFields(job):
 *   1. `version`: SEGMENT_CACHE_VERSION.
 *   2. `render`: this package's version (package.json).
 *      `engine`: the engine itself (engineFingerprint): a digest of this folder's own .js, package.json and
 *      package-lock.json (which pins puppeteer, and so Chrome) and of timeline-core's source, the ffmpeg version line,
 *      PUPPETEER_EXECUTABLE_PATH and MONTAJ_RENDER_SOFTWARE_3D. The package version is not bumped with every engine
 *      change (5.37.0 under montaj 5.40.1 when this was written), so on its own it would let an engine that captures
 *      differently reuse an older engine's chunks.
 *   3. `page`: the sha256 of the generated page, bundle.js and index.html, with the bundle's random work dir
 *      (`montaj-bundle-<id>`, and the whole path that ends in it) replaced by a fixed token (pageDigest).
 *   4. `source`: the sha256 of the component's source file; `stage`: of MONTAJ_SCENE3D_STAGE's file when the segment
 *      is a stage (`scene3d`).
 *   5. `props`: the sha256 of the props as canonical JSON.
 *   6. `capture`: every job field the capture and encode read (renderer.js renderChunk, captureChunkFrames,
 *      chunkEncodeArgs, captureOptionsFor, screenshotOptionsFor, blursInPage, keyframesSteady, frameSteady,
 *      hiddenFrames; motion-blur.js frameTimes and shutterOf): fps, width, height, captureScale, offsetX, offsetY,
 *      scale, scaleX, scaleY, rotation, opacity, keyframes, opaque, transitionTo, fades, sdrMaster, scene3d, subframes
 *      (the motion blur), shutter, frameCount and isCaption. `colorSpace` (the project's, from render.js) sits beside
 *      them. Left out on purpose, since they never change a pixel of the capture: id, outputPath, chunkIndex,
 *      totalChunks, startSeconds and endSeconds (a shot moved in time or renamed is still the same capture), and
 *      `threads` (FFV1 is lossless, and its stream parameters do not follow the thread count: MEASURED 2026-11-15,
 *      ffmpeg 8.1.2, 1920x1080 yuva420p, -threads 1 and 8 give the same extradata).
 *   7. `frames`: the chunk's frame range (frameStart, frameEnd). The segment's window (frameFrom, frameTo, which a
 *      sliced render sets) is not in the key: capture reads only the range, and renderer.js chunkJobs cuts a 3D
 *      segment on its own chunk grid, so a different slice plan reuses the same interior chunks.
 *
 * THE BUMP RULE. Bump SEGMENT_CACHE_VERSION whenever capture or encode output can change for the same inputs, in a way
 * the engine digest cannot see: a change outside this folder and timeline-core's source (an overlay-runtime change is
 * inside the page, so the page digest sees it), a new input the key does not hold, or a change to what an entry is.
 * A miss costs one re-render; a wrong hit puts a stale shot in a finished film.
 *
 * THE READ SET (read-set.js). What the page read while the chunk rendered, stored in the manifest and checked before a
 * reuse. Any change is a miss, and the stale entry is deleted.
 *
 * VALIDITY ON REUSE. ffprobe finds a video stream with as many packets as the chunk has frames, FFV1, the pix_fmt
 * captureOptionsFor gives the job, and the size the manifest recorded from the fresh chunk (within a pixel of the
 * design canvas times captureScale). Anything else is a miss, and the entry is deleted.
 *
 * PRUNING (ea, D1: a project holds at most one export's worth; Bunker's 73 shots are about 3.5 GB on a tight disk).
 * begin(jobs), once every 3D chunk's key is known and before any chunk runs, deletes every entry, and every stray
 * file, not among those keys. end(), when the export ends, done or failed, deletes every entry the export neither
 * reused nor wrote. An export that stops before begin() leaves the cache as it was.
 */
import {
  constants, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'fs'
import os from 'os'
import { basename, dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { isScene3dSegment } from './memory.js'
import { shutterOf } from './motion-blur.js'
import { SCENE3D_STAGE_ENV } from './scene3d.js'
import { softwareAllowed } from './gpu-3d.js'
import { FFMPEG } from './ffmpeg-bin.js'
import { assertSegmentHasVideo, probeSegmentStreams } from './segment-check.js'
import { captureOptionsFor, chunkLabel } from './renderer.js'
import { checkReads, fileSha256, readStat, sealReads, sha256Of } from './read-set.js'

/** Bump whenever capture or encode output can change for the same inputs (the bump rule above). */
export const SEGMENT_CACHE_VERSION = 1

/** The cache's folder under a project's `render/` folder. */
export const SEGMENT_CACHE_DIR = 'segment-cache'

const HERE = dirname(fileURLToPath(import.meta.url))

/** This render package's version (package.json), key item 2. */
export const RENDER_PACKAGE_VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version

// An entry's two files. Anything else in the folder (a `.tmp.<pid>` a stopped write left) is not an entry.
const ENTRY_FILE = /^([0-9a-f]{64})\.(mkv|json)$/

/** JSON with every object's keys sorted, so equal values give equal text. An undefined field is left out, as JSON does. */
export function canonicalJson(value) {
  return JSON.stringify(sorted(value)) ?? 'null'
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const k of Object.keys(value).sort()) out[k] = sorted(value[k])
  return out
}

// ---------------------------------------------------------------------------
// Key item 3: the page
// ---------------------------------------------------------------------------

/** What every path ending in the bundle's own work dir is replaced with before the page is hashed. */
export const WORK_DIR_TOKEN = '<montaj-bundle>'
// The characters a path in the bundle's text never runs across (esbuild's `// <path>` comments, a quoted string).
const PATH_STOP = new Set([' ', '\t', '\n', '\r', '"', "'", '`', '(', ')', '<', '>', '=', ',', ';'])

/**
 * `text` with each path that ends in `workDirName` (`montaj-bundle-<id>`: esbuild writes the shim's path, relative to
 * the engine's folder, into the bundle's comments) replaced by WORK_DIR_TOKEN, the whole path, so neither the random
 * id nor where TMPDIR is reaches the digest. Linear: each path is walked back only as far as the last match.
 */
export function withoutWorkDir(text, workDirName) {
  if (!workDirName) return text
  let out = ''
  let from = 0
  for (let i = text.indexOf(workDirName); i !== -1; i = text.indexOf(workDirName, from)) {
    let start = i
    while (start > from && !PATH_STOP.has(text[start - 1])) start--
    out += text.slice(from, start) + WORK_DIR_TOKEN
    from = i + workDirName.length
  }
  return out + text.slice(from)
}

const pageMemo = new Map()

/**
 * The sha256 of an overlay's generated page (bundle.js bundleComponent): its index.html and bundle.js, each with the
 * bundle's random work dir taken out (withoutWorkDir). null when either cannot be read. Remembered by path and stat:
 * a page is hashed once per render however many chunks it has (a 3D page's bundle is about 12 MB).
 */
export function pageDigest(htmlPath) {
  if (typeof htmlPath !== 'string' || htmlPath.length === 0) return null
  const dir = dirname(htmlPath)
  const files = [htmlPath, join(dir, 'bundle.js')]
  const stats = files.map((f) => readStat(f))
  if (stats.some((st) => st.missing || st.notFile)) return null
  const memo = JSON.stringify([htmlPath, stats])
  if (pageMemo.has(memo)) return pageMemo.get(memo)
  // Only bundleComponent's own dirs are named for a random id; any other is left as it is.
  const name = basename(dir)
  const workDirName = name.startsWith('montaj-bundle-') ? name : null
  let digest = null
  try {
    const hash = createHash('sha256')
    for (const f of files) hash.update(withoutWorkDir(readFileSync(f, 'utf8'), workDirName)).update('\0')
    digest = hash.digest('hex')
  } catch {
    digest = null
  }
  pageMemo.set(memo, digest)
  return digest
}

// ---------------------------------------------------------------------------
// Key item 2: the engine
// ---------------------------------------------------------------------------

let engineMemo = null

/**
 * What the engine is, beside its package version: the digest of its own source (this folder's .js files,
 * package.json and package-lock.json, timeline-core's src), the ffmpeg that encodes, the Chrome puppeteer was pointed
 * at, and whether 3D draws in software. Once per process.
 */
export function engineFingerprint() {
  if (engineMemo) return engineMemo
  const hash = createHash('sha256')
  const sources = [
    [HERE, (n) => n.endsWith('.js') || n === 'package.json' || n === 'package-lock.json'],
    [join(HERE, '..', 'timeline-core', 'src'), (n) => n.endsWith('.js')],
  ]
  for (const [dir, wanted] of sources) {
    let names = []
    try { names = readdirSync(dir).filter(wanted).sort() } catch { names = [] }
    for (const n of names) {
      try { hash.update(n).update('\0').update(readFileSync(join(dir, n))).update('\0') } catch {}
    }
  }
  const ffmpeg = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8', timeout: 15_000 })
  engineMemo = {
    source: hash.digest('hex'),
    ffmpeg: ffmpeg.status === 0 ? String(ffmpeg.stdout).split('\n')[0].trim() : null,
    chrome: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    software3d: softwareAllowed(),
    os: `${process.platform} ${os.release()} ${process.arch}`,
  }
  return engineMemo
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** The sha256 of a source file, or null when it cannot be read. */
function sourceDigest(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const st = readStat(path)
  if (st.missing || st.notFile) return null
  try { return fileSha256(path, st) } catch { return null }
}

const propsMemo = new WeakMap()
function propsDigest(props) {
  if (props === null || typeof props !== 'object') return sha256Of(canonicalJson(props ?? {}))
  if (!propsMemo.has(props)) propsMemo.set(props, sha256Of(canonicalJson(props)))
  return propsMemo.get(props)
}

const orNull = (v) => (v === undefined ? null : v)

/**
 * The fields a chunk's key hashes (the header's seven items), or null when the job cannot be keyed: a page, source or
 * stage that cannot be read, or no whole frame range. Such a job is never reused nor kept.
 *
 * @param {object} job  a planChunks job: a bundled segment spec plus frameStart, frameEnd, subframes
 * @param {{ engine?: object, context?: { colorSpace?: string }, env?: object, version?: number }} [opts]
 */
export function keyFields(job, { engine = engineFingerprint(), context = {}, env = process.env, version = SEGMENT_CACHE_VERSION } = {}) {
  const { frameStart, frameEnd } = job
  if (!Number.isInteger(frameStart) || !Number.isInteger(frameEnd) || frameEnd <= frameStart) return null
  const page = pageDigest(job.htmlPath)
  const source = sourceDigest(job.componentPath)
  if (!page || !source) return null
  if (job.cinematic === true && !job.cinematicKey) return null   // 3D36: never cached without its host's key
  const stagePath = job.scene3d === true ? (env[SCENE3D_STAGE_ENV] || null) : null
  const stage = stagePath ? sourceDigest(stagePath) : null
  if (stagePath && !stage) return null
  return {
    version,
    render: RENDER_PACKAGE_VERSION,
    engine,
    colorSpace: orNull(context.colorSpace),
    page,
    source,
    stage,
    props: propsDigest(job.props),
    // 3D36: a cinematic chunk carries its host's key (renderer, version, samples, denoise, look: scene3d-host.js), so
    // one rendered at another quality or by another renderer is never reused. Absent otherwise: existing keys unchanged.
    ...(job.cinematic === true ? { cinematic: job.cinematicKey } : {}),
    capture: {
      fps: orNull(job.fps),
      width: orNull(job.width),
      height: orNull(job.height),
      captureScale: job.captureScale ?? 2,
      offsetX: job.offsetX ?? 0,
      offsetY: job.offsetY ?? 0,
      scale: job.scale ?? 1,
      scaleX: orNull(job.scaleX),
      scaleY: orNull(job.scaleY),
      rotation: job.rotation ?? 0,
      opacity: job.opacity ?? 1,
      keyframes: job.keyframes?.length ? job.keyframes : null,
      opaque: !!job.opaque,
      transitionTo: job.transitionTo === true,
      fades: job.fades === true,
      sdrMaster: job.sdrMaster === true,
      scene3d: job.scene3d === true,
      subframes: job.subframes ?? 1,
      shutter: shutterOf(job),
      frameCount: orNull(job.frameCount),
      isCaption: job.isCaption === true,
    },
    frames: [frameStart, frameEnd],
  }
}

/** The key of keyFields' fields: sha256 of their canonical JSON. null for null. */
export function cacheKey(fields) {
  return fields ? sha256Of(canonicalJson(fields)) : null
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

/**
 * null when `streams` (probeSegmentStreams) are what a fresh chunk of `job` is, else why not: a video stream with one
 * packet per frame of the chunk, FFV1, captureOptionsFor's pix_fmt, and the capture's size (the design canvas times
 * captureScale, within a pixel: Chrome rounds a fractional scale). `kept`, on a reuse, is the stream the manifest
 * recorded from the fresh chunk, whose size must match exactly.
 */
export function streamProblem(streams, job, kept = null) {
  const v = (streams ?? []).find((s) => s.codec_type === 'video')
  if (!v) return 'it has no video stream'
  const frames = job.frameEnd - job.frameStart
  const packets = Number(v.nb_read_packets)
  if (packets !== frames) return `it holds ${Number.isFinite(packets) ? packets : 0} of its ${frames} frames`
  if (v.codec_name !== 'ffv1') return `its codec is ${v.codec_name}, not ffv1`
  const pixFmt = captureOptionsFor(job).pixFmt
  if (v.pix_fmt !== pixFmt) return `its pixel format is ${v.pix_fmt}, not ${pixFmt}`
  const scale = job.captureScale ?? 2
  const w = job.width * scale
  const h = job.height * scale
  if (!(Math.abs(v.width - w) <= 1 && Math.abs(v.height - h) <= 1)) return `its size is ${v.width}x${v.height}, not ${w}x${h}`
  if (kept && (v.width !== kept.width || v.height !== kept.height)) return `its size is ${v.width}x${v.height}, not the ${kept.width}x${kept.height} it was kept at`
  return null
}

/** The chunk's place on the timeline, seconds, for assertSegmentHasVideo's message. */
function spanOf(job) {
  const at = Number(job.startSeconds) || 0
  const fps = Number(job.fps) || 30
  return { start: at + job.frameStart / fps, end: at + job.frameEnd / fps }
}

/** rmSync that never throws (a path under a file, a permission): the cache never fails a render. */
function removeQuietly(path) {
  try { rmSync(path, { recursive: true, force: true }) } catch {}
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0]

/** A copy that shares the blocks where the volume can (APFS), else a plain copy. */
function cloneFile(from, to) {
  try {
    copyFileSync(from, to, constants.COPYFILE_FICLONE)
  } catch (err) {
    if (err?.code === 'ENOSPC') throw err
    removeQuietly(to)
    copyFileSync(from, to)
  }
}

const TTY = process.stderr.isTTY
const defaultLog = (msg) => process.stderr.write(`${TTY ? '\x1b[96m' : ''}[montaj render]${TTY ? '\x1b[0m' : ''} ${msg}\n`)

// ---------------------------------------------------------------------------
// One export's cache
// ---------------------------------------------------------------------------

/**
 * One export's view of a project's segment cache. render.js opens it, calls begin() with every 3D chunk the export
 * will run, hands it to renderAllSegments (`config.segmentCache`), which calls lookup() for each 3D job before any
 * browser launches and store() for each 3D chunk that encodes, and calls end() when the export ends, done or failed.
 *
 * @param {object} opts
 * @param {string} opts.dir  `<project>/render/segment-cache`
 * @param {{ colorSpace?: string }} [opts.context]  the export's facts every key holds
 * @param {(msg: string) => void} [opts.log]
 * @param {(file: string) => object[]} [opts.probe]  probeSegmentStreams, or a test's stand-in
 * @param {object} [opts.engine]  engineFingerprint(), or a test's stand-in
 * @param {object} [opts.env]  where MONTAJ_SCENE3D_STAGE is read
 * @param {number} [opts.minFreeBytes]  a chunk is kept only while the disk would still have this much free after it
 * @param {(dir: string) => number} [opts.freeBytes]  the free bytes of `dir`'s disk, or a test's stand-in
 */
export function openSegmentCache({ dir, context = {}, log = defaultLog, probe = probeSegmentStreams, engine = null, env = process.env,
  minFreeBytes = 0, freeBytes = (d) => { const s = statfsSync(d); return s.bavail * s.bsize },
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('openSegmentCache: a dir is required')
  const mkvOf = (key) => join(dir, `${key}.mkv`)
  const jsonOf = (key) => join(dir, `${key}.json`)
  const keys = new WeakMap()   // job -> { fields, key }
  const checked = new Map()    // key -> the hit this export validated, or null
  const kept = new Set()       // keys this export reuses
  const written = new Set()    // keys this export wrote
  let begun = false
  let ended = false

  const fieldsOf = (job) => {
    if (!keys.has(job)) {
      const fields = keyFields(job, { engine: engine ??= engineFingerprint(), context, env })
      keys.set(job, { fields, key: cacheKey(fields) })
    }
    return keys.get(job)
  }

  /** A 3D job's key, or null: a 2D job, or one that cannot be keyed. */
  const keyOf = (job) => {
    if (!isScene3dSegment(job)) return null
    try { return fieldsOf(job).key } catch { return null }
  }

  // The manifest first: a stop in between leaves a bare .mkv, which is not an entry.
  const removeEntry = (key) => {
    removeQuietly(jsonOf(key))
    removeQuietly(mkvOf(key))
  }

  /**
   * Deletes every file in the folder that is not an entry of `keep` (a kept key's .mkv with no manifest, or manifest
   * with no .mkv, is not an entry either); returns how many files went.
   */
  const prune = (keep) => {
    let names
    try { names = readdirSync(dir) } catch { return 0 }
    const present = new Set(names)
    let gone = 0
    for (const name of names) {
      const m = ENTRY_FILE.exec(name)
      if (m && keep.has(m[1]) && present.has(`${m[1]}.json`) && present.has(`${m[1]}.mkv`)) continue
      removeQuietly(join(dir, name))
      gone++
    }
    return gone
  }

  /** The entry of `key` if it is valid for `job`; a stale one is deleted, and why is logged. */
  const validate = (key, job) => {
    const stale = (why) => {
      log(`segment cache: ${chunkLabel(job)} not reused (${why})`)
      removeEntry(key)
      return null
    }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(jsonOf(key), 'utf8'))
    } catch (err) {
      // No manifest, no entry: a bare .mkv a stopped write left is removed.
      if (err?.code === 'ENOENT') { removeQuietly(mkvOf(key)); return null }
      return stale('its manifest cannot be read')
    }
    if (manifest?.version !== SEGMENT_CACHE_VERSION || manifest.key !== key) return stale('its manifest is not this key\'s')
    // A manifest with no read set or no stream is never taken for an empty one.
    const r = manifest.reads
    if (!r || !['files', 'props', 'blocked'].every((k) => Array.isArray(r[k])) || !manifest.stream) return stale('its manifest is incomplete')
    if (manifest.frames !== job.frameEnd - job.frameStart) return stale('its frame count is not this chunk\'s')
    let st
    try { st = statSync(mkvOf(key)) } catch { return stale('its file is gone') }
    const changed = checkReads(manifest.reads, job)
    if (changed) return stale(changed)
    let streams
    try { streams = probe(mkvOf(key)) } catch { return stale('ffprobe cannot read it') }
    const bad = streamProblem(streams, job, manifest.stream)
    if (bad) return stale(bad)
    return { path: mkvOf(key), size: st.size, mtimeMs: st.mtimeMs, manifest }
  }

  /** A hit begin() validated is used later (a sliced render's later slice): its file and reads are looked at again. */
  const stillValid = (hit, job) => {
    let st
    try { st = statSync(hit.path) } catch { return 'its file is gone' }
    if (st.size !== hit.size || st.mtimeMs !== hit.mtimeMs) return 'its file changed'
    return checkReads(hit.manifest.reads, job)
  }

  /** lookup()'s work, which may throw: lookup() makes anything unexpected a miss. */
  const lookupJob = (job) => {
    const key = keyOf(job)
    if (!key) return null
    let hit = checked.get(key)
    if (hit === undefined) {
      hit = validate(key, job)
    } else if (hit) {
      const why = stillValid(hit, job)
      if (why) {
        log(`segment cache: ${chunkLabel(job)} not reused (${why})`)
        removeEntry(key)
        hit = null
      }
    }
    checked.set(key, hit)
    if (!hit) return null
    kept.add(key)
    return hit.path
  }

  /** store()'s work, which may throw: store() makes anything unexpected one log line. */
  const storeJob = (job, file, reads, extra = {}) => {
    const key = keyOf(job)
    if (!key) return false
    const label = chunkLabel(job)
    const sealed = sealReads(reads, job)
    if (sealed.why) { log(`segment cache: ${label} not kept (${sealed.why})`); return false }
    const streams = assertSegmentHasVideo(file, spanOf(job), { probe })
    const bad = streamProblem(streams, job)
    if (bad) { log(`segment cache: ${label} not kept (${bad})`); return false }
    const v = streams.find((s) => s.codec_type === 'video')
    const mkv = mkvOf(key)
    const json = jsonOf(key)
    const tmpMkv = `${mkv}.tmp.${process.pid}`
    const tmpJson = `${json}.tmp.${process.pid}`
    try {
      mkdirSync(dir, { recursive: true })
      let low = false
      try { low = freeBytes(dir) - statSync(file).size < minFreeBytes } catch { low = false }
      if (low) { log(`segment cache: ${label} not kept (the disk is low)`); return false }
      // Any older manifest goes first, so the new .mkv is never paired with it.
      rmSync(json, { force: true })
      cloneFile(file, tmpMkv)
      renameSync(tmpMkv, mkv)
      const st = statSync(mkv)
      const manifest = {
        version: SEGMENT_CACHE_VERSION,
        key,
        label,
        frames: job.frameEnd - job.frameStart,
        bytes: st.size,
        stream: { codec_name: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt, nb_read_packets: Number(v.nb_read_packets) },
        reads: sealed.reads,
        fields: fieldsOf(job).fields,
        // A cinematic chunk's camera cuts (segment frames): a reused chunk still gives its segment's filter its shots.
        ...(Array.isArray(extra?.cuts) ? { cuts: extra.cuts.filter(Number.isFinite) } : {}),
      }
      writeFileSync(tmpJson, JSON.stringify(manifest))
      renameSync(tmpJson, json)
      written.add(key)
      checked.set(key, { path: mkv, size: st.size, mtimeMs: st.mtimeMs, manifest })
      return true
    } catch (err) {
      removeQuietly(tmpMkv)
      removeQuietly(tmpJson)
      throw err
    }
  }

  const session = {
    dir,
    keyOf,

    /**
     * Before any chunk runs: every 3D job's key (`jobs`: the export's whole chunk plan, every slice of a sliced
     * render), every entry and stray not among them deleted, and each entry among them looked up, so the ones that
     * are valid stay this export's even if it stops before it reaches them. Returns `{ hits, keys }`.
     */
    begin(jobs) {
      const current = new Map()
      for (const job of jobs) {
        const key = keyOf(job)
        if (key && !current.has(key)) current.set(key, job)
      }
      begun = true
      const removed = prune(new Set(current.keys()))
      let hits = 0
      for (const job of current.values()) if (session.lookup(job)) hits++
      if (current.size > 0 || removed > 0) {
        log(`segment cache: ${hits} of ${current.size} 3d chunk(s) can be reused${removed ? `, ${removed} old file(s) removed` : ''}`)
      }
      return { hits, keys: current.size }
    },

    /**
     * The cached chunk to use in place of rendering `job`, or null: a 2D job, a miss, or an entry that went stale.
     * Never throws: anything unexpected is a miss.
     */
    lookup(job) {
      try {
        return lookupJob(job)
      } catch (err) {
        log(`segment cache: ${chunkLabel(job)} not reused (${firstLine(err)})`)
        return null
      }
    },

    /**
     * The camera cuts (segment frames) the entry this export uses for `job` was stored with, or null: none kept (an
     * older entry), a 2D job or a miss. Never throws.
     */
    cutsOf(job) {
      try {
        const key = keyOf(job)
        const hit = key ? checked.get(key) : null
        return hit && Array.isArray(hit.manifest?.cuts) ? hit.manifest.cuts : null
      } catch {
        return null
      }
    },

    /**
     * Keeps a 3D chunk that encoded (`file`, renderChunk's MKV) with its read set (`reads`, renderChunk's; none is an
     * empty set), and `extra.cuts`, a cinematic chunk's camera cuts. Returns whether it was kept. Never throws: a
     * chunk that cannot be kept, or a write that fails (a full disk), is one log line.
     */
    store(job, file, reads, extra) {
      try {
        return storeJob(job, file, reads, extra)
      } catch (err) {
        log(`segment cache: could not keep ${chunkLabel(job)} (${firstLine(err)})`)
        return false
      }
    },

    /**
     * When the export ends, done or failed: every file of an entry it neither reused nor wrote is deleted, and any
     * stray. Once; nothing before begin(). Returns how many files went.
     */
    end() {
      if (!begun || ended) return 0
      ended = true
      const removed = prune(new Set([...kept, ...written]))
      if (removed > 0) log(`segment cache: ${removed} unused file(s) removed`)
      return removed
    },
  }
  return session
}

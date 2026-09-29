// render/sdr-layer.js
/**
 * The SDR output's view of one video item: the ONLY place render.js's SDR pass
 * and sample-frame.js decide WHETHER a layer is graded. lib/color_provenance.py
 * is its twin; tests/fixtures/color_provenance_cases.json keeps them equal (both
 * test suites run every case in it).
 *
 * Provenance is data, and the datum is `src`: the file the user brought in. An
 * SDR clip converted into the HDR working space is a cache in `normalizedSrc`,
 * never a new `src`. When a converted file ends up in `src` anyway, the
 * container comment lib/normalize.py writes into it (SDR_ORIGIN_MARKER + the
 * original's basename) still names where it came from.
 *
 * probe(path) -> { transfer, comment, width, height, fps, duration }
 *   (width and height are display dims, after rotation; fps is the
 *   r_frame_rate string, e.g. '30000/1001'). `duration` is the container's
 *   (`format=duration`), not the stream's: stream duration is N/A in
 *   Matroska/WebM, and normalize carries every stream, so container against
 *   container is like for like (ScreenRecording 36.652 vs 36.631, inside
 *   tolerance). The failure shape ('unknown' / '' / null) means only "no file
 *   there": a file that exists and cannot be probed throws ProbeError, because
 *   every answer this module could give for it picks a grade.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { FFPROBE } from './ffmpeg-bin.js'
import { detectFromTransfer, isHdr } from './color-space.js'

/** Keep identical to lib/normalize.py's SDR_ORIGIN_MARKER (trailing space included). */
export const SDR_ORIGIN_MARKER = 'montaj: converted from SDR source '

const FAILED_PROBE = Object.freeze({
  transfer: 'unknown', comment: '', width: null, height: null, fps: null, duration: null,
})

const PROBE_ENTRIES =
  'stream=width,height,r_frame_rate,color_transfer:stream_side_data=rotation:format=duration:format_tags=comment'

/**
 * Per attempt. The probe reads headers only: under 50 ms on 240-290 MB 4K
 * HEVC iPhone masters with 10.6 of 12 GB swap in use (measured 2026-09-29), so
 * 30 s is over 600x headroom. It stays bounded, because an unbounded probe of a
 * stalled volume would hang a sample or an export with no error at all.
 */
export const PROBE_TIMEOUT_MS = 30_000
const PROBE_ATTEMPTS = 2
const RETRY_BACKOFF_MS = 250
const STDERR_CAP = 400
/** spawn errnos that mean "the machine is short right now", not "cannot ever work". */
const TRANSIENT_SPAWN = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'])

/**
 * An existing file ffprobe could not read. `reason`: 'timeout' (no answer in
 * PROBE_TIMEOUT_MS), 'killed' (a signal: jetsam, a crash), 'spawn' (ffprobe
 * never started: EAGAIN/ENOMEM under load, ENOENT when there is no ffprobe),
 * 'exit' (non-zero, with its stderr), 'parse' (not JSON) or 'no-stream'.
 */
export class ProbeError extends Error {
  constructor(path, reason, detail) {
    super(`ffprobe could not read ${path} (${reason}): ${detail}. Its colour, and so its grade, is unknown`)
    this.name = 'ProbeError'
    this.code = 'MONTAJ_PROBE_FAILED'
    this.path = path
    this.reason = reason
    this.detail = detail
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** One ffprobe run: { data } or { reason, detail, transient, hard }. */
function probeOnce(path, spawn, timeoutMs) {
  const r = spawn(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', PROBE_ENTRIES, '-of', 'json', path,
  ], { encoding: 'utf8', timeout: timeoutMs })
  // Node sets r.error AND r.signal on its own timeout, so ETIMEDOUT goes first.
  if (r.error?.code === 'ETIMEDOUT') {
    return { reason: 'timeout', detail: `no answer in ${timeoutMs / 1000} s`, transient: true }
  }
  if (r.error) {
    const code = r.error.code || 'unknown error'
    const transient = TRANSIENT_SPAWN.has(code)
    return { reason: 'spawn', detail: `${FFPROBE} did not start (${code})`, transient, hard: !transient }
  }
  if (r.signal) return { reason: 'killed', detail: `killed by ${r.signal}`, transient: true }
  if (r.status !== 0) {
    const err = String(r.stderr ?? '').trim()
    const said = err.length > STDERR_CAP ? `${err.slice(0, STDERR_CAP)}...` : err
    return { reason: 'exit', detail: `exit ${r.status}${said ? `: ${said}` : ''}` }
  }
  let data
  try { data = JSON.parse(r.stdout) } catch { return { reason: 'parse', detail: 'its output is not JSON' } }
  if (!(data?.streams || [])[0]) return { reason: 'no-stream', detail: 'no video stream' }
  return { data }
}

/**
 * One ffprobe of the first video stream. A file that is not there, or a bad
 * argument, gives the failure shape. A file that IS there and cannot be probed
 * throws ProbeError; a timeout, a kill or a spawn failure under load (EAGAIN,
 * ENOMEM) is tried once more first. No ffprobe at all (ENOENT) throws at once,
 * whatever the path: otherwise every clip would probe as "not there". `opts`
 * is for tests: spawn (spawnSync), exists (existsSync), sleep, timeoutMs.
 */
export function probeMedia(path, {
  spawn = spawnSync, exists = existsSync, sleep = sleepSync, timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof path !== 'string' || !path) return { ...FAILED_PROBE }
  let r
  for (let attempt = 1; !(r = probeOnce(path, spawn, timeoutMs)).data; attempt++) {
    if (r.hard) throw new ProbeError(path, r.reason, r.detail)
    if (!exists(path)) return { ...FAILED_PROBE }
    if (!r.transient || attempt >= PROBE_ATTEMPTS) {
      throw new ProbeError(path, r.reason, attempt > 1 ? `${r.detail}, ${attempt} tries` : r.detail)
    }
    sleep(RETRY_BACKOFF_MS)
  }
  const s = r.data.streams[0]
  const fmt = r.data.format || {}

  let width = Number.isInteger(s.width) ? s.width : null
  let height = Number.isInteger(s.height) ? s.height : null
  const rot = (s.side_data_list || []).find((d) => d && d.rotation != null)?.rotation
  if (Math.abs(Math.round(Number(rot) || 0)) % 180 === 90) [width, height] = [height, width]

  // Container duration on purpose (see the header): stream duration is N/A in Matroska/WebM.
  const duration = Number.parseFloat(fmt.duration)
  const comment = fmt.tags?.comment
  return {
    transfer: s.color_transfer || 'unknown',
    comment: typeof comment === 'string' ? comment : '',
    width,
    height,
    fps: typeof s.r_frame_rate === 'string' ? s.r_frame_rate : null,
    duration: Number.isFinite(duration) ? duration : null,
  }
}

/** The real probe and existsSync. Callers pass these; tests inject fakes. */
export const defaultDeps = Object.freeze({ probe: probeMedia, exists: existsSync })

/** An r_frame_rate string ('30000/1001') as a number; 0 for missing, '0/0' or junk. */
export function fpsValue(fps) {
  const m = typeof fps === 'string' ? /^(\d+)\/(\d+)$/.exec(fps) : null
  if (!m) return 0
  const num = Number(m[1])
  const den = Number(m[2])
  return num > 0 && den > 0 ? num / den : 0
}

/**
 * ffmpeg copies `comment` onto anything derived from a marked file (montaj
 * never passes -map_metadata -1), so a marker proves nothing unless the
 * original it names has this file's display size, frame rate and duration
 * (within two frames, and never tighter than 50 ms). A trimmed or scaled copy
 * that inherited the marker fails here. Twin: same_fingerprint in
 * lib/color_provenance.py.
 */
export function sameFingerprint(a, b) {
  const rate = fpsValue(a.fps)
  if (!a.width || !a.height || !rate || a.duration == null || b.duration == null) return false
  return a.width === b.width && a.height === b.height && a.fps === b.fps
      && Math.abs(a.duration - b.duration) <= Math.max(2 / rate, 0.05)
}

/**
 * Where `src`'s colour came from: { colorSpace, original }. `original` is the
 * SDR file a marked conversion was made from, when that file is beside it and
 * matches; otherwise null. A converted clip whose original is gone or does not
 * match is HDR and graded as today (Q1, Sam).
 */
export function originOf(src, { probe, exists } = defaultDeps) {
  const p = probe(src)
  const key = detectFromTransfer(p.transfer)
  if (!isHdr(key)) return { colorSpace: 'sdr_bt709', original: null }
  const comment = typeof p.comment === 'string' ? p.comment : ''
  if (comment.startsWith(SDR_ORIGIN_MARKER)) {
    const name = comment.slice(SDR_ORIGIN_MARKER.length)
    // normalize writes a basename; anything else was not written by montaj.
    if (name && name !== '.' && name !== '..' && !/[/\\]/.test(name)) {
      const original = join(dirname(src), name)
      if (exists(original)) {
        const o = probe(original)
        if (!isHdr(detectFromTransfer(o.transfer)) && sameFingerprint(p, o)) {
          return { colorSpace: 'sdr_bt709', original }
        }
      }
    }
  }
  return { colorSpace: key, original: null }
}

/**
 * { item, grade, cutoutKey } for one raw video item. `grade`: whether the SDR
 * output grades this layer. Not WITH WHICH KEY: for an HDR-origin clip that is
 * the transfer of the file actually decoded, known only after the caller's
 * normalize (gradeKeyFor). A cutout decodes the untagged alpha file, so its key
 * is the provenance key (cutoutKey). `raw` is never mutated.
 */
export function sdrLayerFor(raw, deps = defaultDeps) {
  const origin = originOf(raw.src, deps)
  const item = { ...raw }
  if (raw.remove_bg && raw.nobg_src) {
    const k = isHdr(origin.colorSpace) ? origin.colorSpace : null
    return { item, grade: k !== null, cutoutKey: k }
  }
  if (!isHdr(origin.colorSpace)) {
    // SDR origin: the original, ungraded. Its HDR conversion is only a cache.
    if (origin.original) item.src = origin.original
    delete item.normalizedSrc
    delete item.normalizedInPoint
    return { item, grade: false, cutoutKey: null }
  }
  return { item, grade: true, cutoutKey: null }
}

/**
 * The grade's source key once the caller knows the transfer of the file it
 * decodes (render.js: item.colorTransfer as step 4b re-stamps it after
 * normalize; sample-frame.js: its per-path probe). null = no grade. An HLG clip
 * in a PQ project decodes as PQ; an already graded SDR normalizedSrc (the shape
 * migrate_project_look describes, serve/routes/projects.py) must not be graded
 * again, and buildVividLutChain applies the LUT for ANY key it is given.
 */
export function gradeKeyFor(layer, decodedTransfer) {
  if (!layer.grade) return null
  if (layer.cutoutKey) return layer.cutoutKey
  const k = detectFromTransfer(decodedTransfer)
  return isHdr(k) ? k : null
}

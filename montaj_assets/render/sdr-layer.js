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
 *   ('unknown' / '' / null on failure; width and height are display dims, after
 *   rotation; fps is the r_frame_rate string, e.g. '30000/1001'). `duration` is
 *   the container's (`format=duration`), not the stream's: stream duration is
 *   N/A in Matroska/WebM, and normalize carries every stream, so container
 *   against container is like for like (ScreenRecording 36.652 vs 36.631,
 *   inside tolerance).
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
 * One ffprobe of the first video stream. Never throws: any failure (missing
 * file, no video stream, unparseable output) returns the failure shape.
 */
export function probeMedia(path) {
  if (typeof path !== 'string' || !path) return { ...FAILED_PROBE }
  const r = spawnSync(FFPROBE, [
    '-v', 'quiet', '-select_streams', 'v:0', '-show_entries', PROBE_ENTRIES, '-of', 'json', path,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return { ...FAILED_PROBE }
  let data
  try { data = JSON.parse(r.stdout) } catch { return { ...FAILED_PROBE } }
  const s = (data.streams || [])[0]
  if (!s) return { ...FAILED_PROBE }
  const fmt = data.format || {}

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

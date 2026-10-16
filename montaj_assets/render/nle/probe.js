// render/nle/probe.js
/**
 * Media facts for Export for editor: what the FCP7 XML writer (`nle/xmeml.js`)
 * needs to know about each file a timeline links, read with ffprobe.
 *
 * `probeSources(paths)` resolves to `{ [path]: NleProbe }`, one entry per
 * distinct path. Nothing here throws on a bad file: a missing file is
 * `exists: false`, a file ffprobe cannot read is `exists: true` with no
 * streams, and either way the entry's `warnings` says why.
 *
 * The frame rate is ffprobe's `r_frame_rate` kept EXACTLY ("30000/1001"), with
 * `fpsExact` its quotient. Two Python readers round it to a whole number
 * (`lib/normalize.py` `probe_video`, `lib/canvas.py` `fps_from_rate`); that is
 * right for picking a canvas and wrong here, where 29.97 and 30 must stay apart.
 * An NTSC rate (a whole rate times 1000/1001, within 0.001 fps) is reported as
 * `ntsc: true` with `timebase` the whole rate, which is how FCP7 XML spells it
 * (`<timebase>30</timebase><ntsc>TRUE</ntsc>`).
 *
 * `width`/`height` are the DISPLAY size: a stream whose display matrix turns it
 * by 90 or 270 degrees (a phone's portrait clip, stored landscape) reports them
 * swapped, as `probe_video` does and as Premiere and Resolve show the clip.
 *
 * The binary is the render's own (`ffmpeg-bin.js`: `MONTAJ_FFPROBE`, then the
 * managed build, then PATH).
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { FFPROBE } from '../ffmpeg-bin.js'
import { pMap } from '../p-map.js'

/**
 * @typedef {Object} NleProbe
 * @property {boolean} exists
 * @property {boolean} hasVideo        A real picture stream (cover art, `attached_pic`, is not one).
 * @property {boolean} hasAudio
 * @property {number | null} width     Display width (after rotation).
 * @property {number | null} height    Display height.
 * @property {number} rotation         Degrees from the display matrix (or the legacy `rotate` tag), 0 when untagged.
 * @property {string | null} rFrameRate  ffprobe's `r_frame_rate`, verbatim (e.g. "30000/1001").
 * @property {number | null} fpsExact  Its quotient, never rounded.
 * @property {boolean} ntsc            The rate is a whole rate times 1000/1001.
 * @property {number | null} timebase  The whole rate FCP7 XML writes: `round(fpsExact)`.
 * @property {number | null} durationSeconds  The video stream's duration, else the container's.
 * @property {number | null} durationFrames   `round(durationSeconds * fpsExact)`; null without a picture rate.
 * @property {number | null} audioChannels
 * @property {number | null} audioSampleRate
 * @property {string | null} timecode  The file's start timecode ("01:00:00:00", ";" for drop frame), if tagged.
 * @property {string | null} colorTransfer
 * @property {boolean} isStill         A single image (png, jpeg, ...), which has no duration of its own.
 * @property {string[]} warnings       Why an entry is incomplete; empty for a readable file.
 */

/** How many ffprobe processes run at once. */
const CONCURRENCY = 4

/** ffprobe's demuxers for a single still image. */
const STILL_FORMAT = /(^|,)(image2|[a-z0-9]+_pipe)(,|$)/

/**
 * Probe every path (duplicates are probed once).
 *
 * @param {string[]} paths  Absolute paths.
 * @param {{ ffprobe?: string }} [options]  `ffprobe` overrides the binary (tests).
 * @returns {Promise<Object<string, NleProbe>>}
 */
export async function probeSources(paths, { ffprobe = FFPROBE } = {}) {
  const unique = [...new Set(paths)]
  const results = await pMap(unique, (p) => probeOne(p, ffprobe), CONCURRENCY)
  /** @type {Object<string, NleProbe>} */
  const out = {}
  unique.forEach((p, i) => { out[p] = results[i] })
  return out
}

/** @returns {Promise<NleProbe>} */
async function probeOne(path, ffprobe) {
  try {
    statSync(path)
  } catch {
    return { ...emptyProbe(false), warnings: [`media not found: ${path}`] }
  }
  let json
  try {
    json = await runFfprobe(ffprobe, path)
  } catch (e) {
    return { ...emptyProbe(true), warnings: [`ffprobe could not read ${path}: ${firstLine(e.message)}`] }
  }
  return parseProbe(json)
}

function runFfprobe(ffprobe, path) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message)))
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(e)
        }
      },
    )
  })
}

/**
 * ffprobe's `-show_format -show_streams` JSON → an `NleProbe`. Exported for
 * the tests, which hold it to hand-written ffprobe output.
 *
 * @param {any} json
 * @returns {NleProbe}
 */
export function parseProbe(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const format = json?.format ?? {}
  const video = streams.find((s) => s?.codec_type === 'video' && s?.disposition?.attached_pic !== 1)
  const audio = streams.find((s) => s?.codec_type === 'audio')
  const probe = emptyProbe(true)
  probe.warnings = []

  if (audio) {
    probe.hasAudio = true
    probe.audioChannels = positiveInt(audio.channels)
    probe.audioSampleRate = positiveInt(audio.sample_rate)
  }

  const formatName = String(format.format_name ?? '')
  probe.isStill = Boolean(video) && STILL_FORMAT.test(formatName)

  if (video) {
    probe.hasVideo = true
    probe.rotation = rotationOf(video)
    const w = positiveInt(video.width)
    const h = positiveInt(video.height)
    const turned = Math.abs(probe.rotation) % 180 === 90
    probe.width = turned ? h : w
    probe.height = turned ? w : h
    probe.colorTransfer = typeof video.color_transfer === 'string' ? video.color_transfer : null
    if (!probe.isStill) {
      const rate = chooseFrameRate(video)
      if (rate) {
        probe.rFrameRate = rate.text
        probe.fpsExact = rate.value
        probe.timebase = Math.max(1, Math.round(rate.value))
        probe.ntsc = isNtsc(rate.value)
      } else {
        probe.warnings.push('no frame rate in the video stream')
      }
    }
  }

  if (!probe.isStill) {
    probe.durationSeconds = positiveNumber(video?.duration) ?? positiveNumber(format.duration)
      ?? positiveNumber(audio?.duration)
    if (probe.durationSeconds !== null && probe.fpsExact !== null) {
      probe.durationFrames = Math.round(probe.durationSeconds * probe.fpsExact)
    }
  }

  probe.timecode = timecodeOf(format, streams)
  if (!video && !audio) probe.warnings.push('no video or audio stream')
  return probe
}

/** @returns {NleProbe} */
function emptyProbe(exists) {
  return {
    exists,
    hasVideo: false,
    hasAudio: false,
    width: null,
    height: null,
    rotation: 0,
    rFrameRate: null,
    fpsExact: null,
    ntsc: false,
    timebase: null,
    durationSeconds: null,
    durationFrames: null,
    audioChannels: null,
    audioSampleRate: null,
    timecode: null,
    colorTransfer: null,
    isStill: false,
    warnings: [],
  }
}

/** "30000/1001" → { text, value }, or null when it is not a positive fraction. */
function parseRate(text) {
  if (typeof text !== 'string') return null
  const m = /^(\d+)\/(\d+)$/.exec(text.trim())
  if (!m) return null
  const num = Number(m[1])
  const den = Number(m[2])
  if (!(num > 0 && den > 0)) return null
  return { text: `${num}/${den}`, value: num / den }
}

/** The standard rates a variable-rate clip's average is snapped to: [value, exact rational]. */
const STANDARD_RATES = [
  [24000 / 1001, '24000/1001'], [24, '24/1'], [25, '25/1'], [30000 / 1001, '30000/1001'],
  [30, '30/1'], [50, '50/1'], [60000 / 1001, '60000/1001'], [60, '60/1'],
]

/**
 * The frame rate of a video stream. `r_frame_rate` is the stream's base rate,
 * and for a variable-rate recording (a phone clip) it can be a timebase far from
 * what plays (90000/1, or 120/1 on a 30 fps clip). When it is above 120 or more
 * than 1% off `avg_frame_rate`, the average is used, snapped to the nearest
 * standard rate (an NTSC rate keeps its exact rational).
 *
 * @param {any} video  An ffprobe video stream.
 * @returns {{ text: string, value: number } | null}
 */
export function chooseFrameRate(video) {
  const r = parseRate(video?.r_frame_rate)
  const avg = parseRate(video?.avg_frame_rate)
  if (!r) return avg
  if (!avg) return r
  if (r.value <= 120 && Math.abs(r.value - avg.value) / avg.value <= 0.01) return r
  let best = STANDARD_RATES[0]
  for (const std of STANDARD_RATES) {
    if (Math.abs(std[0] - avg.value) < Math.abs(best[0] - avg.value)) best = std
  }
  return parseRate(best[1])
}

/** A whole rate slowed by 1000/1001 (23.976, 29.97, 59.94, ...). */
export function isNtsc(fps) {
  const whole = Math.round(fps)
  return Math.abs(fps - whole) > 1e-6 && Math.abs(fps - (whole * 1000) / 1001) < 1e-3
}

/** The display-matrix rotation, else the legacy `rotate` tag, else 0. */
function rotationOf(stream) {
  for (const sd of Array.isArray(stream.side_data_list) ? stream.side_data_list : []) {
    const r = Number(sd?.rotation)
    if (sd && 'rotation' in sd && Number.isFinite(r)) return r
  }
  const tag = Number(stream.tags?.rotate)
  return Number.isFinite(tag) ? tag : 0
}

/** The start timecode a camera or an NLE stamped: the container's tag, else any stream's (a QuickTime tmcd track). */
function timecodeOf(format, streams) {
  const tc = format.tags?.timecode ?? streams.map((s) => s?.tags?.timecode).find((t) => typeof t === 'string')
  return typeof tc === 'string' && /^\d{1,2}:\d{2}:\d{2}[:;.]\d{2}$/.test(tc) ? tc : null
}

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function positiveNumber(v) {
  const n = Number(v)
  return v !== undefined && v !== null && Number.isFinite(n) && n > 0 ? n : null
}

function firstLine(s) {
  return String(s).split('\n').find((l) => l.trim()) ?? String(s)
}

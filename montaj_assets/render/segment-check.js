// render/segment-check.js
/**
 * Probes that make a bad segment fail the render by name (5.20.5).
 *
 * Sam's 2026-10-01 export wrote seg-0017.mp4 with PCM audio and NO video stream
 * (libx265's uninitialised DTS, see segment-plan.js MIN_SEGMENT_FRAMES), and
 * what he got back was a stderr tail about a muxer error. Two checks now name
 * the file and its timeline range instead:
 *
 *   - assertSegmentHasVideo: after every segment encode, whatever its exit code
 *     said. A filter graph can also end with no frame at all and still exit 0.
 *   - assertSegmentsJoinable: before the join. compose.js stream-copies the
 *     video, and the joined mp4 keeps the FIRST segment's parameters, so one
 *     segment that differs is either a concat error or a silently wrong film.
 */
import { spawnSync } from 'child_process'
import { ffmpegErrorTail } from './ffmpeg-error.js'
import { basename } from 'path'
import { FFPROBE } from './ffmpeg-bin.js'

const range = (start, end) => `${start.toFixed(2)}-${end.toFixed(2)}s`

/** The streams of `file`, with packet counts. Throws when ffprobe cannot read it. */
export function probeSegmentStreams(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries',
    'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,color_range,color_space,'
      + 'color_transfer,color_primaries,r_frame_rate,sample_rate,channels,sample_fmt,nb_read_packets',
    '-of', 'json', file], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) {
    throw new Error(`cannot read segment ${basename(file)}: ${(ffmpegErrorTail(r.stderr) || r.error?.message || '')}`)
  }
  return JSON.parse(r.stdout).streams ?? []
}

/**
 * Throws, naming the file and its timeline range, unless `file` holds a video
 * stream with at least one frame.
 * @param {string} file
 * @param {{start: number, end: number}} span  the segment's place on the timeline, seconds
 */
export function assertSegmentHasVideo(file, { start, end }) {
  const streams = probeSegmentStreams(file)
  const video = streams.find(s => s.codec_type === 'video')
  if (!video || !(Number(video.nb_read_packets) > 0)) {
    const has = streams.map(s => `${s.codec_type} ${s.codec_name}`).join(', ') || 'nothing'
    throw new Error(`segment ${basename(file)} (${range(start, end)} of the timeline) has no video stream `
      + `(it holds ${has}). The encoder wrote no picture for this span.`)
  }
  return streams
}

// The fields a stream-copy join needs to agree on, and the colour tags that the
// first segment's parameters would otherwise stamp over every other one.
const VIDEO_KEYS = ['codec_name', 'profile', 'width', 'height', 'pix_fmt', 'r_frame_rate',
  'color_range', 'color_space', 'color_transfer', 'color_primaries']
const AUDIO_KEYS = ['codec_name', 'sample_rate', 'channels', 'sample_fmt']

/**
 * Throws, naming the first bad segment, its timeline range and the field that
 * differs, unless every segment has video and audio whose parameters match the
 * first segment's.
 * @param {Array<{path: string, start: number, end: number}>} segments  in join order
 */
export function assertSegmentsJoinable(segments) {
  let ref = null
  for (const [i, seg] of segments.entries()) {
    const streams = assertSegmentHasVideo(seg.path, seg)
    const video = streams.find(s => s.codec_type === 'video')
    const audio = streams.find(s => s.codec_type === 'audio')
    const where = `segment ${basename(seg.path)} (${i + 1} of ${segments.length}, ${range(seg.start, seg.end)} of the timeline)`
    if (!audio) throw new Error(`${where} has no audio stream; every segment carries one, silence included`)
    if (!ref) { ref = { video, audio, name: basename(seg.path) }; continue }
    for (const [kind, keys, s, r] of [['video', VIDEO_KEYS, video, ref.video], ['audio', AUDIO_KEYS, audio, ref.audio]]) {
      for (const k of keys) {
        if (String(s[k] ?? '') !== String(r[k] ?? '')) {
          throw new Error(`${where} cannot be joined: its ${kind} ${k} is ${s[k] ?? 'unset'}, `
            + `${ref.name} has ${r[k] ?? 'unset'}`)
        }
      }
    }
  }
}

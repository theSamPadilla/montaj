/**
 * mix-audio.js — Independent audio track mixing for the montaj render pipeline.
 *
 * Handles project.audio.tracks: per-track delay, volume, trimming, and amix.
 * Video item audio (muted flag on VisualItems) is handled inline in compose.js.
 */
import { spawnSync } from 'child_process'

const FFMPEG_TIMEOUT_MS = 600_000

/**
 * Build ffmpeg input args for all unmuted audio tracks.
 *
 * @param {Array} audioTracks  — project.audio.tracks
 * @returns {string[]}         — flat array of ffmpeg input args
 */
export function buildAudioTrackInputs(audioTracks = []) {
  const args = []
  for (const track of audioTracks) {
    if (track.muted) continue
    const inPt  = track.inPoint  ?? 0
    const outPt = track.outPoint ?? null
    if (inPt > 0)       args.push('-ss', String(inPt))
    if (outPt !== null) args.push('-to', String(outPt))
    args.push('-i', track.src)
  }
  return args
}

/**
 * Build filter_complex parts that mix all unmuted audio tracks into the running audio stream.
 *
 * @param {Array}  audioTracks       — project.audio.tracks
 * @param {number} baseInputIdx      — ffmpeg input index of the first audio track
 * @param {string} currentAudioLabel — current audio label in the filter graph (e.g. '[canvas_a]')
 * @returns {{ filterParts: string[], audioLabel: string }}
 */
export function buildAudioTrackFilters(audioTracks = [], baseInputIdx, currentAudioLabel) {
  const filterParts = []
  let audioLabel = currentAudioLabel
  let offset = 0  // counts only unmuted tracks (maps to input index)

  for (const track of audioTracks) {
    if (track.muted) continue

    const inputIdx = baseInputIdx + offset
    const vol      = track.volume ?? 1.0
    const delayMs  = Math.round((track.start ?? 0) * 1000)
    const audioIn  = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`

    if (track.ducking?.enabled) {
      const depthDb = track.ducking.depth   ?? -12  // dB reduction when ducking
      const attack  = track.ducking.attack  ?? 0.3
      const release = track.ducking.release ?? 0.5
      // Map dB depth → compressor ratio (e.g. -12 dB ≈ ratio 4, -6 dB ≈ ratio 2)
      const ratio   = Math.max(1, Math.round(10 ** (-depthDb / 20)))
      let fadeFilters = ''
      const fadeIn = track.fadeIn ?? 0
      const fadeOut = track.fadeOut ?? 0
      const trackDur = (track.end ?? 0) - (track.start ?? 0)
      if (fadeIn > 0) fadeFilters += `,afade=t=in:d=${fadeIn}`
      if (fadeOut > 0) fadeFilters += `,afade=t=out:st=${Math.max(0, trackDur - fadeOut)}:d=${fadeOut}`
      filterParts.push(
        `${audioIn}asplit=2[speech${offset}][sc${offset}]`,
        `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[mscaled${offset}]`,
        `[mscaled${offset}][sc${offset}]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=${attack * 1000}:release=${release * 1000}[ducked${offset}]`,
        `[speech${offset}][ducked${offset}]amix=inputs=2:duration=first:normalize=0[aout${offset}]`,
      )
      audioLabel = `[aout${offset}]`
    } else {
      let fadeFilters = ''
      const fadeIn = track.fadeIn ?? 0
      const fadeOut = track.fadeOut ?? 0
      const trackDur = (track.end ?? 0) - (track.start ?? 0)
      if (fadeIn > 0) fadeFilters += `,afade=t=in:d=${fadeIn}`
      if (fadeOut > 0) fadeFilters += `,afade=t=out:st=${Math.max(0, trackDur - fadeOut)}:d=${fadeOut}`
      filterParts.push(
        `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[atrack${offset}]`,
        `${audioIn}[atrack${offset}]amix=inputs=2:duration=longest:normalize=0[amid${offset}]`,
      )
      audioLabel = `[amid${offset}]`
    }

    offset++
  }

  return { filterParts, audioLabel }
}

/**
 * Mix audio tracks into a pre-rendered silent/chunk video file.
 * Used by composeChunked() final pass: video stream is copied, audio is re-encoded.
 *
 * @param {string} videoPath   — path to the pre-rendered video (no audio or silent)
 * @param {Array}  audioTracks — project.audio.tracks
 * @param {string} outputPath
 */
export function mixAudioIntoVideo(videoPath, audioTracks, outputPath) {
  // Pre-filter: helpers also skip muted tracks internally, but we need the
  // count here for the early-exit branch and to avoid an empty filter graph.
  const unmuted = (audioTracks ?? []).filter(t => !t.muted)
  if (unmuted.length === 0) {
    const result = spawnSync('ffmpeg', [
      '-y', '-i', videoPath, '-c', 'copy', outputPath,
    ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
    if (result.status !== 0) throw new Error(`ffmpeg copy failed:\n${result.stderr}`)
    return
  }

  const inputs = ['-i', videoPath]
  inputs.push(...buildAudioTrackInputs(unmuted))

  // [0:a] = audio stream from the input video (assumed present; chunked path
  // always produces a silent audio stream via anullsrc in compose.js)
  const { filterParts, audioLabel } = buildAudioTrackFilters(unmuted, 1, '[0:a]')

  const result = spawnSync('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v',
    '-map', audioLabel,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  if (result.status !== 0) throw new Error(`ffmpeg audio mix failed:\n${result.stderr}`)
}

// render/compose.js
/**
 * compose.js — Segment-based video composition.
 *
 * Pipeline:
 *   1. planSegments() — split timeline at clip/overlay boundaries
 *   2. encodeSegment() — encode each segment independently
 *   3. concat — ffmpeg concat demuxer (video: copy, audio: re-encode to uniform AAC 48kHz)
 *   4. mixAudioIntoVideo() — independent audio tracks mixed in final pass
 *
 * No monolithic filter_complex. No chunking threshold. Each ffmpeg call is simple.
 */
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { FFMPEG } from './ffmpeg-bin.js'
import { planSegments } from './segment-plan.js'
import { encodeSegment, buildVividLutChain, hasLut3d } from './encode-segment.js'
import { mixAudioIntoVideo } from './mix-audio.js'
import { pMap } from './p-map.js'

const FFMPEG_TIMEOUT_MS = 600_000

// Segments encode independently, so a bounded pool overlaps them. ffmpeg/x264
// already multithreads, so 2 concurrent encodes saturate most machines without
// thrashing; power users tune MONTAJ_SEGMENT_WORKERS. Floor of 1 keeps a bad
// value (0, NaN, negative) from disabling encoding entirely.
const SEGMENT_WORKERS = Math.max(1, parseInt(process.env.MONTAJ_SEGMENT_WORKERS ?? '', 10) || 2)

const TTY = process.stderr.isTTY
const C = {
  green: TTY ? '\x1b[92m' : '', dim: TTY ? '\x1b[2m' : '', reset: TTY ? '\x1b[0m' : '',
}
function clog(msg) { process.stderr.write(`${C.green}[montaj compose]${C.reset} ${msg}\n`) }

/**
 * Main entry point — replaces compose() from compose.js.
 * Same signature for drop-in compatibility with render.js.
 */
export async function compose({
  projectJson,
  puppeteerSegments = [],
  imageItems = [],
  videoItems = [],
  outputPath,
  videoWidth,
  videoHeight,
  colorSpace,
  // Look curve for every HDR→SDR conversion this compose performs — per-item
  // conversion inside the segment encoder (an HDR source in an SDR project) and
  // the poster-frame tonemap below (an HDR project's thumbnail). null uses the
  // master look, which is what every caller predating --sdr-curve gets.
  sdrCurve = null,
}) {
  // Default resolution is portrait (1080x1920) — montaj's default orientation.
  // render.js always passes explicit dimensions, but direct callers hitting
  // defaults should get the right orientation.
  const vw = videoWidth ?? projectJson.settings?.resolution?.[0] ?? 1080
  const vh = videoHeight ?? projectJson.settings?.resolution?.[1] ?? 1920
  const fps = projectJson.settings?.fps ?? 30
  // Project working color space — drives segment-encoder codec, pix_fmt, and
  // color metadata. Falls back to sdr_bt709 for projects predating this field.
  const projectColorSpace = colorSpace ?? projectJson.settings?.colorSpace ?? 'sdr_bt709'
  const audioTracks = projectJson.audio?.tracks ?? []
  const hasAudio = audioTracks.some(t => !t.muted)

  // 1. Plan segments — merge video + image items
  const allItems = [...imageItems, ...videoItems]
  const segments = planSegments(allItems, puppeteerSegments, vw, vh, fps)

  if (segments.length === 0) {
    clog('no segments to render')
    // Same shape as the success return below — an empty plan has no gap. Kept
    // uniform so `const { leadingGap } = await compose(...)` can't silently
    // destructure `undefined` off a bare string on this path.
    return { outputPath, leadingGap: 0 }
  }

  // ── RESPECT A LEADING GAP ───────────────────────────────────────────────
  //
  // `planSegments` derives its boundaries purely from item and overlay
  // endpoints, so t=0 only enters the boundary set when something actually
  // starts there. A timeline whose first content starts at 2.5s therefore
  // plans its first segment as [2.5, 10.7] and the concat simply BEGINS at
  // the first clip: the 2.5s of black the editor shows at the head is
  // silently dropped, and the export comes out 2.5s shorter than the
  // timeline it was built from.
  //
  // A gap BETWEEN two clips already survives, because both neighbours
  // contribute boundaries and the segment between them gets `items: []` —
  // which the encoder renders as black canvas + `anullsrc` silence. Only the
  // LEADING gap was lost, purely because nothing contributes a 0 boundary.
  // This prepends the segment the planner would have produced if something
  // had, so a leading gap behaves exactly like a middle one.
  //
  // Deliberately here and NOT in `planSegments` / `boundariesFrom`:
  //   - `resolver-parity.test.mjs` is a frozen gate proving `planSegments`
  //     still matches the pre-T7 algorithm over the whole fixture corpus.
  //     A leading gap is not an edge case, so changing the planner would
  //     diverge on many fixtures and gut that gate.
  //   - `boundariesFrom` is shared with the editor preview and
  //     `sample-frame.js`, and the PREVIEW ALREADY RESPECTS leading gaps
  //     (it shows black and reports the full duration). The bug was
  //     render-only, so the fix is render-only; touching the shared resolver
  //     would risk changing two engines to fix one.
  // `compose.js` is the only production caller of `planSegments`, so this is
  // equivalent to fixing the planner for every path that actually renders.
  //
  // The result also makes render self-consistent: output duration now equals
  // `getTotalDurationSeconds` (max end), which is the same basis the overlay
  // and caption Puppeteer segments were already timed against. Before this,
  // a leading gap shifted the picture earlier while overlays, captions and
  // the independently-mixed audio tracks stayed on absolute timeline time —
  // so they drifted by exactly the gap.
  const leadingGap = Math.max(0, segments[0].start)
  if (leadingGap > 0) {
    segments.unshift({
      start: 0,
      end: segments[0].start,
      items: [],
      opaqueVideo: false,
      overlays: [],
      vw,
      vh,
      fps,
    })
    clog(`leading gap of ${leadingGap.toFixed(2)}s — prepending a black segment`)
  }

  const lastEnd = segments[segments.length - 1].end
  clog(`planned ${segments.length} segment(s) across ${lastEnd.toFixed(1)}s`)

  // 2. Encode each segment
  mkdirSync(dirname(outputPath), { recursive: true })
  const segDir = outputPath + '.segments'
  // WIPE stale segments from a previous (possibly partial) render before
  // (re)creating the directory. Without this, leftover seg-NNNN.mp4 files from
  // a prior failed render persist and the segment count from this run won't
  // always overwrite them — but more importantly, if a previous render produced
  // segments with the same index from a different timeline configuration, we'd
  // end up concatenating a mix. Mirror render.js's wipe of `segments/` (overlay
  // chunks) at the corresponding stage.
  rmSync(segDir, { recursive: true, force: true })
  mkdirSync(segDir, { recursive: true })

  // Encode up to SEGMENT_WORKERS segments concurrently. pMap returns results in
  // input order, so concatSegments below still joins them in timeline order; each
  // segment writes a distinct seg-NNNN.mp4, so concurrent encodes never collide.
  const segPaths = await pMap(segments, async (seg, i) => {
    // Stamp project color space onto each segment so the encoder knows what
    // codec/pix_fmt/color metadata to emit. planSegments doesn't know about
    // color space; that's a project-level concern threaded through here.
    seg.colorSpace = projectColorSpace
    const segPath = join(segDir, `seg-${String(i).padStart(4, '0')}.mp4`)

    clog(`segment ${i + 1}/${segments.length} (${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s): ` +
         `${seg.items.length} item(s), ${seg.overlays.length} overlay(s)`)

    await encodeSegment(seg, segPath, { sdrCurve })
    return segPath
  }, SEGMENT_WORKERS)

  // 3. Concat all segments
  const preMixPath = hasAudio ? outputPath.replace(/(\.\w+)$/, '_premix$1') : outputPath
  concatSegments(segPaths, preMixPath)

  // 4. Mix independent audio tracks (concat output guaranteed to have audio
  //    because every segment produces AAC 48kHz — either from source or anullsrc)
  if (hasAudio) {
    mixAudioIntoVideo(preMixPath, audioTracks, outputPath)
    rmSync(preMixPath, { force: true })
  }

  // 5. Embed a poster frame as an MP4 attached_pic stream so Finder, QuickTime,
  //    iMessage, Slack, and social platforms show a thumbnail instead of a
  //    black-or-blank placeholder.
  embedThumbnail(outputPath, projectColorSpace, { sdrCurve, leadingGap })

  // Cleanup segment files
  if (!process.env.MONTAJ_KEEP_SEGMENTS) {
    rmSync(segDir, { recursive: true, force: true })
  }

  // `leadingGap` rides along so the SDR-derive path in render.js can poster
  // its rendition at the same offset — `deriveSdr` maps only `0:v:0`, dropping
  // the master's attached_pic, so that file embeds a poster of its own.
  return { outputPath, leadingGap }
}

/**
 * Embed a poster image (MP4 attached_pic stream) into the final video so
 * file browsers and social platforms show a thumbnail before playback.
 *
 * Two-step: (1) extract one JPEG frame at `leadingGap + 1.0s`, (2) re-mux video+audio+jpg
 * with -disposition:v:1 attached_pic. Both passes stream-copy AV; the only
 * encode cost is the single JPEG. Total runtime ~1s on any sane host.
 *
 * Failure is non-fatal: a missing thumbnail is far better than failing an
 * otherwise-good render. On any error we log and leave outputPath untouched.
 *
 * @param {string} outputPath
 * @param {string} colorSpace  the file's color space, e.g. 'hdr_hlg'
 * @param {object} [opts]
 * @param {string|null} [opts.sdrCurve]  look curve for the HDR→SDR poster
 *   conversion; null uses the master look.
 * @param {number} [opts.leadingGap]  seconds of black at the head of the file
 *   (a timeline whose first content does not start at 0). The poster is taken
 *   1s past it so a gapped project does not thumbnail itself black. Default 0.
 */
export function embedThumbnail(outputPath, colorSpace, opts = {}) {
  const tmpJpg = outputPath + '.thumb.jpg'
  const tmpMp4 = outputPath.replace(/(\.\w+)$/, `.thumb.${randomBytes(4).toString('hex')}$1`)

  // HDR projects (HLG / PQ) must tonemap before the JPEG encode. JPEG is sRGB
  // by definition — handing it raw HLG/PQ Y'CbCr produces a washed-out,
  // colour-skewed poster on every viewer because the gamma assumption is wrong.
  // Since SP6b that tonemap is the Montaj Vivid LUT, so the poster is graded the
  // same way the SDR export and the editor preview are, and `format=yuv420p`
  // closes the chain for the JPEG encoder.
  //
  // zscale (libzimg) is already required for the HDR encode path, so it's safe
  // to assume present here when colorSpace is HDR. lut3d is NOT — `montaj
  // doctor` asks for it but an older build can lack it — so fall back to the
  // pre-SP6b Hable chain rather than emitting a filter this ffmpeg can't run.
  const isHdrFile = colorSpace === 'hdr_hlg' || colorSpace === 'hdr_pq'
  let vf = null
  if (isHdrFile) {
    vf = hasLut3d()
      ? `${buildVividLutChain(colorSpace, opts.sdrCurve ?? null)},format=yuv420p`
      : `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`
  }

  function extractAt(seekSeconds) {
    const args = ['-y', '-v', 'error', '-ss', String(seekSeconds), '-i', outputPath, '-frames:v', '1']
    if (vf) args.push('-vf', vf)
    args.push('-q:v', '2', tmpJpg)
    return spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  }

  // Try `leadingGap + 1.0` first (past most fade-ins). The offset matters now
  // that a leading gap is preserved as real black frames: a project whose
  // first clip starts at 2.5s would otherwise poster itself with a frame from
  // the middle of that black head, and ship a thumbnail that is entirely
  // black. Seeking past the gap picks the same "1s into the picture" frame a
  // gapless project gets. Defaults to 0 so every existing caller is unchanged.
  //
  // If that fails (video shorter than the seek, decoder error), retry at 0 —
  // every valid video has a frame 0. A black frame 0 on a gapped project is
  // still better than failing the poster outright, and this arm is only
  // reached when the preferred seek could not be decoded at all.
  const leadingGap = Number.isFinite(opts.leadingGap) ? Math.max(0, opts.leadingGap) : 0
  let extract = extractAt(leadingGap + 1.0)
  if (extract.status !== 0) {
    rmSync(tmpJpg, { force: true })
    extract = extractAt(0)
  }
  if (extract.status !== 0) {
    clog(`thumbnail extract failed (skipping): ${(extract.stderr || '').trim().slice(-300)}`)
    rmSync(tmpJpg, { force: true })
    return
  }

  // -disposition:v:1 attached_pic flags the JPEG as the cover/poster rather
  // than a second video track. Without it, players treat the file as having
  // two video streams and either reject it or autoplay the JPEG as a 1-frame
  // stuck-frame on a separate track.
  const mux = spawnSync(FFMPEG, [
    '-y', '-v', 'error',
    '-i', outputPath,
    '-i', tmpJpg,
    '-map', '0', '-map', '1',
    '-c', 'copy',
    '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart',
    tmpMp4,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  rmSync(tmpJpg, { force: true })
  if (mux.status !== 0) {
    clog(`thumbnail mux failed (skipping): ${(mux.stderr || '').trim().slice(-300)}`)
    rmSync(tmpMp4, { force: true })
    return
  }
  renameSync(tmpMp4, outputPath)
  clog('attached poster thumbnail')
}

function concatSegments(paths, outputPath) {
  const listFile = outputPath + '.concat.txt'
  writeFileSync(listFile, paths.map(p => `file '${p}'`).join('\n'))

  // PHASE MARKER: "concatenating" → encoding in serve's _render_phase_for (projects.py).
  clog(`concatenating ${paths.length} segment(s)...`)

  // Video: -c:v copy. All segments from a single render share the project's
  // working codec — h264 for SDR, hevc for HDR — so stream-copy concat is safe.
  // Uniform output is now per-project, not pipeline-wide.
  // Audio: -c:a aac re-encode. Segments output stereo 48kHz pcm_s16le (see
  // encode-segment.js Step 6 — switched from per-segment AAC to PCM to make
  // segment seams sample-aligned, since AAC framing/priming/edit-list
  // metadata do not survive the concat demuxer cleanly when audio is
  // transcoded). The concat pass here decodes the joined PCM stream and
  // re-encodes to AAC once at end-of-pipeline — this is the only AAC encode
  // in the render path.
  const tmpPath = outputPath.replace(/(\.\w+)$/, `.${randomBytes(4).toString('hex')}$1`)
  // No error-tolerance flags at concat — those would mask real corruption AND
  // tell the HEVC NAL parser to accept malformed units in stream-copy mode,
  // producing a final.mp4 with garbage video bitstream. Strict by default.
  const result = spawnSync(FFMPEG, [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    tmpPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  rmSync(listFile, { force: true })
  if (result.status !== 0) {
    rmSync(tmpPath, { force: true })
    throw new Error(`ffmpeg concat failed:\n${result.stderr}`)
  }
  renameSync(tmpPath, outputPath)
}

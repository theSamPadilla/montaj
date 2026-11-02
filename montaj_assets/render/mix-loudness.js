#!/usr/bin/env node
/**
 * mix-loudness.js — the integrated loudness of the export's final audio mix,
 * measured through the export's own graph, decoded only (§660).
 *
 * The export levels the whole mix with ONE dynamic loudnorm
 * (mix-audio.js `loudnessFilter`, `settings.loudness` the target), after every
 * clip's and lane's volume, mute, fade and ducking. The editor preview plays
 * the same mix (editor/src/engine/mix/audio-plan.ts) and levels it with a
 * static master gain of `target - inputI`, which needs this number.
 *
 * Nothing here rebuilds the mix by hand. The project is loaded, planned and
 * segmented exactly as the render does it (render.js `loadRenderProject`,
 * `collectPuppeteerSegments`, `collectAllItems`, `stampSourceProbes`;
 * compose.js `planCompose` with the descriptors a sliced render plans with),
 * and each segment's audio is the graph `encodeSegment` builds (its dry run),
 * with the video chains left out (`audioOnlyGraph`). The segments' audio is
 * joined as compose.js joins them, then mixed with the lanes and measured by
 * mix-audio.js's own `buildMixGraph` and `measureLoudness`, the pair the
 * export's silence pre-pass reads the same mix through.
 *
 * Two things differ from an export, neither in the samples: the segments are
 * written as WAV and joined without the export's one AAC pass, and each clip
 * is decoded from the source the render starts from, before its normalize
 * pass (that pass conforms the picture; the copy keeps the source's audio).
 * render/test/mix-loudness.test.mjs holds the result to an actual export.
 *
 * CLI: node mix-loudness.js --project <project.json>
 * stdout: one JSON line, {status: 'measured'|'silent', targetI, inputI,
 *         inputTP, inputLRA} or {status: 'off'} (no settings.loudness)
 * stderr: progress lines; on failure a JSON {error, message} line, exit 1
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { isMain as isMainModule } from './is-main.js'
import { pMap } from './p-map.js'
import { planCompose } from './compose.js'
import { plannedDescriptors } from './slice-run.js'
import { encodeSegment, runFfmpeg, FFMPEG_STALL_MS } from './encode-segment.js'
import { buildMixGraph, measureLoudness, isSilentInputI } from './mix-audio.js'
import { assertInputsExist, fileInputsOf, ffmpegErrorTail } from './ffmpeg-error.js'
import { loadRenderProject, collectPuppeteerSegments, collectAllItems, stampSourceProbes } from './render.js'

const isMain = isMainModule(import.meta.url, process.argv[1])

/** What an input the audio graph never reads becomes: cheap, and keeps every other index. */
const UNREAD_INPUT = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']

/** Split a filtergraph into its chains at every `;` outside single quotes. */
function chainsOf(graph) {
  const out = []
  let cur = ''
  let quoted = false
  for (const ch of graph) {
    if (ch === "'") quoted = !quoted
    if (ch === ';' && !quoted) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

const labelsIn = (s) => (s ? [...s.matchAll(/\[([^\]]*)\]/g)].map((m) => `[${m[1]}]`) : [])

/**
 * The part of an ffmpeg graph that makes `outLabel`: every chain it is built
 * from, in order, and nothing else. Each input those chains never read is
 * swapped for a silent generator, so the input indices the chains name stay
 * right and no picture is decoded. A kept chain's output nothing reads goes to
 * `anullsink` (ffmpeg refuses an unconnected output).
 *
 * @param {string[]} inputs   ffmpeg input args, each input ending at its `-i <src>`
 * @param {string[]} parts    filter chains (`filterParts`), possibly `;`-joined
 * @param {string}   outLabel e.g. '[aseg]'
 * @returns {{ inputs: string[], filter: string }}
 */
export function audioOnlyGraph(inputs, parts, outLabel) {
  const chains = chainsOf(parts.join(';')).map((c) => ({
    c,
    ins: labelsIn(/^(?:\[[^\]]*\])+/.exec(c)?.[0]),
    outs: labelsIn(/(?:\[[^\]]*\])+$/.exec(c)?.[0]),
  }))
  const need = new Set([outLabel])
  const kept = []
  for (let i = chains.length - 1; i >= 0; i--) {
    if (!chains[i].outs.some((o) => need.has(o))) continue
    kept.unshift(chains[i])
    for (const l of chains[i].ins) need.add(l)
  }
  const read = new Set(kept.flatMap((k) => k.ins))
  const sinks = kept.flatMap((k) => k.outs).filter((o) => o !== outLabel && !read.has(o)).map((o) => `${o}anullsink`)

  const used = new Set([...read].map((l) => /^\[(\d+):/.exec(l)?.[1]).filter((n) => n !== undefined).map(Number))
  const out = []
  let group = []
  let index = 0
  for (let k = 0; k < inputs.length; k++) {
    group.push(inputs[k])
    if (inputs[k] !== '-i') continue
    group.push(inputs[++k])
    out.push(...(used.has(index) ? group : UNREAD_INPUT))
    group = []
    index++
  }
  return { inputs: out, filter: [...kept.map((k) => k.c), ...sinks].join(';') }
}

/** Write one planned segment's audio, as encodeSegment would mix it, to `wavPath`. */
async function writeSegmentAudio(segment, wavPath, dir) {
  const { inputs, filterParts } = await encodeSegment(segment, wavPath.replace(/\.wav$/, '.mp4'), { _dryRun: true })
  const g = audioOnlyGraph(inputs, filterParts, '[aseg]')
  assertInputsExist(fileInputsOf(g.inputs))
  const result = await runFfmpeg([
    '-y', ...g.inputs,
    '-filter_complex', g.filter,
    '-map', '[aseg]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    wavPath,
  ], FFMPEG_STALL_MS, dir)
  if (result.status !== 0) {
    throw new Error(`ffmpeg segment audio failed (${segment.start.toFixed(2)}-${segment.end.toFixed(2)}s):\n${ffmpegErrorTail(result.stderr)}`)
  }
}

/**
 * Measure the export's final mix of the project at `projectPath`.
 *
 * @param {string} projectPath
 * @param {object} [opts]
 * @param {string} [opts.workDir]  where the scratch dir goes (default the system temp dir); removed after
 * @param {number} [opts.concurrency]  segments decoded at once
 * @returns {Promise<{status: 'off'} | {status: 'measured'|'silent', targetI: number,
 *   inputI?: number|null, inputTP?: number|null, inputLRA?: number|null}>}
 */
export async function measureMixLoudness(projectPath, { workDir = null, concurrency = 2 } = {}) {
  const { projectJson, settings, fps, renderWidth, renderHeight } = loadRenderProject(projectPath)
  const lufs = settings.loudness
  if (lufs === undefined || lufs === null) return { status: 'off' }

  const base = workDir ? resolve(workDir) : tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'mix-loudness-'))
  try {
    const specs = collectPuppeteerSegments(projectJson, fps, renderWidth, renderHeight, dir)
    const { imageItems, videoItems } = collectAllItems(projectJson)
    stampSourceProbes(videoItems, new Map())
    const plan = await planCompose({
      projectJson, puppeteerSegments: plannedDescriptors(specs), imageItems, videoItems,
      outputPath: join(dir, 'mix.mp4'),
    })
    // An empty plan exports nothing, so there is nothing to level.
    if (plan.empty) return { status: 'silent', targetI: lufs }

    const wavs = await pMap(plan.segments, async (segment, k) => {
      const wav = join(dir, `seg-${String(k).padStart(4, '0')}.wav`)
      await writeSegmentAudio(segment, wav, dir)
      return wav
    }, concurrency)
    // Joined as compose.js concatSegments joins the segments (absolute entries).
    const list = join(dir, 'segments.txt')
    writeFileSync(list, wavs.map((w) => `file '${resolve(w)}'`).join('\n'))

    const graph = buildMixGraph(projectJson.audio?.tracks ?? [], ['-f', 'concat', '-safe', '0', '-i', list])
    const m = measureLoudness(graph.inputs, lufs, graph)
    if (!m) throw new Error('ffmpeg could not measure the mix')
    return { status: isSilentInputI(m.inputI) ? 'silent' : 'measured', targetI: lufs, ...m }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--project')
  const projectPath = at >= 0 ? argv[at + 1] : null
  if (!projectPath) {
    process.stderr.write('Usage: mix-loudness.js --project <project.json>\n')
    process.exit(1)
  }
  try {
    const result = await measureMixLoudness(projectPath)
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.code ?? 'measure_failed', message: err.message }) + '\n')
    process.exit(1)
  }
}

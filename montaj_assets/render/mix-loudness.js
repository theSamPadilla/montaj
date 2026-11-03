#!/usr/bin/env node
/**
 * mix-loudness.js — the integrated loudness the export levels by, measured
 * through the export's own graph, decoded only (§660, §697).
 *
 * The level is ONE static master gain for the whole program (§697, "the way
 * pro editors do"): `settings.loudness - I`, where I is the integrated
 * loudness over the entire timeline, measured on the SPEECH when the project
 * has speech, else on the whole mix. The export applies that gain after every
 * clip's and lane's volume, mute, fade and ducking (mix-audio.js
 * `loudnessFilter`, then a peak limiter at -1.5 dBFS); the editor preview
 * plays the same mix (editor/src/engine/mix/audio-plan.ts) through the same
 * gain and an equivalent limiter (editor/src/video/preview/master-bus.ts).
 * Both get I from here, so preview and export play at one level, and a fader
 * on anything that is not speech is heard as set and never re-levelled away.
 *
 * What is speech is serve's to decide (voiceover lanes, clips with a
 * transcript): it hands a speech set over (`--speech-set <file>`, JSON
 * `{v: 1, items: [timeline item ids], lanes: [audio.tracks ids], srcs: [...]}`).
 * With items or lanes in it, a copy of the project is measured in memory
 * where every timeline video/audio item not in `items` is muted and
 * audio.tracks keeps only the lanes in `lanes`; timing, fades and speeds are
 * untouched and nothing is written. No set, or one naming nothing, measures
 * the whole mix with every volume at unity (a fader is absolute, never undone
 * by the gain, and measures nothing new). `basis` in the answer says which ('speech' or 'mix').
 *
 * Nothing here rebuilds the mix by hand. The project is loaded, planned and
 * segmented exactly as the render does it (render.js `loadRenderProject`,
 * `collectPuppeteerSegments`, `collectAllItems`, `stampSourceProbes`;
 * compose.js `planCompose` with the descriptors a sliced render plans with),
 * and each segment's audio is the graph `encodeSegment` builds (its dry run),
 * with the video chains left out (`audioOnlyGraph`). The segments' audio is
 * joined as compose.js joins them, then mixed with the lanes and measured by
 * mix-audio.js's own `buildMixGraph` and `measureLoudness`.
 *
 * Two things differ from an export, neither in the samples: the segments are
 * written as WAV and joined without the export's one AAC pass, and each clip
 * is decoded from the source the render starts from, before its normalize
 * pass (that pass conforms the picture; the copy keeps the source's audio).
 * render/test/mix-loudness.test.mjs holds the result to an actual export.
 *
 * CLI: node mix-loudness.js --project <project.json> [--speech-set <file>]
 * stdout: one JSON line, {status: 'measured'|'silent', basis: 'speech'|'mix',
 *         targetI, inputI, inputTP, inputLRA} or {status: 'off'} (no settings.loudness)
 * stderr: progress lines; on failure a JSON {error, message} line, exit 1
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { isMain as isMainModule } from './is-main.js'
import { pMap } from './p-map.js'
import { planCompose } from './compose.js'
import { plannedDescriptors } from './slice-run.js'
import { encodeSegment, runFfmpeg, FFMPEG_STALL_MS } from './encode-segment.js'
import { buildMixGraph, measureLoudness, isSilentInputI, masterGainDb } from './mix-audio.js'
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
 * A speech set's file, read: `{items, lanes}` (arrays of ids), or null when
 * there is none. A file that cannot be read or is not a set is said on stderr
 * and read as no set (the whole mix): the level falls back, nothing fails.
 */
export function readSpeechSet(path) {
  if (!path) return null
  try {
    const set = JSON.parse(readFileSync(path, 'utf8'))
    if (!set || typeof set !== 'object' || (!Array.isArray(set.items) && !Array.isArray(set.lanes))) {
      throw new Error('not a speech set ({items, lanes})')
    }
    return set
  } catch (err) {
    process.stderr.write(`mix-loudness: speech set ${path} unread (${err.message}); measuring the whole mix\n`)
    return null
  }
}

/** Whether `set` names any speech. */
function namesSpeech(set) {
  return !!set && ((set.items?.length ?? 0) > 0 || (set.lanes?.length ?? 0) > 0)
}

/** A track's items: the legacy bare list is the items itself. */
const itemsOf = (track) => (Array.isArray(track) ? track : track?.items ?? [])

/**
 * Reduce a loaded project, in memory, to its speech: every timeline video or
 * audio item that is not in the set is muted, and audio.tracks keeps only the
 * lanes in `set.lanes`. Nothing else changes (timing, fades, speeds, and the
 * speech items' own volumes: a speech gain change re-levels).
 *
 * An item is in the set by place when the set has `positions` ([track index,
 * item index] pairs, which serve knows even for an item with no id or an id
 * another track repeats), else by id.
 */
export function speechOnly(projectJson, set) {
  const ids = new Set((set.items ?? []).map(String))
  const places = Array.isArray(set.positions) ? new Set(set.positions.map(([t, i]) => `${t}:${i}`)) : null
  const lanes = new Set((set.lanes ?? []).map(String))
  ;(projectJson.tracks ?? []).forEach((track, ti) => {
    itemsOf(track).forEach((item, ii) => {
      if (!item || (item.type !== 'video' && item.type !== 'audio')) return
      const speech = places ? places.has(`${ti}:${ii}`) : ids.has(String(item.id))
      if (!speech) item.muted = true
    })
  })
  if (projectJson.audio?.tracks) {
    projectJson.audio.tracks = projectJson.audio.tracks.filter((t) => lanes.has(String(t.id)))
  }
  return projectJson
}

const LEVEL_FIELD = /volume|gain/i

/**
 * With no speech the whole mix is measured at unity, in memory: every
 * timeline item's, track's and audio lane's volume/gain field is dropped (1.0),
 * and mutes, fades, ducking, timing and sources stay. A fader is then heard
 * as set, never undone by the master gain, and moving one measures nothing
 * new (serve's key leaves them out for the same reason).
 */
export function atUnity(projectJson) {
  const strip = (o) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) if (LEVEL_FIELD.test(k)) delete o[k]
  }
  for (const track of projectJson.tracks ?? []) {
    if (!Array.isArray(track)) strip(track)
    for (const item of itemsOf(track)) strip(item)
  }
  for (const lane of projectJson.audio?.tracks ?? []) strip(lane)
  return projectJson
}

/**
 * Measure the integrated loudness the project at `projectPath` is levelled by:
 * its speech when `speechSet` names any, else its whole final mix.
 *
 * @param {string} projectPath
 * @param {object} [opts]
 * @param {object|null} [opts.speechSet]  {items, lanes} (readSpeechSet); null/absent = the whole mix
 * @param {string} [opts.workDir]  where the scratch dir goes (default the system temp dir); removed after
 * @param {number} [opts.concurrency]  segments decoded at once
 * @returns {Promise<{status: 'off'} | {status: 'measured'|'silent', basis: 'speech'|'mix', targetI: number,
 *   inputI?: number|null, inputTP?: number|null, inputLRA?: number|null}>}
 */
export async function measureMixLoudness(projectPath, { speechSet = null, workDir = null, concurrency = 2 } = {}) {
  const loaded = loadRenderProject(projectPath)
  const { settings, fps, renderWidth, renderHeight } = loaded
  const lufs = settings.loudness
  if (lufs === undefined || lufs === null) return { status: 'off' }
  const basis = namesSpeech(speechSet) ? 'speech' : 'mix'
  const projectJson = basis === 'speech' ? speechOnly(loaded.projectJson, speechSet) : atUnity(loaded.projectJson)

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
    if (plan.empty) return { status: 'silent', basis, targetI: lufs }

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
    return { status: isSilentInputI(m.inputI) ? 'silent' : 'measured', basis, targetI: lufs, ...m }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The export's static master gain (§697), dB: `targetI - inputI` of
 * measureMixLoudness, clamped as the preview clamps it (mix-audio.js
 * `masterGainDb`). 0 dB for no target, a silent measurement or a failed one:
 * the level then stays as mixed, and nothing fails. `measurement` is the
 * answer (or `{status: 'failed', message}`), for the log.
 */
export async function exportMasterGain(projectPath, opts = {}) {
  let measurement
  try {
    measurement = await measureMixLoudness(projectPath, opts)
  } catch (err) {
    return { gainDb: 0, measurement: { status: 'failed', message: err.message } }
  }
  const gainDb = measurement.status === 'measured' ? masterGainDb(measurement.targetI, measurement.inputI) : 0
  return { gainDb, measurement }
}

if (isMain) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--project')
  const projectPath = at >= 0 ? argv[at + 1] : null
  if (!projectPath) {
    process.stderr.write('Usage: mix-loudness.js --project <project.json> [--speech-set <file>]\n')
    process.exit(1)
  }
  try {
    const setAt = argv.indexOf('--speech-set')
    const speechSet = setAt >= 0 ? readSpeechSet(argv[setAt + 1]) : null
    const result = await measureMixLoudness(projectPath, { speechSet })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.code ?? 'measure_failed', message: err.message }) + '\n')
    process.exit(1)
  }
}

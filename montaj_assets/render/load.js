/**
 * load.js (§698): what a render takes from the machine. A render is a batch job beside an app the person is using, so it
 * leaves room: half the cores by default, and a low scheduling priority (its Chrome and ffmpeg children inherit it).
 *
 * MEASURED 2026-11-03 on a 12-core Mac mid-export: render.js ran 25 children, 12 of them ffmpeg encoders
 * (`-f image2pipe -c:v png`), 5.8 GB RSS, 345% CPU, load average 42; the preview's serve loop blocked 43 times for
 * 100 to 516 ms in an hour. CPU and memory starvation, not main-thread work.
 *
 * Both are configurable and both fail open: a render always runs, only slower.
 */
import os, { availableParallelism } from 'os'

/** The nice level a render runs at: low, but a render that is alone still gets the whole machine. */
export const RENDER_NICE_DEFAULT = 10

/**
 * How many capture workers to ask for when nothing says: half the cores, at least one. `MONTAJ_RENDER_WORKERS`
 * (a positive integer) replaces it; the render config's `render.workers` and `--workers` still beat both.
 * Each worker is a headless Chrome and an ffmpeg encoder, so this is also the encoder count.
 */
export function defaultWorkerTarget({ cpus = (typeof availableParallelism === 'function' ? availableParallelism() : os.cpus().length), env = process.env } = {}) {
  const fromEnv = Number.parseInt(env.MONTAJ_RENDER_WORKERS, 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return Math.max(1, Math.floor((Number(cpus) || 1) / 2))
}

/**
 * Lowers this process's priority; the browsers and encoders it starts afterwards inherit it. `MONTAJ_RENDER_NICE` sets
 * the level (1 to 19), `0` or `off` leaves the priority alone. A refusal is logged and ignored.
 * @returns {{ applied: boolean, level: number }}
 */
export function lowerPriority({ env = process.env, setPriority = os.setPriority, log = () => {} } = {}) {
  const raw = String(env.MONTAJ_RENDER_NICE ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0') return { applied: false, level: 0 }
  const asked = Number.parseInt(raw, 10)
  const level = Number.isInteger(asked) && asked > 0 ? Math.min(19, asked) : RENDER_NICE_DEFAULT
  try {
    setPriority(0, level)
    return { applied: true, level }
  } catch (err) {
    log(`render: could not lower the priority to ${level} (${err && err.message ? err.message : err}); running at normal priority`)
    return { applied: false, level }
  }
}

/**
 * Threads each chunk ffmpeg (PNG decode and FFV1 encode) may use: the cores over the render's workers, at least one. Without
 * a cap every encoder sizes its pools to ALL the cores, so 6 workers on 12 cores ran about 72 busy threads (§698; measured
 * load 42 on 12 cores with 12 encoders). Lossless: threading changes speed, never the frames. `MONTAJ_RENDER_FFMPEG_THREADS`
 * sets it (a positive integer), `0` removes the cap (undefined).
 */
export function ffmpegThreads({ cpus = (typeof availableParallelism === 'function' ? availableParallelism() : os.cpus().length), workers = 1, env = process.env } = {}) {
  const raw = String(env.MONTAJ_RENDER_FFMPEG_THREADS ?? '').trim()
  if (raw === '0') return undefined
  const asked = Number.parseInt(raw, 10)
  if (Number.isInteger(asked) && asked > 0) return asked
  return Math.max(1, Math.floor((Number(cpus) || 1) / Math.max(1, Number(workers) || 1)))
}

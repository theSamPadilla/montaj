/**
 * renderer.js — Puppeteer worker pool.
 * Renders JSX component HTML pages frame-by-frame, produces transparent WebM segments.
 *
 * Worker pool: N Puppeteer browser instances process all segment jobs in parallel.
 * Frame chunking: segments longer than CHUNK_SIZE frames are split, rendered in parallel,
 * then reassembled via ffmpeg concat.
 */
import puppeteer from 'puppeteer'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { spawnSync, spawn } from 'child_process'
import { once } from 'events'
import { homedir } from 'os'
import os from 'os'
import { FFMPEG } from './ffmpeg-bin.js'
import { ffmpegErrorTail } from './ffmpeg-error.js'
import { childKilledError, isChildKilled, syncResultError, CHILD_KILLED_PHASES } from './child-killed.js'
import { adaptiveChunkSize } from './chunk-plan.js'
import { availableMemoryBytes, workerFootprint, planWorkers, createMemoryGovernor, gb, isScene3dSegment, SCENE3D_MAX_WORKERS, SCENE3D_MAX_CHUNK_FRAMES } from './memory.js'
import { toFileHref } from './file-url.js'
import { subframeTimes, motionBlurFilter } from './motion-blur.js'
import { geometryAt } from '@bycrux/timeline-core'
import { overlayPageLaunchOptions, installPageGuard } from './page-guard.js'
import { fontLoadFailure, fontFailureWarning } from './google-fonts.js'
import { captureWithThree, isThreeBlurUnsupported } from './three-frame.js'

const FFMPEG_TIMEOUT_MS  = 600_000


/**
 * Chunk size in OUTPUT frames for a render at `subframes` sub-frames/frame.
 *
 * Motion blur multiplies per-chunk work (N sub-frame captures per output
 * frame), so a chunk sized on output frames alone gets N× more
 * expensive under blur without shrinking. Sizing on `longest * subframes`
 * instead keeps a blurred chunk's actual rendered-image count in the same
 * ballpark as an unblurred one, then converting back down to output frames
 * (`/ subframes`) is what `renderAllSegments` actually chunks segments by.
 *
 * An explicit `configChunkSize` (the `chunkSize` config option) or
 * `userConfigChunkSize` (`~/.montaj/config.json`'s `render.chunkSize`) always
 * wins — this is only the adaptive default.
 *
 * With `subframes === 1` this returns exactly `adaptiveChunkSize(longest,
 * targetWorkers)` — today's behavior, unchanged.
 *
 * Exported for unit testing; `renderAllSegments` is the only production caller.
 */
export function resolveChunkSize(longest, targetWorkers, subframes, configChunkSize, userConfigChunkSize) {
  if (configChunkSize != null) return configChunkSize
  if (userConfigChunkSize != null) return userConfigChunkSize
  return Math.max(1, Math.floor(adaptiveChunkSize(longest * subframes, targetWorkers) / subframes))
}

/**
 * Render all segments using a Puppeteer worker pool.
 *
 * @param {Array<{
 *   id:           string,
 *   htmlPath:     string,
 *   frameCount:   number,
 *   fps:          number,
 *   width:        number,
 *   height:       number,
 *   startSeconds: number,
 *   endSeconds:   number,
 *   outputPath:   string,
 *   boundary:     object,
 *   needsGoogleFonts?: boolean,
 *   propsCache?:  Map<string, { contentType: string, body: Buffer }>,
 * }>} segments
 *   `boundary`, `needsGoogleFonts` and `propsCache` are the page guard's
 *   (page-guard.js): bundleComponent returns the first two, prefetchPropsUrls
 *   the third. A segment with no boundary is refused.
 * @param {{ workers?: number, chunkSize?: number }} [config]
 * @returns {Promise<Array<{ id: string, webmPath: string, startSeconds: number, endSeconds: number }>>}
 */
/**
 * The chunk plan renderAllSegments runs: every segment cut into chunks of
 * `chunkSize` frames, and how many browser workers capture them at once. Also
 * what render.js's disk check (disk-space.js, §128) sizes its estimate from.
 *
 * The worker count is memory.js's planWorkers: the configured count or the
 * cores, lowered to what the memory available now holds at what one worker
 * of these segments holds (workerFootprint), and to SCENE3D_MAX_WORKERS when
 * any segment is 3D. `memory` is that plan, with `footprint`.
 * A 3D segment (isScene3dSegment) is cut at most SCENE3D_MAX_CHUNK_FRAMES
 * output frames a chunk, whatever `chunkSize` says; `chunkSize` is the
 * 2D segments' size.
 * `config.memory` replaces the machine's readings, for tests:
 * `{ readAvailable?: () => bytes, totalBytes?: number }`.
 *
 * @param {Array<{ frameCount: number, opaque?: boolean, props?: object }>} segments
 * @param {{ workers?: number, chunkSize?: number, motionBlur?: number, memory?: object }} [config]
 * @returns {{ jobs: object[], workerCount: number, chunkSize: number, subframes: number, memory: object }}
 */
export function planChunks(segments, config = {}) {
  const userConfig    = readMontajConfig()
  const longest       = segments.reduce((m, s) => Math.max(m, s.frameCount), 0)
  const targetWorkers = config.workers ?? userConfig.render?.workers ?? os.cpus().length
  // Computed before chunkSize so the default can size on sub-frames — see
  // resolveChunkSize's doc comment.
  const subframes     = Math.max(1, Math.trunc(Number(config.motionBlur) || 1))
  const chunkSize     = resolveChunkSize(longest, targetWorkers, subframes, config.chunkSize, userConfig.render?.chunkSize)

  // A 3D segment's chunk is the cap, or an explicit chunk size under it, never the adaptive default: that one is
  // divided by the sub-frames for a capture per sub-frame, and a 3D page averages its sub-frames and captures once
  // per frame, so it would only pay more fresh browsers and more physics replayed from t=0.
  const explicitChunk = config.chunkSize ?? userConfig.render?.chunkSize
  const chunk3d       = Math.max(1, Math.min(explicitChunk ?? SCENE3D_MAX_CHUNK_FRAMES, SCENE3D_MAX_CHUNK_FRAMES))

  // Expand segments into per-chunk jobs
  const jobs = []
  for (const seg of segments) {
    const opaque = seg.opaque ?? false
    const segChunk = isScene3dSegment(seg) ? chunk3d : chunkSize
    if (seg.frameCount > segChunk) {
      const numChunks = Math.ceil(seg.frameCount / segChunk)
      for (let i = 0; i < numChunks; i++) {
        const frameStart = i * segChunk
        const frameEnd   = Math.min(frameStart + segChunk, seg.frameCount)
        jobs.push({ ...seg, opaque, subframes, frameStart, frameEnd, chunkIndex: i, totalChunks: numChunks })
      }
    } else {
      jobs.push({ ...seg, opaque, subframes, frameStart: 0, frameEnd: seg.frameCount, chunkIndex: 0, totalChunks: 1 })
    }
  }

  const footprint = workerFootprint(segments)
  const memory = {
    ...planWorkers({
      target:         targetWorkers,
      jobs:           jobs.length,
      availableBytes: jobs.length > 0 ? (config.memory?.readAvailable ?? availableMemoryBytes)() : 0,
      totalBytes:     config.memory?.totalBytes ?? os.totalmem(),
      perWorkerBytes: footprint.bytes,
      has3d:          footprint.has3d,
    }),
    footprint,
  }
  return { jobs, workerCount: memory.workers, chunkSize, subframes, memory }
}

/** The lines that say why the render runs fewer workers than it asked for, and what a 3D worker is estimated to hold. */
export function memoryPlanLines(memory) {
  const lines = []
  const { footprint: f } = memory
  if (f?.kind === '3d') {
    const s = f.scene
    const mb = (bytes) => `${Math.round(bytes / 1e6)}MB`
    lines.push(`3d worker estimate=${gb(f.bytes)} from=${s.from} text=${mb(s.textBytes)} textures=${s.textures} (${mb(s.textureBytes)} decoded)`)
  }
  if (memory.limitedBy === 'memory') {
    lines.push(`workers lowered by memory: available=${gb(memory.availableBytes)} reserve=${gb(memory.reserveBytes)} perWorker=${gb(memory.perWorkerBytes)} workers=${memory.workers} (asked ${memory.asked})`)
  } else if (memory.limitedBy === '3d') {
    lines.push(`workers capped for 3d: one GPU draws every worker, workers=${memory.workers} (asked ${memory.asked}, cap ${SCENE3D_MAX_WORKERS})`)
  }
  return lines
}

/**
 * The bake's one overall counter: every output frame any worker writes, across
 * every chunk in flight. The per-frame lines (`progressBar`) name only the
 * segment, and a segment's chunks run on several workers at once, so a reader
 * cannot add them up; this line it can. Logged as `baked <n>/<total> frames`
 * at most once per whole percent, so a long render adds about a hundred lines.
 * A chunk that runs again never pushes it past the total.
 *
 * @param {{ total: number, log: (msg: string) => void }} opts
 * @returns {() => void} call once per output frame written
 */
export function createBakeProgress({ total, log: write }) {
  let done = 0
  let lastPct = -1
  return () => {
    if (!(total > 0)) return
    done = Math.min(total, done + 1)
    const pct = Math.floor((done / total) * 100)
    if (pct === lastPct) return
    lastPct = pct
    write(`baked ${done}/${total} frames`)
  }
}

let lastPlan = null
/** The worker count and chunk size the running render planned; null until it has. */
export function currentRenderPlan() { return lastPlan }

export async function renderAllSegments(segments, config = {}) {
  lastPlan = null // never the last render's plan
  if (segments.length === 0) return []
  for (const seg of segments) {
    if (!seg.boundary || typeof seg.boundary.allows !== 'function') {
      throw new TypeError(`renderAllSegments: segment ${seg.id} has no read boundary (bundleComponent returns one)`)
    }
  }

  const { jobs, workerCount, chunkSize, memory } = planChunks(segments, config)
  lastPlan = { workers: workerCount, chunkFrames: chunkSize }
  const noteFrame = createBakeProgress({ total: jobs.reduce((n, j) => n + (j.frameEnd - j.frameStart), 0), log })
  log(`workers=${workerCount} chunk=${chunkSize}`)
  for (const line of memoryPlanLines(memory)) log(line)
  // Test seams: the browser a worker runs and how it renders a chunk.
  const launchWorker = config.launchWorker ?? launchWorkerBrowser
  const renderJob = config.renderJob ?? renderChunk
  // The resolver rule is per browser, and one pool renders every segment, so
  // the font hosts resolve when ANY page links Google Fonts. Each page's guard
  // still lets them through only for a page that links them.
  const needsGoogleFonts = segments.some(s => s.needsGoogleFonts)

  log(`launching ${workerCount} browser worker(s) for ${jobs.length} job(s)...`)

  // Launch browser pool
  const workers = await launchPool(workerCount, () => launchWorker({ needsGoogleFonts }))

  log(`browsers ready`)

  // chunkResults[segId][chunkIndex] = webmPath
  const chunkResults = new Map()
  const queue = [...jobs]
  let jobsDone = 0

  const RECYCLE_AFTER = 5  // restart browser every N jobs to prevent memory bloat
  // and after every 3D chunk: a fresh browser per 3D chunk bounds a leaking
  // GPU process's growth to one short chunk (SCENE3D_MAX_CHUNK_FRAMES, memory.js).

  // Before each chunk a worker reads the memory again, and waits while its
  // chunk would take the machine below the reserve (memory.js). A worker
  // alone never waits; a chunk in flight is never stopped.
  const governor = createMemoryGovernor({
    perWorkerBytes: memory.perWorkerBytes,
    reserveBytes:   memory.reserveBytes,
    readAvailable:  config.memory?.readAvailable ?? availableMemoryBytes,
    ...(config.memory?.pollMs != null ? { pollMs: config.memory.pollMs } : {}),
    log,
  })

  // §128: the first failed chunk fails the render, but only once every worker
  // has stopped: the other browsers are closed at once (their chunk in
  // flight then fails too), each chunk's ffmpeg is stopped and its partial MKV removed on its way out,
  // and each browser's profile with it. Failing the moment the first chunk
  // failed left encoders and profiles behind when the process exited.
  // Every close here is the worker's own close() (PL83), so none of them is
  // taken for a Chrome the system killed.
  const live = new Set(workers)
  let firstFailure = null
  const settled = await Promise.allSettled(
    workers.map(async (worker, workerIdx) => {
      let current = worker
      let jobsOnThisBrowser = 0
      try {
      while (await governor.acquire(`worker ${workerIdx}`, () => queue.length > 0)) {
        const job = queue.shift()
        // Another worker can take the last job between the acquire and here.
        if (!job) { governor.release(); break }
        const label = job.totalChunks > 1
          ? `${job.id} chunk ${job.chunkIndex + 1}/${job.totalChunks}`
          : job.id
        log(`rendering ${label} (${job.frameEnd - job.frameStart} frames)...`)
        let webmPath
        try {
          ({ webmPath } = await renderJob(current, job, { onFrame: noteFrame }))
        } finally {
          governor.release()
        }
        jobsDone++
        jobsOnThisBrowser++
        log(`encoded ${label} (${jobsDone}/${jobs.length} done)`)
        if (!chunkResults.has(job.id)) chunkResults.set(job.id, [])
        chunkResults.get(job.id)[job.chunkIndex] = webmPath

        // Recycle browser to flush memory after RECYCLE_AFTER jobs, or after any 3D job
        const after3d = isScene3dSegment(job)
        if ((after3d || jobsOnThisBrowser >= RECYCLE_AFTER) && queue.length > 0) {
          live.delete(current)
          await current.close()
          current = await launchWorker({ needsGoogleFonts })
          live.add(current)
          jobsOnThisBrowser = 0
          log(`worker ${workerIdx}: browser recycled${after3d ? ' after a 3d chunk' : ''}`)
        }
      }
      } catch (err) {
        // A failed chunk fails the render (§128): the other workers start no
        // new chunk, so a full disk is not filled further, and stop the one
        // they are on.
        queue.length = 0
        if (!firstFailure) {
          firstFailure = err
          for (const other of live) if (other !== current) other.close().catch(() => {})
        }
        throw err
      } finally {
        live.delete(current)
        await current.close().catch(() => {})
      }
    })
  )
  if (firstFailure) throw firstFailure
  const failed = settled.find(r => r.status === 'rejected')
  if (failed) throw failed.reason

  // Reassemble multi-chunk segments
  const results = []
  for (const seg of segments) {
    const chunks = chunkResults.get(seg.id) || []
    let webmPath
    if (chunks.length === 1) {
      webmPath = chunks[0]
    } else {
      mkdirSync(dirname(seg.outputPath), { recursive: true })
      webmPath = concatChunks(chunks, seg.outputPath)
    }
    results.push({ id: seg.id, webmPath, startSeconds: seg.startSeconds, endSeconds: seg.endSeconds, opaque: seg.opaque ?? false })
  }

  return results
}

// ---------------------------------------------------------------------------
// A worker's Chrome (PL83)
// ---------------------------------------------------------------------------

/** How long a dropped connection waits for Chrome's exit, which carries the signal. */
const CHROME_EXIT_WAIT_MS = 1000

/**
 * A stop from outside is not a kill (PL83 review). Serve cancels a render, or
 * supersedes it with a newer export, by SIGTERM to its process group (Chrome
 * runs in a group of its own). Puppeteer's own SIGTERM/SIGHUP handler (on by
 * default) then keeps Node alive and SIGKILLs each Chrome's group itself,
 * around the worker's close(), so the death read as the system killing
 * Chrome. One listener per signal, installed while any worker is live, marks
 * every live worker closing first and remembers the signal for stopSignal().
 * One per browser would print MaxListenersExceededWarning past 10 workers.
 * A live worker is a live Chrome, so Puppeteer's handler is always installed
 * beside this one, which therefore never keeps Node alive on a SIGTERM alone.
 */
const STOP_SIGNALS = ['SIGTERM', 'SIGHUP']
const liveWorkers = new Map() // worker → marks it closing
let stopSignalSeen = null

function onStopSignal(signal) {
  stopSignalSeen ??= signal
  for (const markClosing of liveWorkers.values()) markClosing()
}

function trackWorker(worker, markClosing) {
  if (liveWorkers.size === 0) for (const s of STOP_SIGNALS) process.on(s, onStopSignal)
  liveWorkers.set(worker, markClosing)
}

function untrackWorker(worker) {
  if (!liveWorkers.delete(worker) || liveWorkers.size > 0) return
  for (const s of STOP_SIGNALS) process.off(s, onStopSignal)
}

/** The SIGTERM or SIGHUP that stopped this process from outside while a worker was live, or null. */
export function stopSignal() { return stopSignalSeen }

/**
 * Launches `count` workers at once. If any launch fails, every worker that did
 * launch is closed before the first failure is thrown (§240): with a bare
 * Promise.all the render failed on the first rejection and a sibling's Chrome,
 * launched or still launching, outlived the process (MEASURED 2026-10-14: a
 * second worker's 6 processes, reparented to launchd, after render.js exited).
 * Waits for every launch to settle, so a sibling still starting is closed too
 * (puppeteer itself kills a launch that times out).
 *
 * @template W
 * @param {number} count
 * @param {(index: number) => Promise<W & { close: () => Promise<void> }>} launch
 * @returns {Promise<W[]>}
 */
export async function launchPool(count, launch) {
  const settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => launch(i)))
  const failed = settled.find(s => s.status === 'rejected')
  if (!failed) return settled.map(s => s.value)
  await Promise.allSettled(settled.filter(s => s.status === 'fulfilled').map(s => s.value.close()))
  throw failed.reason
}

/**
 * One worker's Chrome, launched with every overlay page's flags (page-guard.js),
 * --disable-dev-shm-usage included: the sidecar container's /dev/shm is the
 * 64MB Docker default, which a 4K (2160x3840) render overruns.
 *
 * A Chrome the system kills (for memory, a SIGKILL) is told apart from one the
 * engine closes: every close the engine makes (recycle, close-on-failure, the
 * siblings of a failed worker) goes through `close()`, which marks the browser
 * as closing first, and only a death while not closing calls `onDeath`, with
 * `{ signal, code, reason }`. A page passed to `watchPage()` whose renderer
 * dies calls it too, with `signal: null` (Chrome reports a crash, not why), and
 * `reason: 'page-crash'`; the browser itself stays up. `dead` holds the
 * browser's death once seen. A SIGTERM or SIGHUP to the process marks every
 * live worker closing (onStopSignal), so a cancel is never a death either.
 *
 * MEASURED (puppeteer 22.15, Chrome 127): on a SIGKILL the connection drops
 * ~1 ms before the process's exit is seen, so a drop waits for the exit (up
 * to CHROME_EXIT_WAIT_MS) to learn the signal.
 *
 * @param {{ needsGoogleFonts?: boolean }} [opts]
 */
export async function launchWorkerBrowser({ needsGoogleFonts = false } = {}) {
  const browser = await puppeteer.launch(overlayPageLaunchOptions({ needsGoogleFonts, disableWebSecurity: true }))
  const proc = browser.process()
  let closing = false
  let dead = null
  let exitWait = null
  const listeners = new Set()
  const worker = {
    browser, close, onDeath, watchPage, deathWithin,
    get dead() { return dead },
    get closing() { return closing },
  }

  const notify = info => {
    if (closing) return
    for (const cb of [...listeners]) cb(info)
  }
  const die = info => {
    clearTimeout(exitWait)
    if (closing || dead) return
    dead = info
    notify(info)
  }

  const exited = (code, signal) => {
    untrackWorker(worker)
    die({ reason: 'exit', signal: signal ?? null, code: code ?? null })
  }
  trackWorker(worker, () => { closing = true; clearTimeout(exitWait) })
  if (proc && (proc.exitCode !== null || proc.signalCode !== null)) exited(proc.exitCode, proc.signalCode)
  else proc?.once('exit', exited)
  browser.on('disconnected', () => {
    if (closing || dead) return
    if (!proc) return die({ reason: 'disconnected', signal: null, code: null })
    exitWait = setTimeout(() => die({ reason: 'disconnected', signal: proc.signalCode ?? null, code: proc.exitCode ?? null }), CHROME_EXIT_WAIT_MS)
    exitWait.unref?.()
  })

  /** Calls `cb(info)` on a death the engine did not cause; returns the unsubscribe. */
  function onDeath(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  /** Makes `page`'s crash a death of this worker. */
  function watchPage(page) {
    page.on('error', err => notify({ reason: 'page-crash', signal: null, code: null, message: err?.message }))
    return page
  }

  /** The engine's own close: never a death. Quiet on a browser already dead. */
  async function close() {
    closing = true
    clearTimeout(exitWait)
    untrackWorker(worker)
    try {
      await browser.close()
    } catch (err) {
      if (!dead) throw err
    }
  }

  /**
   * The death, if Chrome is dead or dies within `ms`; null at once while
   * closing. For a call that failed just before its death was seen.
   */
  function deathWithin(ms) {
    if (dead) return Promise.resolve(dead)
    if (closing) return Promise.resolve(null)
    return new Promise(resolve => {
      const off = onDeath(info => { clearTimeout(t); off(); resolve(info) })
      const t = setTimeout(() => { off(); resolve(closing ? null : dead) }, ms)
    })
  }

  return worker
}

/** The child_killed error of a Chrome death seen during `phase`. */
function chromeKilledError(info, phase, what) {
  const how = info.reason === 'page-crash' ? 'Chrome\'s overlay page crashed'
    : info.signal ? `Chrome was killed by ${info.signal}`
    : info.code != null ? `Chrome exited with code ${info.code}`
    : 'Chrome disconnected'
  return childKilledError({ child: 'chrome', signal: info.signal ?? null, phase, message: `${how} (${phase}, ${what})` })
}

/**
 * `work` (a capture in flight on `worker`), unless the worker's Chrome dies
 * first: then a child_killed error, `child: 'chrome'`, with the signal and the
 * phase `phaseOf()` names at that moment. A crashed page's screenshot hangs
 * until protocolTimeout (MEASURED), so the death does not wait for the work.
 * A call that fails with Chrome gone ('Target closed' while not closing) waits
 * briefly for the death to be seen, since the drop comes before the exit.
 */
async function unlessChromeDies(worker, work, phaseOf, what) {
  work.catch(() => {}) // a capture that lost the race rejects later, unawaited
  let off = () => {}
  const died = new Promise((_, reject) => {
    const fail = info => reject(chromeKilledError(info, phaseOf(), what))
    if (worker.dead) fail(worker.dead)
    else off = worker.onDeath(fail)
  })
  try {
    return await Promise.race([work, died])
  } catch (err) {
    if (isChildKilled(err) || worker.closing) throw err
    if (worker.browser.connected && err?.name !== 'TargetCloseError') throw err
    const info = await worker.deathWithin(CHROME_EXIT_WAIT_MS + 500)
    if (info) throw chromeKilledError(info, phaseOf(), what)
    throw err
  } finally {
    off()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * How a Puppeteer overlay capture treats its background.
 *
 * `opaque: true` normally means "this overlay replaces the frame" — so the page
 * background is left alone (the JSX root's CSS owns it) and the capture is
 * encoded `yuv420p` with no alpha plane, which is cheaper and correct for
 * something that covers everything.
 *
 * `transitionTo` breaks that. When an opaque overlay is the INCOMING side of a
 * crossfade it has to fade IN over the section beneath it, and an alpha-less
 * capture cannot: the shim's CSS opacity would fade the component against the
 * browser's own page background, and the composite would have no alpha to blend
 * with even if it did not. So such a capture switches to the transparent path.
 *
 * Only the incoming side needs this. The OUTGOING side of an opaque pair holds
 * at full opacity by design (`timeline-core`'s `fadeShape` — fading it out would
 * reveal black), so it never needs an alpha plane and keeps the cheaper capture.
 *
 * `fades` (§309) breaks it the same way, for any opaque overlay that is not at
 * full opacity for its whole life: a static opacity under 1, or an opacity key
 * below it (an opaque 3D item crossfading out over another). Without alpha its
 * fade showed the page background, never what is beneath it.
 *
 * `format` (§284): how each screenshot is encoded. The screenshot is most of a
 * frame's cost (MEASURED 2026-10-15, a 1080x1920 opaque film at 60 fps: 192 of
 * 219 ms per capture, a 3.4 MB PNG each), so an opaque capture for an SDR
 * master (`job.sdrMaster`: an 8-bit 4:2:0 H.264 MP4) is a JPEG at
 * JPEG_CAPTURE_QUALITY: 75 ms per capture instead of 224. Chrome's JPEG is
 * 4:2:0 like the master itself, so nothing finer survives the export anyway
 * (fine red and blue text, through yuv420p and crf 18: PSNR 34.8 dB against the
 * PNG path, no visible difference at 3x). Everything else stays PNG: an alpha
 * capture (JPEG has none), and any master that is not that MP4 (HDR, and any
 * later lossless or ProRes export), where the capture keeps every pixel. Never
 * a setting: it follows from the overlay and the export.
 */
export function captureOptionsFor(job) {
  const needsAlpha = !job.opaque || job.transitionTo === true || job.fades === true
  const format = !needsAlpha && job.sdrMaster === true ? 'jpeg' : 'png'
  return { omitBackground: needsAlpha, pixFmt: needsAlpha ? 'yuva420p' : 'yuv420p', format }
}

/** §284: the JPEG quality of an opaque capture for an SDR master (captureOptionsFor). */
export const JPEG_CAPTURE_QUALITY = 95

/**
 * The `page.screenshot` options of a capture (§284). A PNG is written with
 * `optimizeForSpeed`: its compression is lighter, the file bigger, the pixels
 * the same (MEASURED: identical decoded RGBA; 1.27x faster per capture).
 */
export function screenshotOptionsFor(job) {
  const { omitBackground, format } = captureOptionsFor(job)
  return format === 'jpeg'
    ? { type: 'jpeg', quality: JPEG_CAPTURE_QUALITY }
    : { type: 'png', omitBackground, optimizeForSpeed: true }
}

/**
 * One chunk on one worker (launchWorkerBrowser): its frames, captured straight
 * into the ffmpeg that encodes them. Exported for tests.
 *
 * §131: the chunk's ffmpeg starts first and reads the screenshots from its
 * stdin, so no frame touches the disk. Each frame used to be a PNG in TMPDIR
 * until its chunk was encoded, workers x chunk frames at once, and the chunk
 * grows with the longest overlay: GBs for a long captioned video.
 *
 * Any failure (the capture, Chrome, ffmpeg, a props image not served) stops
 * the chunk's ffmpeg and removes its partial MKV before the chunk fails.
 */
export async function renderChunk(worker, job, { onFrame } = {}) {
  // §377: a 3D page that averaged its chunk's first frame but cannot average a later one has the chunk
  // captured again from the start, every sub-frame: its encode then reads n captures per frame.
  let reported = 0
  try {
    return await renderChunkOnce(worker, job, { onFrame: () => { reported++; onFrame?.() } })
  } catch (err) {
    if (!isThreeBlurUnsupported(err) || !blursInPage(job)) throw err
    noteBlurFallback(job, err.reason)
    // The frames already reported are not reported twice.
    let skip = reported
    return renderChunkOnce(worker, { ...job, scene3d: false }, { onFrame: () => { if (skip > 0) skip--; else onFrame?.() } })
  }
}

async function renderChunkOnce(worker, job, { onFrame } = {}) {
  const { id, chunkIndex, outputPath } = job
  const chunkMkv = outputPath.replace(/\.\w+$/, '') + `-chunk-${chunkIndex}.mkv`
  mkdirSync(dirname(chunkMkv), { recursive: true })

  const what = `ffmpeg PNG→ffv1 failed (segment ${id} chunk ${chunkIndex})`
  // §377: the chunk's ffmpeg reads one capture per frame when the page averages
  // a 3D overlay's sub-frames, and every sub-frame when it cannot, which its
  // first frame tells (captureChunkFrames). So such a chunk starts its ffmpeg
  // at its first frame; every other chunk starts it first, as before.
  let sink = null
  let sinkBlursInPage = null
  const sinkFor = (inPage) => {
    if (sink) {
      if (inPage !== sinkBlursInPage) throw new Error(`segment ${id} chunk ${chunkIndex}: its encode reads ${sinkBlursInPage ? 'one capture' : 'every sub-frame'} per frame`)
      return sink
    }
    sinkBlursInPage = inPage
    sink = frameSink(spawnAsync(FFMPEG, chunkEncodeArgs(job, chunkMkv, { blurInPage: inPage }), what, 'overlay-encode'), what)
    return sink
  }
  if (!blursInPage(job)) {
    sinkFor(false)
    if (job.scene3d === true && (job.subframes ?? 1) > 1) noteBlurFallback(job, KEYFRAMES_MOVE)
  }
  try {
    // PL83: a Chrome the system kills mid-capture, or a page whose renderer
    // dies, fails the chunk at once as child_killed, naming the phase.
    const at = { phase: 'overlay-load' }
    const guard = await unlessChromeDies(worker, captureChunkFrames(worker, job, sinkFor, at, onFrame),
      () => at.phase, `segment ${id} chunk ${chunkIndex}`)
    // A props image the page asked for and could not get fails the render,
    // naming it, rather than exporting without it (page-guard.js).
    guard.assertPropsServed()
    await sinkFor(sinkBlursInPage ?? blursInPage(job)).end()
  } catch (err) {
    await sink?.abort()
    rmSync(chunkMkv, { force: true })
    throw err
  }
  return { webmPath: chunkMkv }
}

/**
 * §377: whether `job`'s motion blur is averaged in its page, one capture per
 * frame: a 3D overlay (`scene3d`, render.js) under motion blur. Its page draws
 * each sub-frame and averages them on the GPU (three-bridge.js
 * averageThreeFrames), where N screenshots per frame made a long 3D overlay
 * the slowest thing in a render. Everything else captures every sub-frame and
 * the encode averages them (motionBlurFilter).
 *
 * A 3D item's keyframed move or fade is drawn outside the canvas (bundle.js
 * __bakeStyle, a wrapper div), which the GPU average does not see, so a chunk
 * where a keyframed prop changes within a frame is captured per sub-frame, as
 * before (keyframesSteady). An item with no keyframes, or one whose keyframes
 * hold still through every frame of the chunk (a 0/1 visibility window), is
 * averaged in the page.
 */
export function blursInPage(job) {
  return job.scene3d === true && (job.subframes ?? 1) > 1 && keyframesSteady(job)
}

const KEYFRAMES_MOVE = 'keyframes change within a frame'
const STEADY_EPS = 1e-9
const steadyCache = new WeakMap()

/**
 * Whether, for every output frame of the chunk (frameStart to frameEnd), the
 * item's keyframed geometry has the same value at all of that frame's sub-frame
 * times (subframeTimes). Evaluated with `geometryAt` from @bycrux/timeline-core
 * at `t / fps`, exactly what the page's __bakeStyle calls (bundle.js) with the
 * time __setFrame gets, so the check and the page cannot disagree. Equal means
 * exactly, or within 1e-9.
 */
export function keyframesSteady(job) {
  if (!job.keyframes?.length) return true
  if (steadyCache.has(job)) return steadyCache.get(job)
  const { fps, subframes = 1, frameStart = 0 } = job
  const frameEnd = job.frameEnd ?? job.frameCount ?? frameStart
  // The item as overlayBakeInputs (render.js) hands the page's bake.
  const item = {
    offsetX: job.offsetX ?? 0, offsetY: job.offsetY ?? 0, scale: job.scale ?? 1,
    scaleX: job.scaleX, scaleY: job.scaleY, rotation: job.rotation ?? 0, opacity: job.opacity ?? 1,
    keyframes: job.keyframes,
  }
  const PROPS = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'opacity']
  let steady = true
  outer: for (let frame = frameStart; frame < frameEnd; frame++) {
    const times = subframeTimes(frame, subframes)
    const first = geometryAt(item, 'overlay', times[0] / fps)
    for (let i = 1; i < times.length; i++) {
      const g = geometryAt(item, 'overlay', times[i] / fps)
      if (PROPS.some(k => !(g[k] === first[k] || Math.abs(g[k] - first[k]) <= STEADY_EPS))) { steady = false; break outer }
    }
  }
  steadyCache.set(job, steady)
  return steady
}

/**
 * Writes a chunk's frames into its ffmpeg's stdin (§131). `encode` is the
 * running ffmpeg's promise (spawnAsync), which settles when it exits.
 *
 * `write` awaits 'drain' whenever ffmpeg has not taken the last frame yet.
 * Without that, a capture faster than its encode would pile the frames up in
 * memory instead: the same GBs that used to be on disk.
 *
 * A write to an ffmpeg that has died fails with EPIPE. That error is only
 * recorded, and the exit decides the chunk's error, so a killed ffmpeg still
 * fails as child_killed with phase overlay-encode, and an ffmpeg that failed
 * on its own still names its last lines. A dead ffmpeg is noticed at the next
 * frame, which stops the capture.
 */
export function frameSink(encode, what) {
  // exited first: a failed spawn (EMFILE/ENFILE) rejects `encode` and leaves
  // child.stdin null, and that rejection must be handled before anything else.
  let outcome = null
  const exited = encode.then(() => { outcome = { ok: true } }, err => { outcome = { err } })
  const { stdin } = encode.child ?? {}
  let stdinError = null
  stdin?.on('error', err => { stdinError ??= err })
  // One abort when ffmpeg exits: it settles any wait for 'drain' and removes its listeners.
  const gone = new AbortController()
  exited.then(() => gone.abort())
  const stopped = () => !stdin || outcome !== null || stdinError !== null
  const exitError = async () => {
    await exited
    if (outcome.err) return outcome.err
    const why = stdinError ? ` (${stdinError.code ?? stdinError.message})` : ''
    return new Error(`${what}:\nffmpeg stopped reading the chunk's frames before the last one${why}`)
  }

  return {
    /** One frame, in order; resolves once ffmpeg can take the next. */
    async write(frame) {
      if (stopped()) throw await exitError()
      if (stdin.write(frame)) return
      // once() rejects on the EPIPE, already recorded; an exit settles it too,
      // and then takes its listeners off.
      await once(stdin, 'drain', { signal: gone.signal }).catch(() => {})
      if (stopped()) throw await exitError()
    },
    /** The last frame was written: ffmpeg finishes the MKV. */
    async end() {
      if (stopped()) throw await exitError()
      stdin.end()
      await exited
      if (outcome.err || stdinError) throw await exitError()
    },
    /** The chunk failed: stop its ffmpeg and wait for it to be gone. */
    async abort() {
      stdin?.destroy()
      if (!outcome) encode.child.kill('SIGKILL')
      await exited
    },
  }
}

/**
 * The chunk's encode: PNG screenshots read from stdin (image2pipe) into FFV1
 * in MKV, written to `chunkMkv`. Only the input changed when the frames moved
 * from files to the pipe (§131); everything after `-i` is as it was.
 *
 * yuva420p for transparent overlays; yuv420p for opaque (no alpha needed).
 * FFV1 codec preserves alpha (yuva420p) losslessly.
 *
 * Container choice: MKV with cluster_size_limit + reserve_index_space.
 *   - NUT was used previously to avoid EBML unknown-size clusters, but the NUT muxer
 *     fails to write the end-of-file index for large files (large frames, many frames),
 *     causing "no index at the end" and backward timestamp scan failures during compose.
 *   - MKV with -cluster_size_limit <N> forces finite-size clusters (no unknown-size
 *     EBML elements), fixing the concurrent-decode EBML error that originally drove the
 *     switch to NUT.
 *   - reserve_index_space writes the seek index at the start of the file, ensuring
 *     fast and reliable seeking without a backward scan.
 *   - -g 1: every FFV1 frame is a keyframe — required so the MKV muxer places a
 *     cluster boundary (and thus a cue point) before every frame, enabling accurate
 *     per-frame seeking used by the compose filter graph.
 *
 * `blurInPage` (§377, blursInPage by default): the page averaged each
 * frame's sub-frames itself, so the chunk is one capture per frame, read at
 * fps with no blur graph: exactly the args of the same chunk unblurred. False
 * for a 3D overlay whose page could not, which captures every sub-frame.
 *
 * Exported for tests.
 */
export function chunkEncodeArgs(job, chunkMkv, { blurInPage = blursInPage(job) } = {}) {
  const { fps, subframes = 1 } = job
  const { pixFmt, omitBackground, format } = captureOptionsFor(job)
  // Motion blur off: args are exactly as before (render goldens depend on it).
  const blurVf = blurInPage ? null : motionBlurFilter(subframes, { alpha: omitBackground })
  const inputRate = blurVf ? String(fps * subframes) : String(fps)
  // Chrome writes a transparent capture's fully opaque frames as RGB PNG, the
  // rest as RGBA. ffmpeg rebuilds the filter graph at each flip by default,
  // and the blur graph is stateful: setpts=PTS-STARTPTS restarts at 0, so -r
  // drops the rebuilt graph's frames as late until they catch up (an opaque
  // card vanished from the segment). -reinit_filter 0 keeps one graph; premultiply takes planar
  // formats only, so the scaler ffmpeg inserts ahead of it converts each frame.
  // Not on the opaque path: its captures are always RGB, and tmix there reads
  // the input format directly, so a flip would be misread rather than converted.
  const keepGraph = blurVf && omitBackground ? ['-reinit_filter', '0'] : []
  return [
    '-y',
    ...keepGraph,
    // Each screenshot is a whole PNG (or JPEG, §284: captureOptionsFor); the
    // parser splits the stream into frames, decoded one by one as the files
    // were, RGB or RGBA per frame. A JPEG decodes to full-range YCbCr, which
    // the scale to the chunk's pix_fmt brings to video range.
    '-f',                   'image2pipe',
    '-c:v',                 format === 'jpeg' ? 'mjpeg' : 'png',
    '-framerate',           inputRate,
    '-i',                   'pipe:0',
    ...(blurVf ? ['-vf', blurVf, '-r', String(fps)] : []),
    '-c:v',                 'ffv1',
    '-g',                   '1',           // all-keyframe → MKV places cluster/cue at every frame
    '-pix_fmt',             pixFmt,
    '-f',                   'matroska',
    '-cluster_size_limit',  '2000000',     // finite-size clusters → no EBML unknown-size errors
    '-reserve_index_space', '1000000',     // seek index at file start → no backward scan needed
    chunkMkv,
  ]
}

/**
 * Loads the chunk's page and streams its frames into the chunk's ffmpeg
 * (`sinkFor(blurInPage)`, frameSink: renderChunk); returns its page guard.
 */
async function captureChunkFrames(worker, job, sinkFor, at, onFrame) {
  const { id, htmlPath, width, height, frameStart, frameEnd, captureScale, subframes = 1 } = job

  const page = worker.watchPage(await worker.browser.newPage())
  // A failed page is closed too, so a restarted 3D chunk does not hold two scenes' GPU memory in one browser.
  try {
    // deviceScaleFactor supersamples the capture: the viewport reported to CSS
    // stays width × height, so overlay JSX authored in design pixels lays out
    // identically, while the screenshot comes back at `captureScale`× device
    // pixels. The factor is derived from the output resolution (captureScaleFor,
    // render.js) rather than fixed at 2, so the capture lands on the OUTPUT's own
    // pixel grid — an identity at 4K, native (1×) at 1080p — instead of always
    // capturing at 4K's scale and forcing compose to downscale it for every
    // smaller output. Two cases still capture off the output grid, both
    // deliberately: a sub-1080 output (clamped to 1, so compose scales down from
    // the design canvas) and a project with no `settings.resolution` at all,
    // where the true output size isn't known this early and captureScaleFor
    // returns 2 to preserve today's behaviour rather than guess.
    // This is deliberately NOT done by raising the design canvas
    // — that changes the CSS coordinate space and shrinks every overlay (see
    // SHORT_EDGE_TARGET's comment in render.js). `?? 2` is the pre-existing
    // fixed behavior, kept as a fallback for any caller that doesn't stamp
    // `captureScale` onto its job.
    await page.setViewport({ width, height, deviceScaleFactor: captureScale ?? 2 })

    // Capture page-level JS errors so we can surface them in the render log
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    // A request the page guard aborted is logged by the guard; Chromium's own
    // console line for it is not a page error.
    let isBlockNoise = () => false
    // §140: a family Google refuses, or a font the network cannot fetch, is
    // named in the render log. The render never failed on it (MEASURED: page
    // errors here only explain a page that did not start), it drew the overlay
    // in its fallback font without a word; now it says which family.
    const fontFailures = new Set()
    page.on('console', msg => {
      if (msg.type() !== 'error' || isBlockNoise(msg)) return
      const font = fontLoadFailure({ type: msg.type(), text: msg.text(), url: msg.location()?.url })
      if (!font) { pageErrors.push(msg.text()); return }
      if (!fontFailures.has(font)) { fontFailures.add(font); console.error(fontFailureWarning([font])) }
    })

    // The page guard (page-guard.js) decides every request: a read outside the
    // boundary or a request off the machine is aborted, a props URL is served
    // from the cache. Images are drawn as authored. In an HDR project the whole
    // capture is mapped into the project's colour space at composite time
    // (encode-segment.js, hdr-graphics.js), so an <img> is converted with the CSS
    // around it, once.
    const guard = await installPageGuard(page, {
      boundary:         job.boundary,
      propsCache:       job.propsCache,
      needsGoogleFonts: job.needsGoogleFonts,
    })
    isBlockNoise = guard.isBlockNoise

    // Load the bundled component page (file:// URL).
    //
    // Use 'networkidle0' (not 'load'). The shim's __waitForFonts() inside
    // __setFrame relies on document.fonts.ready, which only reflects woff2
    // fetches that are *in flight at the time of access*. Google Fonts woff2
    // fetches are deferred by Chromium until something in the rendered tree
    // actually uses the font — i.e. until React has committed its initial
    // mount. With 'load', the screenshot loop can start (and call __setFrame)
    // before that commit has flushed, so document.fonts.ready resolves
    // immediately and the first frames paint with the CSS fallback font
    // (which has wider metrics — text overflows the viewport).
    //
    // 'networkidle0' gives Chromium 500ms of network silence to complete the
    // CSS link load → font-face registration → react commit → woff2 fetch
    // → fonts.ready cascade before we touch the page. The interceptor's
    // request.respond() calls do interact with the network-idle heuristic
    // but only on file:// image fetches we replace — remote font fetches
    // (the load-bearing case for networkidle0) go through request.continue()
    // and are unaffected.
    await page.goto(toFileHref(htmlPath), { waitUntil: 'networkidle0' })

    // For transparent overlays, force-clear any background the OS/browser might add.
    // For opaque overlays, skip this — the JSX root's CSS controls the background.
    if (captureOptionsFor(job).omitBackground) {
      await page.evaluate(() => {
        document.documentElement.style.background = 'transparent'
        document.body.style.background = 'transparent'
      })
    }

    // Verify the component mounted successfully
    const ready = await page.evaluate(() => typeof window.__setFrame === 'function')
    if (!ready) {
      const errDetail = pageErrors.length ? pageErrors.join(' | ') : 'no JS errors captured'
      throw new Error(`window.__setFrame not initialized for segment ${id}: ${errDetail}`)
    }

    // Screenshot each frame
    at.phase = 'overlay-capture'
    const totalFrames = frameEnd - frameStart
    const reportEvery = Math.max(1, Math.floor(totalFrames / 20))
    const renderStartMs = Date.now()
    // Everything after the commit of frame (or sub-frame) `f`, up to and
    // including its screenshot.
    const captureAt = (f) => async () => {
      // 2. Wait until the DOM attribute confirms this exact frame has been committed.
      //    This is more reliable than rAF alone — rAF in headless Chrome can fire
      //    before the compositor has flushed, producing stale screenshots.
      await page.waitForFunction(
        (f) => document.documentElement.dataset.renderedFrame === String(f),
        { timeout: 10000 },
        f,
      )
      // 2b. An image the props name with no extension is fetched when the page
      //     asks for it, so wait for it to arrive before capturing this frame
      //     (page-guard.js settleOnDemand; at once when the props name none).
      await guard.settleOnDemand()
      // 2c. And for every image on the page: an overlay that mounts one only
      //     from a later frame inserts it in the commit just made, on a fresh
      //     page at the first frame of every chunk (page-guard.js settleImages).
      //     Capped; past the cap the frame is captured anyway and the image named.
      await guard.settleImages()
      // 3. Double rAF: first fires after layout+paint, second fires after the result
      //    has been composited — guarantees the screenshot sees the current frame.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
      // 4. Into the chunk's ffmpeg (§131): the same bytes a `path`
      //    screenshot wrote to disk. A PNG, or a JPEG for an opaque capture
      //    of an SDR master (§284: screenshotOptionsFor).
      return page.screenshot(screenshotOptionsFor(job))
    }
    const threeOpts = { overlay: overlayName(job), log, pageErrors }
    // §377: a 3D overlay under motion blur averages each frame's sub-frames in
    // its page and is captured once per frame. A page that cannot says so at the
    // chunk's first frame, before its encode starts, and the chunk captures every
    // sub-frame instead. A later frame that cannot be averaged (a canvas that
    // draws itself mounting after the first frame, a context lost) throws
    // three_blur_unsupported, and renderChunk captures the whole chunk again, every
    // sub-frame: the encode already reads one capture per frame, so a frame
    // averaged some other way would not do.
    let inPage = blursInPage(job)
    for (let frame = frameStart; frame < frameEnd; frame++) {
      const localIdx = frame - frameStart
      // With motion blur on, each output frame is `subframes` sub-frames at
      // f + i/subframes (subframeTimes).
      const times = subframeTimes(frame, subframes)
      if (inPage) {
        try {
          // 1. The page sets and draws every sub-frame, draws their average onto
          //    its 3D canvases and stamps the frame on <html>; one capture. A
          //    sub-frame that did not draw retries the frame (three-frame.js).
          const png = await captureWithThree(page, frame, captureAt(frame), { ...threeOpts, subframes: times })
          await sinkFor(true).write(png)
        } catch (err) {
          if (!isThreeBlurUnsupported(err) || frame !== frameStart) throw err
          inPage = false
          noteBlurFallback(job, err.reason)
        }
      }
      if (!inPage) {
        // Each sub-frame is its own screenshot, written in order; the encode
        // averages each group.
        for (let s = 0; s < times.length; s++) {
          const t = times[s]
          // 1. Tell React to update to this frame (flushSync commits DOM synchronously,
          //    draws any 3D canvas and stamps data-rendered-frame on <html> so we can
          //    verify below). A 3D canvas that did not draw the frame, before the
          //    capture or by the end of it, has the frame set and captured again,
          //    then fails the chunk as three_frame_blank (three-frame.js).
          const png = await captureWithThree(page, t, captureAt(t), threeOpts)
          await sinkFor(false).write(png)
        }
      }
      onFrame?.()
      if ((localIdx + 1) % reportEvery === 0 || localIdx + 1 === totalFrames) {
        log(progressBar(id, localIdx + 1, totalFrames, renderStartMs))
      }
    }
    return guard
  } finally {
    await page.close().catch(() => {})
  }
}

/** How a three_frame_blank error names the chunk's overlay: its file and its segment. */
function overlayName(job) {
  return job.componentPath ? `${basename(job.componentPath)} (${job.id})` : job.id
}

// A 3D overlay whose page cannot average its motion blur is named once per
// segment, not once per chunk.
const blurFallbackNamed = new Set()
function noteBlurFallback(job, reason) {
  if (blurFallbackNamed.has(job.id)) return
  blurFallbackNamed.add(job.id)
  log(`${overlayName(job)}: its page cannot average motion blur (${reason}); capturing each sub-frame instead`)
}

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj render]${C.reset} ${msg}\n`)
}

function progressBar(label, done, total, startMs) {
  const BAR_WIDTH = 24
  const pct       = Math.round((done / total) * 100)
  const filled    = Math.round((done / total) * BAR_WIDTH)
  const bar       = '█'.repeat(filled) + ' '.repeat(BAR_WIDTH - filled)
  const elapsed   = (Date.now() - startMs) / 1000
  const rate      = done / Math.max(elapsed, 0.001)
  const remaining = (total - done) / rate
  const fmt = s => {
    const m = Math.floor(s / 60)
    const ss = Math.floor(s % 60)
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }
  const tag = label.length > 24 ? label.slice(-24) : label
  return `  ${tag}  ${String(pct).padStart(3)}%|${bar}| ${done}/${total} [${fmt(elapsed)}<${fmt(remaining)}]`
}

/**
 * Runs ffmpeg; a death by signal rejects child_killed with `phase`, which is
 * required and one of CHILD_KILLED_PHASES (the app reads it).
 *
 * The returned promise carries the process as `.child`, for a caller that
 * writes to its stdin (renderChunk streams a chunk's frames into it, §131).
 * That caller handles stdin's 'error'.
 */
export function spawnAsync(cmd, args, errorPrefix, phase) {
  if (!CHILD_KILLED_PHASES.includes(phase)) {
    throw new TypeError(`spawnAsync: phase ${JSON.stringify(phase)} is not one of CHILD_KILLED_PHASES`)
  }
  let child
  const done = new Promise((resolve, reject) => {
    const proc = child = spawn(cmd, args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', (code, signal) => {
      const message = `${errorPrefix}:\n${ffmpegErrorTail(stderr)}`
      if (signal) reject(childKilledError({ child: 'ffmpeg', signal, phase, message }))
      else if (code !== 0) reject(new Error(message))
      else resolve()
    })
    proc.on('error', reject)
  })
  return Object.assign(done, { child })
}

function readMontajConfig() {
  const configPath = join(homedir(), '.montaj', 'config.json')
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

function concatChunks(chunkPaths, outputPath) {
  const mkvOutput = outputPath.replace(/\.\w+$/, '.mkv')
  const listFile  = mkvOutput + '.chunks.txt'
  writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'))

  const result = spawnSync(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    '-cluster_size_limit',  '2000000',
    '-reserve_index_space', '1000000',
    mkvOutput,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  if (result.status !== 0) {
    const message = `ffmpeg chunk concat failed:\n${ffmpegErrorTail(result.stderr)}`
    throw syncResultError(result, { child: 'ffmpeg', phase: 'chunk-concat', message }) ?? new Error(message)
  }

  for (const p of chunkPaths) rmSync(p, { force: true })
  rmSync(listFile, { force: true })

  return mkvOutput
}

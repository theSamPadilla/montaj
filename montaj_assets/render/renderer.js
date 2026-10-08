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
import { join, dirname } from 'path'
import { spawnSync, spawn } from 'child_process'
import { tmpdir, homedir } from 'os'
import { randomBytes } from 'crypto'
import os from 'os'
import { FFMPEG } from './ffmpeg-bin.js'
import { ffmpegErrorTail } from './ffmpeg-error.js'
import { childKilledError, isChildKilled, syncResultError } from './child-killed.js'
import { adaptiveChunkSize, workerCap } from './chunk-plan.js'
import { toFileHref } from './file-url.js'
import { subframeTimes, motionBlurFilter } from './motion-blur.js'
import { overlayPageLaunchOptions, installPageGuard } from './page-guard.js'
import { fontLoadFailure, fontFailureWarning } from './google-fonts.js'

const FFMPEG_TIMEOUT_MS  = 600_000


/**
 * Chunk size in OUTPUT frames for a render at `subframes` sub-frames/frame.
 *
 * Motion blur multiplies per-chunk work (N sub-frame captures + temp PNGs per
 * output frame), so a chunk sized on output frames alone gets N× more
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
 * what render.js's disk check (disk-space.js, §128) sizes TMPDIR from, since
 * each worker holds its whole chunk's frames until the chunk is encoded.
 *
 * @param {Array<{ frameCount: number, opaque?: boolean }>} segments
 * @param {{ workers?: number, chunkSize?: number, motionBlur?: number }} [config]
 * @returns {{ jobs: object[], workerCount: number, chunkSize: number, subframes: number }}
 */
export function planChunks(segments, config = {}) {
  const userConfig    = readMontajConfig()
  const longest       = segments.reduce((m, s) => Math.max(m, s.frameCount), 0)
  const targetWorkers = config.workers ?? userConfig.render?.workers ?? os.cpus().length
  // Computed before chunkSize so the default can size on sub-frames — see
  // resolveChunkSize's doc comment.
  const subframes     = config.motionBlur ?? 1
  const chunkSize     = resolveChunkSize(longest, targetWorkers, subframes, config.chunkSize, userConfig.render?.chunkSize)

  // Expand segments into per-chunk jobs
  const jobs = []
  for (const seg of segments) {
    const opaque = seg.opaque ?? false
    if (seg.frameCount > chunkSize) {
      const numChunks = Math.ceil(seg.frameCount / chunkSize)
      for (let i = 0; i < numChunks; i++) {
        const frameStart = i * chunkSize
        const frameEnd   = Math.min(frameStart + chunkSize, seg.frameCount)
        jobs.push({ ...seg, opaque, subframes, frameStart, frameEnd, chunkIndex: i, totalChunks: numChunks })
      }
    } else {
      jobs.push({ ...seg, opaque, subframes, frameStart: 0, frameEnd: seg.frameCount, chunkIndex: 0, totalChunks: 1 })
    }
  }

  const workerCount = Math.min(workerCap(targetWorkers, os.totalmem()), jobs.length)
  return { jobs, workerCount, chunkSize, subframes }
}

export async function renderAllSegments(segments, config = {}) {
  if (segments.length === 0) return []
  for (const seg of segments) {
    if (!seg.boundary || typeof seg.boundary.allows !== 'function') {
      throw new TypeError(`renderAllSegments: segment ${seg.id} has no read boundary (bundleComponent returns one)`)
    }
  }

  const { jobs, workerCount } = planChunks(segments, config)
  // The resolver rule is per browser, and one pool renders every segment, so
  // the font hosts resolve when ANY page links Google Fonts. Each page's guard
  // still lets them through only for a page that links them.
  const needsGoogleFonts = segments.some(s => s.needsGoogleFonts)

  log(`launching ${workerCount} browser worker(s) for ${jobs.length} job(s)...`)

  // Launch browser pool
  const workers = await Promise.all(
    Array.from({ length: workerCount }, () => launchWorkerBrowser({ needsGoogleFonts }))
  )

  log(`browsers ready`)

  // chunkResults[segId][chunkIndex] = webmPath
  const chunkResults = new Map()
  const queue = [...jobs]
  let jobsDone = 0

  const RECYCLE_AFTER = 5  // restart browser every N jobs to prevent memory bloat

  // §128: the first failed chunk fails the render, but only once every worker
  // has stopped: the other browsers are closed at once (their chunk in
  // flight then fails too), each chunk's frames are removed on its way out,
  // and each browser's profile with it. Failing the moment the first chunk
  // failed left frames and profiles behind when the process exited.
  // Every close here is the worker's own close() (PL83), so none of them is
  // taken for a Chrome the system killed.
  const live = new Set(workers)
  let firstFailure = null
  const settled = await Promise.allSettled(
    workers.map(async (worker, workerIdx) => {
      let current = worker
      let jobsOnThisBrowser = 0
      try {
      while (true) {
        const job = queue.shift()
        if (!job) break
        const label = job.totalChunks > 1
          ? `${job.id} chunk ${job.chunkIndex + 1}/${job.totalChunks}`
          : job.id
        log(`rendering ${label} (${job.frameEnd - job.frameStart} frames)...`)
        const { webmPath } = await renderChunk(current, job)
        jobsDone++
        jobsOnThisBrowser++
        log(`encoded ${label} (${jobsDone}/${jobs.length} done)`)
        if (!chunkResults.has(job.id)) chunkResults.set(job.id, [])
        chunkResults.get(job.id)[job.chunkIndex] = webmPath

        // Recycle browser to flush memory after RECYCLE_AFTER jobs
        if (jobsOnThisBrowser >= RECYCLE_AFTER && queue.length > 0) {
          live.delete(current)
          await current.close()
          current = await launchWorkerBrowser({ needsGoogleFonts })
          live.add(current)
          jobsOnThisBrowser = 0
          log(`worker ${workerIdx}: browser recycled`)
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
 * browser's death once seen.
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

  proc?.once('exit', (code, signal) => die({ reason: 'exit', signal: signal ?? null, code: code ?? null }))
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

  return {
    browser, close, onDeath, watchPage, deathWithin,
    get dead() { return dead },
    get closing() { return closing },
  }
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
 */
export function captureOptionsFor(job) {
  const needsAlpha = !job.opaque || job.transitionTo === true
  return { omitBackground: needsAlpha, pixFmt: needsAlpha ? 'yuva420p' : 'yuv420p' }
}

/**
 * One chunk on one worker (launchWorkerBrowser): capture its frames, encode
 * them. Exported for tests.
 */
export async function renderChunk(worker, job) {
  const { id, chunkIndex } = job

  const frameDir = join(tmpdir(), `montaj-frames-${id}-c${chunkIndex}-${randomBytes(4).toString('hex')}`)
  mkdirSync(frameDir, { recursive: true })
  // Removed on every way out (§128): a chunk that failed, a full disk
  // included, used to leave its frames behind for the next attempt to trip on.
  try {
    return await captureAndEncodeChunk(worker, job, frameDir)
  } finally {
    rmSync(frameDir, { recursive: true, force: true })
  }
}

async function captureAndEncodeChunk(worker, job, frameDir) {
  const { id, chunkIndex } = job

  // PL83: a Chrome the system kills mid-capture, or a page whose renderer
  // dies, fails the chunk at once as child_killed, naming the phase.
  const at = { phase: 'overlay-load' }
  const guard = await unlessChromeDies(worker, captureChunkFrames(worker, job, frameDir, at),
    () => at.phase, `segment ${id} chunk ${chunkIndex}`)
  // A props image the page asked for and could not get fails the render,
  // naming it, rather than exporting without it (page-guard.js).
  guard.assertPropsServed()

  return encodeChunkFrames(job, frameDir)
}

/** Loads the chunk's page and screenshots its frames into `frameDir`; returns its page guard. */
async function captureChunkFrames(worker, job, frameDir, at) {
  const { id, htmlPath, width, height, frameStart, frameEnd, captureScale, subframes = 1 } = job

  const page = worker.watchPage(await worker.browser.newPage())
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
  for (let frame = frameStart; frame < frameEnd; frame++) {
    const localIdx = frame - frameStart
    // With motion blur on, each output frame captures `subframes` screenshots at
    // f + i/subframes, numbered consecutively; the encode averages each group.
    const times = subframeTimes(frame, subframes)
    for (let s = 0; s < times.length; s++) {
      const t = times[s]
      // 1. Tell React to update to this frame (flushSync commits DOM synchronously
      //    and stamps data-rendered-frame on <html> so we can verify below).
      await page.evaluate((f) => window.__setFrame(f), t)
      // 2. Wait until the DOM attribute confirms this exact frame has been committed.
      //    This is more reliable than rAF alone — rAF in headless Chrome can fire
      //    before the compositor has flushed, producing stale screenshots.
      await page.waitForFunction(
        (f) => document.documentElement.dataset.renderedFrame === String(f),
        { timeout: 10000 },
        t,
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
      const shotIdx = localIdx * subframes + s
      const framePath = join(frameDir, `frame-${String(shotIdx).padStart(6, '0')}.png`)
      await page.screenshot({ path: framePath, omitBackground: captureOptionsFor(job).omitBackground })
    }
    if ((localIdx + 1) % reportEvery === 0 || localIdx + 1 === totalFrames) {
      log(progressBar(id, localIdx + 1, totalFrames, renderStartMs))
    }
  }

  await page.close()
  return guard
}

/** Encodes a captured chunk's PNG sequence into its FFV1 MKV. */
async function encodeChunkFrames(job, frameDir) {
  const { id, fps, chunkIndex, outputPath, subframes = 1 } = job

  // Encode PNG sequence → FFV1 in MKV.
  // yuva420p for transparent overlays; yuv420p for opaque (no alpha needed).
  // FFV1 codec preserves alpha (yuva420p) losslessly.
  //
  // Container choice: MKV with cluster_size_limit + reserve_index_space.
  //   - NUT was used previously to avoid EBML unknown-size clusters, but the NUT muxer
  //     fails to write the end-of-file index for large files (large frames, many frames),
  //     causing "no index at the end" and backward timestamp scan failures during compose.
  //   - MKV with -cluster_size_limit <N> forces finite-size clusters (no unknown-size
  //     EBML elements), fixing the concurrent-decode EBML error that originally drove the
  //     switch to NUT.
  //   - reserve_index_space writes the seek index at the start of the file, ensuring
  //     fast and reliable seeking without a backward scan.
  //   - -g 1: every FFV1 frame is a keyframe — required so the MKV muxer places a
  //     cluster boundary (and thus a cue point) before every frame, enabling accurate
  //     per-frame seeking used by the compose filter graph.
  const chunkMkv = outputPath.replace(/\.\w+$/, '') + `-chunk-${chunkIndex}.mkv`
  mkdirSync(dirname(chunkMkv), { recursive: true })

  const { pixFmt, omitBackground } = captureOptionsFor(job)
  // Motion blur off: args are exactly as before (render goldens depend on it).
  const blurVf = motionBlurFilter(subframes, { alpha: omitBackground })
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
  await spawnAsync(FFMPEG, [
    '-y',
    ...keepGraph,
    '-framerate',           inputRate,
    '-i',                   join(frameDir, 'frame-%06d.png'),
    ...(blurVf ? ['-vf', blurVf, '-r', String(fps)] : []),
    '-c:v',                 'ffv1',
    '-g',                   '1',           // all-keyframe → MKV places cluster/cue at every frame
    '-pix_fmt',             pixFmt,
    '-f',                   'matroska',
    '-cluster_size_limit',  '2000000',     // finite-size clusters → no EBML unknown-size errors
    '-reserve_index_space', '1000000',     // seek index at file start → no backward scan needed
    chunkMkv,
  ], `ffmpeg PNG→ffv1 failed (segment ${id} chunk ${chunkIndex})`)

  return { webmPath: chunkMkv }
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

export function spawnAsync(cmd, args, errorPrefix, phase = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
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

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

const DEFAULT_CHUNK_SIZE = 1000
const FFMPEG_TIMEOUT_MS  = 600_000


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
 * }>} segments
 * @param {{ workers?: number, chunkSize?: number }} [config]
 * @returns {Promise<Array<{ id: string, webmPath: string, startSeconds: number, endSeconds: number }>>}
 */
export async function renderAllSegments(segments, config = {}) {
  if (segments.length === 0) return []

  const userConfig = readMontajConfig()
  const chunkSize  = config.chunkSize ?? userConfig.render?.chunkSize ?? DEFAULT_CHUNK_SIZE

  // Expand segments into per-chunk jobs
  const jobs = []
  for (const seg of segments) {
    const opaque = seg.opaque ?? false
    if (seg.frameCount > chunkSize) {
      const numChunks = Math.ceil(seg.frameCount / chunkSize)
      for (let i = 0; i < numChunks; i++) {
        const frameStart = i * chunkSize
        const frameEnd   = Math.min(frameStart + chunkSize, seg.frameCount)
        jobs.push({ ...seg, opaque, frameStart, frameEnd, chunkIndex: i, totalChunks: numChunks })
      }
    } else {
      jobs.push({ ...seg, opaque, frameStart: 0, frameEnd: seg.frameCount, chunkIndex: 0, totalChunks: 1 })
    }
  }

  const workerCount = Math.min(config.workers ?? userConfig.render?.workers ?? os.cpus().length, jobs.length)

  log(`launching ${workerCount} browser worker(s) for ${jobs.length} job(s)...`)

  // Launch browser pool
  const browsers = await Promise.all(
    Array.from({ length: workerCount }, () => launchBrowser())
  )

  log(`browsers ready`)

  // chunkResults[segId][chunkIndex] = webmPath
  const chunkResults = new Map()
  const queue = [...jobs]
  let jobsDone = 0

  const RECYCLE_AFTER = 5  // restart browser every N jobs to prevent memory bloat

  async function launchBrowser() {
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
      protocolTimeout: 120000,
    })
  }

  await Promise.all(
    browsers.map(async (browser, workerIdx) => {
      let currentBrowser = browser
      let jobsOnThisBrowser = 0
      while (true) {
        const job = queue.shift()
        if (!job) break
        const label = job.totalChunks > 1
          ? `${job.id} chunk ${job.chunkIndex + 1}/${job.totalChunks}`
          : job.id
        log(`rendering ${label} (${job.frameEnd - job.frameStart} frames)...`)
        const webmPath = await renderChunk(currentBrowser, job)
        jobsDone++
        jobsOnThisBrowser++
        log(`encoded ${label} (${jobsDone}/${jobs.length} done)`)
        if (!chunkResults.has(job.id)) chunkResults.set(job.id, [])
        chunkResults.get(job.id)[job.chunkIndex] = webmPath

        // Recycle browser to flush memory after RECYCLE_AFTER jobs
        if (jobsOnThisBrowser >= RECYCLE_AFTER && queue.length > 0) {
          await currentBrowser.close()
          currentBrowser = await launchBrowser()
          jobsOnThisBrowser = 0
          log(`worker ${workerIdx}: browser recycled`)
        }
      }
      await currentBrowser.close()
    })
  )

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
// Internal helpers
// ---------------------------------------------------------------------------

async function renderChunk(browser, job) {
  const { id, htmlPath, fps, width, height, frameStart, frameEnd, chunkIndex, outputPath } = job

  const frameDir = join(tmpdir(), `montaj-frames-${id}-c${chunkIndex}-${randomBytes(4).toString('hex')}`)
  mkdirSync(frameDir, { recursive: true })

  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })

  // Capture page-level JS errors so we can surface them in the render log
  const pageErrors = []
  page.on('pageerror', err => pageErrors.push(err.message))
  page.on('console', msg => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

  // Load the bundled component page (file:// URL)
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' })

  // For transparent overlays, force-clear any background the OS/browser might add.
  // For opaque overlays, skip this — the JSX root's CSS controls the background.
  if (!job.opaque) {
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
  const totalFrames = frameEnd - frameStart
  const reportEvery = Math.max(1, Math.floor(totalFrames / 20))
  const renderStartMs = Date.now()
  for (let frame = frameStart; frame < frameEnd; frame++) {
    // 1. Tell React to update to this frame (flushSync commits DOM synchronously
    //    and stamps data-rendered-frame on <html> so we can verify below).
    await page.evaluate((f) => window.__setFrame(f), frame)
    // 2. Wait until the DOM attribute confirms this exact frame has been committed.
    //    This is more reliable than rAF alone — rAF in headless Chrome can fire
    //    before the compositor has flushed, producing stale screenshots.
    await page.waitForFunction(
      (f) => document.documentElement.dataset.renderedFrame === String(f),
      { timeout: 10000 },
      frame,
    )
    // 3. Double rAF: first fires after layout+paint, second fires after the result
    //    has been composited — guarantees the screenshot sees the current frame.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const localIdx = frame - frameStart
    const framePath = join(frameDir, `frame-${String(localIdx).padStart(6, '0')}.png`)
    await page.screenshot({ path: framePath, omitBackground: !job.opaque })
    if ((localIdx + 1) % reportEvery === 0 || localIdx + 1 === totalFrames) {
      log(progressBar(id, localIdx + 1, totalFrames, renderStartMs))
    }
  }

  await page.close()

  // Encode PNG sequence → VP9 WebM
  // yuva420p for transparent overlays; yuv420p for opaque (no alpha needed).
  // -auto-alt-ref 0 is required when encoding yuva420p — VP9 alpha doesn't support alt-ref frames.
  // NUT container: simpler than MKV, no EBML unknown-size elements, reliable under
  // concurrent decode. FFV1 codec preserves alpha (yuva420p) losslessly.
  const chunkNut = outputPath.replace(/\.\w+$/, '') + `-chunk-${chunkIndex}.nut`
  mkdirSync(dirname(chunkNut), { recursive: true })

  const pixFmt = job.opaque ? 'yuv420p' : 'yuva420p'
  await spawnAsync('ffmpeg', [
    '-y',
    '-framerate', String(fps),
    '-i',         join(frameDir, 'frame-%06d.png'),
    '-c:v',       'ffv1',
    '-pix_fmt',   pixFmt,
    '-f',         'nut',
    chunkNut,
  ], `ffmpeg PNG→ffv1 failed (segment ${id} chunk ${chunkIndex})`)

  rmSync(frameDir, { recursive: true, force: true })

  return chunkNut
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

function spawnAsync(cmd, args, errorPrefix) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${errorPrefix}:\n${stderr}`))
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
  const webmOutput = outputPath.replace(/\.\w+$/, '.nut')
  const listFile   = webmOutput + '.chunks.txt'
  writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'))

  const result = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy',
    webmOutput,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  if (result.status !== 0) {
    throw new Error(`ffmpeg chunk concat failed:\n${result.stderr}`)
  }

  for (const p of chunkPaths) rmSync(p, { force: true })
  rmSync(listFile, { force: true })

  return webmOutput
}

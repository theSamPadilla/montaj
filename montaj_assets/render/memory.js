/**
 * memory.js: how many browser workers a render can afford, from the memory the
 * machine has free NOW and what each worker will hold, and a governor that
 * holds a worker back from its next chunk while memory is short.
 *
 * MEASURED 2026-10-17 (a 36 GB Apple silicon Mac): a heavy 3D render opened 12
 * headless Chromes, one per core. Their GPU processes held 1.8 to 9.8 GB each,
 * about 77 GB together, each renderer about 1.6 GB more, and swap reached
 * 14.9 GB. The cap then was the machine's TOTAL memory over a 2D worker's
 * 1.5 GB (24 workers on 36 GB), so it never bound, and a 3D worker holds far
 * more than a 2D one.
 *
 * Every budget is here, with what it is calibrated against.
 */
import os from 'os'
import { readFileSync, statSync } from 'fs'
import { spawnSync } from 'child_process'

const GB = 1e9

/**
 * A 2D overlay or caption worker: a 4K (2160x3840) headless-Chrome capture.
 * The budget the render has always used (chunk-plan.js, before this file).
 * A segment's own 2D budget scales it by its capture's pixels over 4K's
 * (captureWorkerBytes), never below PER_WORKER_MIN_BYTES. PROVISIONAL: the
 * scaling and the floor are not measured; the floor stands for Chrome's own
 * cost, which a smaller capture does not shrink.
 */
export const PER_WORKER_BYTES = 1.5 * GB
export const PER_WORKER_MIN_BYTES = 0.75 * GB
const CAPTURE_4K_PIXELS = 3840 * 2160

/**
 * What a render leaves to everything else on the machine: 4 GB, or a quarter
 * of the total when that is more (9.7 GB on a 36 GB Mac). Workers are planned
 * only into what is available above it, and the governor holds a worker back
 * when its next chunk would go below it.
 */
export const RESERVE_MIN_BYTES = 4 * GB
export const RESERVE_SHARE = 0.25

/**
 * A render with any 3D in it runs at most this many workers, whatever the
 * memory. One GPU draws every worker's scene: parallel WebGL contexts contend
 * for it, so more workers buy little speed, and each holds its own copy of the
 * scene on the GPU (the 12 workers measured above).
 */
export const SCENE3D_MAX_WORKERS = 2

/**
 * A 3D segment is cut into chunks of at most this many OUTPUT frames, and
 * each chunk runs on a fresh browser (renderer.js). Chrome's GPU process can
 * leak about 41 MB per frame within one page, intermittently, when a CSS
 * filter sits over the WebGL canvas (R-leak, 2026-10-17; older generated
 * stage bundles may have one), so growth within a chunk is unbounded but by
 * its length: 120 frames bounds it to about 5 GB. Short chunks do not change
 * the output: the stage is deterministic in the frame's time (verified
 * 2026-10-17 by probing a fresh page at each chunk start against a
 * continuous run, bit for bit, physics included).
 */
export const SCENE3D_MAX_CHUNK_FRAMES = 120

/**
 * A 3D segment whose scene this file cannot read (a stage bundle it cannot
 * stat, or no file at all): priced at the heaviest 3D worker measured, the
 * park-notes stage's 3.6 GB (cf P0, 2026-10-17, below), so an unknown scene
 * is budgeted as the worst one known rather than as 2D.
 */
export const SCENE3D_UNKNOWN_BYTES = 3.6 * GB

/**
 * A 3D worker is SCENE3D_BASE_BYTES, plus SCENE3D_TEXT_FACTOR per byte of
 * its scene's text, plus each texture decoded (SCENE3D_TEXTURE_COPIES).
 *
 * Fitted to the render measured above (2026-10-17): its scene's active.json
 * is 85 MB (60 MB of it two props' inline geometry, 17 MB an 11-entry cast,
 * 6 MB the model, about 40 textures, nearly all small), captured at
 * 1080x1920 (captureScale 1). Each worker held about 1.6 GB in its renderer
 * and 1.8 GB in its GPU process (the youngest worker; older ones grew to
 * 9.8 GB, a capture-side growth being measured, not part of this estimate):
 * 3.4 GB. MEASURED again on its own 2026-10-17 (cf P0,
 * /Users/Shared/montaj-377-p0/results.txt): the same stage, 85,270,896 bytes
 * of scene, 1080x1920, 60 fps, motion blur 5, phys_footprint summed over
 * every Chrome process: one worker peaks at 3.6 GB (GPU 1.8 + renderer 1.7),
 * two at 7.3 GB. A base of 1 GB plus 30 bytes per byte of text gives 3.6 GB
 * for it, plus its textures: the scene's cost is mostly its text, held as text
 * (the bundle's source, the `sceneJson` prop, the parsed scene) and as the
 * geometry decoded from it (typed arrays in the page, buffers on the GPU and
 * the GPU process's own copies). One scene: the split between base and
 * factor is a fit, not two measurements. The base is a 1080p capture's; a
 * 4K one's framebuffers add a few hundred MB, inside the fit's margin.
 */
export const SCENE3D_BASE_BYTES = 1 * GB
export const SCENE3D_TEXT_FACTOR = 30
/**
 * Each texture decoded: RGBA in the page (stage-textures.js keeps an
 * ImageBitmap of each) and RGBA with a mip chain on the GPU (4/3 of it;
 * texture.js gpuBytes, the app's own budget).
 */
export const SCENE3D_TEXTURE_COPIES = 1 + 4 / 3
/** Decoded over encoded bytes for a texture whose header gives no size (a 4K photo JPEG is about 10x; a PNG less). */
export const TEXTURE_UNKNOWN_EXPANSION = 8

/** How often a held-back worker reads the memory again. */
export const GOVERNOR_POLL_MS = 3000

/** The reserve on a machine of `totalBytes`. */
export function reserveBytes(totalBytes) {
  return Math.max(RESERVE_MIN_BYTES, RESERVE_SHARE * (Number(totalBytes) || 0))
}

// ---------------------------------------------------------------------------
// What is available now
// ---------------------------------------------------------------------------

/**
 * Bytes available from macOS `vm_stat` output: free + inactive + speculative
 * + purgeable pages, times its page size. `os.freemem()` is the free pages
 * alone, a fraction of what the system hands out on demand (MEASURED
 * 2026-10-17 on a 36 GB Mac: 5.9 GB free of 17.0 GB by this count). Purgeable
 * pages also sit in the active or inactive queue, so they can count twice;
 * they are few and the reserve absorbs it. Null when the output is not
 * vm_stat's.
 */
export function parseVmStat(text) {
  if (typeof text !== 'string') return null
  const page = /page size of (\d+) bytes/.exec(text)
  if (!page) return null
  const pages = (label) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const free = pages('free'), inactive = pages('inactive')
  if (free === null || inactive === null) return null
  return (free + inactive + (pages('speculative') ?? 0) + (pages('purgeable') ?? 0)) * Number(page[1])
}

/** Bytes available from Linux `/proc/meminfo` (its MemAvailable), or null. */
export function parseMeminfo(text) {
  if (typeof text !== 'string') return null
  const m = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text)
  return m ? Number(m[1]) * 1024 : null
}

function runVmStat() {
  const r = spawnSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 2000 })
  return r.status === 0 ? r.stdout : null
}

/**
 * The memory a render can use now: vm_stat on macOS, MemAvailable on Linux,
 * `os.freemem()` on Windows (which reports what is available there) and
 * wherever the first two cannot be read. Every reader is injectable, so a
 * test never runs vm_stat.
 */
export function availableMemoryBytes({
  platform = process.platform,
  vmStat = runVmStat,
  meminfo = () => readFileSync('/proc/meminfo', 'utf8'),
  freemem = os.freemem,
} = {}) {
  let bytes = null
  try {
    if (platform === 'darwin') bytes = parseVmStat(vmStat())
    else if (platform === 'linux') bytes = parseMeminfo(meminfo())
  } catch {
    bytes = null
  }
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : freemem()
}

// ---------------------------------------------------------------------------
// What one worker holds
// ---------------------------------------------------------------------------

const u16 = (b, o) => (b[o] << 8) | b[o + 1]
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

/** { width, height } from a PNG or JPEG's first bytes, or null (the app's texture.js imageSize). */
export function imageSize(buf, mime) {
  if (mime === 'image/png') {
    if (buf.length < 24 || u32(buf, 0) !== 0x89504e47 || u32(buf, 4) !== 0x0d0a1a0a) return null
    if (String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== 'IHDR') return null
    return { width: u32(buf, 16), height: u32(buf, 20) }
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let o = 2
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) { o++; continue }
    const m = buf[o + 1]
    if (m === 0xff) { o++; continue }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { o += 2; continue }
    if (m === 0xd9 || m === 0xda) return null
    const len = u16(buf, o + 2)
    if (len < 2) return null
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (o + 9 > buf.length) return null
      return { height: u16(buf, o + 5), width: u16(buf, o + 7) }
    }
    o += 2 + len
  }
  return null
}

/** Base64 characters of a texture read for its header first: 64 KiB decoded, past a JPEG's usual EXIF block. */
const HEADER_CHARS = 87384

/** The size of the base64 image at text[start, end), from its header, else from all of it, else null. */
function base64ImageSize(text, start, end, mime) {
  const head = Math.min(end - start, HEADER_CHARS)
  const size = imageSize(Buffer.from(text.slice(start, start + head), 'base64'), mime)
  if (size || head === end - start) return size
  return imageSize(Buffer.from(text.slice(start, end), 'base64'), mime)
}

const TEXTURE_URI = /"data:(image\/(?:png|jpeg));base64,/g

/**
 * What a 3D worker holds for one scene, from its text (`sceneJson`, which
 * scene3d.js puts on the overlay's props): the base, SCENE3D_TEXT_FACTOR per
 * byte of the text, and each distinct texture decoded at the size its header
 * gives. A texture decodes to far more than its text (a flat 2048x2048 PNG
 * of a few KB is 16 MB of RGBA), so it is counted by its pixels as well as
 * by its text. Textures are every PNG or JPEG data URI in the text; one met
 * twice is the same image (its id is a hash of its text), which the stage
 * decodes once (stage-textures.js).
 *
 * @returns {{ bytes: number, textBytes: number, textures: number, textureBytes: number }}
 *   `textureBytes` is the decoded RGBA of the distinct textures, once.
 */
export function scene3dFootprint(sceneJson) {
  const text = String(sceneJson)
  let textureBytes = 0, textures = 0
  const seen = new Set()
  const re = new RegExp(TEXTURE_URI.source, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = re.lastIndex
    const end = text.indexOf('"', start)
    if (end < 0) break
    re.lastIndex = end
    // Its length and three samples: two different images matching on all four does not happen in practice.
    const mid = start + ((end - start) >> 1)
    const key = `${m[1]}:${end - start}:${text.slice(start, start + 64)}:${text.slice(mid, mid + 64)}:${text.slice(end - 64, end)}`
    if (seen.has(key)) continue
    seen.add(key)
    textures++
    const size = base64ImageSize(text, start, end, m[1])
    textureBytes += size
      ? size.width * size.height * 4
      : Math.floor(((end - start) * 3) / 4) * TEXTURE_UNKNOWN_EXPANSION
  }
  const textBytes = text.length
  const bytes = Math.ceil(SCENE3D_BASE_BYTES + textBytes * SCENE3D_TEXT_FACTOR + textureBytes * SCENE3D_TEXTURE_COPIES)
  return { bytes, textBytes, textures, textureBytes }
}

/**
 * A 2D worker's budget for one segment: PER_WORKER_BYTES scaled by its
 * capture's pixels (width x height x captureScale squared; captureScale is 2
 * when unset, as renderer.js captures) over a 4K capture's, never below
 * PER_WORKER_MIN_BYTES. A segment without a size is PER_WORKER_BYTES.
 */
export function captureWorkerBytes(seg) {
  const w = Number(seg?.width), h = Number(seg?.height), scale = Number(seg?.captureScale ?? 2)
  if (!(w > 0 && h > 0 && scale > 0)) return PER_WORKER_BYTES
  return Math.max(PER_WORKER_MIN_BYTES, Math.ceil(PER_WORKER_BYTES * (w * h * scale * scale) / CAPTURE_4K_PIXELS))
}

/**
 * Whether a render segment draws a 3D stage: render.js marks every one
 * `scene3d: true` (scene3d.js isThreeStageOverlay: a scene item, the host's
 * stage, or a generated stage bundle), and a segment whose props carry
 * `sceneJson` is one whatever its marks.
 */
export function isScene3dSegment(seg) {
  return seg?.scene3d === true || typeof seg?.props?.sceneJson === 'string'
}

/**
 * What a 3D worker holds for a stage bundle with no `sceneJson` prop (a
 * generated stage: its .jsx inlines the scene): scene3dFootprint's model over
 * the file's size, from a stat, so its textures count only as text. A path
 * that cannot be read is SCENE3D_UNKNOWN_BYTES.
 */
export function bundleFootprint(componentPath, { stat = statSync } = {}) {
  let size = null
  try {
    if (typeof componentPath === 'string' && componentPath) size = stat(componentPath).size
  } catch {
    size = null
  }
  if (!Number.isFinite(size)) return { bytes: SCENE3D_UNKNOWN_BYTES, textBytes: 0, textures: 0, textureBytes: 0, from: 'unknown' }
  return { bytes: Math.ceil(SCENE3D_BASE_BYTES + size * SCENE3D_TEXT_FACTOR), textBytes: size, textures: 0, textureBytes: 0, from: 'bundle' }
}

/**
 * What one worker holds for this render's segments: the most any one of them
 * needs, since any worker may take any chunk. A 3D segment (isScene3dSegment)
 * is priced from its `sceneJson` (scene3dFootprint) or else from its
 * component file (bundleFootprint); a 2D one is its captureWorkerBytes.
 * A 3D render is budgeted at its largest scene, never below its largest 2D
 * budget (its captions and titles run on the same workers, and a 3D page is
 * a 2D page with WebGL besides); `kind` is then '3d', `id` that scene's
 * segment and `scene` its footprint.
 *
 * @param {Array<{ id?: string, scene3d?: boolean, componentPath?: string, props?: object }>} segments
 * @returns {{ bytes: number, kind: '2d'|'3d', id: string|null, has3d: boolean, scene?: object }}
 */
export function workerFootprint(segments) {
  let largest = null
  let twoD = segments.length > 0 ? 0 : PER_WORKER_BYTES
  const scenes = new Map() // one scan per scene text or bundle, however many items show it
  for (const seg of segments) {
    twoD = Math.max(twoD, captureWorkerBytes(seg))
    if (!isScene3dSegment(seg)) continue
    const json = seg.props?.sceneJson
    const key = typeof json === 'string' ? json : `bundle:${seg.componentPath ?? ''}`
    if (!scenes.has(key)) scenes.set(key, typeof json === 'string' ? { ...scene3dFootprint(json), from: 'sceneJson' } : bundleFootprint(seg.componentPath))
    const scene = scenes.get(key)
    if (!largest || scene.bytes > largest.scene.bytes) largest = { id: seg.id ?? null, scene }
  }
  if (!largest) return { bytes: twoD, kind: '2d', id: null, has3d: false }
  return { bytes: Math.max(twoD, largest.scene.bytes), kind: '3d', id: largest.id, has3d: true, scene: largest.scene }
}

// ---------------------------------------------------------------------------
// How many workers
// ---------------------------------------------------------------------------

/**
 * The worker count of a render:
 *
 *   clamp(1, min(target, jobs), floor((available - reserve) / perWorker))
 *
 * and at most SCENE3D_MAX_WORKERS when the render has 3D. `target` is the
 * configured count (`--workers`, `render.workers`) or the core count: a
 * ceiling memory can lower and never raise. No jobs is no workers.
 * `limitedBy` names what lowered it below min(target, jobs): 'memory', '3d'
 * or null.
 */
export function planWorkers({ target, jobs, availableBytes, totalBytes, perWorkerBytes = PER_WORKER_BYTES, has3d = false }) {
  const reserve = reserveBytes(totalBytes)
  const asked = Math.max(1, Math.min(Math.max(1, target | 0), jobs))
  const byMemory = Math.max(1, Math.floor((availableBytes - reserve) / perWorkerBytes))
  const by3d = has3d ? SCENE3D_MAX_WORKERS : Infinity
  const workers = jobs > 0 ? Math.min(asked, byMemory, by3d) : 0
  const limitedBy = jobs === 0 || workers === asked ? null : workers === byMemory ? 'memory' : '3d'
  return { workers, asked, byMemory, availableBytes, totalBytes, reserveBytes: reserve, perWorkerBytes, has3d, limitedBy }
}

/** Bytes as the log writes them: `17.0GB`. */
export const gb = (bytes) => `${(bytes / GB).toFixed(1)}GB`

// ---------------------------------------------------------------------------
// The governor
// ---------------------------------------------------------------------------

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Holds a worker back from its next chunk while memory is short. Before a
 * worker takes a chunk it reads what is available; below the reserve plus one
 * worker's estimate it waits, reading again every `pollMs`, until there is
 * room or no other worker is rendering a chunk. A worker alone always
 * proceeds, so a render never deadlocks; a chunk in flight is never stopped.
 * A worker waits silently after its one log line.
 *
 * @param {{ perWorkerBytes: number, reserveBytes: number, readAvailable?: () => number,
 *           sleep?: (ms: number) => Promise<void>, pollMs?: number, log?: (msg: string) => void }} opts
 */
export function createMemoryGovernor({
  perWorkerBytes, reserveBytes: reserve, readAvailable = availableMemoryBytes,
  sleep = sleepFor, pollMs = GOVERNOR_POLL_MS, log = () => {},
}) {
  let running = 0
  return {
    /**
     * Resolves true once `name` may take a chunk (it then counts as rendering
     * until release()), or false as soon as `more()` says there is none left.
     */
    async acquire(name, more = () => true) {
      let waited = false
      for (;;) {
        if (!more()) return false
        if (running === 0) break
        const available = readAvailable()
        if (available >= reserve + perWorkerBytes) break
        if (!waited) {
          log(`${name}: waiting for memory: available=${gb(available)} reserve=${gb(reserve)} perWorker=${gb(perWorkerBytes)} rendering=${running}`)
          waited = true
        }
        await sleep(pollMs)
      }
      running++
      if (waited) log(`${name}: continuing`)
      return true
    },
    /** The chunk taken by the last acquire() of this worker has ended, either way. */
    release() {
      running = Math.max(0, running - 1)
    },
    get running() { return running },
  }
}

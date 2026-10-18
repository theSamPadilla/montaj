// render/test/memory.test.mjs
//
// memory.js: the memory available now (vm_stat, /proc/meminfo, os.freemem),
// what one browser worker holds (2D, or a 3D scene by its text and textures),
// the worker count those give, and the governor that holds a worker back from
// its next chunk while memory is short. Every reading is injected: nothing
// here runs vm_stat or reads the machine's memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'fs'
import { join } from 'path'
import os from 'os'
import {
  parseVmStat, parseMeminfo, availableMemoryBytes, imageSize, scene3dFootprint, workerFootprint, planWorkers,
  createMemoryGovernor, reserveBytes, isScene3dSegment, captureWorkerBytes, PER_WORKER_BYTES, PER_WORKER_MIN_BYTES, SCENE3D_BASE_BYTES, SCENE3D_MAX_WORKERS,
  SCENE3D_TEXT_FACTOR, SCENE3D_TEXTURE_COPIES, SCENE3D_UNKNOWN_BYTES, TEXTURE_UNKNOWN_EXPANSION,
} from '../memory.js'

const GB = 1e9

// `vm_stat` on a 36 GB Apple silicon Mac (macOS 26), captured 2026-10-17 during a release build.
const VM_STAT_2026_10_17 = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   357577.
Pages active:                                 644880.
Pages inactive:                               592760.
Pages speculative:                             69051.
Pages throttled:                                   0.
Pages wired down:                             579805.
Pages purgeable:                               20700.
"Translation faults":                    53783488905.
Pages copy-on-write:                      2204478860.
Pages zero filled:                       30018375726.
Pages reactivated:                       16202622180.
Pages purged:                              849386077.
File-backed pages:                            392991.
Anonymous pages:                              913700.
Pages stored in compressor:                  1391144.
Pages occupied by compressor:                  72224.
Decompressions:                          13829805364.
Compressions:                            15340321151.
Pageins:                                   832213145.
Pageouts:                                   11199443.
Swapins:                                   119844163.
Swapouts:                                  143096890.
`

test('parseVmStat: free + inactive + speculative + purgeable pages, at the page size it prints', () => {
  assert.equal(parseVmStat(VM_STAT_2026_10_17), (357577 + 592760 + 69051 + 20700) * 16384)
  assert.equal(parseVmStat(VM_STAT_2026_10_17), 17040801792)
  // Three times the free pages alone, which is what os.freemem() counts.
  assert.ok(parseVmStat(VM_STAT_2026_10_17) > 2.5 * 357577 * 16384)
})

test('parseVmStat: anything that is not vm_stat output is null', () => {
  for (const text of [null, undefined, '', 'vm_stat: command not found', 'Pages free: 10.\nPages inactive: 10.',
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 5.']) {
    assert.equal(parseVmStat(text), null, JSON.stringify(text))
  }
})

test('parseMeminfo: MemAvailable, in bytes', () => {
  const text = 'MemTotal:       32768000 kB\nMemFree:         1024000 kB\nMemAvailable:   20480000 kB\nBuffers:  12 kB\n'
  assert.equal(parseMeminfo(text), 20480000 * 1024)
  assert.equal(parseMeminfo('MemTotal: 5 kB\n'), null)
})

test('availableMemoryBytes: vm_stat on macOS, MemAvailable on Linux, os.freemem on Windows; freemem when a reading fails', () => {
  const freemem = () => 123
  const vmStat = () => VM_STAT_2026_10_17
  const meminfo = () => 'MemAvailable:   1000 kB\n'
  assert.equal(availableMemoryBytes({ platform: 'darwin', vmStat, meminfo, freemem }), 17040801792)
  assert.equal(availableMemoryBytes({ platform: 'linux', vmStat, meminfo, freemem }), 1024000)
  assert.equal(availableMemoryBytes({ platform: 'win32', vmStat, meminfo, freemem }), 123)
  assert.equal(availableMemoryBytes({ platform: 'darwin', vmStat: () => null, freemem }), 123)
  assert.equal(availableMemoryBytes({ platform: 'darwin', vmStat: () => 'garbage', freemem }), 123)
  assert.equal(availableMemoryBytes({ platform: 'darwin', vmStat: () => { throw new Error('ENOENT') }, freemem }), 123)
  assert.equal(availableMemoryBytes({ platform: 'linux', meminfo: () => { throw new Error('EACCES') }, freemem }), 123)
})

// --- textures, as the app stores them: PNG or JPEG data URIs ---------------

/** The first bytes of a PNG of this size: signature and IHDR, then some image data. */
function pngBytes(width, height, extra = 64) {
  const b = Buffer.alloc(33 + extra, 7)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}
/** A JPEG whose SOF0 comes after APPn blocks (EXIF, ICC) of these sizes, each under 64 KiB. */
function jpegBytes(width, height, appSizes = [100]) {
  const apps = appSizes.map((n, i) => {
    const app = Buffer.alloc(4 + n, 1)
    app.writeUInt16BE(0xffe1 + i, 0)
    app.writeUInt16BE(2 + n, 2)
    return app
  })
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...apps, sof, Buffer.alloc(64, 9), Buffer.from([0xff, 0xd9])])
}
const uri = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`
const png = (w, h, extra) => uri('image/png', pngBytes(w, h, extra))
const jpeg = (w, h, apps) => uri('image/jpeg', jpegBytes(w, h, apps))

test('imageSize reads a PNG IHDR and a JPEG SOF past its EXIF block', () => {
  assert.deepEqual(imageSize(pngBytes(2048, 1024), 'image/png'), { width: 2048, height: 1024 })
  assert.deepEqual(imageSize(jpegBytes(4000, 3000, [40000]), 'image/jpeg'), { width: 4000, height: 3000 })
  assert.equal(imageSize(Buffer.from('not an image'), 'image/png'), null)
})

test('scene3dFootprint: the base, the factor per byte of text, and each distinct texture at its decoded size', () => {
  const big = png(2048, 2048, 5000)
  const scene = JSON.stringify({
    model: { textures: { aaaaaaaaaaaaaaaa: big, bbbbbbbbbbbbbbbb: jpeg(4096, 2048, [60000, 30000]) }, meshes: { m: { position: 'A'.repeat(40000) } } },
    // The same character twice in the cast: its texture is one image (stage-textures.js decodes it once).
    cast: [{ model: { textures: { aaaaaaaaaaaaaaaa: big } } }, { model: { textures: { aaaaaaaaaaaaaaaa: big } } }],
  })
  const f = scene3dFootprint(scene)
  assert.equal(f.textures, 2)
  assert.equal(f.textureBytes, (2048 * 2048 + 4096 * 2048) * 4)
  assert.equal(f.textBytes, scene.length)
  assert.ok(Math.abs(f.bytes - (SCENE3D_BASE_BYTES + SCENE3D_TEXT_FACTOR * f.textBytes + SCENE3D_TEXTURE_COPIES * f.textureBytes)) <= 1)
})

test('the 3D constants still cover the scene they were fitted to', () => {
  // cf P0, 2026-10-17 (results.txt): an 85,270,896-byte active.json whose 48 textures decode to 108.8 MB
  // (scene3dFootprint), 1080x1920, one worker on the in-page blur path: 4.1, 4.2 and 4.7 GB peak (the last under
  // the studio grade). The estimate covers the heaviest, within a fifth above it.
  const estimate = SCENE3D_BASE_BYTES + SCENE3D_TEXT_FACTOR * 85_270_896 + SCENE3D_TEXTURE_COPIES * 108.8e6
  assert.ok(estimate >= 4.7 * GB && estimate <= 1.2 * 4.7 * GB, `${estimate}`)
})

test('scene3dFootprint: a texture whose header gives no size is counted from its length', () => {
  const blob = Buffer.alloc(3000, 5)
  const scene = JSON.stringify({ model: { textures: { cccccccccccccccc: uri('image/png', blob) } } })
  const f = scene3dFootprint(scene)
  assert.equal(f.textures, 1)
  assert.equal(f.textureBytes, 3000 * TEXTURE_UNKNOWN_EXPANSION)
})

test('workerFootprint: a 3D scene with large textures needs more per worker than any 2D overlay', () => {
  // 24 textures of 2048x2048 (an environment model may hold 48): 400 MB of RGBA, decoded in the page and on the GPU.
  const scene = JSON.stringify({ model: { textures: Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [i.toString(16).padStart(16, '0'), png(2048, 2048, 100 + i)])) } })
  const twoD = workerFootprint([{ id: 'title', props: { text: 'hi' } }, { id: 'captions' }])
  const threeD = workerFootprint([{ id: 'title', props: { text: 'hi' } }, { id: 'film', props: { sceneJson: scene, sceneFile: '/p/models/active.json' } }])
  assert.deepEqual({ bytes: twoD.bytes, kind: twoD.kind, has3d: twoD.has3d }, { bytes: PER_WORKER_BYTES, kind: '2d', has3d: false })
  assert.equal(threeD.kind, '3d')
  assert.equal(threeD.id, 'film')
  assert.equal(threeD.has3d, true)
  assert.ok(threeD.bytes > PER_WORKER_BYTES, `${threeD.bytes}`)
  assert.ok(threeD.bytes > SCENE3D_BASE_BYTES + 24 * 2048 * 2048 * 4 * 2, `${threeD.bytes}`)
  assert.equal(threeD.scene.textures, 24)
})

test('workerFootprint: a small 3D scene is budgeted no lower than a 2D worker, and still reads as 3D', () => {
  // An 8K capture's 2D budget (4 x the 4K one) is over any small scene's.
  const f = workerFootprint([{ id: 'captions', width: 2160, height: 3840, captureScale: 2 }, { id: 'cube', props: { sceneJson: JSON.stringify({ model: { name: 'cube' } }) } }])
  assert.ok(f.scene.bytes < 4 * PER_WORKER_BYTES)
  assert.equal(f.bytes, 4 * PER_WORKER_BYTES)
  assert.deepEqual({ kind: f.kind, id: f.id, has3d: f.has3d }, { kind: '3d', id: 'cube', has3d: true })
})

// --- the worker count ------------------------------------------------------

test('isScene3dSegment: a segment marked scene3d, or one carrying sceneJson; nothing else', () => {
  assert.equal(isScene3dSegment({ scene3d: true }), true)
  assert.equal(isScene3dSegment({ props: { sceneJson: '{}' } }), true)
  assert.equal(isScene3dSegment({ scene3d: 'yes', props: { sceneJson: {} } }), false)
  assert.equal(isScene3dSegment({ props: { text: 'hi' } }), false)
  assert.equal(isScene3dSegment(undefined), false)
})

test('workerFootprint: a stage bundle marked scene3d, with no sceneJson, is 3D and priced from its file size', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'montaj-memory-'))
  try {
    const bundle = join(dir, 'stage.jsx')
    writeFileSync(bundle, '')
    truncateSync(bundle, 40e6) // a generated stage inlining a 40 MB scene
    const f = workerFootprint([{ id: 'title', props: { text: 'hi' } }, { id: 'stage', scene3d: true, componentPath: bundle, props: {} }])
    assert.deepEqual({ kind: f.kind, id: f.id, has3d: f.has3d, from: f.scene.from }, { kind: '3d', id: 'stage', has3d: true, from: 'bundle' })
    assert.equal(f.scene.textBytes, 40e6)
    assert.equal(f.bytes, SCENE3D_BASE_BYTES + SCENE3D_TEXT_FACTOR * 40e6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workerFootprint: a 3D segment whose bundle cannot be read, or that names none, is the heaviest measured worker', () => {
  for (const seg of [{ id: 'gone', scene3d: true, componentPath: '/nonexistent/stage.jsx' }, { id: 'bare', scene3d: true }]) {
    const f = workerFootprint([{ id: 'captions' }, seg])
    assert.deepEqual({ bytes: f.bytes, kind: f.kind, has3d: f.has3d, from: f.scene.from }, { bytes: SCENE3D_UNKNOWN_BYTES, kind: '3d', has3d: true, from: 'unknown' })
  }
  assert.equal(SCENE3D_UNKNOWN_BYTES, 4.7 * GB)
})

test('captureWorkerBytes: the 4K budget scaled by capture pixels, captureScale 2 when unset, never below the floor', () => {
  assert.equal(PER_WORKER_MIN_BYTES, 0.75 * GB)
  assert.equal(captureWorkerBytes({ width: 1080, height: 1920, captureScale: 2 }), PER_WORKER_BYTES, 'a 4K capture')
  assert.equal(captureWorkerBytes({ width: 1080, height: 1920 }), PER_WORKER_BYTES, 'unset scale is 2')
  assert.equal(captureWorkerBytes({ width: 1920, height: 1080, captureScale: 1.5 }), Math.ceil(PER_WORKER_BYTES * 2.25 / 4))
  assert.equal(captureWorkerBytes({ width: 1080, height: 1920, captureScale: 1 }), PER_WORKER_MIN_BYTES, 'a quarter of 4K, floored')
  assert.equal(captureWorkerBytes({ width: 2160, height: 3840, captureScale: 2 }), 4 * PER_WORKER_BYTES, 'an 8K capture')
  assert.equal(captureWorkerBytes({ id: 'no size' }), PER_WORKER_BYTES)
})

test('workerFootprint: a 2D render is budgeted at its largest capture; a 3D one never below it', () => {
  const small = { id: 'title', width: 1080, height: 1920, captureScale: 1 }
  const big = { id: 'captions', width: 1080, height: 1920, captureScale: 2 }
  assert.equal(workerFootprint([small]).bytes, PER_WORKER_MIN_BYTES)
  assert.equal(workerFootprint([small, big]).bytes, PER_WORKER_BYTES)
  const cube = { ...small, id: 'cube', props: { sceneJson: JSON.stringify({ model: { name: 'cube' } }) } }
  assert.equal(workerFootprint([small, cube]).bytes, SCENE3D_BASE_BYTES + Math.ceil(SCENE3D_TEXT_FACTOR * cube.props.sceneJson.length))
  const huge = { id: 'captions', width: 2160, height: 3840, captureScale: 2 }
  assert.equal(workerFootprint([huge, cube]).bytes, 4 * PER_WORKER_BYTES)
})

test('reserve: 4 GB, or a quarter of the total when that is more', () => {
  assert.equal(reserveBytes(8 * GB), 4 * GB)
  assert.equal(reserveBytes(36 * GB), 9 * GB)
})

test('planWorkers: sized on the memory available, not the total', () => {
  const at = (availableBytes) => planWorkers({ target: 12, jobs: 30, availableBytes, totalBytes: 36 * GB }).workers
  assert.equal(at(30 * GB), 12)                       // (30 - 9) / 1.5 = 14, so the 12 asked for
  assert.equal(at(15 * GB), 4)                        // (15 - 9) / 1.5
  assert.equal(at(6 * GB), 1)                         // under the reserve: one worker, never none
  assert.ok(at(6 * GB) < at(30 * GB))
  const low = planWorkers({ target: 12, jobs: 30, availableBytes: 15 * GB, totalBytes: 36 * GB })
  assert.equal(low.limitedBy, 'memory')
  assert.equal(low.reserveBytes, 9 * GB)
})

test('planWorkers: never more than the jobs; no jobs is no workers', () => {
  assert.equal(planWorkers({ target: 12, jobs: 3, availableBytes: 64 * GB, totalBytes: 64 * GB }).workers, 3)
  assert.equal(planWorkers({ target: 12, jobs: 3, availableBytes: 64 * GB, totalBytes: 64 * GB }).limitedBy, null)
  assert.equal(planWorkers({ target: 12, jobs: 0, availableBytes: 64 * GB, totalBytes: 64 * GB }).workers, 0)
})

test('planWorkers: a render with 3D runs at most SCENE3D_MAX_WORKERS, however much memory is free', () => {
  const p = planWorkers({ target: 12, jobs: 30, availableBytes: 120 * GB, totalBytes: 128 * GB, perWorkerBytes: 3 * GB, has3d: true })
  assert.equal(p.workers, SCENE3D_MAX_WORKERS)
  assert.equal(p.limitedBy, '3d')
})

// --- the governor ----------------------------------------------------------

/** A sleep the test ends by hand, and a few turns of the event loop. */
function manualSleep() {
  const waiting = []
  return { sleep: () => new Promise((r) => waiting.push(r)), wake: () => { for (const r of waiting.splice(0)) r() }, get sleepers() { return waiting.length } }
}
const turns = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
function tracked(promise) {
  const t = { done: false, value: undefined }
  promise.then((v) => { t.done = true; t.value = v })
  return t
}

test('governor: with memory short, a second worker waits while the first renders, and goes when memory recovers', async () => {
  let available = 5 * GB
  const lines = []
  const clock = manualSleep()
  const g = createMemoryGovernor({ perWorkerBytes: 2 * GB, reserveBytes: 9 * GB, readAvailable: () => available, sleep: clock.sleep, log: (l) => lines.push(l) })
  assert.equal(await g.acquire('worker 0'), true)
  const second = tracked(g.acquire('worker 1'))
  await turns()
  assert.equal(second.done, false, 'held back')
  clock.wake(); await turns(); clock.wake(); await turns()
  assert.equal(second.done, false, 'still held back while memory is short')
  assert.equal(lines.filter((l) => l.includes('waiting for memory')).length, 1, 'one line however long it waits')
  available = 12 * GB // the reserve plus one worker's estimate is 11
  clock.wake(); await turns()
  assert.equal(second.done, true)
  assert.equal(second.value, true)
  assert.equal(g.running, 2)
  assert.match(lines.at(-1), /worker 1: continuing/)
})

test('governor: the last worker rendering never waits, so a render cannot deadlock', async () => {
  const clock = manualSleep()
  let reads = 0
  const g = createMemoryGovernor({ perWorkerBytes: 2 * GB, reserveBytes: 9 * GB, readAvailable: () => { reads++; return 1 * GB }, sleep: clock.sleep })
  // Alone: through at once, without even reading the memory.
  assert.equal(await g.acquire('worker 0'), true)
  assert.equal(reads, 0)
  const second = tracked(g.acquire('worker 1'))
  await turns()
  assert.equal(second.done, false)
  g.release() // worker 0's chunk ends; memory is as short as ever
  clock.wake(); await turns()
  assert.equal(second.done, true, 'the only worker left goes')
  assert.equal(g.running, 1)
})

test('governor: a waiting worker stops waiting once there is nothing left to take', async () => {
  const clock = manualSleep()
  let more = true
  const g = createMemoryGovernor({ perWorkerBytes: 2 * GB, reserveBytes: 9 * GB, readAvailable: () => 1 * GB, sleep: clock.sleep })
  await g.acquire('worker 0')
  const second = tracked(g.acquire('worker 1', () => more))
  await turns()
  more = false
  clock.wake(); await turns()
  assert.deepEqual(second, { done: true, value: false })
  assert.equal(g.running, 1)
})

test('governor: with room, workers go at once', async () => {
  const g = createMemoryGovernor({ perWorkerBytes: 2 * GB, reserveBytes: 9 * GB, readAvailable: () => 30 * GB, sleep: () => { throw new Error('slept') } })
  assert.equal(await g.acquire('worker 0'), true)
  assert.equal(await g.acquire('worker 1'), true)
  assert.equal(await g.acquire('worker 2'), true)
  assert.equal(g.running, 3)
})

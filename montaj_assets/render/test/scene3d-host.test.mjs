// render/test/scene3d-host.test.mjs
//
// 3D36: the hook that hands a cinematic 3D chunk to a host renderer (scene3d-host.js). Pure checks, no Chrome: the
// project's 3D look and quality, the host module loaded from MONTAJ_SCENE3D_NATIVE (a missing, broken or incomplete
// one failing as cinematic_unavailable, never falling back), every cinematic spec stamped with its host's own cache
// key, a cinematic chunk's capture format, and its segment-cache key: another quality (samples) or another host
// version never reuses a chunk, and a job that is not cinematic keeps exactly the key it had.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  look3dOf, look3dQualityOf, scene3dHost, stampCinematic, CinematicUnavailableError, SCENE3D_NATIVE_ENV,
} from '../scene3d-host.js'
import { captureOptionsFor, chunkEncodeArgs } from '../renderer.js'
import { keyFields } from '../segment-cache.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scene3d-host-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// A host whose key covers its version and the samples the job's quality maps to, as the app's does.
const HOST = (version) => `export const version = ${JSON.stringify(version)}
export function cacheKey(job) { return 'samples=' + ({ standard: 64, high: 256 }[job.look3dQuality] ?? 64) + ';denoise=1' }
export async function captureChunk() {}
`

test('the 3D look is cinematic only when the project asks for it; quality defaults to standard', () => {
  assert.equal(look3dOf({ look3d: 'cinematic' }), 'cinematic')
  assert.equal(look3dOf({ look3d: 'standard' }), 'standard')
  assert.equal(look3dOf({}), 'standard')
  assert.equal(look3dOf(undefined), 'standard')
  assert.equal(look3dOf({ look3d: 'Cinematic' }), 'standard')
  assert.equal(look3dQualityOf({ look3dQuality: 'high' }), 'high')
  assert.equal(look3dQualityOf({}), 'standard')
  assert.equal(look3dQualityOf({ look3dQuality: '../x' }), 'standard')
})

test('no host configured: null; specs that are not cinematic are never stamped', async () => {
  assert.equal(await scene3dHost({}), null)
  const specs = [{ id: 'a', scene3d: true }]
  await stampCinematic(specs, {})
  assert.equal(specs[0].cinematicKey, undefined)
})

test('a cinematic spec with no host fails as cinematic_unavailable', async () => {
  await assert.rejects(stampCinematic([{ id: 'a', cinematic: true }], {}), (e) => e instanceof CinematicUnavailableError && e.code === 'cinematic_unavailable')
})

test('a host that cannot load, or lacks the contract, fails as cinematic_unavailable', async () => {
  await assert.rejects(scene3dHost({ [SCENE3D_NATIVE_ENV]: join(tmpdir(), 'no-such-host-3d36.mjs') }), (e) => e.code === 'cinematic_unavailable')
  await withDir(async (dir) => {
    const p = join(dir, 'partial.mjs')
    writeFileSync(p, 'export const version = "1"\nexport async function captureChunk() {}\n')
    await assert.rejects(scene3dHost({ [SCENE3D_NATIVE_ENV]: p }), (e) => e.code === 'cinematic_unavailable' && /cacheKey/.test(e.message))
  })
})

test('each cinematic spec carries its host version and the key for its quality', async () => {
  await withDir(async (dir) => {
    const p = join(dir, 'host.mjs')
    writeFileSync(p, HOST('cycles-5.2.0+1'))
    const specs = [{ id: 'a', cinematic: true, look3dQuality: 'standard' }, { id: 'b', cinematic: true, look3dQuality: 'high' }, { id: 'c' }]
    await stampCinematic(specs, { [SCENE3D_NATIVE_ENV]: p })
    assert.equal(specs[0].cinematicKey, 'cycles-5.2.0+1|samples=64;denoise=1')
    assert.equal(specs[1].cinematicKey, 'cycles-5.2.0+1|samples=256;denoise=1')
    assert.equal(specs[2].cinematicKey, undefined)
  })
})

test('the segment-cache key: another quality or host version never reuses a chunk; other jobs are unchanged', async () => {
  await withDir(async (dir) => {
    const page = join(dir, 'montaj-bundle-x'); mkdirSync(page)
    writeFileSync(join(page, 'index.html'), '<html></html>'); writeFileSync(join(page, 'bundle.js'), '//')
    const comp = join(dir, 'c.jsx'); writeFileSync(comp, 'export default () => null')
    const base = { htmlPath: join(page, 'index.html'), componentPath: comp, frameStart: 0, frameEnd: 30, fps: 30, width: 1080, height: 1920, props: { s: 1 } }
    const opts = { engine: 'e', env: {} }
    const plain = keyFields(base, opts)
    assert.equal('cinematic' in plain, false, 'a job that is not cinematic has no cinematic field')
    const k = (cinematicKey) => JSON.stringify(keyFields({ ...base, cinematic: true, cinematicKey }, opts))
    assert.notEqual(k('v1|samples=64;denoise=1'), k('v1|samples=256;denoise=1'))
    assert.notEqual(k('v1|samples=64;denoise=1'), k('v2|samples=64;denoise=1'))
    assert.notEqual(k('v1|samples=64;denoise=1'), JSON.stringify(plain))
    assert.equal(keyFields({ ...base, cinematic: true }, opts), null, 'never cached without its host key')
  })
})

test('a cinematic chunk is captured as PNG, one frame per output frame, even for an SDR master', () => {
  const base = { opaque: true, sdrMaster: true, fps: 30, subframes: 8, scene3d: true }
  assert.equal(captureOptionsFor(base).format, 'jpeg')
  const cine = { ...base, cinematic: true }
  assert.equal(captureOptionsFor(cine).format, 'png')
  const args = chunkEncodeArgs(cine, '/x/chunk.mkv', { blurInPage: true })
  assert.equal(args[args.indexOf('-framerate') + 1], '30')
  assert.equal(args[args.indexOf('-c:v') + 1], 'png')
  assert.ok(!args.includes('-vf'))
})

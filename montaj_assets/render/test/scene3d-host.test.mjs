// render/test/scene3d-host.test.mjs
//
// 3D36: the hook that hands a cinematic 3D chunk to a host renderer (scene3d-host.js). Pure checks, no Chrome: the
// project's 3D look, the host module loaded from MONTAJ_SCENE3D_NATIVE (and a missing or broken one failing as
// cinematic_unavailable, never falling back), a cinematic chunk's capture format and cache key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { look3dOf, scene3dHost, scene3dHostKey, CinematicUnavailableError, SCENE3D_NATIVE_ENV } from '../scene3d-host.js'
import { captureOptionsFor, chunkEncodeArgs } from '../renderer.js'

test('the 3D look is cinematic only when the project asks for it', () => {
  assert.equal(look3dOf({ look3d: 'cinematic' }), 'cinematic')
  assert.equal(look3dOf({ look3d: 'standard' }), 'standard')
  assert.equal(look3dOf({}), 'standard')
  assert.equal(look3dOf(undefined), 'standard')
  assert.equal(look3dOf({ look3d: 'Cinematic' }), 'standard')
})

test('no host configured: null, and no cache-key field', async () => {
  assert.equal(await scene3dHost({}), null)
  assert.equal(scene3dHostKey({}), null)
})

test('a host module loads once and names itself in the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene3d-host-'))
  try {
    const path = join(dir, 'host.mjs')
    writeFileSync(path, 'export const version = "t1"\nexport async function captureChunk() {}\n')
    const env = { [SCENE3D_NATIVE_ENV]: path, MONTAJ_SCENE3D_NATIVE_KEY: 'cycles-5.2.0:64' }
    const host = await scene3dHost(env)
    assert.equal(host.version, 't1')
    assert.equal(typeof host.captureChunk, 'function')
    assert.equal(await scene3dHost(env), host)
    assert.equal(scene3dHostKey(env), `${path}#cycles-5.2.0:64`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a host that cannot load fails as cinematic_unavailable', async () => {
  const env = { [SCENE3D_NATIVE_ENV]: join(tmpdir(), 'no-such-host-3d36.mjs') }
  await assert.rejects(scene3dHost(env), (err) => err instanceof CinematicUnavailableError && err.code === 'cinematic_unavailable')
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

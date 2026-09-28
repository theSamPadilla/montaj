// render/test/render-loudness-validation.test.mjs
//
// render.js validates settings.loudness early — right next to the existing
// motionBlur validation — so a bad value fails fast with a clean
// `invalid_argument` error instead of surfacing as an opaque ffmpeg loudnorm
// failure deep inside the mix pass, after a potentially long render.
//
// A minimal project (no tracks, no audio) reaches this validation in a few
// milliseconds: resolveProjectPaths/validateProjectFiles are no-ops on an
// empty project, and the loudness check runs before puppeteer, bundling, or
// any ffmpeg work starts. No fixture media, no browser launch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')

function runWithLoudness(loudness) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-loudness-cli-'))
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify({ status: 'final', settings: { loudness } }))
  const r = spawnSync('node', [RENDER_JS, projectPath], { encoding: 'utf8', timeout: 30_000 })
  rmSync(dir, { recursive: true, force: true })
  return r
}

test('render fails fast on an out-of-range settings.loudness, before doing any work', { timeout: 30_000 }, () => {
  const r = runWithLoudness(-40)
  assert.equal(r.status, 1)
  const err = JSON.parse((r.stderr || '').trim().split('\n').pop())
  assert.equal(err.error, 'invalid_argument')
  assert.match(err.message, /loudness/)
})

test('render fails fast on a non-numeric settings.loudness', { timeout: 30_000 }, () => {
  const r = runWithLoudness('loud please')
  assert.equal(r.status, 1)
  const err = JSON.parse((r.stderr || '').trim().split('\n').pop())
  assert.equal(err.error, 'invalid_argument')
  assert.match(err.message, /loudness/)
})

test('render proceeds past validation with a valid settings.loudness (fails later, on the empty project, not on loudness)', { timeout: 30_000 }, () => {
  const r = runWithLoudness(-14)
  // An empty project (no tracks) fails downstream for an unrelated reason —
  // the point here is only that it does NOT fail with invalid_argument citing
  // loudness, proving the valid value cleared this gate.
  const lastLine = (r.stderr || '').trim().split('\n').pop()
  let err = null
  try { err = JSON.parse(lastLine) } catch { /* not a fail() JSON line */ }
  if (err?.error === 'invalid_argument') {
    assert.doesNotMatch(err.message, /loudness/, `should not fail loudness validation with a valid value: ${err.message}`)
  }
})

test('render with no settings.loudness at all is unaffected by the new check', { timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-loudness-cli-'))
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify({ status: 'final', settings: {} }))
  const r = spawnSync('node', [RENDER_JS, projectPath], { encoding: 'utf8', timeout: 30_000 })
  rmSync(dir, { recursive: true, force: true })
  const lastLine = (r.stderr || '').trim().split('\n').pop()
  let err = null
  try { err = JSON.parse(lastLine) } catch { /* not a fail() JSON line */ }
  if (err?.error === 'invalid_argument') {
    assert.doesNotMatch(err.message, /loudness/, `absent loudness must never fail validation: ${err.message}`)
  }
})

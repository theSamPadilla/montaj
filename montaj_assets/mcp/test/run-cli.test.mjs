import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../run-cli.js'

test('captures stdout and zero status', async () => {
  const r = await runCli(process.execPath, ['-e', 'console.log("hi")'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), 'hi')
})

test('captures stderr and non-zero status', async () => {
  const r = await runCli(process.execPath, ['-e', 'console.error("bad"); process.exit(3)'])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /bad/)
})

test('timeout kills with SIGTERM semantics', async () => {
  const r = await runCli(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 })
  assert.equal(r.signal, 'SIGTERM')
})

test('spawn failure resolves with error', async () => {
  const r = await runCli('/nonexistent-binary-xyz', [])
  assert.ok(r.error)
})

test('does not block the event loop while the child runs', async () => {
  let ticks = 0
  const t = setInterval(() => ticks++, 20)
  await runCli(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
  clearInterval(t)
  assert.ok(ticks >= 5, `event loop starved: ${ticks} ticks`)
})

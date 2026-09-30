import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliFailureMessage } from '../cli-failure.js'

test('signal kill with empty stderr names the signal', () => {
  const m = JSON.parse(cliFailureMessage('sample_overlay', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }))
  assert.equal(m.error, 'cli_failed')
  assert.equal(m.tool, 'sample_overlay')
  assert.equal(m.signal, 'SIGKILL')
  assert.equal(m.exit, null)
})

test('non-zero exit includes exit code and stderr', () => {
  const m = JSON.parse(cliFailureMessage('t', { status: 3, signal: null, stdout: '', stderr: 'boom\n' }))
  assert.equal(m.exit, 3)
  assert.match(m.stderr_tail, /boom/)
})

test('falls back to stdout tail and truncates to 2000 chars', () => {
  const out = 'x'.repeat(5000) + 'END'
  const m = JSON.parse(cliFailureMessage('t', { status: 1, signal: null, stdout: out, stderr: '  ' }))
  assert.equal(m.stderr_tail, undefined)
  assert.equal(m.stdout_tail.length, 2000)
  assert.ok(m.stdout_tail.endsWith('END'))
})

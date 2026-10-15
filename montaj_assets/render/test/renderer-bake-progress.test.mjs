// render/test/renderer-bake-progress.test.mjs
//
// createBakeProgress (renderer.js): the bake's one overall frame counter, the
// line the app's export bar moves on between whole chunks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBakeProgress } from '../renderer.js'

test('one line per whole percent, ending at the total', () => {
  const lines = []
  const note = createBakeProgress({ total: 250, log: (m) => lines.push(m) })
  for (let i = 0; i < 250; i++) note()
  assert.equal(lines.length, 101)
  assert.equal(lines[0], 'baked 1/250 frames')
  assert.equal(lines.at(-1), 'baked 250/250 frames')
})

test('a small total logs every frame; a chunk run again never passes the total', () => {
  const lines = []
  const note = createBakeProgress({ total: 3, log: (m) => lines.push(m) })
  for (let i = 0; i < 5; i++) note()
  assert.deepEqual(lines, ['baked 1/3 frames', 'baked 2/3 frames', 'baked 3/3 frames'])
})

test('no frames to bake logs nothing', () => {
  const lines = []
  const note = createBakeProgress({ total: 0, log: (m) => lines.push(m) })
  note()
  assert.deepEqual(lines, [])
})

test('the line the app reads: "baked <n>/<total> frames"', () => {
  const lines = []
  createBakeProgress({ total: 10, log: (m) => lines.push(m) })()
  assert.match(lines[0], /^baked (\d+)\/(\d+) frames$/)
})

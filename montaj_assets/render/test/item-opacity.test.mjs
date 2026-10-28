import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { opacityCommands, opacityFilterStep } from '../item-opacity.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const fade = { opacity: 1, keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] }

test('no track and opacity 1: no step at all', () => {
  assert.equal(opacityFilterStep({}, 'op3', 0, 2, 30), null)
})
test('static opacity: the plain colorchannelmixer string, byte for byte as before', () => {
  assert.equal(opacityFilterStep({ opacity: 0.5 }, 'op3', 0, 2, 30), 'colorchannelmixer=aa=0.5')
})
test('a track: sendcmd per frame where the value changes, sampled with opacityAt', () => {
  const cmds = opacityCommands(fade, 'colorchannelmixer@op3', 0, 1, 10)
  assert.equal(cmds[0], '0.000000 colorchannelmixer@op3 aa 0.000000')
  assert.equal(cmds.length, 11)              // frames 0..10, every one changes
  assert.equal(cmds[5], '0.500000 colorchannelmixer@op3 aa 0.500000')
  const step = opacityFilterStep(fade, 'op3', 0, 1, 10)
  assert.match(step, /^sendcmd=c='0\.000000 colorchannelmixer@op3 aa 0\.000000;0\.100000 /)
  assert.match(step, /,colorchannelmixer@op3=aa=0$/)
})
test('the item-time offset shifts the sample, not the command time', () => {
  const cmds = opacityCommands(fade, 'x@y', 0.5, 0.5, 10)
  assert.equal(cmds[0], '0.000000 x@y aa 0.500000')
})
test('held values send one command', () => {
  const hold = { keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0.3 }] }] }
  assert.equal(opacityCommands(hold, 'x@y', 0, 2, 30).length, 1)
})
test('real ffmpeg: the step fades a white layer over black', () => {
  const step = opacityFilterStep(fade, 'op0', 0, 1, 10)
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=16x16:r=10:d=1.1',
    '-f', 'lavfi', '-i', 'color=white:s=16x16:r=10:d=1.1',
    '-filter_complex', `[1:v]format=yuva420p,${step}[t];[0:v][t]overlay=format=yuv420,format=gray`,
    '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
  assert.equal(r.status, 0, String(r.stderr))
  const px = (f) => r.stdout[f * 256 + 136]
  assert.ok(px(0) < 20); assert.ok(Math.abs(px(5) - 128) < 12); assert.ok(px(10) > 235)
})

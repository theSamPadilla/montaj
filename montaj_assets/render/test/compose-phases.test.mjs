// render/test/compose-phases.test.mjs
//
// compose() is planCompose -> startCompose -> encodeComposeGroups ->
// finishCompose. These tests cover the seams: the plan is what the planner
// yields, an overlay swap reaches the encoder without touching the shared
// overlay objects, and a subset of group indices keeps global file names.
// No ffmpeg: the encoder is injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { planSegments, groupShortSegments } from '../segment-plan.js'
import { planCompose, startCompose, encodeComposeGroups } from '../compose.js'

const FPS = 30
const items = () => [
  { id: 'a', type: 'image', start: 1, end: 4, src: '/a.jpg', trackIdx: 0 },
  { id: 'b', type: 'image', start: 4, end: 7, src: '/b.jpg', trackIdx: 0 },
  { id: 'c', type: 'image', start: 8, end: 10, src: '/c.jpg', trackIdx: 0 },
]
const overlays = () => [
  { id: 'ov1', startSeconds: 2, endSeconds: 5, webmPath: '/ov1.mkv', opaque: false, isCaption: false },
  { id: 'ov2', startSeconds: 8, endSeconds: 9, webmPath: '/ov2.mkv', opaque: false, isCaption: false },
]
const project = () => ({ settings: { resolution: [1080, 1920], fps: FPS } })
const tmp = () => mkdtempSync(join(tmpdir(), 'compose-phases-'))

async function plan(dir) {
  return planCompose({
    projectJson: project(), imageItems: items(), videoItems: [], puppeteerSegments: overlays(),
    outputPath: join(dir, 'out.mp4'),
  })
}

test('planCompose: groups equal planSegments + leading gap + groupShortSegments', async () => {
  const dir = tmp()
  const p = await plan(dir)
  const segs = planSegments(items(), overlays(), 1080, 1920, FPS)
  assert.equal(segs[0].start, 1)
  segs.unshift({ start: 0, end: 1, items: [], opaqueVideo: false, overlays: [], vw: 1080, vh: 1920, fps: FPS })
  assert.deepEqual(p.groups, groupShortSegments(segs, FPS))
  assert.equal(p.leadingGap, 1)
  assert.equal(p.empty, false)
  assert.equal(p.segDir, join(dir, 'out.mp4.segments'))
  assert.equal(p.projectColorSpace, 'sdr_bt709')
  rmSync(dir, { recursive: true, force: true })
})

test('planCompose: no items is an empty plan with no gap', async () => {
  const dir = tmp()
  const p = await planCompose({ projectJson: project(), outputPath: join(dir, 'o.mp4') })
  assert.equal(p.empty, true)
  assert.equal(p.leadingGap, 0)
  assert.equal(p.outputPath, join(dir, 'o.mp4'))
  rmSync(dir, { recursive: true, force: true })
})

test('encodeComposeGroups: overlaysFor swaps webmPath for the encode only', async () => {
  const dir = tmp()
  const p = await plan(dir)
  startCompose(p)
  const seen = []
  const enc = async (group) => { seen.push(group) }
  await encodeComposeGroups(p, p.groups.map((_, i) => i), {
    _encodeGroup: enc,
    overlaysFor: ov => ({ ...ov, webmPath: `/slice/${ov.id}.webm`, startSeconds: 0 }),
  })
  const paths = seen.flatMap(g => g.parts.flatMap(pt => pt.overlays.map(o => o.webmPath)))
  assert.ok(paths.length > 0)
  assert.ok(paths.every(x => x.startsWith('/slice/')))
  const originals = p.groups.flatMap(g => g.parts.flatMap(pt => pt.overlays))
  assert.ok(originals.length > 0)
  assert.ok(originals.every(o => o.webmPath.endsWith('.mkv') && o.startSeconds !== 0))
  rmSync(dir, { recursive: true, force: true })
})

test('encodeComposeGroups: default path hands the encoder the shared group', async () => {
  const dir = tmp()
  const p = await plan(dir)
  startCompose(p)
  const seen = []
  await encodeComposeGroups(p, [0], { _encodeGroup: async g => { seen.push(g) } })
  assert.equal(seen[0], p.groups[0])
  assert.equal(seen[0].parts[0].colorSpace, 'sdr_bt709')
  rmSync(dir, { recursive: true, force: true })
})

test('encodeComposeGroups: a subset encodes only those groups, named by global index', async () => {
  const dir = tmp()
  const p = await plan(dir)
  assert.ok(p.groups.length >= 3)
  startCompose(p)
  assert.ok(existsSync(p.segDir))
  const calls = []
  const out = await encodeComposeGroups(p, [2, 0], {
    _encodeGroup: async (g, path) => { calls.push([g, basename(path)]); writeFileSync(path, '') },
  })
  assert.deepEqual(calls.map(c => c[1]).sort(), ['seg-0000.mp4', 'seg-0002.mp4'])
  assert.deepEqual(out.map(o => o.index), [2, 0])
  assert.deepEqual(out.map(o => basename(o.path)), ['seg-0002.mp4', 'seg-0000.mp4'])
  assert.equal(out[0].start, p.groups[2].start)
  assert.equal(out[0].end, p.groups[2].end)
  assert.ok(!existsSync(join(p.segDir, 'seg-0001.mp4')))
  rmSync(dir, { recursive: true, force: true })
})

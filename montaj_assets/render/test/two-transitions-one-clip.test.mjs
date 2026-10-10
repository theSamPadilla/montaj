// render/test/two-transitions-one-clip.test.mjs
//
// A clip in two transitions back to back (A→B, then B→C) is the INCOMING side
// of the first pair and the OUTGOING side of the second. collectAllItems once
// stamped a single `crossfade` per clip and the second pair overwrote the
// first, so the export hard-cut A→B, picture and sound, while the preview and
// the preview mixer blended it (§195). Run through the real collectAllItems
// and a dry-run encodeSegment, both transitions must blend the picture and
// ramp the sound, each in its own segment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectAllItems } from '../render.js'
import { encodeSegment } from '../encode-segment.js'

const clip = (id, start, end) => ({ id, type: 'video', src: `/m/${id}.mp4`, start, end })

// A 0-5, B 4-9, C 8-12 on one track: A→B over [4, 5], B→C over [8, 9].
const PROJECT = {
  id: 'p',
  settings: { resolution: [1080, 1920], fps: 30 },
  tracks: [{ id: 't0', items: [clip('A', 0, 5), clip('B', 4, 9), clip('C', 8, 12)] }],
}

async function segmentGraph(start, end) {
  const { imageItems, videoItems } = collectAllItems(PROJECT)
  const items = [...imageItems, ...videoItems].filter((i) => i.start < end && i.end > start)
  const { inputs, filterParts } = await encodeSegment(
    { start, end, items, overlays: [], vw: 1080, vh: 1920, fps: 30 },
    '/nonexistent/segment.mp4',
    { _dryRun: true },
  )
  // Input index → source, so each audio chain can be named by its clip.
  const srcOf = []
  for (let i = 0; i < inputs.length; i++) if (inputs[i] === '-i') srcOf.push(inputs[i + 1])
  const ramps = {}
  for (const part of filterParts) {
    const head = /^\[(\d+):a:0\]/.exec(part)
    if (!head) continue
    const id = /\/m\/(\w+)\.mp4$/.exec(srcOf[Number(head[1])])[1]
    const xf = /volume='(1-\()?[^']*\*t\)?'/.exec(part)
    ramps[id] = xf ? (xf[1] ? 'down' : 'up') : 'none'
  }
  return { graph: filterParts.join(';'), ramps }
}

test('the first of two back-to-back transitions blends the picture and ramps the sound (A→B)', async () => {
  const { graph, ramps } = await segmentGraph(4, 5)
  assert.match(graph, /split=2\[xfa/, 'A→B: no picture blend in [4, 5]')
  assert.deepEqual(ramps, { A: 'down', B: 'up' }, 'A→B: the sound must cross over too')
})

test('the second of two back-to-back transitions still blends (B→C)', async () => {
  const { graph, ramps } = await segmentGraph(8, 9)
  assert.match(graph, /split=2\[xfa/, 'B→C: no picture blend in [8, 9]')
  assert.deepEqual(ramps, { B: 'down', C: 'up' }, 'B→C: the sound must cross over too')
})

test('between the two transitions the middle clip plays plain', async () => {
  const { graph, ramps } = await segmentGraph(5, 8)
  assert.doesNotMatch(graph, /split=2/)
  assert.deepEqual(ramps, { B: 'none' })
})

test('a clip in one transition still carries the single-span stamp (goldens unchanged)', () => {
  const { videoItems } = collectAllItems(PROJECT)
  const byId = Object.fromEntries(videoItems.map((i) => [i.id, i]))
  assert.deepEqual(byId.A.crossfade, { role: 'from', start: 4, end: 5 })
  assert.deepEqual(byId.C.crossfade, { role: 'to', start: 8, end: 9 })
})

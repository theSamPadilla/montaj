// §284: how a capture is encoded follows from the overlay and the export, never
// from a setting. An opaque capture for an SDR master (an 8-bit 4:2:0 H.264 MP4)
// is a JPEG at JPEG_CAPTURE_QUALITY; every other capture is a PNG written with
// optimizeForSpeed (an alpha capture, an HDR project's captures, and so any
// later lossless master). The chunk's ffmpeg decodes what was captured.
// Pure: no Chrome, no ffmpeg (capture-format.integration.test.mjs runs them).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as R from '../renderer.js'

const MKV = '/x/seg-chunk-0.mkv'

test('an opaque capture for an SDR master is a JPEG; every other capture is a PNG', () => {
  const cases = [
    // [job, format, omitBackground]
    [{ opaque: true, sdrMaster: true }, 'jpeg', false],
    [{ opaque: true, sdrMaster: false }, 'png', false],       // an HDR project's capture
    [{ opaque: true }, 'png', false],                         // no export known: as before
    [{ opaque: false, sdrMaster: true }, 'png', true],        // needs alpha: JPEG has none
    [{ opaque: true, transitionTo: true, sdrMaster: true }, 'png', true], // a crossfade's incoming side
  ]
  for (const [job, format, omitBackground] of cases) {
    const opts = R.captureOptionsFor(job)
    assert.equal(opts.format, format, JSON.stringify(job))
    assert.equal(opts.omitBackground, omitBackground, JSON.stringify(job))
  }
})

test('screenshot options: JPEG at the capture quality, PNG with optimizeForSpeed and its background rule', () => {
  assert.equal(R.JPEG_CAPTURE_QUALITY, 95)
  assert.deepEqual(R.screenshotOptionsFor({ opaque: true, sdrMaster: true }), { type: 'jpeg', quality: 95 })
  assert.deepEqual(R.screenshotOptionsFor({ opaque: true, sdrMaster: false }), { type: 'png', omitBackground: false, optimizeForSpeed: true })
  assert.deepEqual(R.screenshotOptionsFor({ opaque: false, sdrMaster: true }), { type: 'png', omitBackground: true, optimizeForSpeed: true })
})

test('the chunk decodes JPEG for a JPEG capture; nothing else in its encode changes', () => {
  for (const fps of [30, 60]) {
    for (const subframes of [1, 3]) {
      const png = R.chunkEncodeArgs({ fps, opaque: true, subframes }, MKV)
      const jpeg = R.chunkEncodeArgs({ fps, opaque: true, subframes, sdrMaster: true }, MKV)
      const at = png.indexOf('png')
      assert.ok(at > 0 && png[at - 1] === '-c:v', 'the PNG decoder is named')
      assert.deepEqual(jpeg, [...png.slice(0, at), 'mjpeg', ...png.slice(at + 1)], `fps ${fps}, subframes ${subframes}`)
    }
  }
  // A transparent overlay keeps PNG on an SDR master.
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: false, subframes: 1, sdrMaster: true }, MKV),
    R.chunkEncodeArgs({ fps: 30, opaque: false, subframes: 1 }, MKV))
})

test('every chunk of a segment carries its sdrMaster', () => {
  const segments = [
    { id: 'a', frameCount: 400, opaque: true, sdrMaster: true },
    { id: 'b', frameCount: 30, opaque: false, sdrMaster: true },
  ]
  const { jobs } = R.planChunks(segments, { workers: 2, chunkSize: 100 })
  assert.ok(jobs.length > 2)
  assert.ok(jobs.every((j) => j.sdrMaster === true))
  assert.deepEqual(jobs.filter((j) => j.id === 'a').map((j) => R.captureOptionsFor(j).format), ['jpeg', 'jpeg', 'jpeg', 'jpeg'])
})

test('render.js stamps each overlay segment with whether its master is SDR, before bundling it', () => {
  const src = readFileSync(fileURLToPath(new URL('../render.js', import.meta.url)), 'utf8')
  const stamp = src.indexOf('spec.sdrMaster = !isHdr(projectColorSpace)')
  assert.ok(stamp > 0, 'the stamp is there')
  assert.equal(src.indexOf('spec.sdrMaster', stamp + 1), -1, 'once')
  const loop = src.lastIndexOf('const spec = segmentSpecs[i]', stamp)
  const bundle = src.indexOf('await bundleComponent({', stamp)
  assert.ok(loop > 0 && stamp - loop < 400 && bundle > stamp, 'inside the bundle loop, before bundleComponent')
  assert.ok(src.indexOf('renderAllSegments(segmentSpecs', stamp) > stamp, 'before the capture')
})

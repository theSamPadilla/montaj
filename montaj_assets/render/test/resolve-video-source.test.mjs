// render/test/resolve-video-source.test.mjs
//
// Unit tests for sample-frame.js's resolveVideoSource — filesystem-only
// (statSync/readdirSync pattern matching), no ffmpeg/puppeteer involved, so
// these run fast and everywhere. Complements the integration coverage in
// sample-frame.test.mjs, which exercises the full sampleFrame pipeline.
//
// Covers the SP6b Task T3 addition: when both a look-tagged normalized
// sibling (`_normalized_<colorSpace>_<look>.mp4`, produced when an HDR
// source was tone-mapped through the Montaj Vivid LUT) and an untagged one
// (`_normalized_<colorSpace>.mp4`) are fresh, the tagged one wins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveVideoSource } from '../sample-frame.js'
import { MASTER_LOOK } from '../look.js'

/** Write a tiny placeholder file and stamp its mtime (seconds since epoch). */
function writeAt(path, mtimeSeconds) {
  writeFileSync(path, 'placeholder')
  utimesSync(path, mtimeSeconds, mtimeSeconds)
}

test('resolveVideoSource: no siblings — returns src unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    writeAt(src, 1000)
    assert.equal(resolveVideoSource(src), src)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: only an untagged normalized sibling — prefers it when fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    const untagged = join(dir, 'clip_normalized_sdr_bt709.mp4')
    writeAt(src, 1000)
    writeAt(untagged, 2000)
    assert.equal(resolveVideoSource(src), untagged)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: tagged + untagged both fresh — prefers the look-tagged sibling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    const untagged = join(dir, 'clip_normalized_sdr_bt709.mp4')
    const tagged = join(dir, `clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`)
    writeAt(src, 1000)
    writeAt(untagged, 2000)
    writeAt(tagged, 2000)
    assert.equal(resolveVideoSource(src), tagged)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: stale tagged sibling is ignored in favor of a fresh untagged one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    const untagged = join(dir, 'clip_normalized_sdr_bt709.mp4')
    const staleTagged = join(dir, `clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`)
    writeAt(staleTagged, 500) // older than src — a leftover from before a source re-record
    writeAt(src, 1000)
    writeAt(untagged, 2000)
    assert.equal(resolveVideoSource(src), untagged)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: all siblings stale — falls back to src', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    const untagged = join(dir, 'clip_normalized_sdr_bt709.mp4')
    const tagged = join(dir, `clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`)
    writeAt(untagged, 500)
    writeAt(tagged, 500)
    writeAt(src, 1000) // source re-recorded after both caches were built
    assert.equal(resolveVideoSource(src), src)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: _audioclean sibling still wins over any _normalized_ sibling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rvs-'))
  try {
    const src = join(dir, 'clip.mp4')
    const audioclean = join(dir, 'clip_audioclean.mp4')
    const tagged = join(dir, `clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`)
    writeAt(src, 1000)
    writeAt(audioclean, 2000)
    writeAt(tagged, 2000)
    assert.equal(resolveVideoSource(src), audioclean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveVideoSource: null/undefined src passes through unchanged', () => {
  assert.equal(resolveVideoSource(null), null)
  assert.equal(resolveVideoSource(undefined), undefined)
  assert.equal(resolveVideoSource(''), '')
})

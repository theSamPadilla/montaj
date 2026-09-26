// ffmpeg-filter-path.js — filtergraph-safe path escaping, mirroring
// lib/common.py::ffmpeg_filter_path (same table of cases, same pinned
// strings — the two runtimes must not drift).
//
// A plain path with no special characters is pinned UNCHANGED so
// encode-segment.test.mjs / derive-sdr.test.mjs keep asserting today's
// `lut3d=file=${lutPath()}:interp=tetrahedral` byte-for-byte.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ffmpegFilterPath } from '../ffmpeg-filter-path.js'

describe('ffmpegFilterPath — plain paths are unchanged', () => {
  for (const p of ['/Users/sam/Montaj/montaj_assets/luts/montaj-vivid-v1.cube', '/a/b/c.ttf']) {
    test(`identity for ${JSON.stringify(p)}`, () => {
      assert.equal(ffmpegFilterPath(p), p)
    })
  }
})

describe('ffmpegFilterPath — Windows drive path', () => {
  test('backslashes -> forward slashes, drive colon escaped, single-quoted', () => {
    assert.equal(ffmpegFilterPath('C:\\Users\\a\\x.cube'), "'C\\:/Users/a/x.cube'")
  })
})

describe('ffmpegFilterPath — POSIX paths with filtergraph-special characters', () => {
  const cases = [
    ['/a:b/x.cube', "'/a\\:b/x.cube'"],
    ["/a'b/x.cube", "'/a\\'\\''b/x.cube'"],
    ['/a,b/x.cube', "'/a,b/x.cube'"],
    ['/a[b]/x.cube', "'/a[b]/x.cube'"],
    ['/a;b/x.cube', "'/a;b/x.cube'"],
    ['/a b/x.cube', "'/a b/x.cube'"],
  ]
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(ffmpegFilterPath(raw), expected)
    })
  }
})

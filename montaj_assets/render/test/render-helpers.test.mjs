import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getTotalDurationSeconds, collectAllItems, collectPuppeteerSegments, resolveFilePath, shouldSkipNormalize } from '../render.js'

test('getTotalDurationSeconds: returns 0 for empty tracks', () => {
  assert.equal(getTotalDurationSeconds({ tracks: [[]] }), 0)
})

test('getTotalDurationSeconds: returns max end across all tracks', () => {
  const project = {
    tracks: [
      [{ id: 'c1', end: 10.0 }, { id: 'c2', end: 20.0 }],
      [{ id: 'ov1', end: 15.0 }],
    ],
  }
  assert.equal(getTotalDurationSeconds(project), 20.0)
})

test('getTotalDurationSeconds: canvas project — max end from overlay tracks', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'ov1', end: 8.0 }, { id: 'ov2', end: 12.0 }],
    ],
  }
  assert.equal(getTotalDurationSeconds(project), 12.0)
})

test('getTotalDurationSeconds: returns 0 when tracks is absent', () => {
  assert.equal(getTotalDurationSeconds({}), 0)
})

test('getTotalDurationSeconds: items missing end field default to 0', () => {
  assert.equal(getTotalDurationSeconds({ tracks: [[{ id: 'c1' }]] }), 0)
})

test('collectAllItems: collects image and video items from all tracks', () => {
  const project = {
    tracks: [
      [{ id: 'bg1', type: 'image', src: '/bg.png', start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 }],
      [
        { id: 'img1', type: 'image', src: '/logo.png', start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 },
        { id: 'vid1', type: 'video', src: '/pip.mp4', start: 2, end: 8, inPoint: 0, outPoint: 6, offsetX: 0, offsetY: 0, scale: 0.5, opacity: 1 },
      ],
    ],
  }
  const { imageItems, videoItems } = collectAllItems(project)
  assert.equal(imageItems.length, 2)
  assert.equal(imageItems[0].id, 'bg1')
  assert.equal(imageItems[0].trackIdx, 0)
  assert.equal(imageItems[1].id, 'img1')
  assert.equal(imageItems[1].trackIdx, 1)
  assert.equal(videoItems.length, 1)
  assert.equal(videoItems[0].id, 'vid1')
})

test('collectAllItems: tracks[0] items are included (no special-casing)', () => {
  const project = {
    tracks: [
      [{ id: 'primary', type: 'video', src: '/main.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5 }],
    ],
  }
  const { imageItems, videoItems } = collectAllItems(project)
  assert.equal(imageItems.length, 0)
  assert.equal(videoItems.length, 1)
  assert.equal(videoItems[0].id, 'primary')
  assert.equal(videoItems[0].trackIdx, 0)
})

test('collectAllItems: normalizedSrc is substituted as src and inPoint/outPoint are rebased by the cache origin', () => {
  // A normalizedSrc cache covers [normalizedInPoint, normalizedInPoint+duration] of
  // the original and plays from time 0. encode-segment computes actualIn = inPoint +
  // seekOffset, so both inPoint and outPoint must be rebased by the cache origin.
  // When normalizedInPoint is absent, origin defaults to inPoint (legacy rebase-to-0).
  const project = {
    tracks: [
      [{ id: 'primary', type: 'video', src: '/orig.mp4', normalizedSrc: '/orig_normalized_hdr.mp4', start: 0, end: 5, inPoint: 3.5, outPoint: 8.5 }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems.length, 1)
  assert.equal(videoItems[0].src, '/orig_normalized_hdr.mp4')
  // No normalizedInPoint → origin = inPoint (3.5) → rebased inPoint = 0, outPoint = 5.0
  assert.equal(videoItems[0].inPoint, 0)
  assert.equal(videoItems[0].outPoint, 5.0)
})

test('collectAllItems: normalizedSrc with normalizedInPoint rebases by origin (trim-after-cache)', () => {
  // Cache was built at origin 0 (normalizedInPoint=0). User trimmed start to 0.9157.
  // effectiveInPoint = 0.9157 - 0 = 0.9157; effectiveOutPoint = 16.97 - 0 = 16.97.
  const project = {
    tracks: [
      [{ id: 'v', type: 'video', src: '/orig.mp4', normalizedSrc: '/orig_norm.mp4', normalizedInPoint: 0, start: 0, end: 16.0543, inPoint: 0.9157, outPoint: 16.97 }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.ok(Math.abs(videoItems[0].inPoint  - 0.9157) < 0.0001)
  assert.ok(Math.abs(videoItems[0].outPoint - 16.97)  < 0.0001)
})

test('collectAllItems: without normalizedSrc, src and inPoint are unchanged', () => {
  const project = {
    tracks: [
      [{ id: 'primary', type: 'video', src: '/orig.mp4', start: 0, end: 5, inPoint: 3.5, outPoint: 8.5 }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems.length, 1)
  assert.equal(videoItems[0].src, '/orig.mp4')
  assert.equal(videoItems[0].inPoint, 3.5)
})

test('collectAllItems: nobg_src path is NOT rebased even if normalizedSrc present', () => {
  // The nobg alpha clip is a render-only artifact; it is not a normalized cache
  // and its seek must use the original inPoint.
  const project = {
    tracks: [
      [{ id: 'v', type: 'video', src: '/orig.mp4', nobg_src: '/orig_nobg.mov', remove_bg: true, normalizedSrc: '/orig_normalized_hdr.mp4', start: 0, end: 5, inPoint: 2.0, outPoint: 7.0 }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].src, '/orig_nobg.mov')
  assert.equal(videoItems[0].inPoint, 2.0)
})

test('shouldSkipNormalize: lazy + normalizedSrc → skip (cache already conforms)', () => {
  assert.equal(shouldSkipNormalize({ normalize: 'lazy' }, { normalizedSrc: '/orig_normalized_hdr.mp4' }), true)
})

test('shouldSkipNormalize: lazy + no normalizedSrc → do not skip (fallback to normalize)', () => {
  assert.equal(shouldSkipNormalize({ normalize: 'lazy' }, { src: '/orig.mp4' }), false)
})

test('shouldSkipNormalize: eager (normalize absent) → never skip even with normalizedSrc', () => {
  assert.equal(shouldSkipNormalize({}, { normalizedSrc: '/orig_normalized_hdr.mp4' }), false)
})

test('collectAllItems: overlay items are ignored (not image or video)', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'ov1', type: 'overlay', src: '/ov.jsx', start: 0, end: 5 }],
    ],
  }
  const { imageItems, videoItems } = collectAllItems(project)
  assert.equal(imageItems.length, 0)
  assert.equal(videoItems.length, 0)
})

test('collectPuppeteerSegments: picks up overlay items from tracks[1+]', () => {
  const project = {
    tracks: [
      [{ id: 'clip1', type: 'video', src: '/foo.mp4', start: 0, end: 5 }],
      [{ id: 'ov1', type: 'overlay', src: '/abs/ov.jsx', start: 1.0, end: 4.0 }],
    ],
    settings: { fps: 30 },
  }
  const specs = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].id, 'overlay-0--ov1')
  assert.equal(specs[0].startSeconds, 1.0)
  assert.equal(specs[0].endSeconds, 4.0)
  assert.equal(specs[0].frameCount, 90)  // round((4.0-1.0)*30)
})

test('collectPuppeteerSegments: quantizes overlay times to the frame grid', () => {
  // Regression: project boundaries arrive as sub-frame floats (e.g. 5.4474 from
  // the editor). The spec must quantize so the overlay's startSeconds and
  // frameCount agree with the segment that displays it — otherwise compose
  // seeks negative on the first frame and frameCount over-shoots by one,
  // producing a stray trailing frame the segment never renders.
  const project = {
    tracks: [
      [{ id: 'clip1', type: 'video', src: '/foo.mp4', start: 0, end: 10 }],
      [{ id: 'ov1', type: 'overlay', src: '/abs/ov.jsx', start: 5.4474, end: 8.9474 }],
    ],
    settings: { fps: 30 },
  }
  const specs = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg')
  assert.equal(specs[0].startSeconds, 163 / 30)  // round(5.4474*30) / 30
  assert.equal(specs[0].endSeconds,   268 / 30)  // round(8.9474*30) / 30
  assert.equal(specs[0].frameCount,   105)        // 268 - 163
})

test('collectPuppeteerSegments: ignores non-overlay types in tracks[1+]', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'img1', type: 'image', src: '/bg.png', start: 0, end: 5 }],
    ],
    settings: { fps: 30 },
  }
  const specs = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg')
  assert.equal(specs.length, 0)
})

// ---------------------------------------------------------------------------
// resolveFilePath
// ---------------------------------------------------------------------------

test('resolveFilePath: exact match returns path immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-test-'))
  try {
    const p = join(dir, 'clip.mp4')
    writeFileSync(p, '')
    assert.equal(resolveFilePath(p), p)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('resolveFilePath: \u202f in filename resolved to actual file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-test-'))
  // Create file with actual narrow no-break space in name
  const actualName = 'Screenshot\u202f2026-01-01.png'
  try {
    writeFileSync(join(dir, actualName), '')
    // Request path with regular space
    const requested = join(dir, 'Screenshot 2026-01-01.png')
    const resolved = resolveFilePath(requested)
    assert.equal(resolved, join(dir, actualName))
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('resolveFilePath: missing file returns null', () => {
  assert.equal(resolveFilePath('/nonexistent/path/file.mp4'), null)
})

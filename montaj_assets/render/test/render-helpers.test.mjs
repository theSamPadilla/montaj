import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getTotalDurationSeconds, collectAllItems, collectPuppeteerSegments, resolveFilePath, shouldSkipNormalize, buildNormalizedOutputPath } from '../render.js'
import { MASTER_LOOK } from '../look.js'

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

test('getTotalDurationSeconds: object-shape tracks (VisualTrack[]) return the same max end as the legacy array-of-arrays shape', () => {
  // trackItems() (called internally) is both-shapes tolerant; this pins that
  // getTotalDurationSeconds itself never assumes tracks[i] is a bare array.
  const project = {
    tracks: [
      { id: 'trk-0', items: [{ id: 'c1', end: 10.0 }, { id: 'c2', end: 20.0 }] },
      { id: 'trk-1', items: [{ id: 'ov1', end: 15.0 }], volume: 0.8, muted: false },
    ],
  }
  assert.equal(getTotalDurationSeconds(project), 20.0)
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

test('collectAllItems: object-shape tracks (VisualTrack[]) collect the same items as the legacy array-of-arrays shape', () => {
  const project = {
    tracks: [
      { id: 'trk-0', items: [{ id: 'bg1', type: 'image', src: '/bg.png', start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 }] },
      {
        id: 'trk-1',
        items: [
          { id: 'img1', type: 'image', src: '/logo.png', start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 },
          { id: 'vid1', type: 'video', src: '/pip.mp4', start: 2, end: 8, inPoint: 0, outPoint: 6, offsetX: 0, offsetY: 0, scale: 0.5, opacity: 1 },
        ],
        volume: 0.5,
      },
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
  assert.equal(videoItems[0].trackIdx, 1)
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

// ---------------------------------------------------------------------------
// collectAllItems — the output whitelist (SP2 T8)
//
// `collectAllItems` builds each video item from an explicit field whitelist
// rather than spreading the source item. That is deliberate (the renderer's
// items are mutated in place downstream, and a spread would drag editor-only
// fields into the encoder), but it means every field the encoder reads has to
// be listed by hand — and a field that is NOT listed is dropped silently, with
// no type error and no failing test. Both cases below are real shipped bugs of
// exactly that shape. They are pinned here so the T8 swap onto
// `@bycrux/timeline-core`'s `sourceWindow` cannot reintroduce them.
// ---------------------------------------------------------------------------

test('collectAllItems: sourceCrop / sourceWidth / sourceHeight survive the whitelist verbatim (Bug B regression)', () => {
  // SHIPPED BUG (CHANGELOG "Render: sourceCrop is applied again"): these three
  // fields were absent from the whitelist, so `buildVideoItemFilterParts`'s crop
  // gate — which requires ALL THREE — never fired and the clips-workflow
  // vertical reframe was silently a no-op: the full 16:9 source got letterboxed
  // into the portrait canvas instead of being cropped to its 9:16 slice.
  // `normalize_window` keeps the cache at full source dimensions, so the crop
  // MUST survive to encode time whichever src is chosen.
  const crop = { x: 0.1, y: 0.05, w: 0.8, h: 0.9 }
  const project = {
    tracks: [
      [{
        id: 'cropped', type: 'video', src: '/orig.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5,
        sourceCrop: crop, sourceWidth: 1920, sourceHeight: 1080,
      }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.deepEqual(videoItems[0].sourceCrop, crop)
  assert.equal(videoItems[0].sourceCrop, crop, 'forwarded by reference, not cloned')
  assert.equal(videoItems[0].sourceWidth, 1920)
  assert.equal(videoItems[0].sourceHeight, 1080)
})

test('collectAllItems: sourceCrop survives even when the normalized cache is substituted (Bug B + rebase together)', () => {
  // The two fixes interact: substituting `normalizedSrc` rebases in/outPoint,
  // and the crop still has to ride along. `sourceWidth`/`sourceHeight` describe
  // the cache too (normalize_window does not resize), so the crop math holds.
  const crop = { x: 0.2, y: 0, w: 0.5625, h: 1 }
  const project = {
    tracks: [
      [{
        id: 'v', type: 'video', src: '/orig.mp4', normalizedSrc: '/orig_norm.mp4', normalizedInPoint: 5,
        start: 0, end: 5, inPoint: 6, outPoint: 11,
        sourceCrop: crop, sourceWidth: 3840, sourceHeight: 2160,
      }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].src, '/orig_norm.mp4')
  assert.equal(videoItems[0].inPoint, 1)
  assert.equal(videoItems[0].outPoint, 6)
  assert.deepEqual(videoItems[0].sourceCrop, crop)
  assert.equal(videoItems[0].sourceWidth, 3840)
  assert.equal(videoItems[0].sourceHeight, 2160)
})

test('collectAllItems: sourceCrop with NO sourceWidth/sourceHeight is still forwarded — the drop happens downstream [registry: sourcecrop-missing-dims-silent-drop]', () => {
  // KNOWN-DIVERGENCES.md `sourcecrop-missing-dims-silent-drop`. This documents
  // TODAY'S behavior as expected-for-now, not as desirable. collectAllItems has
  // no opinion on the combination — it forwards `sourceCrop` and forwards the
  // two `undefined` dimensions. One layer down, `buildVideoItemFilterParts`'s
  // gate (encode-segment.js:243) needs all three, so it emits no crop= step at
  // all and the reframe vanishes with no warning. Owner of the actual fix: SP4.
  // Mirrored by fixtures/source-crop-missing-dims.json, whose committed
  // encode-args golden contains no crop filter — see encode-args-golden.test.mjs.
  const crop = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 }
  const project = {
    tracks: [
      [{ id: 'croppedNoDims', type: 'video', src: '/orig.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceCrop: crop }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.deepEqual(videoItems[0].sourceCrop, crop)
  assert.equal(videoItems[0].sourceWidth, undefined)
  assert.equal(videoItems[0].sourceHeight, undefined)
  assert.ok('sourceWidth' in videoItems[0], 'the key is present-but-undefined, not absent — the whitelist always sets it')
})

test('collectAllItems: a normalizedSrc item with neither normalizedInPoint nor inPoint rebases to 0, not NaN (the ONE sanctioned SP2 behavior change)', () => {
  // SANCTIONED BEHAVIOR CHANGE (SP2 T2/T8 — the only one in the whole swap).
  // Legacy render.js:613 read `item.normalizedInPoint ?? item.inPoint` with NO
  // `?? 0` tail, so an item carrying neither field made the rebase arithmetic
  // `undefined - undefined` = NaN, and that NaN travelled all the way to
  // ffmpeg's `-ss` (encode-segment.js:216's `item.inPoint ?? 0` does NOT catch
  // it — NaN is not nullish). The editor's copy of this math always had the
  // tail; adopting `sourceWindow(item, 'render')` is how render finally gets it.
  // A missing origin means "origin 0", never NaN.
  // Corpus twin: timeline-core fixtures/nan-case.json.
  const project = {
    tracks: [
      [{ id: 'nanItem', type: 'video', src: '/nan_orig.mp4', normalizedSrc: '/nan_norm.mp4', start: 0, end: 4, outPoint: 4.5 }],
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].src, '/nan_norm.mp4')
  assert.ok(!Number.isNaN(videoItems[0].inPoint), 'inPoint must not be NaN')
  assert.ok(!Number.isNaN(videoItems[0].outPoint), 'outPoint must not be NaN')
  assert.equal(videoItems[0].inPoint, 0)
  assert.equal(videoItems[0].outPoint, 4.5)
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

// ---------------------------------------------------------------------------
// buildNormalizedOutputPath (SP6b Task T3 — look-tagged master naming)
// ---------------------------------------------------------------------------

test('buildNormalizedOutputPath: untagged when not tonemapped', () => {
  assert.equal(
    buildNormalizedOutputPath('/videos/clip.mp4', 'sdr_bt709', false),
    '/videos/clip_normalized_sdr_bt709.mp4'
  )
})

test('buildNormalizedOutputPath: appends the master look when tonemapped', () => {
  assert.equal(
    buildNormalizedOutputPath('/videos/clip.mp4', 'sdr_bt709', true),
    `/videos/clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`
  )
})

test('buildNormalizedOutputPath: trusts the tonemapped flag verbatim, even for an HDR target', () => {
  // Not a real call shape render.js would produce (tonemapped is only ever
  // computed true for an HDR source + SDR target) but pins that the helper
  // itself just does what it's told — namespacing by color space, tagging by
  // the boolean, no re-derivation of "is this really a tonemap" inside it.
  // Mirrors Python's test_hdr_target_gets_tagged_when_told_tonemapped.
  assert.equal(
    buildNormalizedOutputPath('/videos/clip.mp4', 'hdr_hlg', false),
    '/videos/clip_normalized_hdr_hlg.mp4'
  )
  assert.equal(
    buildNormalizedOutputPath('/videos/clip.mp4', 'hdr_hlg', true),
    `/videos/clip_normalized_hdr_hlg_${MASTER_LOOK}.mp4`
  )
})

test('buildNormalizedOutputPath: preserves directory and swaps only the trailing extension segment', () => {
  const out = buildNormalizedOutputPath('/a/b/c/my.clip.mov', 'sdr_bt709', true)
  assert.equal(out, `/a/b/c/my.clip_normalized_sdr_bt709_${MASTER_LOOK}.mp4`)
})

// ── Skipped tracks ──────────────────────────────────────────────────────────
// A track with `enabled: false` must be absent from the export: no picture, no
// audio, and not counted toward the project's length. These drive the exported
// render helpers directly, so a regression shows up here rather than in a file
// someone has to watch.

test('collectAllItems: a skipped track contributes no items', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2 }] },
      { id: 't1', items: [{ id: 'b', type: 'image', src: '/b.png', start: 0, end: 2 }], enabled: false },
    ],
  }
  const { imageItems, videoItems } = collectAllItems(project)
  assert.deepEqual(videoItems.map(i => i.id), ['a'])
  assert.deepEqual(imageItems.map(i => i.id), [], 'the skipped track\'s image is gone')
})

test('collectAllItems: an enabled:true track is included, same as an absent flag', () => {
  const project = {
    tracks: [{ id: 't0', items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2 }], enabled: true }],
  }
  assert.deepEqual(collectAllItems(project).videoItems.map(i => i.id), ['a'])
})

test('getTotalDurationSeconds: skipping the track with the last clip shortens the render', () => {
  // The deliberate call: the export ends where the remaining content ends,
  // rather than running on into blank tail. See docs/plans/2026-08-21-track-skip.md.
  const tracks = [
    { id: 't0', items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 4 }] },
    { id: 't1', items: [{ id: 'b', type: 'image', src: '/b.png', start: 4, end: 10 }] },
  ]
  assert.equal(getTotalDurationSeconds({ tracks }), 10)

  const skipped = [tracks[0], { ...tracks[1], enabled: false }]
  assert.equal(getTotalDurationSeconds({ tracks: skipped }), 4)
})

test('getTotalDurationSeconds: legacy array-of-arrays is unaffected', () => {
  assert.equal(getTotalDurationSeconds({ tracks: [[{ id: 'a', end: 3 }]] }), 3)
})

// ── Track-wide volume/mute ───────────────────────────────────────────────
// collectAllItems folds track.volume/track.muted into each video item's
// effective volume/muted via effectiveItemAudio — multiply for volume, OR for
// mute. See docs/plans/2026-08-21-track-skip.md ("F1 · Track-wide volume and
// mute") and project-tracks.js's effectiveItemAudio for the rule.

test('collectAllItems: track volume multiplies with clip volume, not replaces it', () => {
  const project = {
    tracks: [
      {
        id: 't0',
        volume: 0.5,
        items: [
          { id: 'loud', type: 'video', src: '/loud.mp4', start: 0, end: 2, volume: 1.0 },
          { id: 'quiet', type: 'video', src: '/quiet.mp4', start: 2, end: 4, volume: 0.4 },
        ],
      },
    ],
  }
  const { videoItems } = collectAllItems(project)
  const loud = videoItems.find(i => i.id === 'loud')
  const quiet = videoItems.find(i => i.id === 'quiet')
  assert.equal(loud.volume, 0.5)   // 0.5 * 1.0
  assert.ok(Math.abs(quiet.volume - 0.2) < 1e-9)  // 0.5 * 0.4
  // Multiplying (not replacing) keeps the ratio the operator set between the
  // two clips intact under the track-level pull-down.
  assert.ok(Math.abs(loud.volume / quiet.volume - 1.0 / 0.4) < 1e-9)
})

test('collectAllItems: track mute silences every item on it regardless of clip volume', () => {
  const project = {
    tracks: [
      {
        id: 't0',
        muted: true,
        items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2, volume: 2.0 }],
      },
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].muted, true)
})

test('collectAllItems: a muted clip stays muted when its track is not', () => {
  const project = {
    tracks: [
      {
        id: 't0',
        items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2, muted: true }],
      },
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].muted, true)
})

test('collectAllItems: absent track volume/muted leave the item\'s own audio unchanged', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2, volume: 0.7 }] },
    ],
  }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].volume, 0.7)
  assert.equal(videoItems[0].muted, false)
})

test('collectAllItems: legacy array-of-arrays tracks (no track settings possible) default volume to 1 and muted to false', () => {
  const project = { tracks: [[{ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 2 }]] }
  const { videoItems } = collectAllItems(project)
  assert.equal(videoItems[0].volume, 1)
  assert.equal(videoItems[0].muted, false)
})

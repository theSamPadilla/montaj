// montaj_assets/render/test/glass-plate.test.mjs
//
// The two pure choices glass-plate.js makes before it spawns anything: which
// clips a plate prepares, and the filter chain that writes its frames. The
// rendered result is checked end to end by tests/steps/test_glass_plate.py
// (alignment against sample_frame, colour on saturated swatches, and that a
// clip outside the range is never normalized or audio-stripped).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plateItemFilter, plateFrameFilter } from '../glass-plate.js'

const FPS = 24
const clip = (id, start, end, trackIdx = 0) => ({ id, type: 'video', start, end, trackIdx })

test('plateItemFilter: the clips that can show in the range, to within a frame each side', () => {
  // Range: screen frames 24-47 (1.0-2.0 s). activeIn takes an item active in a
  // segment it covers to within 1/fps, so half a frame outside is still in.
  const items = [
    clip('before', 0, 1 - 2 / FPS),
    clip('half-frame-before', 0, 1 - 0.5 / FPS),
    clip('under', 0.5, 1.5),
    clip('spans', 0, 3),
    clip('half-frame-after', 2 + 0.5 / FPS, 3),
    clip('after', 2 + 2 / FPS, 3),
  ]
  const keep = plateItemFilter({ resolution: [1920, 1080] }, items, 24, 48, FPS)
  assert.deepEqual(items.filter(keep).map((it) => it.id),
    ['half-frame-before', 'under', 'spans', 'half-frame-after'])
})

test('plateItemFilter: without settings.resolution the clip outputSize probes is prepared too', () => {
  // outputSize reads the frame size from the lowest track's first clip's
  // PREPARED file (normalize bakes a rotation in), wherever it sits in time.
  const items = [clip('top', 1, 2, 1), clip('sizer', 10, 11, 0), clip('other', 12, 13, 0)]
  const noRes = plateItemFilter({}, items, 24, 48, FPS)
  assert.deepEqual(items.filter(noRes).map((it) => it.id), ['top', 'sizer'])
  const withRes = plateItemFilter({ resolution: [1080, 1920] }, items, 24, 48, FPS)
  assert.deepEqual(items.filter(withRes).map((it) => it.id), ['top'])
})

test('plateFrameFilter: JPEG frames are BT.601 full range, PNG frames RGB, both read as BT.709 limited', () => {
  assert.equal(plateFrameFilter('jpg', 2.2),
    'gblur=sigma=2.2,scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc,format=yuvj420p')
  assert.equal(plateFrameFilter('png', 0), 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24')
})

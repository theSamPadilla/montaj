// render/test/project-tracks.test.mjs
//
// The load-bearing properties: normalization never mutates its input, is
// idempotent, and returns the SAME OBJECT when the project is already in object
// form (the lazy on-open migration reads that identity as "no write needed").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveItemAudio, enabledTrackItems, enabledTracks, normalizeTracks, trackItems } from '../project-tracks.js'

const item = id => ({ id, type: 'video', src: `${id}.mp4`, start: 0, end: 1 })

const legacyProject = () => ({ id: 'p1', tracks: [[item('a'), item('b')], [item('c')]] })

const objectProject = () => ({
  id: 'p1',
  tracks: [
    { id: 'trk-0', items: [item('a'), item('b')] },
    { id: 'trk-1', items: [item('c')] },
  ],
})

// ── legacy → object ─────────────────────────────────────────────────────────

test('normalizeTracks: legacy shape becomes object shape', () => {
  const out = normalizeTracks(legacyProject())
  assert.deepEqual(out.tracks, [
    { id: 'trk-0', items: [item('a'), item('b')] },
    { id: 'trk-1', items: [item('c')] },
  ])
})

test('normalizeTracks: items are carried by reference and keep order', () => {
  const p = legacyProject()
  const out = normalizeTracks(p)
  assert.equal(out.tracks[0].items[0], p.tracks[0][0])
  assert.equal(out.tracks[0].items[1], p.tracks[0][1])
  assert.equal(out.tracks[1].items[0], p.tracks[1][0])
  assert.deepEqual(out.tracks[0].items.map(i => i.id), ['a', 'b'])
})

test('normalizeTracks: track order is preserved', () => {
  const p = { id: 'p1', tracks: [[item('a')], [item('b')], [item('c')]] }
  const out = normalizeTracks(p)
  assert.deepEqual(out.tracks.map(t => t.id), ['trk-0', 'trk-1', 'trk-2'])
  assert.deepEqual(out.tracks.map(t => t.items[0].id), ['a', 'b', 'c'])
})

test('normalizeTracks: other project keys survive', () => {
  const p = legacyProject()
  p.settings = { resolution: [1080, 1920] }
  const out = normalizeTracks(p)
  assert.equal(out.id, 'p1')
  assert.equal(out.settings, p.settings)
})

// ── purity ──────────────────────────────────────────────────────────────────

test('normalizeTracks: does not mutate its input', () => {
  const p = legacyProject()
  const before = JSON.parse(JSON.stringify(p))
  normalizeTracks(p)
  assert.deepEqual(p, before)
  assert.ok(Array.isArray(p.tracks[0]))  // still legacy shape
})

test('normalizeTracks: item arrays are new containers', () => {
  const p = legacyProject()
  const out = normalizeTracks(p)
  out.tracks[0].items.push(item('z'))
  assert.equal(p.tracks[0].length, 2)
})

// ── identity / idempotency ──────────────────────────────────────────────────

test('normalizeTracks: already-normalized project is returned as the same object', () => {
  const p = objectProject()
  assert.equal(normalizeTracks(p), p)
})

test('normalizeTracks: is idempotent and converges to the same object', () => {
  const once = normalizeTracks(legacyProject())
  const twice = normalizeTracks(once)
  assert.deepEqual(twice, once)
  assert.equal(twice, once)  // converged — the migration must not rewrite it
})

// ── absent / empty tracks ───────────────────────────────────────────────────

test('normalizeTracks: missing tracks key returns the same object and invents nothing', () => {
  const p = { id: 'p1' }
  assert.equal(normalizeTracks(p), p)
  assert.ok(!('tracks' in normalizeTracks(p)))
})

test('normalizeTracks: tracks null/undefined returns the same object', () => {
  const withNull = { id: 'p1', tracks: null }
  assert.equal(normalizeTracks(withNull), withNull)
  assert.equal(withNull.tracks, null)
  const withUndefined = { id: 'p1', tracks: undefined }
  assert.equal(normalizeTracks(withUndefined), withUndefined)
})

test('normalizeTracks: empty tracks array returns the same object', () => {
  const p = { id: 'p1', tracks: [] }
  assert.equal(normalizeTracks(p), p)
})

// ── hostile input ───────────────────────────────────────────────────────────

test('normalizeTracks: tracks that is not an array returns the same object', () => {
  for (const bogus of ['nope', 7, { 'trk-0': [] }]) {
    const p = { id: 'p1', tracks: bogus }
    assert.equal(normalizeTracks(p), p)
  }
})

test('normalizeTracks: a non-array non-object track becomes an empty track', () => {
  const out = normalizeTracks({ id: 'p1', tracks: [null, 'nope', 7] })
  assert.deepEqual(out.tracks, [
    { id: 'trk-0', items: [] },
    { id: 'trk-1', items: [] },
    { id: 'trk-2', items: [] },
  ])
})

test('normalizeTracks: object track missing items gets an empty array', () => {
  const out = normalizeTracks({ id: 'p1', tracks: [{ id: 'trk-0' }] })
  assert.deepEqual(out.tracks, [{ id: 'trk-0', items: [] }])
})

test('normalizeTracks: object track with items null or non-array gets an empty array', () => {
  const out = normalizeTracks({ id: 'p1', tracks: [{ id: 'a', items: null }, { id: 'b', items: 'x' }] })
  assert.deepEqual(out.tracks, [{ id: 'a', items: [] }, { id: 'b', items: [] }])
})

test('normalizeTracks: object track with a missing/empty/non-string id gets a generated one', () => {
  const out = normalizeTracks({
    id: 'p1',
    tracks: [{ items: [item('a')] }, { id: '', items: [] }, { id: 7, items: [] }],
  })
  assert.deepEqual(out.tracks.map(t => t.id), ['trk-0', 'trk-1', 'trk-2'])
})

test('normalizeTracks: on duplicate ids the first holder keeps it', () => {
  const out = normalizeTracks({ id: 'p1', tracks: [{ id: 'dup', items: [] }, { id: 'dup', items: [] }] })
  assert.deepEqual(out.tracks.map(t => t.id), ['dup', 'trk-1'])
})

test('normalizeTracks: an explicit id colliding with a generated one wins the name', () => {
  // Track 1 already owns "trk-0", so track 0's generated id steps aside.
  const out = normalizeTracks({ id: 'p1', tracks: [[item('a')], { id: 'trk-0', items: [item('b')] }] })
  assert.deepEqual(out.tracks.map(t => t.id), ['trk-0-2', 'trk-0'])
})

test('normalizeTracks: generated ids stay unique under repeated collision', () => {
  const out = normalizeTracks({
    id: 'p1',
    tracks: [[], { id: 'trk-0', items: [] }, { id: 'trk-0-2', items: [] }],
  })
  const ids = out.tracks.map(t => t.id)
  assert.deepEqual(ids, ['trk-0-3', 'trk-0', 'trk-0-2'])
  assert.equal(new Set(ids).size, 3)
})

// ── track properties ────────────────────────────────────────────────────────

test('normalizeTracks: track properties and unknown keys survive', () => {
  const out = normalizeTracks({
    id: 'p1',
    tracks: [
      { id: 'trk-0', items: [], volume: 0.8, muted: false, enabled: true, somethingNew: { a: 1 } },
      [item('a')],  // forces a rebuild so the object above is copied, not returned as-is
    ],
  })
  assert.deepEqual(out.tracks[0], {
    id: 'trk-0', items: [], volume: 0.8, muted: false, enabled: true, somethingNew: { a: 1 },
  })
})

test('normalizeTracks: adds no default track properties', () => {
  const out = normalizeTracks(legacyProject())
  assert.deepEqual(Object.keys(out.tracks[0]).sort(), ['id', 'items'])
})

// ── trackItems ──────────────────────────────────────────────────────────────

test('trackItems: legacy shape', () => {
  assert.deepEqual(trackItems(legacyProject()), [[item('a'), item('b')], [item('c')]])
})

test('trackItems: object shape returns the tracks own item arrays', () => {
  const p = objectProject()
  assert.deepEqual(trackItems(p), [[item('a'), item('b')], [item('c')]])
  assert.equal(trackItems(p)[0], p.tracks[0].items)
})

test('trackItems: no tracks', () => {
  assert.deepEqual(trackItems({ id: 'p1' }), [])
  assert.deepEqual(trackItems({ id: 'p1', tracks: null }), [])
  assert.deepEqual(trackItems({ id: 'p1', tracks: [] }), [])
  assert.deepEqual(trackItems({ id: 'p1', tracks: 'nope' }), [])
  assert.deepEqual(trackItems(null), [])
  assert.deepEqual(trackItems(undefined), [])
})

test('trackItems: flattens the same either way', () => {
  const legacy = legacyProject()
  const obj = normalizeTracks(legacy)
  const flat = p => trackItems(p).flat().map(i => i.id)
  assert.deepEqual(flat(legacy), ['a', 'b', 'c'])
  assert.deepEqual(flat(obj), ['a', 'b', 'c'])
})

// ── enabledTrackItems ───────────────────────────────────────────────────────
// The accessor the renderer uses for anything that PRODUCES picture or sound.
// `trackItems` (every track) stays the editing view; these two differing by
// exactly the skipped tracks is the whole feature.

test('enabledTrackItems: empties tracks marked enabled:false, in place', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'a' }] },
      { id: 't1', items: [{ id: 'b' }], enabled: false },
      { id: 't2', items: [{ id: 'c' }], enabled: true },
    ],
  }
  assert.deepEqual(enabledTrackItems(project).map(t => t.map(i => i.id)), [['a'], [], ['c']])
  assert.equal(trackItems(project).length, 3, 'the editing view still sees every track')
})

test('enabledTrackItems: skipping track 0 does not renumber the rest — this is the whole bug', () => {
  // Every consumer indexes this array positionally ([0] = base footage track,
  // .slice(1) = overlay tracks). Filtering skipped tracks out — instead of
  // emptying them in place — would promote t1 into slot 0 and silently drop
  // t2 from the overlay set entirely.
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'base' }], enabled: false },
      { id: 't1', items: [{ id: 'o1' }] },
      { id: 't2', items: [{ id: 'o2' }] },
    ],
  }
  const out = enabledTrackItems(project)
  assert.deepEqual(out.map(t => t.map(i => i.id)), [[], ['o1'], ['o2']])
  assert.deepEqual(out.slice(1).map(t => t.map(i => i.id)), [['o1'], ['o2']])
})

test('enabledTrackItems: absent `enabled` means enabled', () => {
  // Nothing writes the field in, so every pre-existing project relies on this.
  assert.equal(enabledTrackItems({ tracks: [{ id: 't0', items: [{ id: 'a' }] }] }).length, 1)
})

test('enabledTrackItems: legacy array-of-arrays is all-enabled', () => {
  assert.equal(enabledTrackItems({ tracks: [[{ id: 'a' }], [{ id: 'b' }]] }).length, 2)
})

test('enabledTrackItems: items are shared by reference, never copied', () => {
  // resolveProjectPaths rewrites item.src in place through this view; a copy
  // here would break path resolution in the renderer with nothing failing.
  const item = { id: 'a', src: 'rel.mp4' }
  const out = enabledTrackItems({ tracks: [{ id: 't0', items: [item] }] })
  assert.equal(out[0][0], item)
})

test('enabledTrackItems: malformed input yields [] rather than throwing', () => {
  for (const bad of [undefined, null, {}, { tracks: 'nope' }, { tracks: 42 }]) {
    assert.deepEqual(enabledTrackItems(bad), [])
  }
})

// ── enabledTracks ───────────────────────────────────────────────────────────
// The object-shape sibling of enabledTrackItems — same skip test, same order,
// but yields full track objects (with volume/muted/id) instead of flattening
// to items. Exists for collectAllItems' track-audio fold.

test('enabledTracks: empties tracks marked enabled:false in place, keeps full track objects for the rest', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'a' }], volume: 0.6 },
      { id: 't1', items: [{ id: 'b' }], enabled: false },
    ],
  }
  const out = enabledTracks(project)
  assert.deepEqual(out.map(t => t.id), ['t0', 't1'])
  assert.equal(out[0].volume, 0.6)
  assert.deepEqual(out[1].items, [], 'skipped track keeps its slot, empty of items')
})

test('enabledTracks: skipping track 0 does not renumber the rest', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'base' }], enabled: false },
      { id: 't1', items: [{ id: 'o1' }] },
    ],
  }
  const out = enabledTracks(project)
  assert.deepEqual(out.map(t => t.id), ['t0', 't1'])
  assert.deepEqual(out[1].items.map(i => i.id), ['o1'])
})

test('enabledTracks: absent `enabled` means enabled', () => {
  assert.equal(enabledTracks({ tracks: [{ id: 't0', items: [] }] }).length, 1)
})

test('enabledTracks: legacy array-of-arrays normalizes and is all-enabled', () => {
  assert.equal(enabledTracks({ tracks: [[{ id: 'a' }], [{ id: 'b' }]] }).length, 2)
})

test('enabledTracks: malformed input yields [] rather than throwing', () => {
  for (const bad of [undefined, null, {}, { tracks: 'nope' }, { tracks: 42 }]) {
    assert.deepEqual(enabledTracks(bad), [])
  }
})

test('enabledTracks: same skip test and order as enabledTrackItems — the two must never disagree', () => {
  const project = {
    tracks: [
      { id: 't0', items: [{ id: 'a' }] },
      { id: 't1', items: [{ id: 'b' }], enabled: false },
      { id: 't2', items: [{ id: 'c' }] },
    ],
  }
  assert.deepEqual(enabledTracks(project).map(t => t.id), ['t0', 't1', 't2'])
  assert.deepEqual(enabledTracks(project).map(t => t.items.map(i => i.id)), [['a'], [], ['c']])
  assert.deepEqual(enabledTrackItems(project).map(items => items.map(i => i.id)), [['a'], [], ['c']])
})

// ── effectiveItemAudio ──────────────────────────────────────────────────────
// The track x item audio fold. See the function's own doc comment for the
// formula; these tests pin the multiply-not-replace and either/or-mute rules.

test('effectiveItemAudio: multiplies track and item volume', () => {
  assert.equal(effectiveItemAudio({ volume: 0.5 }, { volume: 0.4 }).volume, 0.2)
})

test('effectiveItemAudio: does not let track volume replace a clip volume that was already turned down', () => {
  // Two clips on the same track at different clip volumes keep their RATIO
  // after a track-level pull-down.
  const track = { volume: 0.5 }
  const loud = effectiveItemAudio(track, { volume: 1.0 })
  const quiet = effectiveItemAudio(track, { volume: 0.4 })
  assert.ok(Math.abs(loud.volume / quiet.volume - 1.0 / 0.4) < 1e-9)
})

test('effectiveItemAudio: absent volume on both sides defaults to unity', () => {
  assert.equal(effectiveItemAudio({}, {}).volume, 1)
  assert.equal(effectiveItemAudio(undefined, undefined).volume, 1)
})

test('effectiveItemAudio: an explicit item volume of 0 is respected (nullish coalescing, not falsy)', () => {
  assert.equal(effectiveItemAudio({ volume: 1 }, { volume: 0 }).volume, 0)
})

test('effectiveItemAudio: track muted:true silences regardless of item mute', () => {
  assert.equal(effectiveItemAudio({ muted: true }, { muted: false }).muted, true)
})

test('effectiveItemAudio: item muted:true silences regardless of track mute', () => {
  assert.equal(effectiveItemAudio({ muted: false }, { muted: true }).muted, true)
})

test('effectiveItemAudio: neither muted means unmuted', () => {
  assert.equal(effectiveItemAudio({}, {}).muted, false)
})

test('effectiveItemAudio: tolerates null/undefined track and item without throwing', () => {
  assert.deepEqual(effectiveItemAudio(null, null), { volume: 1, muted: false })
  assert.deepEqual(effectiveItemAudio(undefined, {}), { volume: 1, muted: false })
})

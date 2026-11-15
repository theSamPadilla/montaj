// render/test/segment-cache.test.mjs
//
// The segment cache (segment-cache.js) and the read set it checks (read-set.js): one key per set of inputs, every
// input that changes pixels in the key, a cached chunk reused only while what its page read is unchanged and its
// file is whole, atomic entries, and pruning to the current export's keys. Real tiny FFV1 files from the bundled
// ffmpeg (a few frames); no Chrome.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync,
  statSync, utimesSync, truncateSync, copyFileSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { toFileHref } from '../file-url.js'
import {
  openSegmentCache, keyFields, cacheKey, canonicalJson, withoutWorkDir, WORK_DIR_TOKEN, pageDigest, streamProblem,
  SEGMENT_CACHE_VERSION,
} from '../segment-cache.js'
import { createReadRecorder, sealReads, checkReads } from '../read-set.js'

const ENGINE = Object.freeze({ source: 'engine-under-test', ffmpeg: 'ffmpeg-under-test', chrome: null, software3d: false })

let root
let fixture3   // 3 frames, 216x384 yuva420p FFV1: what a 3-frame chunk of a 108x192 page at captureScale 2 encodes
let fixture2   // the same, 2 frames
let componentPath
let stagePath
let htmlPath

function ffv1(path, frames) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=216x384:r=30', '-frames:v', String(frames),
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska',
    '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000', path], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return path
}

function page(dir, { html = '<html>stage</html>', js = 'console.log("stage")' } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
  writeFileSync(join(dir, 'bundle.js'), js)
  return join(dir, 'index.html')
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'montaj-segcache-'))
  fixture3 = ffv1(join(root, 'fixture3.mkv'), 3)
  fixture2 = ffv1(join(root, 'fixture2.mkv'), 2)
  componentPath = join(root, 'stage.jsx')
  writeFileSync(componentPath, 'export default () => null // stage v1')
  stagePath = componentPath
  htmlPath = page(join(root, 'page'))
})

after(() => { rmSync(root, { recursive: true, force: true }) })

/** A planned 3D job (planChunks' shape) over the shared page and stage. */
function job(over = {}) {
  return {
    id: 'overlay-0--s1', componentPath, htmlPath, props: { sceneJson: '{"cast":[]}', inPoint: 0 }, scene3d: true,
    fps: 30, width: 108, height: 192, captureScale: 2, offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1,
    opaque: false, sdrMaster: true, frameCount: 3, startSeconds: 0, endSeconds: 0.1,
    outputPath: join(root, 'segments', 'overlay-0--s1.mkv'), boundary: { allows: () => true }, propsCache: new Map(),
    needsGoogleFonts: false, subframes: 1, frameStart: 0, frameEnd: 3, chunkIndex: 0, totalChunks: 1,
    ...over,
  }
}

const fieldsOpts = { engine: ENGINE, context: { colorSpace: 'sdr_bt709' }, env: {} }
const keyOfJob = (j, opts = fieldsOpts) => cacheKey(keyFields(j, opts))

/** A fresh cache folder and a session on it, logging into `lines`. */
function session(dir = mkdtempSync(join(root, 'cache-')), opts = {}) {
  const lines = []
  const cache = openSegmentCache({ dir, engine: ENGINE, context: { colorSpace: 'sdr_bt709' }, env: {}, log: (l) => lines.push(l), ...opts })
  return { cache, dir, lines }
}

const entries = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])

// --- the key -----------------------------------------------------------------

test('canonicalJson sorts keys at every depth and leaves undefined fields out', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[{"y":2,"z":1}]},"b":1}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
})

test('withoutWorkDir replaces the whole path that ends in the work dir, in every form, and nothing else', () => {
  const id = 'montaj-bundle-0123456789abcdef'
  const text = [
    `// ../../../../private/var/folders/x/T/${id}/shim.jsx`,
    `import "/var/folders/x/T/${id}/icon-stub.js"`,
    `const a = '${id}'`,
    'const untouched = "montaj-bundle-other"',
  ].join('\n')
  assert.equal(withoutWorkDir(text, id), [
    `// ${WORK_DIR_TOKEN}/shim.jsx`,
    `import "${WORK_DIR_TOKEN}/icon-stub.js"`,
    `const a = '${WORK_DIR_TOKEN}'`,
    'const untouched = "montaj-bundle-other"',
  ].join('\n'))
  // Linear: a path is walked back no further than the last match, so 8 MB with no stop character is one pass.
  const long = 'x'.repeat(4e6) + id + ' ' + 'y'.repeat(4e6) + id
  const out = withoutWorkDir(long, id)
  assert.ok(out === `${WORK_DIR_TOKEN} ${WORK_DIR_TOKEN}`, 'each path, prefix and all, is one token')
})

test('bundling the same spec twice, in two random work dirs, gives one key', async () => {
  const proj = join(root, 'proj')
  mkdirSync(proj, { recursive: true })
  const comp = join(proj, 'Shot.jsx')
  writeFileSync(comp, 'export default function Shot({ frame }) { return <div>{frame}</div> }\n')
  const spec = { componentPath: comp, props: { sceneJson: '{"a":1}' }, fps: 30, durationFrames: 3, width: 108, height: 192, projectDir: proj }
  const a = await bundleComponent(spec)
  const b = await bundleComponent(spec)
  try {
    assert.notEqual(a.workDir, b.workDir)
    const rawA = readFileSync(join(a.workDir, 'bundle.js'), 'utf8')
    const rawB = readFileSync(join(b.workDir, 'bundle.js'), 'utf8')
    assert.ok(rawA.includes(basename(a.workDir)), 'the bundle names its own work dir (esbuild\'s path comments)')
    assert.notEqual(rawA, rawB, 'so the raw bundles differ')
    assert.equal(pageDigest(a.htmlPath), pageDigest(b.htmlPath))
    const ka = keyOfJob(job({ componentPath: comp, htmlPath: a.htmlPath, props: spec.props }))
    const kb = keyOfJob(job({ componentPath: comp, htmlPath: b.htmlPath, props: spec.props }))
    assert.match(ka, /^[0-9a-f]{64}$/)
    assert.equal(ka, kb)
  } finally {
    cleanupBundle(a.workDir)
    cleanupBundle(b.workDir)
  }
})

test('changing any one key field gives a new key', () => {
  const base = keyOfJob(job())
  assert.match(base, /^[0-9a-f]{64}$/)
  const kf = [{ property: 'opacity', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }]
  const rows = [
    ['fps', { fps: 60 }],
    ['width', { width: 110 }],
    ['height', { height: 194 }],
    ['captureScale', { captureScale: 1 }],
    ['offsetX', { offsetX: 5 }],
    ['offsetY', { offsetY: 5 }],
    ['scale', { scale: 1.5 }],
    ['scaleX', { scaleX: 1.2 }],
    ['scaleY', { scaleY: 0.8 }],
    ['rotation', { rotation: 10 }],
    ['opacity', { opacity: 0.5 }],
    ['keyframes', { keyframes: kf }],
    ['opaque', { opaque: true }],
    ['transitionTo', { transitionTo: true }],
    ['fades', { fades: true }],
    ['sdrMaster', { sdrMaster: false }],
    ['scene3d', { scene3d: false }],
    ['subframes (motion blur)', { subframes: 5 }],
    ['shutter', { shutter: 'trailing' }],
    ['frameCount', { frameCount: 4 }],
    ['isCaption', { isCaption: true }],
    ['props', { props: { sceneJson: '{"cast":[1]}', inPoint: 0 } }],
    ['frame range', { frameStart: 1, frameEnd: 3 }],
    ['window from', { frameFrom: 0 }],
    ['window to', { frameTo: 3 }],
  ]
  const seen = new Set([base])
  for (const [name, change] of rows) {
    const key = keyOfJob(job(change))
    assert.ok(key, `${name}: keyed`)
    assert.notEqual(key, base, name)
    seen.add(key)
  }
  assert.equal(seen.size, rows.length + 1, 'every row its own key')
  assert.notEqual(keyOfJob(job(), { ...fieldsOpts, context: { colorSpace: 'hdr_hlg' } }), base, 'colour space')
  assert.notEqual(keyOfJob(job(), { ...fieldsOpts, engine: { ...ENGINE, ffmpeg: 'another ffmpeg' } }), base, 'engine')
  assert.notEqual(keyOfJob(job(), { ...fieldsOpts, version: SEGMENT_CACHE_VERSION + 1 }), base, 'cache version')
})

test('changing the source bytes, the stage bytes or the page bytes gives a new key; a moved file with the same bytes does not', () => {
  const dir = mkdtempSync(join(root, 'bytes-'))
  const comp = join(dir, 'Comp.jsx')
  const stage = join(dir, 'stage.jsx')
  writeFileSync(comp, 'export default () => 1')
  writeFileSync(stage, '// stage 1')
  const pg = page(join(dir, 'page'))
  const opts = { ...fieldsOpts, env: { MONTAJ_SCENE3D_STAGE: stage } }
  const at = () => keyOfJob(job({ componentPath: comp, htmlPath: pg }), opts)
  const base = at()
  writeFileSync(comp, 'export default () => 22')
  const source = at()
  assert.notEqual(source, base, 'source bytes')
  writeFileSync(stage, '// stage 22')
  const staged = at()
  assert.notEqual(staged, source, 'stage bytes')
  writeFileSync(pg, '<html>stage, edited</html>')
  const paged = at()
  assert.notEqual(paged, staged, 'index.html bytes')
  writeFileSync(join(dir, 'page', 'bundle.js'), 'console.log("stage, edited")')
  assert.notEqual(at(), paged, 'bundle.js bytes')
  // A stage is hashed only for a stage segment.
  assert.equal(keyOfJob(job({ componentPath: comp, htmlPath: pg, scene3d: false, props: { sceneJson: '{}' } }), opts),
    keyOfJob(job({ componentPath: comp, htmlPath: pg, scene3d: false, props: { sceneJson: '{}' } }), { ...opts, env: {} }))
  const copy = join(dir, 'Copy.jsx')
  copyFileSync(comp, copy)
  assert.equal(keyOfJob(job({ componentPath: copy, htmlPath: pg }), opts), at(), 'the source path is not in the key, its bytes are')
})

test('what never changes a pixel of the capture is not in the key', () => {
  const base = keyOfJob(job())
  for (const change of [
    { id: 'overlay-3--renamed' }, { outputPath: '/elsewhere/x.mkv' }, { startSeconds: 12, endSeconds: 12.1 },
    { chunkIndex: 4, totalChunks: 9 }, { boundary: { allows: () => false } }, { propsCache: new Map([['u', {}]]) },
  ]) assert.equal(keyOfJob(job(change)), base, JSON.stringify(Object.keys(change)))
})

test('a job that cannot be keyed has no key: an unreadable page, source or named stage, or no frame range', () => {
  assert.equal(keyOfJob(job({ htmlPath: join(root, 'nope', 'index.html') })), null)
  assert.equal(keyOfJob(job({ componentPath: join(root, 'nope.jsx') })), null)
  assert.equal(keyOfJob(job(), { ...fieldsOpts, env: { MONTAJ_SCENE3D_STAGE: join(root, 'gone-stage.jsx') } }), null)
  assert.equal(keyOfJob(job({ frameStart: 3, frameEnd: 3 })), null)
  const { cache } = session()
  assert.equal(cache.keyOf(job({ scene3d: false, props: {} })), null, 'a 2D job has no key')
})

// --- entries ---------------------------------------------------------------

test('a kept chunk is reused by the next export, and its entry is the .mkv and its manifest', () => {
  const { cache, dir } = session()
  const j = job()
  assert.equal(cache.store(j, fixture3), true)
  const key = cache.keyOf(j)
  assert.deepEqual(entries(dir), [`${key}.json`, `${key}.mkv`])
  const manifest = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'))
  assert.equal(manifest.key, key)
  assert.equal(manifest.frames, 3)
  assert.deepEqual(manifest.stream, { codec_name: 'ffv1', width: 216, height: 384, pix_fmt: 'yuva420p', nb_read_packets: 3 })
  const next = session(dir)
  assert.equal(next.cache.lookup(job()), join(dir, `${key}.mkv`))
  assert.deepEqual(next.lines, [])
})

test('a truncated, empty or short cached file is a miss and its entry is deleted', () => {
  for (const [name, spoil] of [
    ['truncated', (f) => truncateSync(f, Math.floor(statSync(f).size / 2))],
    ['empty', (f) => truncateSync(f, 0)],
    ['two of three frames', (f) => copyFileSync(fixture2, f)],
  ]) {
    const { cache, dir } = session()
    const j = job()
    assert.equal(cache.store(j, fixture3), true, name)
    spoil(join(dir, `${cache.keyOf(j)}.mkv`))
    const next = session(dir)
    assert.equal(next.cache.lookup(job()), null, name)
    assert.deepEqual(entries(dir), [], `${name}: deleted`)
    assert.match(next.lines.join('\n'), /not reused \(/, name)
  }
})

test('a manifest with no read set, no stream, or another key is a miss, never an empty read set', () => {
  for (const [name, spoil] of [
    ['no reads', (m) => { delete m.reads }],
    ['reads with no files', (m) => { delete m.reads.files }],
    ['no stream', (m) => { delete m.stream }],
    ['another key', (m) => { m.key = '0'.repeat(64) }],
    ['another version', (m) => { m.version += 1 }],
  ]) {
    const { cache, dir } = session()
    const j = job()
    assert.equal(cache.store(j, fixture3), true, name)
    const json = join(dir, `${cache.keyOf(j)}.json`)
    const manifest = JSON.parse(readFileSync(json, 'utf8'))
    spoil(manifest)
    writeFileSync(json, JSON.stringify(manifest))
    const next = session(dir)
    assert.equal(next.cache.lookup(job()), null, name)
    assert.deepEqual(entries(dir), [], `${name}: deleted`)
  }
})

test('a chunk that is not what a fresh chunk of its job would be is never kept', () => {
  const { cache, dir, lines } = session()
  assert.equal(cache.store(job({ frameEnd: 4, frameCount: 4 }), fixture3), false, '3 frames for a 4-frame chunk')
  assert.equal(cache.store(job({ opaque: true }), fixture3), false, 'alpha where the job captures none')
  assert.equal(cache.store(job({ width: 200 }), fixture3), false, 'another size')
  assert.equal(cache.store(job(), join(root, 'missing.mkv')), false, 'no file')
  assert.deepEqual(entries(dir), [])
  assert.equal(lines.length, 4)
  assert.ok(lines.every((l) => /^segment cache: (overlay-0--s1 not kept|could not keep overlay-0--s1) \(/.test(l)), lines.join('\n'))
})

test('streamProblem: one packet per frame, FFV1, the capture\'s pix_fmt and size, and the size it was kept at', () => {
  const ok = { codec_type: 'video', codec_name: 'ffv1', width: 216, height: 384, pix_fmt: 'yuva420p', nb_read_packets: '3' }
  const j = job()
  assert.equal(streamProblem([ok], j), null)
  assert.equal(streamProblem([ok], j, { width: 216, height: 384 }), null)
  assert.match(streamProblem([], j), /no video stream/)
  assert.match(streamProblem([{ ...ok, nb_read_packets: '0' }], j), /holds 0 of its 3 frames/)
  assert.match(streamProblem([{ ...ok, codec_name: 'h264' }], j), /codec is h264/)
  assert.match(streamProblem([{ ...ok, pix_fmt: 'yuv420p' }], j), /pixel format is yuv420p, not yuva420p/)
  assert.equal(streamProblem([{ ...ok, pix_fmt: 'yuv420p' }], job({ opaque: true })), null, 'opaque: no alpha')
  assert.match(streamProblem([{ ...ok, width: 220 }], j), /size is 220x384/)
  assert.equal(streamProblem([{ ...ok, width: 217 }], j), null, 'a pixel of rounding')
  assert.match(streamProblem([{ ...ok, width: 217 }], j, { width: 216, height: 384 }), /kept at/)
})

test('a .tmp with no manifest, or a bare .mkv, is not an entry: never reused, and the start prune removes it', () => {
  const { cache, dir } = session()
  const key = cache.keyOf(job())
  mkdirSync(dir, { recursive: true })
  copyFileSync(fixture3, join(dir, `${key}.mkv.tmp.123`))
  writeFileSync(join(dir, `${key}.json.tmp.123`), '{}')
  assert.equal(cache.lookup(job()), null)
  const next = session(dir)
  next.cache.begin([job()])
  assert.deepEqual(entries(dir), [], 'strays pruned')
  // A bare .mkv under a current key (a write stopped before its manifest).
  copyFileSync(fixture3, join(dir, `${key}.mkv`))
  const third = session(dir)
  assert.deepEqual(third.cache.begin([job()]), { hits: 0, keys: 1 })
  assert.deepEqual(entries(dir), [])
})

test('the start prune keeps exactly the current keys', () => {
  const { cache, dir } = session()
  const a = job({ id: 'a', props: { sceneJson: '"a"' } })
  const b = job({ id: 'b', props: { sceneJson: '"b"' } })
  const c = job({ id: 'c', props: { sceneJson: '"c"' } })
  for (const j of [a, b, c]) assert.equal(cache.store(j, fixture3), true)
  writeFileSync(join(dir, 'stray.txt'), 'x')
  const next = session(dir)
  const got = next.cache.begin([job({ id: 'a', props: { sceneJson: '"a"' } }), job({ id: 'b', props: { sceneJson: '"b"' } }),
    job({ id: 'title', scene3d: false, props: {} })])
  assert.deepEqual(got, { hits: 2, keys: 2 })
  const keep = [next.cache.keyOf(a), next.cache.keyOf(b)].flatMap((k) => [`${k}.json`, `${k}.mkv`]).sort()
  assert.deepEqual(entries(dir), keep)
  assert.match(next.lines.join('\n'), /2 of 2 3d chunk\(s\) can be reused, 3 old file\(s\) removed/)
})

test('end() deletes every file the export neither reused nor wrote, once, and nothing before begin()', () => {
  const { cache, dir } = session()
  const [a, b, c] = ['a', 'b', 'c'].map((id) => job({ id, props: { sceneJson: `"${id}"` } }))
  for (const j of [a, b, c]) cache.store(j, fixture3)
  const idle = session(dir)
  assert.equal(idle.cache.end(), 0)
  assert.equal(entries(dir).length, 6, 'an export that never began leaves the cache as it was')
  const next = session(dir)
  next.cache.begin([a])
  assert.equal(entries(dir).length, 2, 'b and c are not this export\'s: gone at begin')
  // After begin: a stopped write's stray, and an entry this export did not reuse or write.
  writeFileSync(join(dir, `${next.cache.keyOf(b)}.mkv.tmp.999`), 'partial')
  const later = session(dir)
  later.cache.store(b, fixture3)
  assert.equal(entries(dir).length, 5)
  assert.equal(next.cache.end(), 3)
  assert.deepEqual(entries(dir), [`${next.cache.keyOf(a)}.json`, `${next.cache.keyOf(a)}.mkv`])
  assert.equal(next.cache.end(), 0, 'once')
})

test('a write that fails is one log line, never a throw', () => {
  const blocker = join(root, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const { cache, lines } = session(join(blocker, 'segment-cache'))
  assert.equal(cache.store(job(), fixture3), false)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^segment cache: could not keep overlay-0--s1 \(/)
})

// --- the read set ------------------------------------------------------------

/** A chunk kept with a page that read `paths` (file URLs through the recorder), in a fresh cache. */
function keptReading(paths, { j = job(), blocked = [] } = {}) {
  const rec = createReadRecorder({ skipDir: join(root, 'page') })
  for (const p of paths) rec.allowed(toFileHref(p))
  const s = session()
  assert.equal(s.cache.store(j, fixture3, rec.reads(blocked)), true, s.lines.join('\n'))
  return s
}

test('the recorder keeps file reads with their stat, skips the page\'s own files and data/blob URLs, and marks the network', () => {
  const asset = join(root, 'asset-a.glb')
  writeFileSync(asset, 'model')
  const rec = createReadRecorder({ skipDir: join(root, 'page') })
  rec.allowed(toFileHref(asset))
  rec.allowed(toFileHref(asset) + '?v=2')
  rec.allowed(toFileHref(join(root, 'page', 'bundle.js')))
  rec.allowed('data:image/png;base64,AAAA')
  rec.allowed('blob:file:///abc')
  rec.allowed(toFileHref(join(root, 'never-there.png')))
  const reads = rec.reads(['https://example.invalid/x'])
  assert.deepEqual(reads.files.map((f) => f.path), [asset, join(root, 'never-there.png')])
  assert.equal(reads.files[0].size, 5)
  assert.equal(reads.files[1].missing, true)
  assert.deepEqual(reads.network, [])
  assert.deepEqual(reads.blocked, ['https://example.invalid/x'])
  rec.allowed('https://fonts.googleapis.com/css2?family=Anton')
  assert.match(sealReads(rec.reads(), job()).why, /fetched from the network/)
})

test('a read-set file that changes size is a miss, and the stale entry is deleted', () => {
  const asset = join(root, 'tex-size.png')
  writeFileSync(asset, 'texture')
  const { dir } = keptReading([asset])
  appendFileSync(asset, '!')
  const next = session(dir)
  assert.equal(next.cache.lookup(job()), null)
  assert.deepEqual(entries(dir), [])
  assert.match(next.lines[0], /not reused \(.*tex-size\.png changed\)/)
})

test('a read-set file rewritten with the same size and its mtime put back is taken as unchanged (the size+mtime rule)', () => {
  // Documented limit (read-set.js): size, mtimeMs and inode all equal pass without hashing, as every mtime-based
  // build tool does. In-place writes keep the inode.
  // A whole-second mtime, so putting it back is exact (a Date carries milliseconds, the disk finer).
  const asset = join(root, 'tex-same.png')
  const when = 1_700_000_000
  writeFileSync(asset, 'AAAA')
  utimesSync(asset, when, when)
  const { dir } = keptReading([asset])
  writeFileSync(asset, 'BBBB')
  utimesSync(asset, when, when)
  assert.ok(session(dir).cache.lookup(job()))
})

test('a read-set file whose mtime changed but whose bytes did not is a hit, by its sha256', () => {
  const asset = join(root, 'tex-touched.png')
  writeFileSync(asset, 'same bytes')
  const { dir } = keptReading([asset])
  utimesSync(asset, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  assert.ok(session(dir).cache.lookup(job()))
  writeFileSync(asset, 'other byte')
  const next = session(dir)
  assert.equal(next.cache.lookup(job()), null, 'same size, new mtime, other bytes: a miss')
})

test('a file the page did not find that now exists, or a file that is gone, is a miss', () => {
  const later = join(root, 'appears-later.png')
  const { dir } = keptReading([later])
  writeFileSync(later, 'now here')
  assert.equal(session(dir).cache.lookup(job()), null)
  const gone = join(root, 'goes-away.png')
  writeFileSync(gone, 'here')
  const s = keptReading([gone])
  rmSync(gone)
  assert.equal(session(s.dir).cache.lookup(job()), null)
})

test('a read the guard blocked that it would now allow is a miss', () => {
  const outside = toFileHref(join(root, 'outside', 'logo.png'))
  const denies = { allows: () => false }
  const { dir } = keptReading([], { j: job({ boundary: denies }), blocked: [outside] })
  assert.ok(session(dir).cache.lookup(job({ boundary: denies })), 'still blocked: a hit')
  assert.equal(session(dir).cache.lookup(job({ boundary: { allows: () => true } })), null)
})

test('a props URL is kept by its body: a changed body is a miss; one fetched on demand is never kept', () => {
  const url = 'https://cdn.example/texture.png'
  const at = (body) => job({ propsCache: new Map([[url, { contentType: 'image/png', body: Buffer.from(body) }]]) })
  const rec = createReadRecorder()
  rec.cached(url)
  const s = session()
  assert.equal(s.cache.store(at('v1'), fixture3, rec.reads()), true)
  assert.ok(session(s.dir).cache.lookup(at('v1')))
  assert.equal(session(s.dir).cache.lookup(at('v2')), null)
  assert.match(sealReads(rec.reads(), job()).why, /fetched on demand/)
})

test('a file that changed while its chunk rendered keeps the chunk out', () => {
  const asset = join(root, 'tex-mid.png')
  writeFileSync(asset, 'one')
  const rec = createReadRecorder()
  rec.allowed(toFileHref(asset))
  writeFileSync(asset, 'three')
  assert.match(sealReads(rec.reads(), job()).why, /changed while it rendered/)
  assert.equal(checkReads({ files: [], props: [], blocked: [] }, job()), null, 'an empty read set is unchanged')
})

// montaj_assets/render/test/windows-argv-cap.test.mjs
//
// WIN1b: every ffmpeg spawn's command line fits Windows' 32,767-character
// CreateProcess cap. A single eased zoom on one photo writes a filter graph of
// ~90k characters, so the graph must reach ffmpeg through a file
// (`-/filter_complex <path>`), never as an argv element.
//
// Checked AT THE LEAF: ffmpeg is a stub, and the stub is the process the OS
// spawned, so the argv it logs is the command line Windows would have been
// handed. Comparing strings inside encode-segment.js would only prove the code
// agrees with itself.
//
// Import order matters. ffmpeg-bin.js reads MONTAJ_FFMPEG once, at import, so
// the env is set first and encode-segment.js is imported dynamically after it
// (a static import would hoist above the assignment). `node --test` runs each
// file in its own process, so this env does not leak into other files.
import { describe, test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CAP = 32_767
const WORK = mkdtempSync(join(tmpdir(), 'montaj-argv-cap-'))
const STUB = join(WORK, 'ffmpeg-stub.cjs')
const PROBE_STUB = join(WORK, 'ffprobe-stub.cjs')

// On `-filters` it lists zscale and lut3d, so the live path takes the branch
// `_dryRun` pins (both probes true). Otherwise it logs its argv and the content
// of every file named after a `-/…` option, read while the file exists, then
// exits WIN1B_STUB_EXIT (default 0).
writeFileSync(STUB, `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
if (argv.includes('-filters')) {
  process.stdout.write(' T.C zscale            V->V       stub\\n TSC lut3d             V->V       stub\\n')
  process.exit(0)
}
const scripts = []
for (let i = 0; i < argv.length - 1; i++) {
  if (!argv[i].startsWith('-/')) continue
  let content = null
  try { content = fs.readFileSync(argv[i + 1], 'utf8') } catch {}
  scripts.push({ opt: argv[i], path: argv[i + 1], content })
}
fs.appendFileSync(process.env.WIN1B_STUB_LOG, JSON.stringify({ argv, scripts }) + '\\n')
process.exit(Number(process.env.WIN1B_STUB_EXIT || 0))
`, { mode: 0o755 })
chmodSync(STUB, 0o755)
// The inputs the stubbed encodes name: the encoders re-check that their files exist.
for (const f of ['photo.png', 'a.wav', 'b.wav', 'v.mp4']) writeFileSync(join(WORK, f), '')

// §116: every segment encode is followed by segment-check.js's probe (5.20.5,
// assertSegmentHasVideo), which reads ffprobe's JSON. Answered here with one
// video stream that has frames; the encode stub above logs only ffmpeg calls.
// Pointing ffprobe at the encode stub printed nothing, and JSON.parse('') threw
// out of every encode that exited 0.
writeFileSync(PROBE_STUB, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', nb_read_packets: '150' }] }))
`, { mode: 0o755 })
chmodSync(PROBE_STUB, 0o755)

process.env.MONTAJ_FFMPEG = STUB
process.env.MONTAJ_FFPROBE = PROBE_STUB
const { FFMPEG } = await import('../ffmpeg-bin.js')
const { encodeSegment, encodeSegmentGroup } = await import('../encode-segment.js')
const { mixAudioIntoVideo, buildAudioTrackFilters, loudnessFilter } = await import('../mix-audio.js')
// sample-frame.js fixes its cache dir from tmpdir() at import, so TMPDIR moves
// inside WORK first. (The mix test below sets and restores its own TMPDIR.)
process.env.TMPDIR = mkdtempSync(join(WORK, 'tmp-'))
const { sampleFrame } = await import('../sample-frame.js')

// One photo, one eased 2x crop zoom over 5 s. probedWidth/Height are the image
// path's test seam (encode-segment.js animatedImageCrop), so no ffprobe runs.
const ease = (prop, a, b) => ({ prop, points: [{ t: 0, value: a, easing: 'ease-in-out' }, { t: 5, value: b }] })
const segmentFor = (src) => ({
  start: 0, end: 5, vw: 1080, vh: 1920, fps: 30, overlays: [],
  items: [{
    type: 'image', src, start: 0, end: 5, scale: 1, offsetX: 0, offsetY: 0,
    probedWidth: 1080, probedHeight: 1920,
    keyframes: [ease('cropX', 0, 0.25), ease('cropY', 0, 0.25), ease('cropW', 1, 0.5), ease('cropH', 1, 0.5)],
  }],
})
const SEGMENT = segmentFor(join(WORK, 'photo.png'))

let logN = 0
function freshLog() {
  const p = join(WORK, `calls-${++logN}.jsonl`)
  process.env.WIN1B_STUB_LOG = p
  return p
}
function readLog(p) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
// An upper bound on the Windows command line libuv builds from [file, ...args]
// (MSVCRT quoting): two quotes and a separator per argument, and at most every
// character doubled by escaping.
const cmdlineBound = (argv) => [FFMPEG, ...argv].reduce((s, a) => s + 2 * a.length + 3, 0)
const cmdlineLen = (argv) => [FFMPEG, ...argv].reduce((s, a) => s + a.length + 3, 0)
const scriptsIn = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('montaj-fc-')) : []

let warn
before(() => { warn = mock.method(console, 'warn', () => {}) })
after(() => {
  warn.mock.restore()
  rmSync(WORK, { recursive: true, force: true })
})

test('the stub is the ffmpeg encode-segment.js spawns', () => {
  assert.equal(FFMPEG, STUB)
})

describe('an eased crop zoom on one photo, at the leaf', () => {
  const outputPath = join(WORK, 'main.segments', 'seg-000.mp4')
  let graph, calls, scriptExistedAfter

  before(async () => {
    const dry = await encodeSegment(SEGMENT, outputPath, { _dryRun: true })
    graph = dry.filterParts.join(';')
    const log = freshLog()
    await encodeSegment(SEGMENT, outputPath)
    calls = readLog(log)
    scriptExistedAfter = calls.flatMap((c) => c.scripts).map((s) => existsSync(s.path))
  })

  test('1. fixture: the graph alone is over the cap', () => {
    assert.ok(graph.length > CAP,
      `the fixture no longer reaches the cap (graph ${graph.length} chars); pick one that does`)
  })

  test('2. the stub ran: exactly one call, ending in outputPath', () => {
    assert.equal(calls.length, 1, `logged calls: ${calls.length}`)
    assert.equal(calls[0].argv.at(-1), outputPath)
  })

  test('3. every command line fits under the cap', () => {
    for (const c of calls) {
      const bound = cmdlineBound(c.argv)
      assert.ok(bound < CAP,
        `command line bound ${bound} >= ${CAP} (len+3 measure: ${cmdlineLen(c.argv)})`)
    }
  })

  test('4. the graph goes by -/filter_complex, never inline', () => {
    const argv = calls[0].argv
    assert.ok(argv.includes('-/filter_complex'), 'no -/filter_complex in argv')
    assert.ok(!argv.includes('-filter_complex'), '-filter_complex is still in argv')
    assert.ok(!argv.some((a) => a.includes(graph)), 'an argv element carries the graph')
  })

  test('5. the script ffmpeg read is the dry-run graph, exactly', () => {
    const s = calls[0].scripts.find((x) => x.opt === '-/filter_complex')
    assert.ok(s, 'no -/filter_complex script was logged')
    assert.ok(s.content === graph, `script (${s.content?.length} chars) !== graph (${graph.length} chars)`)
  })

  test('6. the script is gone afterwards, and lived beside the output', () => {
    const s = calls[0].scripts.find((x) => x.opt === '-/filter_complex')
    assert.ok(s, 'no -/filter_complex script was logged')
    assert.equal(dirname(s.path), dirname(outputPath))
    assert.deepEqual(scriptExistedAfter, [false])
    assert.deepEqual(scriptsIn(dirname(outputPath)), [])
  })
})

describe('no render source builds an inline -filter_complex spawn', () => {
  const RENDER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sources = readdirSync(RENDER_DIR).filter((f) => f.endsWith('.js'))

  test('the scan covers the spawning modules', () => {
    for (const f of ['encode-segment.js', 'sample-frame.js', 'mix-audio.js']) {
      assert.ok(sources.includes(f), `${f} not in the scanned set (${sources.length} files)`)
    }
  })

  test('a source that builds a -filter_complex pair also calls externalizeFilterGraph', () => {
    // Callers keep building the inline pair (so _dryRun and the goldens pin the
    // graph) and hand it to the helper before the spawn. Every literal needs a
    // route, so a second spawn in a file that already has one still fails. A
    // route is a direct externalizeFilterGraph call, or a call of
    // encode-segment.js's runFfmpeg, which makes that call for every spawn
    // (§116: its two encodes, the segment and the short-part join, share it, so
    // counting only the helper's one call read the join as inline). Its own
    // inner call is then not a route of its own. filter-script.js itself is the
    // helper and is excluded. Comments are stripped first. The leaf tests prove
    // the routes are live.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    const count = (src, re) => (src.match(re) || []).length
    const hits = sources
      .filter((f) => f !== 'filter-script.js')
      .map((f) => {
        const src = strip(readFileSync(join(RENDER_DIR, f), 'utf8'))
        const direct = count(src, /\bexternalizeFilterGraph\(/g)
        const runner = /\bfunction runFfmpeg\([^)]*\)\s*\{[^]*?\bexternalizeFilterGraph\(/.test(src)
        const runs = runner ? count(src, /\brunFfmpeg\(/g) - count(src, /\bfunction runFfmpeg\(/g) : 0
        return [f, count(src, /['"]-filter_complex['"]/g), direct - (runner ? 1 : 0) + runs]
      })
      .filter(([, literals, routes]) => literals > routes)
      .map(([f, literals, routes]) => `${f}: ${literals} literal(s), ${routes} route(s)`)
    assert.deepEqual(hits, [], `inline -filter_complex with too few externalizeFilterGraph calls: ${hits.join('; ')}`)
  })
})

describe('the audio mix, at the leaf', () => {
  const TRACKS = [
    { src: join(WORK, 'a.wav'), start: 0, volume: 0.8 },
    { src: join(WORK, 'b.wav'), start: 1.5, volume: 0.5 },
  ]
  test('mixAudioIntoVideo passes -/filter_complex with the exact graph and removes the file', () => {
    const tmp = join(WORK, 'mix-tmp')
    mkdirSync(tmp, { recursive: true })
    const oldTmp = process.env.TMPDIR
    process.env.TMPDIR = tmp
    const log = freshLog()
    try {
      mixAudioIntoVideo(join(WORK, 'v.mp4'), TRACKS, join(WORK, 'out.mp4'), { loudness: -14 })
    } finally {
      if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp
    }
    const calls = readLog(log)
    // With settings.loudness set the mix is measured first (a decode-only pass
    // that also goes through a script file), then muxed: two calls, the last
    // one is the real graph.
    assert.equal(calls.length, 2)
    assert.ok(calls[0].scripts.find((x) => x.opt === '-/filter_complex')?.content.includes('print_format=json'), 'first call is the silence measurement')
    const { filterParts, audioLabel } = buildAudioTrackFilters(TRACKS, 1, '[0:a]')
    const expected = [...filterParts, loudnessFilter(audioLabel, -14).part].join(';')
    const argv = calls[1].argv
    assert.ok(argv.includes('-/filter_complex'), 'no -/filter_complex in argv')
    assert.ok(!argv.includes('-filter_complex'), '-filter_complex is still in argv')
    const s = calls[1].scripts.find((x) => x.opt === '-/filter_complex')
    assert.ok(s, 'no script logged')
    assert.ok(s.content === expected, 'script content !== expected graph')
    assert.equal(dirname(s.path), tmp)
    assert.equal(existsSync(s.path), false)
    assert.deepEqual(scriptsIn(tmp), [])
  })

  test('ffmpeg exits non-zero: mixAudioIntoVideo throws, the script is gone', () => {
    const tmp = join(WORK, 'mix-tmp-fail')
    mkdirSync(tmp, { recursive: true })
    const oldTmp = process.env.TMPDIR
    process.env.TMPDIR = tmp
    process.env.WIN1B_STUB_EXIT = '1'
    freshLog()
    try {
      assert.throws(() => mixAudioIntoVideo(join(WORK, 'v.mp4'), TRACKS, join(WORK, 'out.mp4')), /ffmpeg audio mix failed/)
    } finally {
      delete process.env.WIN1B_STUB_EXIT
      if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp
    }
    assert.deepEqual(scriptsIn(tmp), [])
  })
})

describe('the composite frame sample, at the leaf', () => {
  test('sampleFrame passes -/filter_complex with a non-empty script and removes it', async () => {
    const still = join(WORK, 'still.png')
    // 1x1 PNG; the stub never decodes it.
    writeFileSync(still, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const outPath = join(WORK, 'sample-out', 'frame.png')
    const log = freshLog()
    await sampleFrame({
      projectJson: {
        settings: { resolution: [1080, 1920] },
        tracks: [{ id: 't', items: [
          { id: 'i1', type: 'image', src: still, start: 0, end: 5 },
          { id: 'i2', type: 'image', src: still, start: 0, end: 5, scale: 0.5 },
        ] }],
      },
      atSeconds: 1,
      outPath,
    })
    const calls = readLog(log).filter((c) => c.argv.at(-1) === outPath)
    assert.equal(calls.length, 1, `composite calls: ${calls.length}`)
    const argv = calls[0].argv
    assert.ok(argv.includes('-/filter_complex'), 'no -/filter_complex in argv')
    assert.ok(!argv.includes('-filter_complex'), '-filter_complex is still in argv')
    const s = calls[0].scripts.find((x) => x.opt === '-/filter_complex')
    assert.ok(s && s.content && s.content.length > 0, 'the stub read no script content')
    assert.equal(existsSync(s.path), false)
  })
})

describe('the script is removed on every way out', () => {
  test('ffmpeg exits non-zero: encodeSegment throws, the script is gone', async () => {
    const outputPath = join(WORK, 'fail.segments', 'seg-000.mp4')
    const log = freshLog()
    process.env.WIN1B_STUB_EXIT = '1'
    try {
      await assert.rejects(encodeSegment(SEGMENT, outputPath), /ffmpeg segment encode failed/)
    } finally {
      delete process.env.WIN1B_STUB_EXIT
    }
    const calls = readLog(log)
    assert.equal(calls.length, 1)
    const s = calls[0].scripts.find((x) => x.opt === '-/filter_complex')
    assert.ok(s && s.content !== null, 'the stub did not read a -/filter_complex script')
    assert.equal(existsSync(s.path), false)
    assert.deepEqual(scriptsIn(dirname(outputPath)), [])
  })

  test('two concurrent encodes into one dir: two scripts, both gone', async () => {
    const dir = join(WORK, 'pool.segments')
    const log = freshLog()
    await Promise.all([
      encodeSegment(SEGMENT, join(dir, 'seg-000.mp4')),
      encodeSegment(SEGMENT, join(dir, 'seg-001.mp4')),
    ])
    const paths = readLog(log).flatMap((c) => c.scripts).map((s) => s.path)
    assert.equal(paths.length, 2)
    assert.notEqual(paths[0], paths[1])
    for (const p of paths) assert.equal(existsSync(p), false)
    assert.deepEqual(scriptsIn(dir), [])
  })

  // §116: the short-part join (757e846b, encodeSegmentGroup) is the second
  // -filter_complex in encode-segment.js. It reaches ffmpeg through runFfmpeg,
  // so by file like the segment's own graph.
  test('a short-part group: each part and the join go by -/filter_complex, and every script is gone', async () => {
    const dir = join(WORK, 'group.segments')
    const outputPath = join(dir, 'seg-000.mp4')
    const part = (start, end) => ({ ...segmentFor(join(WORK, 'photo.png')), start, end, colorSpace: 'sdr_bt709' })
    const group = { start: 0, end: 0.1, parts: [part(0, 0.05), part(0.05, 0.1)] }
    const dry = await encodeSegmentGroup(group, outputPath, { _dryRun: true })
    const joinGraph = dry.args[dry.args.indexOf('-filter_complex') + 1]
    const log = freshLog()
    await encodeSegmentGroup(group, outputPath)
    const calls = readLog(log)
    assert.equal(calls.length, 3, `two parts and the join, got ${calls.length} call(s)`)
    for (const c of calls) {
      assert.ok(c.argv.includes('-/filter_complex'), 'no -/filter_complex in argv')
      assert.ok(!c.argv.includes('-filter_complex'), '-filter_complex is still in argv')
    }
    const joined = calls[2]
    assert.equal(joined.argv.at(-1), outputPath)
    assert.equal(joined.scripts.find((x) => x.opt === '-/filter_complex')?.content, joinGraph)
    for (const p of calls.flatMap((c) => c.scripts).map((x) => x.path)) assert.equal(existsSync(p), false)
    assert.deepEqual(scriptsIn(dir), [])
  })

  test('a spawn that throws synchronously: the cause is in the error, nothing ran', async () => {
    // A NUL in an argv element makes spawn() throw before any process exists.
    const outputPath = join(WORK, 'nul.segments', 'seg-000.mp4')
    const log = freshLog()
    await assert.rejects(
      encodeSegment(segmentFor(join(WORK, 'bad\0name.png')), outputPath),
      /ffmpeg segment encode failed[\s\S]*null bytes/)
    assert.deepEqual(readLog(log), [])
    assert.deepEqual(scriptsIn(dirname(outputPath)), [])
  })

  // Last in the file: ffmpeg-bin.js has already fixed FFMPEG to this path, so
  // the spawn fails with EACCES and runFfmpeg takes its 'error' path.
  test('the spawn itself fails: the script is still gone', async () => {
    const outputPath = join(WORK, 'noexec.segments', 'seg-000.mp4')
    const log = freshLog()
    chmodSync(STUB, 0o644)
    try {
      await assert.rejects(encodeSegment(SEGMENT, outputPath), /ffmpeg segment encode failed/)
    } finally {
      chmodSync(STUB, 0o755)
    }
    assert.deepEqual(readLog(log), [], 'the stub ran, so the error path was not exercised')
    assert.deepEqual(scriptsIn(dirname(outputPath)), [])
  })
})

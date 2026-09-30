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

const CAP = 32_767
const WORK = mkdtempSync(join(tmpdir(), 'montaj-argv-cap-'))
const STUB = join(WORK, 'ffmpeg-stub.cjs')

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

process.env.MONTAJ_FFMPEG = STUB
process.env.MONTAJ_FFPROBE = STUB
const { FFMPEG } = await import('../ffmpeg-bin.js')
const { encodeSegment } = await import('../encode-segment.js')
const { mixAudioIntoVideo, buildAudioTrackFilters, loudnessFilter } = await import('../mix-audio.js')

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
  const RENDER_DIR = join(dirname(new URL(import.meta.url).pathname), '..')
  const sources = readdirSync(RENDER_DIR).filter((f) => f.endsWith('.js'))

  test('the scan covers the spawning modules', () => {
    for (const f of ['encode-segment.js', 'sample-frame.js', 'mix-audio.js']) {
      assert.ok(sources.includes(f), `${f} not in the scanned set (${sources.length} files)`)
    }
  })

  test('a source that builds a -filter_complex pair also calls externalizeFilterGraph', () => {
    // Callers keep building the inline pair (so _dryRun and the goldens pin the
    // graph) and hand it to the helper before the spawn. A file with the literal
    // and no helper call would spawn the graph inline. filter-script.js itself
    // is the helper and is excluded. The leaf tests prove the calls are live.
    const hits = sources
      .filter((f) => f !== 'filter-script.js')
      .filter((f) => {
        const src = readFileSync(join(RENDER_DIR, f), 'utf8')
        return /['"]-filter_complex['"]/.test(src) && !/externalizeFilterGraph\(/.test(src)
      })
    assert.deepEqual(hits, [], `inline -filter_complex with no externalizeFilterGraph call: ${hits.join(', ')}`)
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
    assert.equal(calls.length, 1)
    const { filterParts, audioLabel } = buildAudioTrackFilters(TRACKS, 1, '[0:a]')
    const expected = [...filterParts, loudnessFilter(audioLabel, -14).part].join(';')
    const argv = calls[0].argv
    assert.ok(argv.includes('-/filter_complex'), 'no -/filter_complex in argv')
    assert.ok(!argv.includes('-filter_complex'), '-filter_complex is still in argv')
    const s = calls[0].scripts.find((x) => x.opt === '-/filter_complex')
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

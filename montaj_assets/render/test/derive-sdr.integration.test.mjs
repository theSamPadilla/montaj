// render/test/derive-sdr.integration.test.mjs
//
// End-to-end tests for `--export auto|sdr|both` (SP6b Task T7): a real render
// of a real (tiny, synthetic) HLG project through real ffmpeg, then ffprobe on
// what came out.
//
// The unit suite (derive-sdr.test.mjs) pins the ffmpeg arguments; only a real
// run can show that those arguments actually produce a Rec.709 file whose audio
// survived untouched, that the master is left alone in `both` mode, and that
// `sdr` mode leaves no scratch behind.
//
// GATING: skipped unless this ffmpeg has zscale + lut3d (the Montaj Vivid
// chain) and libx265 (the HDR project's segment encoder). Same policy as
// sample-frame.test.mjs's HDR tests — a build without them can't run the
// pipeline under test at all, and failing would only report the build.
//
// COST: the fixture is 64×64 and 6s long, and the project is marked
// `normalize: lazy` with each clip pointing at itself as its own normalized
// cache — so the render skips the `python3 -m lib.normalize` spawn entirely and
// the whole file runs in a few seconds. The derive pass is what's under test,
// not intake.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')

// ---------------------------------------------------------------------------
// Capability probes
// ---------------------------------------------------------------------------

function ffmpegFilters() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? (r.stdout || '') : ''
}
function ffmpegEncoders() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? (r.stdout || '') : ''
}

const FILTERS = ffmpegFilters()
const ENCODERS = ffmpegEncoders()
const CAPABLE =
  /^[A-Z. ]+ zscale\b/m.test(FILTERS) &&
  /^[A-Z. ]+ lut3d\b/m.test(FILTERS) &&
  /\blibx265\b/.test(ENCODERS)
const SKIP = CAPABLE ? false : 'ffmpeg lacks zscale + lut3d + libx265'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Two solid-color HLG clips with real audio, back to back on track 0, plus the
 * project.json that stitches them. Returns null when ffmpeg couldn't build the
 * media (environment capability, not a failure of the code under test).
 *
 * The HLG tags go on via `-x264-params`: `-color_trc` alone doesn't reliably
 * stick on an h264 stream, and without a real tagged transfer the zscale chain
 * has nothing to convert FROM. Same trick makeSyntheticFixture uses in
 * sample-frame.test.mjs.
 *
 * `-t 3` (not `duration=3` on the source, the way makeSyntheticFixture does it
 * in sample-frame.test.mjs) because these clips carry audio: the `sine` source
 * is unbounded, so without an output-side limit the mux never ends and the
 * encode runs until the timeout kills it.
 */
function makeHlgFixture(dir, name) {
  const clipA = join(dir, 'clip-a.mp4')
  const clipB = join(dir, 'clip-b.mp4')

  for (const [color, out] of [['red', clipA], ['blue', clipB]]) {
    const r = spawnSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:size=64x64:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '3',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      '-c:a', 'aac',
      out,
    ], { encoding: 'utf8', timeout: 60_000 })
    if (r.status !== 0) return null
  }

  const project = {
    version: '0.2',
    status: 'final',
    name,
    settings: { resolution: [128, 128], fps: 30, colorSpace: 'hdr_hlg', normalize: 'lazy' },
    tracks: [[
      // normalizedSrc pointing at the clip itself + normalize:'lazy' is what
      // makes render.js skip the intake normalize spawn (shouldSkipNormalize).
      { id: 'c0', type: 'video', src: clipA, normalizedSrc: clipA, normalizedInPoint: 0, start: 0, end: 3, inPoint: 0 },
      { id: 'c1', type: 'video', src: clipB, normalizedSrc: clipB, normalizedInPoint: 0, start: 3, end: 6, inPoint: 0 },
    ]],
    audio: { tracks: [] },
  }
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify(project, null, 2))
  return { projectPath, renderDir: join(dir, 'render') }
}

/** Run render.js on a project and return { status, stdout, stderr, outputs }. */
function runRender(projectPath, extraArgs) {
  const r = spawnSync('node', [RENDER_JS, projectPath, ...extraArgs], {
    encoding: 'utf8', timeout: 300_000,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    outputs: (r.stdout ?? '').trim().split('\n').filter(Boolean),
  }
}

/** ffprobe one field off one stream, or null. */
function probeField(file, stream, field) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-select_streams', stream,
    '-show_entries', `stream=${field}`, '-of', 'csv=p=0', file,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return null
  const value = (r.stdout || '').trim().split('\n')[0].replace(/,+$/, '')
  return value || null
}

/**
 * MD5 of the file's first audio stream, stream-copied — i.e. of the compressed
 * bitstream, not of decoded samples. Identical between two files only if the
 * packets were copied verbatim; any re-encode, even at the same settings,
 * changes it.
 */
function audioBitstreamMd5(file) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-',
  ], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) return null
  const m = (r.stdout || '').match(/MD5=([0-9a-f]+)/)
  return m ? m[1] : null
}

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-derive-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('render --export both: HDR master untouched + Rec.709 sibling with copied audio',
  { skip: SKIP, timeout: 300_000 }, () => {
    withWorkspace((dir) => {
      const fixture = makeHlgFixture(dir, 'Derive Both')
      if (!fixture) return // ffmpeg couldn't synthesize the sources

      const master = join(fixture.renderDir, 'Derive Both.mp4')
      const derived = join(fixture.renderDir, 'Derive Both-sdr.mp4')

      const run = runRender(fixture.projectPath, ['--export', 'both'])
      assert.equal(run.status, 0, `render failed:\n${run.stderr.slice(-2000)}`)

      // Both files exist, under the names the plan promises.
      assert.ok(existsSync(master), `missing master at ${master}`)
      assert.ok(existsSync(derived), `missing derived SDR at ${derived}`)

      // stdout: master first (single-path readers keep working), sibling second.
      assert.deepEqual(run.outputs, [master, derived])

      // The master is still HDR — the derive must not have touched it.
      assert.equal(probeField(master, 'v:0', 'color_transfer'), 'arib-std-b67')
      assert.equal(probeField(master, 'v:0', 'codec_name'), 'hevc')

      // The derived rendition is Rec.709 on every axis. color_transfer is the
      // one that used to come out wrong (zscale passes an axis it wasn't
      // explicitly given straight through, HDR tag and all).
      assert.equal(probeField(derived, 'v:0', 'color_transfer'), 'bt709')
      assert.equal(probeField(derived, 'v:0', 'color_primaries'), 'bt709')
      assert.equal(probeField(derived, 'v:0', 'color_space'), 'bt709')
      assert.equal(probeField(derived, 'v:0', 'codec_name'), 'h264')
      assert.equal(probeField(derived, 'v:0', 'pix_fmt'), 'yuv420p')

      // Audio was copied, not re-encoded: same codec, same bytes.
      assert.equal(probeField(derived, 'a:0', 'codec_name'), probeField(master, 'a:0', 'codec_name'))
      const masterAudio = audioBitstreamMd5(master)
      assert.ok(masterAudio, 'master should have an audio stream to compare')
      assert.equal(audioBitstreamMd5(derived), masterAudio,
        'audio bitstream differs — the derive re-encoded it instead of copying')

      // Both files carry a poster; the derived one gets its own SDR extract.
      assert.equal(probeField(derived, 'v:1', 'codec_name'), 'mjpeg')

      // The progress phase the serve layer maps to `sdr_derive`.
      assert.match(run.stderr, /deriving SDR rendition/)

      // No scratch left behind.
      const leftovers = readdirSync(fixture.renderDir).filter(f => f.includes('hdrmaster'))
      assert.deepEqual(leftovers, [])
    })
  })

test('render --export sdr: one Rec.709 file under the project name, temp master removed',
  { skip: SKIP, timeout: 300_000 }, () => {
    withWorkspace((dir) => {
      const fixture = makeHlgFixture(dir, 'Derive Sdr')
      if (!fixture) return

      const output = join(fixture.renderDir, 'Derive Sdr.mp4')

      const run = runRender(fixture.projectPath, ['--export', 'sdr'])
      assert.equal(run.status, 0, `render failed:\n${run.stderr.slice(-2000)}`)

      assert.deepEqual(run.outputs, [output], 'sdr mode emits exactly one path')
      assert.ok(existsSync(output))
      assert.equal(probeField(output, 'v:0', 'color_transfer'), 'bt709')
      assert.equal(probeField(output, 'v:0', 'codec_name'), 'h264')

      // The HDR master was scaffolding: no temp, and no -sdr sibling either —
      // the user asked for one file and gets one file, under their own name.
      const files = readdirSync(fixture.renderDir).filter(f => f.endsWith('.mp4'))
      assert.deepEqual(files, ['Derive Sdr.mp4'],
        `unexpected files left in the render dir: ${files.join(', ')}`)
    })
  })

test('render --export sdr honors --sdr-curve end to end',
  { skip: SKIP, timeout: 300_000 }, () => {
    withWorkspace((dir) => {
      const fixture = makeHlgFixture(dir, 'Derive Curve')
      if (!fixture) return

      // A registered non-master curve must render as cleanly as the default —
      // the unit suite proves it reaches the argv; this proves ffmpeg accepts
      // the cube it names.
      const run = runRender(fixture.projectPath, ['--export', 'sdr', '--sdr-curve', 'vivid1-neutral'])
      assert.equal(run.status, 0, `render failed:\n${run.stderr.slice(-2000)}`)
      assert.equal(probeField(join(fixture.renderDir, 'Derive Curve.mp4'), 'v:0', 'color_transfer'), 'bt709')
    })
  })

test('render --export auto (the default) is unchanged: one HDR file, no derive',
  { skip: SKIP, timeout: 300_000 }, () => {
    withWorkspace((dir) => {
      const fixture = makeHlgFixture(dir, 'Derive Auto')
      if (!fixture) return

      const master = join(fixture.renderDir, 'Derive Auto.mp4')
      const run = runRender(fixture.projectPath, [])
      assert.equal(run.status, 0, `render failed:\n${run.stderr.slice(-2000)}`)

      assert.deepEqual(run.outputs, [master])
      assert.equal(probeField(master, 'v:0', 'color_transfer'), 'arib-std-b67')
      assert.doesNotMatch(run.stderr, /deriving SDR rendition/)
      assert.deepEqual(readdirSync(fixture.renderDir).filter(f => f.endsWith('.mp4')), ['Derive Auto.mp4'])
    })
  })

test('render --sdr-curve <unknown> fails before doing any work', { timeout: 60_000 }, () => {
  // No project needed and none read: the flag is validated during argument
  // parsing, so a typo costs nothing instead of surfacing after a long render.
  const r = spawnSync('node', [RENDER_JS, '/nonexistent/project.json', '--sdr-curve', 'vivid9000'], {
    encoding: 'utf8', timeout: 60_000,
  })
  assert.equal(r.status, 1)
  const err = JSON.parse((r.stderr || '').trim().split('\n').pop())
  assert.equal(err.error, 'invalid_argument')
  assert.match(err.message, /Unknown sdr curve "vivid9000"/)
  assert.match(err.message, /vivid1/)
})

test('render --export <unknown> fails before doing any work', { timeout: 60_000 }, () => {
  const r = spawnSync('node', [RENDER_JS, '/nonexistent/project.json', '--export', 'hdr'], {
    encoding: 'utf8', timeout: 60_000,
  })
  assert.equal(r.status, 1)
  const err = JSON.parse((r.stderr || '').trim().split('\n').pop())
  assert.equal(err.error, 'invalid_argument')
  assert.match(err.message, /Unknown export mode "hdr"/)
  assert.match(err.message, /auto, sdr, both/)
})

test('render --export both on an SDR project: one notice, one file, no derive',
  { skip: SKIP, timeout: 300_000 }, () => {
    withWorkspace((dir) => {
      const fixture = makeHlgFixture(dir, 'Sdr Project')
      if (!fixture) return

      // Re-point the project at SDR. The clips stay HLG-tagged, so the segment
      // encoder tone-maps them on the way in — which is exactly the case where
      // --export sdr is a no-op: the render already IS the SDR rendition.
      const project = JSON.parse(readFileSync(fixture.projectPath, 'utf8'))
      project.settings.colorSpace = 'sdr_bt709'
      writeFileSync(fixture.projectPath, JSON.stringify(project, null, 2))

      const run = runRender(fixture.projectPath, ['--export', 'both'])
      assert.equal(run.status, 0, `render failed:\n${run.stderr.slice(-2000)}`)

      assert.match(run.stderr, /--export both: this project is already SDR/)
      assert.doesNotMatch(run.stderr, /deriving SDR rendition/)

      const output = join(fixture.renderDir, 'Sdr Project.mp4')
      assert.deepEqual(run.outputs, [output])
      assert.deepEqual(readdirSync(fixture.renderDir).filter(f => f.endsWith('.mp4')), ['Sdr Project.mp4'])
      assert.equal(probeField(output, 'v:0', 'color_transfer'), 'bt709')
    })
  })

// render/test/derive-sdr.test.mjs
//
// Arg-level tests for the SDR derive pass (SP6b Task T7).
//
// `buildDeriveSdrArgs` is pure — no probe, no spawn, no disk — so these assert
// the exact ffmpeg argv the derive runs, the same way encode-args-golden.test.mjs
// asserts the segment encoder's. What matters here and is easy to break
// silently: the LUT chain (a wrong `format=` around lut3d quantizes the grade),
// `-c:a copy` (an accidental re-encode costs a generation of audio quality for
// nothing), and the output naming rules in planExport.
//
// Expectations are built from the same sources render.js reads — `specFor`,
// `lutPath` — rather than pasted literals, because the .cube path is absolute
// and differs on every checkout (the standing hazard the golden test's header
// calls out). The chain SHAPE is still asserted literally.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { buildDeriveSdrArgs, deriveSdr } from '../derive-sdr.js'
import { EXPORT_MODES, resolveExportMode, resolveSdrCurve, planExport } from '../render.js'
import { specFor } from '../color-space.js'
import { lutPath, curveIds, MASTER_LOOK } from '../look.js'

const SPEC = specFor('sdr_bt709')
const CAPABLE = { zscaleAvailable: true, lut3dAvailable: true }

// The non-master curve, whichever it is — asserting on the id itself would pin
// looks.json's contents rather than the threading being tested.
const ALT_CURVE = curveIds().find(id => id !== MASTER_LOOK) ?? null

/** The value of `-vf` in an argv, or undefined. */
function vfOf(args) {
  const i = args.indexOf('-vf')
  return i === -1 ? undefined : args[i + 1]
}

/** The value that follows `flag`, or undefined. */
function valueOf(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

// ---------------------------------------------------------------------------
// buildDeriveSdrArgs
// ---------------------------------------------------------------------------

test('buildDeriveSdrArgs: HLG master — full argv, exactly', () => {
  const args = buildDeriveSdrArgs('/w/render/Clip.mp4', '/w/render/Clip-sdr.mp4', {
    srcColorSpace: 'hdr_hlg', ...CAPABLE,
  })
  assert.deepEqual(args, [
    '-y', '-v', 'error',
    '-i', '/w/render/Clip.mp4',
    '-map', '0:v:0', '-map', '0:a?',
    '-vf',
    'zscale=matrixin=2020_ncl:rangein=limited:range=full,'
    + 'format=rgb48le,'
    + `lut3d=file=${lutPath()}:interp=tetrahedral,`
    + 'zscale=t=bt709:m=bt709:p=bt709:rin=full:r=tv,'
    + 'format=yuv420p',
    '-c:v', SPEC.encoder, ...SPEC.encoderArgs, '-pix_fmt', SPEC.outputPixFmt,
    ...SPEC.outputColorArgs,
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '/w/render/Clip-sdr.mp4',
  ])
})

test('buildDeriveSdrArgs: PQ master gets the PQ→HLG pre-arm at the LUT design white', () => {
  const args = buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_pq', ...CAPABLE })
  assert.ok(
    vfOf(args).startsWith('zscale=tin=smpte2084:t=arib-std-b67:npl=1000,'),
    `PQ chain must open with the pre-arm, got: ${vfOf(args)}`)
  // …and is otherwise the same chain as HLG.
  const hlg = buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE })
  assert.equal(
    vfOf(args).replace('zscale=tin=smpte2084:t=arib-std-b67:npl=1000,', ''),
    vfOf(hlg))
})

test('buildDeriveSdrArgs: the LUT is pinned to 16-bit RGB and tetrahedral interpolation', () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE }))
  assert.ok(vf.includes(`format=rgb48le,lut3d=file=${lutPath()}:interp=tetrahedral`),
    `LUT must be fed rgb48le, got: ${vf}`)
})

test('buildDeriveSdrArgs: the chain ends yuv420p, after the bt709 retag', () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE }))
  assert.ok(vf.endsWith('zscale=t=bt709:m=bt709:p=bt709:rin=full:r=tv,format=yuv420p'),
    `chain must retag to bt709 before the pixel format, got: ${vf}`)
})

test('buildDeriveSdrArgs: --sdr-curve selects that curve\'s cube', { skip: !ALT_CURVE }, () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', {
    srcColorSpace: 'hdr_hlg', sdrCurve: ALT_CURVE, ...CAPABLE,
  }))
  assert.ok(vf.includes(`lut3d=file=${lutPath(ALT_CURVE)}:`), `expected the ${ALT_CURVE} cube, got: ${vf}`)
  assert.ok(!vf.includes(lutPath(MASTER_LOOK)), 'master-look cube must not appear')
})

test('buildDeriveSdrArgs: omitted curve uses the master look', () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE }))
  assert.ok(vf.includes(`lut3d=file=${lutPath(MASTER_LOOK)}:`))
})

test('buildDeriveSdrArgs: audio is copied, never encoded', () => {
  const args = buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE })
  assert.equal(valueOf(args, '-c:a'), 'copy')
  assert.ok(!args.includes('aac'), 'no audio encoder may appear in the derive argv')
  assert.ok(!args.includes('-b:a'), 'no audio bitrate may appear — nothing is being encoded')
})

test('buildDeriveSdrArgs: maps the real video stream and tolerates a silent master', () => {
  const args = buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE })
  // The master carries compose's attached_pic poster; default stream selection
  // can pick that JPEG as the video. v:0 is explicit; `?` keeps a master with no
  // audio stream from failing the map.
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4),
    ['-map', '0:v:0', '-map', '0:a?'])
})

test('buildDeriveSdrArgs: encodes with the sdr_bt709 spec and tags bt709 at the stream level', () => {
  const args = buildDeriveSdrArgs('/m.mp4', '/o.mp4', { srcColorSpace: 'hdr_hlg', ...CAPABLE })
  assert.equal(valueOf(args, '-c:v'), SPEC.encoder)
  assert.equal(valueOf(args, '-pix_fmt'), SPEC.outputPixFmt)
  for (const flag of ['-color_primaries', '-color_trc', '-colorspace']) {
    assert.equal(valueOf(args, flag), 'bt709', `${flag} must be bt709`)
  }
  assert.equal(valueOf(args, '-movflags'), '+faststart')
  assert.equal(args[args.length - 1], '/o.mp4', 'output path is the final argument')
})

test('buildDeriveSdrArgs: a build without lut3d degrades to the shared fallback, not a broken filter', () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', {
    srcColorSpace: 'hdr_hlg', zscaleAvailable: true, lut3dAvailable: false,
  }))
  assert.ok(!vf.includes('lut3d'), 'must not name a filter this ffmpeg lacks')
  assert.ok(vf.includes('tonemap=hable:desat=0'), `expected the Hable fallback, got: ${vf}`)
  assert.ok(vf.endsWith(',format=yuv420p'))
})

test('buildDeriveSdrArgs: a build without zscale degrades further still', () => {
  const vf = vfOf(buildDeriveSdrArgs('/m.mp4', '/o.mp4', {
    srcColorSpace: 'hdr_hlg', zscaleAvailable: false, lut3dAvailable: false,
  }))
  assert.equal(vf, 'format=p010le,tonemap=hable:desat=0,format=yuv420p')
})

test('deriveSdr: refuses an SDR master instead of re-encoding it for nothing', async () => {
  await assert.rejects(
    () => deriveSdr(fileURLToPath(import.meta.url), '/w/render/out.mp4', { srcColorSpace: 'sdr_bt709' }),
    /not an HDR master/)
})

test('deriveSdr: a missing master says so, rather than reporting it as SDR', async () => {
  // The probe on a missing file yields no transfer, which detects as SDR — so
  // without the existence check this path would produce a confidently wrong
  // diagnosis of a file that simply is not there.
  await assert.rejects(
    () => deriveSdr('/w/render/does-not-exist.mp4', '/w/render/out.mp4'),
    /no master to derive from/)
})

// ---------------------------------------------------------------------------
// CLI flag validation
// ---------------------------------------------------------------------------

test('resolveExportMode: defaults to auto', () => {
  assert.equal(resolveExportMode(null), 'auto')
  assert.equal(resolveExportMode(undefined), 'auto')
})

test('resolveExportMode: accepts every documented mode', () => {
  assert.deepEqual(EXPORT_MODES, ['auto', 'sdr', 'both'])
  for (const mode of EXPORT_MODES) assert.equal(resolveExportMode(mode), mode)
})

test('resolveExportMode: unknown mode is a hard error listing the valid ones', () => {
  assert.throws(() => resolveExportMode('hdr'), (err) => {
    assert.match(err.message, /Unknown export mode "hdr"/)
    assert.match(err.message, /auto, sdr, both/)
    return true
  })
})

test('resolveSdrCurve: omitted means the master look', () => {
  assert.equal(resolveSdrCurve(null), null)
  assert.equal(resolveSdrCurve(undefined), null)
})

test('resolveSdrCurve: every registered curve id is accepted', () => {
  for (const id of curveIds()) assert.equal(resolveSdrCurve(id), id)
})

test('resolveSdrCurve: unknown curve is a hard error listing the registered ids', () => {
  assert.throws(() => resolveSdrCurve('vivid9000'), (err) => {
    assert.match(err.message, /Unknown sdr curve "vivid9000"/)
    for (const id of curveIds()) {
      assert.ok(err.message.includes(id), `error must list ${id}`)
    }
    assert.match(err.message, /looks\.json/)
    return true
  })
})

// ---------------------------------------------------------------------------
// planExport — which files a render emits, and where compose writes
// ---------------------------------------------------------------------------

test('planExport: auto on an HDR project is byte-for-byte the old flow', () => {
  const plan = planExport({ exportMode: 'auto', projectColorSpace: 'hdr_hlg', outputPath: '/w/render/Clip.mp4' })
  assert.deepEqual(plan, {
    mode: 'auto',
    composePath: '/w/render/Clip.mp4',
    derivePath: null,
    tempMaster: null,
    outputs: ['/w/render/Clip.mp4'],
    notice: null,
  })
})

test('planExport: both — master keeps its name, SDR lands on the -sdr sibling', () => {
  const plan = planExport({ exportMode: 'both', projectColorSpace: 'hdr_hlg', outputPath: '/w/render/My Clip.mp4' })
  assert.equal(plan.mode, 'both')
  assert.equal(plan.composePath, '/w/render/My Clip.mp4')
  assert.equal(plan.derivePath, '/w/render/My Clip-sdr.mp4')
  assert.equal(plan.tempMaster, null)
  assert.deepEqual(plan.outputs, ['/w/render/My Clip.mp4', '/w/render/My Clip-sdr.mp4'])
  assert.equal(plan.notice, null)
})

test('planExport: sdr — the HDR master is scratch, the user\'s name goes to the SDR file', () => {
  const plan = planExport({ exportMode: 'sdr', projectColorSpace: 'hdr_pq', outputPath: '/w/render/Clip.mp4' })
  assert.equal(plan.mode, 'sdr')
  assert.equal(plan.composePath, '/w/render/Clip-hdrmaster.tmp.mp4')
  assert.equal(plan.derivePath, '/w/render/Clip.mp4')
  assert.equal(plan.tempMaster, '/w/render/Clip-hdrmaster.tmp.mp4')
  assert.deepEqual(plan.outputs, ['/w/render/Clip.mp4'], 'the temp master is not an output')
  assert.notEqual(plan.composePath, plan.derivePath, 'compose must not write over its own derive target')
})

test('planExport: sdr/both on an already-SDR project fall back to auto with one notice', () => {
  for (const mode of ['sdr', 'both']) {
    const plan = planExport({ exportMode: mode, projectColorSpace: 'sdr_bt709', outputPath: '/w/render/Clip.mp4' })
    assert.equal(plan.mode, 'auto', `${mode} must behave as auto`)
    assert.equal(plan.derivePath, null, `${mode} must not derive`)
    assert.equal(plan.composePath, '/w/render/Clip.mp4')
    assert.deepEqual(plan.outputs, ['/w/render/Clip.mp4'])
    assert.match(plan.notice, /already SDR/)
    assert.ok(plan.notice.includes(`--export ${mode}`), 'the notice names the mode that was asked for')
  }
})

test('planExport: auto on an SDR project says nothing at all', () => {
  const plan = planExport({ exportMode: 'auto', projectColorSpace: 'sdr_bt709', outputPath: '/w/render/Clip.mp4' })
  assert.equal(plan.notice, null)
  assert.equal(plan.derivePath, null)
})

test('planExport: an extensionless --out still gets distinct sibling names', () => {
  // A no-op `.replace(/(\.\w+)$/,…)` would hand ffmpeg the same path to read
  // and write — the derive would eat its own input.
  const both = planExport({ exportMode: 'both', projectColorSpace: 'hdr_hlg', outputPath: '/tmp/clip' })
  assert.equal(both.derivePath, '/tmp/clip-sdr')
  assert.notEqual(both.derivePath, both.composePath)

  const sdr = planExport({ exportMode: 'sdr', projectColorSpace: 'hdr_hlg', outputPath: '/tmp/clip' })
  assert.equal(sdr.composePath, '/tmp/clip-hdrmaster.tmp')
  assert.notEqual(sdr.composePath, sdr.derivePath)
})

test('planExport: naming only touches the trailing extension, whatever the path', () => {
  const plan = planExport({
    exportMode: 'both', projectColorSpace: 'hdr_hlg',
    outputPath: '/a.b/c/my.video.v2.mp4',
  })
  assert.equal(plan.derivePath, '/a.b/c/my.video.v2-sdr.mp4')
})

// render/test/sample-frame-per-layer.integration.test.mjs
//
// PV42 T9: in an HDR project the still grades each video layer by its ORIGIN
// (sdr-layer.js decides), not by the project's colour space, and the proxy
// crop is computed from the decoded frame's own size. Real ffmpeg, no overlays
// (so no Puppeteer), tiny synthetic clips.
//
// Every SDR/HDR expectation is a pixel read from a file the test itself
// decodes or grades with ffmpeg, never a hand-typed number.
//
// The sample cache is pointed at a private dir BEFORE sample-frame.js loads
// (CACHE_DIR is fixed at import), so a stale PNG from an earlier run cannot
// answer for this one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = join(__dirname, '..', '..', '..')
const PYTHON = process.env.MONTAJ_TEST_PYTHON || 'python3'

process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'montaj-t9-cache-'))

const { sampleFrame, buildFrameCacheKey, SAMPLE_CACHE_VERSION } = await import('../sample-frame.js')
const { buildVividLutChain } = await import('../encode-segment.js')
const { FFMPEG } = await import('../ffmpeg-bin.js')

const FILTERS = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || ''
const SKIP = /\bzscale\b/.test(FILTERS) && /\blut3d\b/.test(FILTERS)
  ? false : 'ffmpeg lacks zscale + lut3d'
// A missing capability FAILS by default (PV52); MONTAJ_TEST_ALLOW_MISSING_CAPS=1 skips instead.
if (SKIP && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${SKIP}. Point MONTAJ_FFMPEG/MONTAJ_FFPROBE at the managed build (~/.local/share/montaj/models/ffmpeg is a directory; the binaries are inside), or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)

const HLG = ['-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc']
const BT709 = ['-c:v', 'libx264', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709']
const UNTAGGED = ['-c:v', 'libx264']

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').slice(-400)}`)
  return r
}

/** A 64x64, 30 fps, 1 s solid clip. */
function makeClip(path, color, codecArgs) {
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=64x64:rate=30:duration=1`,
    '-pix_fmt', 'yuv420p', ...codecArgs, path])
  return path
}

function transferOf(path) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer',
    '-of', 'csv=p=0', path])
  return r.stdout.trim()
}

/** Centre pixel [r,g,b] of a PNG. */
function centre(png, fx = 0.5) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-vf', `crop=1:1:iw*${fx}:ih/2,format=rgb24`,
    '-f', 'rawvideo', '-frames:v', '1', 'pipe:1'], { encoding: 'buffer', timeout: 20_000 })
  if (r.status !== 0) throw new Error('pixel read failed')
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

function maxDiff(a, b) { return Math.max(...a.map((v, i) => Math.abs(v - b[i]))) }

/** ffmpeg's plain decode of frame 0, centre pixel. */
function plainDecode(dir, clip, tag) {
  const png = join(dir, `plain-${tag}.png`)
  run('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-frames:v', '1', '-update', '1', png])
  return centre(png)
}

/** The ideal Vivid grade of frame 0, centre pixel (no encode in between). */
function idealVivid(dir, clip, tag) {
  const png = join(dir, `vivid-${tag}.png`)
  run('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-vf', `${buildVividLutChain('hdr_hlg')},format=rgb24`,
    '-frames:v', '1', '-update', '1', png])
  return centre(png)
}

function projectOf(colorSpace, item, resolution = [64, 64]) {
  return {
    version: '0.2', status: 'final', name: 't9',
    settings: { resolution, fps: 30, colorSpace },
    tracks: [[{ id: 'c0', type: 'video', start: 0, end: 1, inPoint: 0, ...item }]],
    audio: { tracks: [] },
  }
}

let n = 0
async function sample(dir, project, extra = {}, fx = 0.5) {
  const out = join(dir, `out-${n++}.png`)
  await sampleFrame({ projectJson: project, atSeconds: 0.2, outPath: out, ...extra })
  return centre(out, fx)
}

const t = (name, fn) => test(name, { skip: SKIP, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-t9-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
})

// --- HLG project -----------------------------------------------------------

/** A 64x64, 30 fps, 1 s clip of saturated colour bars (BT.601 and BT.709 disagree on these). */
function makeBars(path, codecArgs) {
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=64x64:rate=30:duration=1',
    '-pix_fmt', 'yuv420p', ...codecArgs, path])
  return path
}

/** ffmpeg's decode of frame 0 with the source declared BT.709 (as the export reads an untagged clip). */
function decodeAs709(dir, clip, tag, fx) {
  const png = join(dir, `as709-${tag}.png`)
  run('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-vf',
    'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709', '-frames:v', '1', '-update', '1', png])
  return centre(png, fx)
}

t('1. raw untagged SDR clip in an HLG project is read as BT.709, like the export', async (dir) => {
  const sdr = makeBars(join(dir, 'raw.mp4'), UNTAGGED)
  assert.ok(['', 'unknown'].includes(transferOf(sdr)), `fixture must be untagged, got ${transferOf(sdr)}`)
  const project = projectOf('hdr_hlg', { src: sdr })
  // Bars 1, 3 and 5 of 7 (yellow, green, red-ish): saturated, so 601 vs 709 shows.
  let worst = 0
  for (const fx of [0.2, 0.4, 0.6]) {
    const want = decodeAs709(dir, sdr, `1-${fx}`, fx)
    const got = await sample(dir, project, {}, fx)
    worst = Math.max(worst, maxDiff(got, want))
  }
  assert.ok(worst <= 1.0, `worst channel diff vs the BT.709 decode: ${worst}`)
})

t('2. SDR original with an HLG normalizedSrc: the original is decoded, ungraded', async (dir) => {
  const sdr = makeClip(join(dir, 'orig.mp4'), '0x5090c0', BT709)
  const hlg = makeClip(join(dir, 'orig-hlg-cache.mp4'), '0xc07030', HLG)
  const want = await sample(dir, projectOf('sdr_bt709', { src: sdr }))
  const got = await sample(dir, projectOf('hdr_hlg', { src: sdr, normalizedSrc: hlg, normalizedInPoint: 0 }))
  assert.ok(maxDiff(got, want) <= 1.0, `got ${got}, as authored ${want}`)
})

t('3. a fresh _normalized_hdr_hlg_w203 sibling of an SDR original is not used', async (dir) => {
  const sdr = makeClip(join(dir, 'clip.mp4'), '0x5090c0', BT709)
  const sib = makeClip(join(dir, 'clip_normalized_hdr_hlg_w203.mp4'), '0xc07030', HLG)
  const future = new Date(Date.now() + 60_000)
  utimesSync(sib, future, future)
  // (An SDR project would pick the sibling up itself, so the reference is the
  // original's own decode.)
  const want = plainDecode(dir, sdr, '3')
  const got = await sample(dir, projectOf('hdr_hlg', { src: sdr }))
  assert.ok(maxDiff(got, want) <= 1.0, `got ${got}, as authored ${want}`)
})

t('4. a marked HLG src (lib.normalize) decodes the original, ungraded', async (dir) => {
  const sdr = makeClip(join(dir, 'source.mp4'), '0x5090c0', BT709)
  const marked = join(dir, 'source_hlg.mp4')
  run(PYTHON, ['-m', 'lib.normalize', '--input', sdr, '--color-space', 'hdr_hlg', '--out', marked], { cwd: MONTAJ_ROOT })
  assert.equal(transferOf(marked), 'arib-std-b67', 'fixture: the conversion is HLG')
  const want = await sample(dir, projectOf('sdr_bt709', { src: sdr }))
  const got = await sample(dir, projectOf('hdr_hlg', { src: marked }))
  assert.ok(maxDiff(got, want) <= 1.0, `got ${got}, as authored ${want}`)
})

t('5. an HLG clip is graded: the ideal Vivid within 1', async (dir) => {
  const hlg = makeClip(join(dir, 'hlg.mp4'), '0x5090c0', HLG)
  const want = idealVivid(dir, hlg, '5')
  const ungraded = plainDecode(dir, hlg, '5')
  assert.ok(maxDiff(want, ungraded) > 8, 'fixture: the grade must visibly change this colour')
  const got = await sample(dir, projectOf('hdr_hlg', { src: hlg }))
  // 1, not 0.5: the composite step alone moves a plain image by 1 in one channel
  // (measured: an image item in an SDR project, 0x79 in, 0x78 out), so integer
  // pixels cannot land closer than that. The ungraded pixel is >8 away.
  assert.ok(maxDiff(got, want) <= 1.0, `got ${got}, ideal ${want}`)
})

t('6. an HLG item whose normalizedSrc is a graded SDR master is not graded again', async (dir) => {
  const hlg = makeClip(join(dir, 'hlg.mp4'), '0x5090c0', HLG)
  const master = makeClip(join(dir, 'graded-master.mp4'), '0xc07030', BT709)
  const want = await sample(dir, projectOf('sdr_bt709', { src: master }))
  const got = await sample(dir, projectOf('hdr_hlg', { src: hlg, normalizedSrc: master, normalizedInPoint: 0 }))
  assert.ok(maxDiff(got, want) <= 1.0, `got ${got}, as decoded ${want}`)
})

t('7. the cache key carries the sample cache version', () => {
  assert.equal(SAMPLE_CACHE_VERSION, 10)  // HDR graphics white 900 -> 800 nits
  const p = { settings: { colorSpace: 'hdr_hlg' } }
  const now = buildFrameCacheKey(null, p, 1)
  assert.equal(buildFrameCacheKey(null, p, 1, null, false, SAMPLE_CACHE_VERSION), now)
  assert.notEqual(buildFrameCacheKey(null, p, 1, null, false, SAMPLE_CACHE_VERSION - 1), now)
})

// --- SDR project: unchanged ------------------------------------------------

t('8. SDR project: frames equal ffmpeg\'s plain decode', async (dir) => {
  const sdr = makeClip(join(dir, 'sdr.mp4'), '0x5090c0', BT709)
  const hlg = makeClip(join(dir, 'hlg.mp4'), '0x60a0d0', HLG)
  const cache = makeClip(join(dir, 'cache.mp4'), '0xc07030', BT709)
  const cases = [
    [{ src: sdr }, sdr],
    [{ src: hlg, normalizedSrc: cache, normalizedInPoint: 0 }, cache],
    [{ src: hlg }, hlg],
  ]
  for (const [i, [item, decoded]] of cases.entries()) {
    const got = await sample(dir, projectOf('sdr_bt709', item))
    const want = plainDecode(dir, decoded, `8-${i}`)
    assert.ok(maxDiff(got, want) <= 1.0, `case ${i}: got ${got}, plain ${want}`)
  }
})

// --- Proxy crop ------------------------------------------------------------

/** 320x180 master, left half red and right half blue, plus a 160x90 proxy of it. */
function makeCropFixture(dir) {
  const master = join(dir, 'master.mp4')
  const proxy = join(dir, 'proxy.mp4')
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=30:duration=1',
    '-vf', 'drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill', '-pix_fmt', 'yuv420p', ...BT709, master])
  run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', 'scale=160:90', '-pix_fmt', 'yuv420p', ...BT709, proxy])
  return { master, proxy }
}

t('9a. --prefer-proxy with a source crop: works, and matches the master path', async (dir) => {
  const { master, proxy } = makeCropFixture(dir)
  const item = {
    src: master, proxySrc: proxy, sourceWidth: 320, sourceHeight: 180,
    sourceCrop: { x: 0.5, y: 0, w: 0.5, h: 1 },
  }
  const project = projectOf('sdr_bt709', item, [160, 180])
  const viaMaster = await sample(dir, project)
  const viaProxy = await sample(dir, project, { preferProxy: true })
  // The proxy is a 2x downscale of the master, so an interior pixel of a flat
  // region differs only by codec noise.
  assert.ok(maxDiff(viaProxy, viaMaster) <= 6, `proxy ${viaProxy}, master ${viaMaster}`)
  assert.ok(viaMaster[2] > 150 && viaMaster[0] < 100, `the crop is the blue half, got ${viaMaster}`)
})

t('9b. --prefer-proxy with an identity crop and a smaller proxy succeeds', async (dir) => {
  const { master, proxy } = makeCropFixture(dir)
  const item = {
    src: master, proxySrc: proxy, sourceWidth: 320, sourceHeight: 180,
    sourceCrop: { x: 0, y: 0, w: 1, h: 1 },
  }
  const viaMaster = await sample(dir, projectOf('sdr_bt709', item, [320, 180]), {}, 0.75)
  const viaProxy = await sample(dir, projectOf('sdr_bt709', item, [320, 180]), { preferProxy: true }, 0.75)
  assert.ok(maxDiff(viaProxy, viaMaster) <= 6, `proxy ${viaProxy}, master ${viaMaster}`)
})

// --- Untagged proxies (PV42 acceptance G6) ----------------------------------

/** An untagged proxy of `master`, the way a pre-fix montaj built one: re-encoded, no colour tags. */
function makeUntaggedProxy(master, proxy) {
  run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', 'scale=64:64,format=yuv420p', '-c:v', 'libx264',
    '-crf', '10', '-g', '1', proxy])
  assert.ok(['', 'unknown'].includes(transferOf(proxy)), `fixture proxy must be untagged, got ${transferOf(proxy)}`)
  return proxy
}

for (const space of ['hdr_hlg', 'sdr_bt709']) {
  t(`9c. --prefer-proxy reads an untagged proxy as BT.709 like the export (${space} project)`, async (dir) => {
    const master = makeBars(join(dir, 'dl.mp4'), UNTAGGED)
    const proxy = makeUntaggedProxy(master, join(dir, 'dl_proxy.mp4'))
    const project = projectOf(space, { src: master, proxySrc: proxy })
    let vsProxy = 0, vsSource = 0
    for (const fx of [0.2, 0.4, 0.6]) {
      const got = await sample(dir, project, { preferProxy: true }, fx)
      vsProxy = Math.max(vsProxy, maxDiff(got, decodeAs709(dir, proxy, `9c-p-${space}-${fx}`, fx)))
      // The source read as the export reads it. Not exact: the proxy is a lossy re-encode
      // (601 vs 709 differs by ~30 on these bars, so 3 still separates them cleanly).
      vsSource = Math.max(vsSource, maxDiff(got, decodeAs709(dir, master, `9c-s-${space}-${fx}`, fx)))
    }
    // (the sample is frame 0.2 s, the reference frame 0: all-intra noise differs per frame)
    assert.ok(vsProxy <= 3, `worst channel diff vs the proxy read as BT.709: ${vsProxy}`)
    assert.ok(vsSource <= 3, `worst channel diff vs the source read as BT.709: ${vsSource}`)
  })
}

t('9d. --prefer-proxy with a BT.709-tagged proxy is unchanged (plain decode)', async (dir) => {
  const master = makeBars(join(dir, 'tagged.mp4'), BT709)
  const proxy = join(dir, 'tagged_proxy.mp4')
  run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-vf', 'scale=64:64,format=yuv420p', '-crf', '10', ...BT709, proxy])
  assert.equal(transferOf(proxy), 'bt709')
  const project = projectOf('sdr_bt709', { src: master, proxySrc: proxy })
  for (const fx of [0.2, 0.4, 0.6]) {
    const want = decodeAs709(dir, proxy, `9d-${fx}`, fx)
    const got = await sample(dir, project, { preferProxy: true }, fx)
    assert.ok(maxDiff(got, want) <= 1.0, `tagged proxy at ${fx}: ${got} vs ${want}`)
  }
})

// --- Cutouts ---------------------------------------------------------------

t('10. an HDR-origin cutout decodes as BT.601 YUV, is graded to the ideal Vivid, and keeps its alpha', async (dir) => {
  const hlg = makeClip(join(dir, 'hlg.mp4'), '0xe0ac69', HLG)
  // The cutout the way steps/transform/remove_bg.py makes one (T8 measured it):
  // the HLG frame decoded to RGB with the BT.2020 matrix, alpha opaque on the
  // left half and clear on the right, then RGB to 10-bit YUV with BT.601
  // limited (PyAV's default), ProRes 4444, colour tags left unknown.
  const cut = join(dir, 'cutout.mov')
  run('ffmpeg', ['-y', '-v', 'error', '-i', hlg,
    '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=30:duration=1',
    '-filter_complex',
    '[0:v]scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,'
      + 'format=rgb24,format=rgba[c];'
      + "[1:v]format=gray,geq=lum='if(lt(X\\,32)\\,255\\,0)'[m];"
      + '[c][m]alphamerge,'
      + 'scale=out_color_matrix=bt601:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuva444p10le,'
      + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=tv[out]',
    '-map', '[out]', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', cut])
  assert.equal(transferOf(cut), 'unknown', 'the cutout must be untagged, as remove_bg writes it')
  const project = projectOf('hdr_hlg', { src: hlg, remove_bg: true, nobg_src: cut })
  const out = join(dir, 'cut-out.png')
  await sampleFrame({ projectJson: project, atSeconds: 0.2, outPath: out })
  const opaque = centre(out, 0.25)
  const clear = centre(out, 0.75)
  assert.deepEqual(clear, [0, 0, 0], 'the transparent half shows the black canvas')
  assert.notDeepEqual(opaque, plainDecode(dir, hlg, '10'), 'and it is graded')
  // The export declares this file BT.601 (T8); so must the still. Declared
  // BT.2020 it measured 3-5 levels off on skin.
  const ideal = idealVivid(dir, hlg, '10')
  assert.ok(maxDiff(opaque, ideal) <= 1.5, `cutout ${opaque}, ideal Vivid of its source ${ideal}`)
})

t('10b. the still builds its cutout grade with the export\'s builder, so they cannot drift', async () => {
  const { buildCutoutSampleVf } = await import('../sample-frame.js')
  const { buildCutoutGradeFilter, hasZscale, hasLut3d } = await import('../encode-segment.js')
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    const want = buildCutoutGradeFilter(key, hasZscale(), { sdrCurve: null, hasLut3d: hasLut3d() })
    const vf = buildCutoutSampleVf(key, null)
    assert.ok(vf.includes(want), `the still's cutout graph must contain the export's grade:\n${vf}\nwant ${want}`)
    assert.ok(vf.includes('matrixin=170m'), 'BT.601 matrix')
    assert.match(vf, /alphamerge,format=rgba$/)
  }
})

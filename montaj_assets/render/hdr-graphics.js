// render/hdr-graphics.js
/**
 * Graphics into an HDR project: the one colour mapping every overlay capture,
 * caption capture and timeline image takes in an HLG or PQ segment.
 *
 * Graphics are authored in sRGB (Chrome draws the overlays; images are sRGB
 * files) and the editor preview shows them as authored. The mapping keeps
 * their colours and puts sRGB white at GRAPHICS_WHITE_NITS:
 *
 *   sRGB EOTF → BT.709 to BT.2020 primaries (linear) → white to
 *   GRAPHICS_WHITE_NITS → the project's transfer (HLG OETF or PQ)
 *
 * This is the "vivid" image tone's math (it was lib/normalize_image.py's),
 * applied to every graphics pixel instead of to <img> files alone, with the
 * white level as its one parameter. Before it, captures and images went into
 * the HDR canvas unconverted: sRGB code values read as HLG/PQ signal (white at
 * Y10 940, the HLG peak), sRGB colours read as BT.2020 primaries
 * (oversaturated), and an <img> converted on its own looked different from the
 * CSS around it.
 *
 * 900 nits is the product owner's choice, made by eye against SDR clips and
 * camera HDR on an XDR display (2026-10-01). It is brighter than BT.2408's 203-nit
 * graphics white, which SDR clips in an HDR project use (lib/normalize.py
 * SDR_WHITE_NITS), so a white card sits above an SDR clip's white on purpose.
 *
 * Applied in ffmpeg as a 65-point 3D LUT (tetrahedral) on float RGB: a
 * per-pixel geq is far too slow for every overlay frame. Measured against the
 * math on a grey ramp: within 2 Y10 codes from sRGB 4 up (the float path
 * rounds about 2 high at white: 928 for 926); the first grid interval
 * undershoots the steep toe below that, sRGB 1 to 3 by up to 12 codes on HLG
 * and 48 on PQ. The LUT is generated
 * from the math here, not shipped: the white level stays one constant in code,
 * and the wheel carries no second 7 MB .cube that could drift from it. It is
 * written once per process to the temp dir under a name hashed from its own
 * text (graphicsLutPath), so a stale file can never be served for a changed
 * mapping, and two renders writing it at once each rename a complete file into
 * place.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ffmpegFilterPath } from './ffmpeg-filter-path.js'

/** Where sRGB white lands in an HLG or PQ output, in nits. */
export const GRAPHICS_WHITE_NITS = 900

// HLG's nominal display: 1000-nit peak, system gamma 1.2 (BT.2100). Scene
// light E maps to display light 1000 * E^1.2 for a neutral, so white at
// GRAPHICS_WHITE_NITS is scene light (900/1000)^(1/1.2) = 0.91587.
const HLG_PEAK_NITS = 1000
const HLG_SYSTEM_GAMMA = 1.2
const PQ_PEAK_NITS = 10000

const LUT_SIZE = 65

// BT.709 → BT.2020 primaries in linear light (BT.2087). Rows sum to 1, so
// neutrals are untouched. The constants lib/normalize_image.py used.
const M_709_2020 = [
  [0.627404, 0.329283, 0.043313],
  [0.069097, 0.919540, 0.011362],
  [0.016391, 0.088013, 0.895595],
]

/** sRGB EOTF (IEC 61966-2-1): encoded [0,1] → linear [0,1]. */
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** HLG OETF (BT.2100): scene light [0,1] → signal [0,1]. */
export function hlgOetf(e) {
  const a = 0.17883277, b = 0.28466892, c = 0.55991073
  const x = Math.min(1, Math.max(0, e))
  return x <= 1 / 12 ? Math.sqrt(3 * x) : a * Math.log(12 * x - b) + c
}

/** PQ inverse EOTF (SMPTE ST 2084): display light in nits → signal [0,1]. */
export function pqOetf(nits) {
  const m1 = 2610 / 16384, m2 = 2523 / 4096 * 128
  const c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32
  const y = Math.min(1, Math.max(0, nits / PQ_PEAK_NITS)) ** m1
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2
}

/**
 * One sRGB colour through the mapping: [r, g, b] in [0,1] → the project's
 * non-linear BT.2020 R'G'B' in [0,1].
 *
 * @param {number[]} rgb
 * @param {'hdr_hlg'|'hdr_pq'} dstKey
 * @returns {number[]}
 */
export function graphicsToHdr(rgb, dstKey) {
  const lin = rgb.map(srgbToLinear)
  const wide = M_709_2020.map(row => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])
  if (dstKey === 'hdr_pq') return wide.map(l => pqOetf(l * GRAPHICS_WHITE_NITS))
  const k = (GRAPHICS_WHITE_NITS / HLG_PEAK_NITS) ** (1 / HLG_SYSTEM_GAMMA)
  return wide.map(l => hlgOetf(l * k))
}

/** The mapping as a .cube file's text (red fastest, as the format orders it). */
export function graphicsLutText(dstKey) {
  const n = LUT_SIZE
  const lines = [`TITLE "montaj graphics ${dstKey} ${GRAPHICS_WHITE_NITS} nits"`, `LUT_3D_SIZE ${n}`]
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const out = graphicsToHdr([r / (n - 1), g / (n - 1), b / (n - 1)], dstKey)
        lines.push(out.map(v => v.toFixed(6)).join(' '))
      }
    }
  }
  return lines.join('\n') + '\n'
}

const lutPaths = new Map()

/**
 * Absolute path of the mapping's .cube for `dstKey`, written to the temp dir
 * on first use in this process. `write: false` (dry runs) names it without
 * touching the disk.
 */
export function graphicsLutPath(dstKey, { write = true } = {}) {
  let entry = lutPaths.get(dstKey)
  if (!entry) {
    const text = graphicsLutText(dstKey)
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
    entry = { text, path: join(tmpdir(), 'montaj-luts', `graphics-${dstKey}-${hash}.cube`), written: false }
    lutPaths.set(dstKey, entry)
  }
  if (write && !entry.written) {
    if (!existsSync(entry.path)) {
      mkdirSync(join(tmpdir(), 'montaj-luts'), { recursive: true })
      const partial = `${entry.path}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(partial, entry.text)
      renameSync(partial, entry.path)
    }
    entry.written = true
  }
  return entry.path
}

/**
 * The ffmpeg chain that maps graphics into `dstKey`, alpha kept, ending in
 * yuva444p10le tagged as the HDR canvas is.
 *
 * `input: 'capture'` is a Puppeteer capture as renderer.js encodes it: YUV
 * from Chrome's RGB with ffmpeg's BT.601 limited-range default, untagged, so
 * the chain declares that before reading it back to RGB. `input: 'rgb'` is an
 * image item, already RGB(A) from its fit chain.
 *
 * The chain ends in 4:4:4 with alpha, converted by `scale`, which carries the
 * alpha plane through (measured: no row off by more than one code, 4 runs
 * each at 1080x1920, 1920x1080 and 3840x2160). zscale must not do this step:
 * the managed ffmpeg 8.1.2's zscale, writing yuva420p or yuva420p10le under
 * slice threading, leaves most rows of the alpha plane at 0 (measured 1846 of
 * 1920 rows on a 1080x1920 frame), and the lower part of an overlay disappears.
 *
 * @param {'hdr_hlg'|'hdr_pq'} dstKey
 * @param {object} opts
 * @param {'capture'|'rgb'} opts.input
 * @param {boolean} [opts.write=true]  write the LUT file (false for dry runs)
 * @returns {string}
 */
export function graphicsToHdrChain(dstKey, { input, write = true }) {
  const trc = dstKey === 'hdr_pq' ? 'smpte2084' : 'arib-std-b67'
  const flags = 'flags=accurate_rnd+full_chroma_int'
  const toRgb = input === 'capture'
    ? `setparams=colorspace=bt470bg:range=tv,scale=in_color_matrix=bt601:in_range=tv:${flags},`
    : ''
  return toRgb
       + 'format=gbrapf32le,'
       + `lut3d=file=${ffmpegFilterPath(graphicsLutPath(dstKey, { write }))}:interp=tetrahedral,`
       + `scale=out_color_matrix=bt2020:out_range=tv:${flags},format=yuva444p10le,`
       + `setparams=colorspace=bt2020nc:color_trc=${trc}:color_primaries=bt2020:range=tv`
}

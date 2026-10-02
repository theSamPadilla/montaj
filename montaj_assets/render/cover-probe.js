// render/cover-probe.js
/**
 * Full-screen cards in an HDR render (POSTLAUNCH §47).
 *
 * A film often keeps footage running under a full-screen overlay, for the audio
 * and the continuity, so "a video clip is in the segment" (encode-segment.js
 * graphicsWhiteNitsFor) kept such an overlay at 800 nits even though no footage
 * shows. A CARD is an overlay that covers the frame opaquely at some point: its
 * placement is the whole canvas and its capture has at least one frame whose
 * alpha is fully opaque everywhere, or it carries the explicit `opaque: true`.
 * A card maps graphics white to GRAPHICS_WHITE_NITS_NO_FOOTAGE (300 nits) for its WHOLE span, its fades
 * included, and overlays stacked above it follow it (overlayWhiteNits). Deciding
 * per segment instead would step the white at clip cuts hidden under the card,
 * mid-animation.
 *
 * Measured once per capture, only in HDR composes, only for overlays placed over
 * the whole canvas: a lower third, a caption, or anything scaled, moved,
 * rotated, translucent or keyframed is never probed, so SDR and card-free
 * renders pay nothing. The probe reads the capture's alpha plane with ffmpeg and
 * stops at the first fully opaque frame.
 */
import { spawn } from 'node:child_process'
import { isFullCanvasPlacement } from '@bycrux/timeline-core'
import { FFMPEG } from './ffmpeg-bin.js'
import { isHdr } from './color-space.js'

/**
 * True when the overlay is drawn over the whole canvas exactly as captured: the
 * shared placement rule (timeline-core's `isFullCanvasPlacement`, which `opaque`
 * reads too), and on top of it no caption, no static opacity below 1 and no
 * keyframes at all, since an opacity track changes what the composite shows.
 */
export function isCardPlacement(ov) {
  if (ov.isCaption) return false
  if (ov.keyframes?.length) return false
  const one = (v) => v === undefined || v === null || v === 1
  return one(ov.opacity) && isFullCanvasPlacement(ov)
}

/**
 * True when some frame of the capture is fully opaque at every pixel. Any
 * failure (missing file, no alpha plane, ffmpeg error) is false: 800 nits is the
 * safe answer.
 *
 * @param {string} capturePath
 * @param {{ ffmpeg?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export function captureHasOpaqueFrame(capturePath, { ffmpeg = FFMPEG } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    // alphaextract gives the alpha plane as luma; format=gray makes it 8-bit
    // whatever the capture's depth, so "fully opaque" is a minimum of 255.
    const child = spawn(ffmpeg, ['-v', 'error', '-i', capturePath, '-an',
      '-vf', 'alphaextract,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
      '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      if (lines.some((l) => /lavfi\.signalstats\.YMIN=255\b/.test(l))) {
        done(true)
        child.kill('SIGKILL')
      }
    })
    child.on('error', () => done(false))
    child.on('close', () => done(/lavfi\.signalstats\.YMIN=255\b/.test(buf)))
  })
}

/**
 * Sets `coversFrame` on each rendered overlay segment that is a card. Only in
 * an HDR colour space; each capture is probed at most once.
 *
 * @param {object[]} puppeteerSegs  render.js's rendered segments (webmPath + placement)
 * @param {{ colorSpace: string, probe?: (path: string) => Promise<boolean> }} opts
 */
export async function markCards(puppeteerSegs, { colorSpace, probe = captureHasOpaqueFrame }) {
  if (!isHdr(colorSpace)) return
  const results = new Map()
  for (const seg of puppeteerSegs) {
    if (seg.opaque === true) { seg.coversFrame = true; continue }
    if (!isCardPlacement(seg)) continue
    if (!results.has(seg.webmPath)) results.set(seg.webmPath, probe(seg.webmPath))
  }
  for (const seg of puppeteerSegs) {
    if (seg.opaque === true || !results.has(seg.webmPath) || !isCardPlacement(seg)) continue
    if (await results.get(seg.webmPath)) seg.coversFrame = true
  }
}

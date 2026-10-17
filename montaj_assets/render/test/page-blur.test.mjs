// render/test/page-blur.test.mjs (§377)
//
// A 3D overlay under motion blur averages each frame's sub-frames in its page
// (three-bridge.js averageThreeFrames) and is captured once per frame, so its
// chunk encode reads one capture per frame at fps with no blur graph. Every
// other overlay keeps today's encode: every sub-frame, read at fps x N and
// averaged by tmix. A 3D page that cannot average falls back to the latter.
// The pixels are checked in scene3d-motion-blur.integration.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as R from '../renderer.js'
import { captureWithThree, isThreeBlurUnsupported, isThreeFrameBlank } from '../three-frame.js'
import { subframeTimes } from '../motion-blur.js'
import { generateShim } from '../bundle.js'
import { geometryAt } from '@bycrux/timeline-core'

const MKV = '/tmp/seg-chunk-0.mkv'
const TAIL = ['-c:v', 'ffv1', '-g', '1']
const MUX = ['-f', 'matroska', '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000', MKV]

// Today's args for a 2D overlay at 30 fps under motionBlur 5, written out: the golden.
const BLUR5_OPAQUE = ['-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '150', '-i', 'pipe:0',
  '-vf', "tmix=frames=5,select='eq(mod(n\\,5)\\,4)',setpts=PTS-STARTPTS", '-r', '30',
  ...TAIL, '-pix_fmt', 'yuv420p', ...MUX]
const BLUR5_ALPHA = ['-y', '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '150', '-i', 'pipe:0',
  '-vf', "premultiply=inplace=1,tmix=frames=5,unpremultiply=inplace=1,select='eq(mod(n\\,5)\\,4)',setpts=PTS-STARTPTS", '-r', '30',
  ...TAIL, '-pix_fmt', 'yuva420p', ...MUX]
// One capture per frame: exactly the unblurred chunk.
const ONE_OPAQUE = ['-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '30', '-i', 'pipe:0', ...TAIL, '-pix_fmt', 'yuv420p', ...MUX]
const ONE_ALPHA = ['-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '30', '-i', 'pipe:0', ...TAIL, '-pix_fmt', 'yuva420p', ...MUX]

test('chunkEncodeArgs: a 2D overlay under motion blur 5 keeps today\'s args (golden)', () => {
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: true, subframes: 5 }, MKV), BLUR5_OPAQUE)
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: false, subframes: 5 }, MKV), BLUR5_ALPHA)
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: true, subframes: 5, scene3d: false }, MKV), BLUR5_OPAQUE)
})

test('chunkEncodeArgs: a 3D overlay under motion blur 5 reads one capture per frame at fps, with no tmix', () => {
  for (const [opaque, want] of [[true, ONE_OPAQUE], [false, ONE_ALPHA]]) {
    const args = R.chunkEncodeArgs({ fps: 30, opaque, subframes: 5, scene3d: true }, MKV)
    assert.deepEqual(args, want, `opaque ${opaque}`)
    assert.ok(!args.some(a => /tmix|premultiply|select=/.test(a)), 'no blur graph')
    assert.equal(args[args.indexOf('-framerate') + 1], '30', 'read at fps')
    assert.deepEqual(args, R.chunkEncodeArgs({ fps: 30, opaque, subframes: 1 }, MKV), 'the same chunk unblurred')
  }
  // The JPEG capture of an opaque overlay for an SDR master (§284) is kept.
  const jpeg = R.chunkEncodeArgs({ fps: 30, opaque: true, subframes: 5, scene3d: true, sdrMaster: true }, MKV)
  assert.deepEqual(jpeg, R.chunkEncodeArgs({ fps: 30, opaque: true, subframes: 1, sdrMaster: true }, MKV))
})

test('chunkEncodeArgs: a 3D page that cannot average falls back to today\'s args', () => {
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: true, subframes: 5, scene3d: true }, MKV, { blurInPage: false }), BLUR5_OPAQUE)
  assert.deepEqual(R.chunkEncodeArgs({ fps: 30, opaque: false, subframes: 5, scene3d: true }, MKV, { blurInPage: false }), BLUR5_ALPHA)
})

test('blursInPage: only a 3D overlay, only under motion blur', () => {
  assert.equal(R.blursInPage({ scene3d: true, subframes: 5 }), true)
  assert.equal(R.blursInPage({ scene3d: true, subframes: 2 }), true)
  assert.equal(R.blursInPage({ scene3d: true, subframes: 1 }), false, 'no blur: one capture per frame anyway')
  assert.equal(R.blursInPage({ scene3d: true }), false)
  assert.equal(R.blursInPage({ subframes: 5 }), false, 'a 2D overlay')
  assert.equal(R.blursInPage({ scene3d: 'yes', subframes: 5 }), false)
})

/** A page whose evaluate calls are recorded; each set call takes the next of `sets`. */
function fakePage(sets) {
  const calls = []
  return {
    calls,
    async evaluate(fn, ...args) {
      const src = String(fn)
      calls.push({ src, args })
      if (src.includes('__montajThreeCheck')) return null
      return sets.shift()
    },
  }
}
const DREW = { canvases: 1, blank: null }

test('captureWithThree: a blurred frame hands the page exactly its subframeTimes, then captures once', async () => {
  const times = subframeTimes(7, 5)
  const page = fakePage([DREW])
  let captures = 0
  const got = await captureWithThree(page, 7, async () => { captures++; return 'png' }, { overlay: 'o', subframes: times })
  assert.equal(got, 'png')
  assert.equal(captures, 1, 'one capture for the frame')
  assert.match(page.calls[0].src, /__setFrameBlurred/)
  assert.deepEqual(page.calls[0].args, [7, [7, 7 + 1 / 5, 7 + 2 / 5, 7 + 3 / 5, 7 + 4 / 5]])
  assert.match(page.calls[1].src, /__montajThreeCheck/, 'then the check after the capture, as for any 3D frame')
})

test('captureWithThree: without sub-frames the page is set as before', async () => {
  const page = fakePage([DREW])
  await captureWithThree(page, 3.4, async () => 'png', { overlay: 'o' })
  assert.doesNotMatch(page.calls[0].src, /__setFrameBlurred/)
  assert.match(page.calls[0].src, /__setFrame\(/)
  assert.deepEqual(page.calls[0].args, [3.4])
})

test('captureWithThree: a sub-frame that did not draw retries the frame, then fails naming the sub-frame', async () => {
  const logs = []
  const blank = { canvases: 1, blank: 'not_rendered', frame: 7.4 }
  const page = fakePage([blank, DREW])
  const got = await captureWithThree(page, 7, async () => 'png', { overlay: 'o', subframes: subframeTimes(7, 5), log: m => logs.push(m) })
  assert.equal(got, 'png')
  assert.match(logs[0], /frame 7\.4 \(not_rendered\); retrying \(1\/2\)/)
  assert.deepEqual(page.calls.filter(c => /__setFrameBlurred/.test(c.src)).map(c => c.args[0]), [7, 7], 'the whole frame again')

  const always = fakePage([blank, blank, blank])
  await assert.rejects(
    captureWithThree(always, 7, async () => assert.fail('never captured'), { overlay: 'o', subframes: subframeTimes(7, 5) }),
    (err) => isThreeFrameBlank(err) && err.frame === 7.4 && err.reason === 'not_rendered' && err.attempts === 3,
  )
})

test('captureWithThree: a page that cannot average fails as three_blur_unsupported before any capture', async () => {
  const page = fakePage([{ unsupported: 'no_float_target' }])
  await assert.rejects(
    captureWithThree(page, 0, async () => assert.fail('never captured'), { overlay: 'o', subframes: subframeTimes(0, 5) }),
    (err) => isThreeBlurUnsupported(err) && err.reason === 'no_float_target' && err.frame === 0 && /no_float_target/.test(err.message),
  )
  assert.equal(page.calls.length, 1)
})

// A 3D item's keyframed move or fade is drawn on a wrapper div outside the canvas (bundle.js __bakeStyle), which the
// GPU average cannot see, so a chunk where a keyframed prop changes within a frame is captured per sub-frame.
const SLIDE = [{ prop: 'offsetX', points: [{ t: 0, value: -20 }, { t: 1, value: 20 }] }]
// A visibility window: 0, then 1 from 2 s, switching over 0.01 s.
const WINDOW = [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 2, value: 0 }, { t: 2.01, value: 1 }, { t: 5, value: 1 }] }]
const chunk = (keyframes, frameStart, frameEnd) => ({ fps: 30, opaque: true, subframes: 5, scene3d: true, keyframes, frameStart, frameEnd })

test('blursInPage: a keyframed slide across the chunk is captured per sub-frame, with today\'s args', () => {
  const job = chunk(SLIDE, 0, 8)
  assert.equal(R.keyframesSteady(job), false)
  assert.equal(R.blursInPage(job), false)
  assert.deepEqual(R.chunkEncodeArgs(job, MKV), BLUR5_OPAQUE)
})

test('blursInPage: an opacity window averages in the page where it holds, not across its switch', () => {
  assert.equal(R.blursInPage(chunk(WINDOW, 0, 30)), true, 'before the switch')
  assert.equal(R.blursInPage(chunk(WINDOW, 70, 150)), true, 'after the switch')
  assert.deepEqual(R.chunkEncodeArgs(chunk(WINDOW, 0, 30), MKV), ONE_OPAQUE)
  assert.equal(R.blursInPage(chunk(WINDOW, 55, 65)), false, 'the chunk holds the switch at 2 s (frame 60)')
  assert.deepEqual(R.chunkEncodeArgs(chunk(WINDOW, 55, 65), MKV), BLUR5_OPAQUE)
})

test('blursInPage: an item with no keyframes averages in the page', () => {
  assert.equal(R.blursInPage({ fps: 30, scene3d: true, subframes: 5, frameStart: 0, frameEnd: 8 }), true)
  assert.equal(R.blursInPage({ fps: 30, scene3d: true, subframes: 5, frameStart: 0, frameEnd: 8, keyframes: [] }), true)
  assert.equal(R.blursInPage({ fps: 30, scene3d: false, subframes: 5, keyframes: WINDOW, frameStart: 0, frameEnd: 8 }), false, 'a 2D overlay never')
})

test('keyframesSteady: the node check evaluates keyframes with the page\'s own function (geometryAt of timeline-core)', () => {
  const item = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1, keyframes: [...SLIDE, ...WINDOW] }
  const shim = generateShim('/abs/o.jsx', {}, 30, 90, item)
  const code = shim.slice(shim.indexOf('const __bakeItem'), shim.indexOf('let __setFrame'))
  const bakeStyle = new Function('geometryAt', `${code}\nreturn __bakeStyle`)(geometryAt)
  for (const t of [0, 3.4, 29.8, 59.6, 60.2, 60.4, 75]) {
    const g = geometryAt(item, 'overlay', t / 30)
    const got = bakeStyle(t)
    assert.equal(got.opacity, g.opacity, `opacity at ${t}`)
    assert.equal(got.transform, `translate(${g.offsetX}%, ${g.offsetY}%) rotate(${g.rotation}deg) scale(${g.scaleX}, ${g.scaleY})`, `transform at ${t}`)
  }
})

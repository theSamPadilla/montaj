// render/test/fixtures/short-segment-run.mjs
//
// Sam's 2026-10-01 export (robotics-decomission), scaled down to 2.4 s: a
// talking-head clip cut in the middle of an agent-made "zoom" built as
// consecutive 2-frame slices of one b-roll clip (contiguous inPoints), between
// the b-roll at full size and the b-roll as a pip. Shared by
// short-segments.test.mjs (planning) and short-segments.integration.test.mjs
// (encoding).

const FPS = 30

/** Sam's shape at 30 fps. `t0` is off the frame grid, like his 45.62215. */
export function samShape({ base = '/base.mp4', broll = '/broll.mp4', zooms = 12 } = {}) {
  const t0 = 0.62215
  const two = 2 / FPS
  const items = [
    // The talking head, cut inside the zoom run (Sam's 45.9321): the cut lands
    // inside zoom-05's span and splits it into two 1-frame segments.
    { id: 'clip-a', type: 'video', trackIdx: 0, src: base, start: 0, end: 0.9321, inPoint: 0, outPoint: 0.9321 },
    { id: 'clip-b', type: 'video', trackIdx: 0, src: base, start: 0.9321, end: 2.4, inPoint: 1.2, outPoint: 2.6679 },
    { id: 'broll-full', type: 'video', trackIdx: 2, src: broll, start: 0.2, end: t0, inPoint: 0.5, outPoint: 0.5 + t0 - 0.2, muted: true, scale: 1.6 },
  ]
  for (let k = 0; k < zooms; k++) {
    items.push({
      id: `broll-zoom-${String(k + 1).padStart(2, '0')}`, type: 'video', trackIdx: 2, src: broll,
      start: t0 + k * two, end: t0 + (k + 1) * two,
      inPoint: 0.5 + (t0 - 0.2) + k * two, outPoint: 0.5 + (t0 - 0.2) + (k + 1) * two,
      muted: true, scale: 1.55 - k * 0.08, offsetY: -k * 2.5,
    })
  }
  const runEnd = t0 + zooms * two
  items.push({ id: 'broll-pip', type: 'video', trackIdx: 2, src: broll, start: runEnd, end: 2.1,
    inPoint: 0.5 + (t0 - 0.2) + zooms * two, outPoint: 0.5 + (t0 - 0.2) + zooms * two + (2.1 - runEnd), muted: true, scale: 0.6 })
  return items
}


// montaj_assets/render/bake-tally.js
//
// §737: what `bake left` (renderer.js) counts with: the means of the jobs finished so far and the work still to do.
// One tally spans a whole render: a sliced render (slice-run.js) builds it once from every slice's jobs and passes it to
// each renderAllSegments call, so slice 1 of 2 counts slice 2's chunks too.
import { isScene3dSegment } from './memory.js'

/**
 * @param {Array<{ frameStart: number, frameEnd: number }>} jobs every job the render will run (3D chunks and 2D jobs)
 * @returns {{ n3d: number, ms3d: number, ms2d: number, frames2d: number, left3d: number, left2dFrames: number }}
 */
export function createBakeTally(jobs) {
  const tally = { n3d: 0, ms3d: 0, ms2d: 0, frames2d: 0, left3d: 0, left2dFrames: 0 }
  for (const j of jobs) addJob(tally, j, 1)
  return tally
}

/** A job reused or finished leaves the work left (`sign` -1); the tally is built with +1. */
export function addJob(tally, job, sign) {
  if (isScene3dSegment(job)) tally.left3d += sign
  else tally.left2dFrames += sign * (job.frameEnd - job.frameStart)
}

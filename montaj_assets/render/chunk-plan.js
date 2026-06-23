// Per-chunk floor: below this, browser-page setup + concat overhead dominates.
export const MIN_CHUNK_FRAMES = 120          // ~4s @ 30fps
// Conservative per-worker RAM budget for a 4K headless-Chrome render worker.
export const PER_WORKER_BYTES = 1.5 * 1e9

/** Chunk size that splits the longest segment into ~`workers` chunks, floored. */
export function adaptiveChunkSize(longestFrameCount, workers) {
  const w = Math.max(1, workers | 0)
  return Math.max(MIN_CHUNK_FRAMES, Math.ceil(longestFrameCount / w))
}
/** Cap workers so concurrent 4K Chrome workers don't OOM the box. */
export function workerCap(cores, totalMemBytes) {
  const byMem = Math.max(1, Math.floor(totalMemBytes / PER_WORKER_BYTES))
  return Math.min(Math.max(1, cores | 0), byMem)
}

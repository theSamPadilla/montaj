// Per-chunk floor: below this, browser-page setup + concat overhead dominates.
export const MIN_CHUNK_FRAMES = 120          // ~4s @ 30fps

/** Chunk size that splits the longest segment into ~`workers` chunks, floored. */
export function adaptiveChunkSize(longestFrameCount, workers) {
  const w = Math.max(1, workers | 0)
  return Math.max(MIN_CHUNK_FRAMES, Math.ceil(longestFrameCount / w))
}
// How many workers run at once is memory.js's (planWorkers).

// render/p-map.js
// Bounded-concurrency map, shared by render.js and sample-frame.js.
// Cap matches materialize_cut.py's libx264 worker pool. Results are
// index-ordered regardless of completion order.
export async function pMap(items, mapper, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await mapper(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

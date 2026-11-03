/**
 * playback.js (§698): a render yields to the editor preview. While the preview plays, most of the render's workers rest
 * between chunks (each worker is a headless Chrome and an ffmpeg encoder, the CPU and memory the preview's decoder
 * needs), and they pick up again when the playing stops. Cooperative: a chunk in flight is never stopped, a worker
 * rests only BEFORE taking its next chunk, and the kept workers carry the render, so it always finishes.
 *
 * The play state is serve's own (`GET /api/playback`, §683): serve passes the URL as MONTAJ_PLAYBACK_URL. Fails open
 * throughout: no URL, an unreachable or malformed answer, a slow serve all read as "not playing".
 * `MONTAJ_RENDER_YIELD=0` turns it off.
 */

/** How many workers keep rendering while the preview plays: a third, at least one. */
export function keptWorkers(workers) {
  return Math.max(1, Math.floor((Number(workers) || 0) / 3))
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads the play state in the background. `isPlaying()` is the last answer read (never waits); any failure makes it false.
 * @returns {{ isPlaying: () => boolean, refresh: () => Promise<void>, start: () => void, stop: () => void }}
 */
export function createPlaybackWatcher({ url = '', fetchImpl = globalThis.fetch, intervalMs = 500, timeoutMs = 800 } = {}) {
  let playing = false
  let timer = null
  const refresh = async () => {
    if (!url || typeof fetchImpl !== 'function') { playing = false; return }
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res || !res.ok) { playing = false; return }
      const body = await res.json()
      playing = body && body.playing === true
    } catch {
      playing = false
    }
  }
  return {
    isPlaying: () => playing,
    refresh,
    start() {
      if (!url || timer) return
      void refresh()
      timer = setInterval(() => { void refresh() }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      playing = false
    },
  }
}

/**
 * The gate a worker passes before taking its next chunk. A kept worker (index below `keptWorkers`) never waits; the others
 * wait while `isPlaying()` and chunks remain. True when it waited at all.
 */
export function createPlaybackThrottle({ workers, isPlaying, pollMs = 250, sleep = sleepFor, log = () => {} }) {
  const keep = keptWorkers(workers)
  let said = false
  return {
    keep,
    async wait(workerIdx, more = () => true) {
      if (workerIdx < keep) return false
      let waited = false
      while (more() && isPlaying()) {
        if (!said) { log(`render: the preview is playing; ${keep} of ${workers} workers keep rendering, the others rest until it stops`); said = true }
        waited = true
        await sleep(pollMs)
      }
      return waited
    },
  }
}

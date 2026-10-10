/**
 * §190 T3: the conform client. It asks serve to conform every audio source the
 * plan may need (`POST /api/audio/conform`), polls `GET /api/audio/conformed`
 * until each one is settled, and answers the plan builder's `ConformLookup`.
 *
 * The handlers are `serve/routes/audio.py` over `serve/audio_conform.py`. What
 * this module leans on from them:
 *
 *  - A POST answers `{results: [{path, status, ...}]}`, one per path, and
 *    REFUSES THE WHOLE REQUEST (400 or 403) when any one path is bad. A file the
 *    user browsed to outside serve's roots is the common case (the app answers
 *    `/api/files` for those itself, so the source plays but serve may not read
 *    it). So a refused batch is split and sent path by path, and only the paths
 *    refused on their own resolve to "no conform".
 *  - `status` is one of `running`, `ready`, `silent`, `failed`, `missing`. The
 *    GET never starts a job. `missing` from the POST means serve cannot stat the
 *    file, so no conform will ever exist. `missing` from the GET after a job
 *    started means serve lost it (a restart, or its LRU evicted the result), so
 *    the source is conformed again, a bounded number of times.
 *  - A `ready` URL is page-relative (`/api/files?path=...`). The default client
 *    is same-origin (the app shell proxies `/api/*` to serve, and OSS serves the
 *    editor itself), so it is handed to the mixer as is; `apiBase` prefixes it
 *    for a host that points elsewhere.
 *
 * Every source ends ready, silent or "none", never in an endless poll: the
 * delay doubles to a cap, a source still `running` past `giveUpMs` is given up
 * on (serve bounds a job at 30 min, `FFMPEG_MAX_TIMEOUT`), and transport
 * failures (a network error, a 5xx, a body that is not the JSON asked for) are
 * counted. A 2xx whose body does not parse is "none" at once: the desktop shell
 * answers an unknown path with its SPA index and a 200, which retrying cannot
 * fix (CLAUDE.md's `serveStaticFile` note).
 *
 * The editor package depends on nothing from Montaj (schema.ts's header). The
 * two endpoint paths are the one Montaj-shaped assumption, and the engine takes
 * an injected client, so a host can replace all of it.
 */
import type { ConformLookup, ConformedSource } from './audio-plan'

/** First poll delay; it doubles per poll up to {@link CONFORM_POLL_MAX_MS}. */
export const CONFORM_POLL_BASE_MS = 250
export const CONFORM_POLL_MAX_MS = 4000
/** A source still unsettled after this much polling is given up on: past serve's own 30 min job ceiling. */
export const CONFORM_GIVE_UP_MS = 35 * 60_000
/** Consecutive transport failures before a source is given up on. */
export const CONFORM_MAX_ERRORS = 5
/** How many times a source serve lost (`missing` after a start) is conformed again. */
export const CONFORM_MAX_RESTARTS = 2

/** `none`: failed, unreachable or given up on. The plan treats it like `pending`: no conform. */
export type ConformState = 'pending' | 'ready' | 'silent' | 'none'

export interface ConformClient {
  /** Ask for these sources to be conformed. Paths already asked for are skipped, so this is cheap per edit. */
  request(paths: readonly string[]): void
  /** The conform for a source, or null while it has none (pending, failed, unreachable). */
  readonly lookup: ConformLookup
  /** `undefined` for a path never requested. */
  state(path: string): ConformState | undefined
  /** Fires whenever a source settles (ready, silent or none). Returns the unsubscribe. */
  onChange(listener: () => void): () => void
  dispose(): void
}

/** The slice of a fetch `Response` this reads. */
export interface ConformResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface ConformClientOptions {
  /** Default: the page's `fetch`, same origin. */
  fetch?: (url: string, init: RequestInit) => Promise<ConformResponse>
  /** Prefixed to both endpoints and to a page-relative conform URL. Default `''`. */
  apiBase?: string
  /** Timer seams, for tests. Default `setTimeout`/`clearTimeout`. */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  pollBaseMs?: number
  pollMaxMs?: number
  giveUpMs?: number
  maxErrors?: number
}

interface Entry {
  state: ConformState
  source: ConformedSource | null
  /** The next request this source needs: a (re)start, or a status poll. */
  next: 'post' | 'get'
  delayMs: number
  /** Total delay scheduled so far, the give-up budget's measure (no wall clock needed). */
  waitedMs: number
  errors: number
  restarts: number
  timer: unknown
}

interface ConformResult {
  path?: unknown
  status?: unknown
  url?: unknown
  format?: unknown
  sampleRate?: unknown
  channels?: unknown
  frames?: unknown
}

function positive(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** A `ready`/`silent` result as the plan builder's `ConformedSource`, or null for anything else or anything malformed. */
export function conformedFrom(r: ConformResult, apiBase = ''): ConformedSource | null {
  if (r.status === 'silent') {
    return {
      url: '',
      format: 'pcm_s16le',
      sampleRate: positive(r.sampleRate, 48000),
      channels: positive(r.channels, 2),
      frames: 0,
      silent: true,
    }
  }
  if (r.status !== 'ready') return null
  if (typeof r.url !== 'string' || !r.url) return null
  if (r.format !== 'pcm_s16le' && r.format !== 'pcm_f32le') return null
  const frames = typeof r.frames === 'number' ? r.frames : Number(r.frames)
  if (!Number.isFinite(frames) || frames < 0) return null
  return {
    url: apiBase && r.url.startsWith('/') ? apiBase + r.url : r.url,
    format: r.format,
    sampleRate: positive(r.sampleRate, 48000),
    channels: positive(r.channels, 2),
    frames,
  }
}

type Outcome =
  | { kind: 'json'; body: unknown }
  /** A 4xx: serve refused the request (bad path, outside its roots) or has no such route. */
  | { kind: 'refused'; status: number }
  /** A 2xx whose body is not JSON: something other than serve answered. */
  | { kind: 'unreadable' }
  /** Network error or 5xx: may clear up. */
  | { kind: 'error' }

export function createConformClient(options: ConformClientOptions = {}): ConformClient {
  const doFetch =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init) as Promise<ConformResponse>)
  const apiBase = options.apiBase ?? ''
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const pollBaseMs = options.pollBaseMs ?? CONFORM_POLL_BASE_MS
  const pollMaxMs = options.pollMaxMs ?? CONFORM_POLL_MAX_MS
  const giveUpMs = options.giveUpMs ?? CONFORM_GIVE_UP_MS
  const maxErrors = options.maxErrors ?? CONFORM_MAX_ERRORS

  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let disposed = false

  const send = async (url: string, init: RequestInit): Promise<Outcome> => {
    let res: ConformResponse
    try {
      res = await doFetch(url, { ...init, signal: controller?.signal })
    } catch {
      return { kind: 'error' }
    }
    if (res.status >= 400 && res.status < 500) return { kind: 'refused', status: res.status }
    if (!res.ok) return { kind: 'error' }
    try {
      return { kind: 'json', body: await res.json() }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // a listener's failure is its own
      }
    }
  }

  const settle = (path: string, state: ConformState, source: ConformedSource | null = null) => {
    const entry = entries.get(path)
    if (!entry || entry.state !== 'pending') return
    entry.state = state
    entry.source = source
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.timer = undefined
    notify()
  }

  const schedule = (path: string, next: 'post' | 'get') => {
    const entry = entries.get(path)
    if (!entry || entry.state !== 'pending' || disposed) return
    if (entry.waitedMs >= giveUpMs) {
      settle(path, 'none')
      return
    }
    entry.next = next
    const delay = entry.delayMs
    entry.waitedMs += delay
    entry.delayMs = Math.min(pollMaxMs, delay * 2)
    entry.timer = setTimer(() => {
      entry.timer = undefined
      if (entry.next === 'post') void post([path])
      else void poll(path)
    }, delay)
  }

  /** A transport failure: retry the same request after the backoff, until `maxErrors` in a row. */
  const failed = (path: string, next: 'post' | 'get') => {
    const entry = entries.get(path)
    if (!entry || entry.state !== 'pending') return
    entry.errors += 1
    if (entry.errors >= maxErrors) settle(path, 'none')
    else schedule(path, next)
  }

  /** One result for one path, from either endpoint. */
  const handle = (path: string, result: ConformResult, from: 'post' | 'get') => {
    const entry = entries.get(path)
    if (!entry || entry.state !== 'pending') return
    entry.errors = 0
    switch (result.status) {
      case 'ready':
      case 'silent': {
        const source = conformedFrom(result, apiBase)
        settle(path, source ? (source.silent ? 'silent' : 'ready') : 'none', source)
        return
      }
      case 'running':
        schedule(path, 'get')
        return
      case 'missing':
        // From the POST: serve cannot stat the file, so no conform will come.
        // From the GET: the job it started is gone; start it once more.
        if (from === 'get' && entry.restarts < CONFORM_MAX_RESTARTS) {
          entry.restarts += 1
          schedule(path, 'post')
        } else {
          settle(path, 'none')
        }
        return
      default:
        // `failed`, or a shape this client does not know.
        settle(path, 'none')
    }
  }

  const post = async (paths: string[]): Promise<void> => {
    if (disposed || paths.length === 0) return
    const outcome = await send(`${apiBase}/api/audio/conform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    if (disposed) return
    if (outcome.kind === 'refused') {
      // 404: no conform endpoint at all (an older serve, or a host that does
      // not proxy it). Anything else refuses the whole batch for one bad path:
      // split it so the good ones still get conformed.
      if (outcome.status !== 404 && paths.length > 1) {
        for (const path of paths) void post([path])
      } else {
        for (const path of paths) settle(path, 'none')
      }
      return
    }
    if (outcome.kind === 'unreadable') {
      for (const path of paths) settle(path, 'none')
      return
    }
    if (outcome.kind === 'error') {
      for (const path of paths) failed(path, 'post')
      return
    }
    const results = (outcome.body as { results?: unknown } | null)?.results
    const byPath = new Map<string, ConformResult>()
    if (Array.isArray(results)) {
      for (const r of results as ConformResult[]) {
        if (r && typeof r.path === 'string') byPath.set(r.path, r)
      }
    }
    for (const path of paths) {
      const result = byPath.get(path)
      // A path the answer left out: ask the status endpoint rather than guess.
      if (result) handle(path, result, 'post')
      else schedule(path, 'get')
    }
  }

  const poll = async (path: string): Promise<void> => {
    if (disposed) return
    const outcome = await send(`${apiBase}/api/audio/conformed?path=${encodeURIComponent(path)}`, {
      method: 'GET',
    })
    if (disposed) return
    if (outcome.kind === 'refused' || outcome.kind === 'unreadable') settle(path, 'none')
    else if (outcome.kind === 'error') failed(path, 'get')
    else handle(path, (outcome.body ?? {}) as ConformResult, 'get')
  }

  return {
    request(paths) {
      if (disposed) return
      const fresh: string[] = []
      for (const path of paths) {
        if (!path || entries.has(path)) continue
        entries.set(path, {
          state: 'pending',
          source: null,
          next: 'post',
          delayMs: pollBaseMs,
          waitedMs: 0,
          errors: 0,
          restarts: 0,
          timer: undefined,
        })
        fresh.push(path)
      }
      void post(fresh)
    },
    lookup: (src: string) => entries.get(src)?.source ?? null,
    state: (path: string) => entries.get(path)?.state,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      controller?.abort()
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimer(entry.timer)
        entry.timer = undefined
      }
      listeners.clear()
    },
  }
}

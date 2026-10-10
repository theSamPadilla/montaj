/**
 * §190 T3: the conform client against a scripted fetch and hand-run timers:
 * what it asks serve for, how it backs off, when it gives up, and that every
 * source ends ready, silent or "none". The response shapes are serve's
 * (`serve/routes/audio.py`, `serve/audio_conform.py`'s `start`/`lookup`).
 */
import { describe, expect, it } from 'vitest'
import {
  CONFORM_MAX_RESTARTS,
  conformedFrom,
  createConformClient,
  type ConformClientOptions,
  type ConformResponse,
} from '../conform-client'

interface Call {
  method: string
  url: string
  paths?: string[]
  path?: string
}

type Reply = { status: number; body?: unknown; unreadable?: boolean } | 'network-error'

const READY = (path: string, frames = 4800) => ({
  path,
  status: 'ready',
  url: `/api/files?path=/ws/.cache/conformed-audio/${encodeURIComponent(path)}.pcm`,
  format: 'pcm_s16le',
  sampleRate: 48000,
  channels: 2,
  frames,
  bytes: frames * 4,
})

/** A scripted serve: `post` and `get` answer per path; every call is logged. */
function rig(script: {
  post?: (paths: string[]) => Reply
  get?: (path: string, n: number) => Reply
}, over: Partial<ConformClientOptions> = {}) {
  const calls: Call[] = []
  const gets = new Map<string, number>()
  const timers: Array<{ cb: () => void; ms: number; cancelled: boolean }> = []
  const delays: number[] = []
  const respond = (reply: Reply): Promise<ConformResponse> => {
    if (reply === 'network-error') return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => (reply.unreadable ? Promise.reject(new SyntaxError('Unexpected token <')) : Promise.resolve(reply.body)),
    })
  }
  const fetch = (url: string, init: RequestInit): Promise<ConformResponse> => {
    if (init.method === 'POST') {
      const paths = (JSON.parse(String(init.body)) as { paths: string[] }).paths
      calls.push({ method: 'POST', url, paths })
      return respond(script.post ? script.post(paths) : { status: 200, body: { results: paths.map((p) => ({ path: p, status: 'running' })) } })
    }
    const path = new URL(url, 'http://x').searchParams.get('path') ?? ''
    calls.push({ method: 'GET', url, path })
    const n = (gets.get(path) ?? 0) + 1
    gets.set(path, n)
    return respond(script.get ? script.get(path, n) : { status: 200, body: { path, status: 'running' } })
  }
  const client = createConformClient({
    fetch,
    setTimer: (cb, ms) => {
      const t = { cb, ms, cancelled: false }
      timers.push(t)
      delays.push(ms)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cancelled: boolean }).cancelled = true
    },
    ...over,
  })
  let changes = 0
  client.onChange(() => {
    changes++
  })
  /** Let every pending fetch settle. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  /** Fire every timer armed so far (each may arm the next), then settle. */
  const tick = async () => {
    const due = timers.splice(0)
    for (const t of due) if (!t.cancelled) t.cb()
    await settle()
  }
  return { client, calls, delays, timers, settle, tick, changes: () => changes }
}

describe('createConformClient: what it asks for', () => {
  it('POSTs the requested sources once, and skips the ones it already asked for', async () => {
    const r = rig({ post: (paths) => ({ status: 200, body: { results: paths.map((p) => READY(p)) } }) })
    r.client.request(['/m/a.mov', '/m/b.wav', '/m/a.mov', ''])
    await r.settle()
    r.client.request(['/m/a.mov', '/m/c.mp3'])
    await r.settle()
    expect(r.calls).toEqual([
      { method: 'POST', url: '/api/audio/conform', paths: ['/m/a.mov', '/m/b.wav'] },
      { method: 'POST', url: '/api/audio/conform', paths: ['/m/c.mp3'] },
    ])
  })

  it('a source already conformed is ready from the POST answer: no poll, one change event', async () => {
    const r = rig({ post: (paths) => ({ status: 200, body: { results: paths.map((p) => READY(p, 96000)) } }) })
    r.client.request(['/m/a.mov'])
    await r.settle()
    expect(r.client.state('/m/a.mov')).toBe('ready')
    expect(r.client.lookup('/m/a.mov')).toEqual({
      url: '/api/files?path=/ws/.cache/conformed-audio/%2Fm%2Fa.mov.pcm',
      format: 'pcm_s16le',
      sampleRate: 48000,
      channels: 2,
      frames: 96000,
    })
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
    expect(r.changes()).toBe(1)
  })

  it('a source with no audio is silent: a lookup the plan builds nothing from', async () => {
    const r = rig({
      post: (paths) => ({
        status: 200,
        body: { results: paths.map((p) => ({ path: p, status: 'silent', url: null, format: null, sampleRate: 48000, channels: 2, frames: 0, bytes: 0 })) },
      }),
    })
    r.client.request(['/m/broll.mov'])
    await r.settle()
    expect(r.client.state('/m/broll.mov')).toBe('silent')
    expect(r.client.lookup('/m/broll.mov')).toMatchObject({ silent: true, frames: 0 })
  })

  it('prefixes `apiBase` to both endpoints and to a page-relative conform URL', async () => {
    const r = rig(
      { post: (paths) => ({ status: 200, body: { results: paths.map((p) => READY(p)) } }) },
      { apiBase: 'http://127.0.0.1:3000' },
    )
    r.client.request(['/m/a.mov'])
    await r.settle()
    expect(r.calls[0].url).toBe('http://127.0.0.1:3000/api/audio/conform')
    expect(r.client.lookup('/m/a.mov')?.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/api\/files\?path=/)
  })
})

describe('createConformClient: polling', () => {
  it('polls a running conform with a doubling delay, capped, until it is ready', async () => {
    const r = rig({ get: (path, n) => (n < 6 ? { status: 200, body: { path, status: 'running' } } : { status: 200, body: READY(path) }) }, {
      pollBaseMs: 250,
      pollMaxMs: 2000,
    })
    r.client.request(['/m/a.mov'])
    await r.settle()
    for (let i = 0; i < 8 && r.client.state('/m/a.mov') === 'pending'; i++) await r.tick()
    expect(r.client.state('/m/a.mov')).toBe('ready')
    expect(r.delays).toEqual([250, 500, 1000, 2000, 2000, 2000])
    expect(r.calls.filter((c) => c.method === 'GET').map((c) => c.url)).toContain('/api/audio/conformed?path=%2Fm%2Fa.mov')
    expect(r.changes()).toBe(1)
    // Settled: nothing left armed.
    expect(r.timers.filter((t) => !t.cancelled)).toHaveLength(0)
  })

  it('a failed conform is "none", and is never asked about again', async () => {
    const r = rig({ get: (path) => ({ status: 200, body: { path, status: 'failed', error: 'ffmpeg exited 1' } }) })
    r.client.request(['/m/a.mov'])
    await r.settle()
    await r.tick()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.client.lookup('/m/a.mov')).toBeNull()
    expect(r.timers).toHaveLength(0)
    expect(r.changes()).toBe(1)
  })

  it('gives up on a source still running past the budget', async () => {
    const r = rig({}, { pollBaseMs: 100, pollMaxMs: 400, giveUpMs: 1000 })
    r.client.request(['/m/huge.mov'])
    await r.settle()
    for (let i = 0; i < 20 && r.client.state('/m/huge.mov') === 'pending'; i++) await r.tick()
    expect(r.client.state('/m/huge.mov')).toBe('none')
    // 100 + 200 + 400 + 400 = 1100 >= 1000: four polls, then it stops.
    expect(r.delays).toEqual([100, 200, 400, 400])
    expect(r.timers).toHaveLength(0)
  })

  it('a job serve lost (missing after a start) is conformed again, a bounded number of times', async () => {
    const r = rig({ get: (path) => ({ status: 200, body: { path, status: 'missing' } }) })
    r.client.request(['/m/a.mov'])
    await r.settle()
    for (let i = 0; i < 20 && r.client.state('/m/a.mov') === 'pending'; i++) await r.tick()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1 + CONFORM_MAX_RESTARTS)
  })

  it('"missing" from the POST is a file serve cannot stat: none at once', async () => {
    const r = rig({ post: (paths) => ({ status: 200, body: { results: paths.map((p) => ({ path: p, status: 'missing' })) } }) })
    r.client.request(['/m/gone.mov'])
    await r.settle()
    expect(r.client.state('/m/gone.mov')).toBe('none')
    expect(r.timers).toHaveLength(0)
  })

  it('dispose stops every poll', async () => {
    const r = rig({})
    r.client.request(['/m/a.mov'])
    await r.settle()
    expect(r.timers).toHaveLength(1)
    r.client.dispose()
    expect(r.timers[0].cancelled).toBe(true)
    await r.tick()
    expect(r.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })
})

describe('createConformClient: unreachable sources resolve to "none", never an endless poll', () => {
  it('a batch refused for one path outside serve\'s roots is split, and only that path is none', async () => {
    const r = rig({
      post: (paths) =>
        paths.includes('/Users/me/Desktop/elsewhere.mp3')
          ? { status: 403, body: { error: { code: 'forbidden' } } }
          : { status: 200, body: { results: paths.map((p) => READY(p)) } },
    })
    r.client.request(['/ws/a.mov', '/Users/me/Desktop/elsewhere.mp3', '/ws/b.wav'])
    await r.settle()
    expect(r.client.state('/ws/a.mov')).toBe('ready')
    expect(r.client.state('/ws/b.wav')).toBe('ready')
    expect(r.client.state('/Users/me/Desktop/elsewhere.mp3')).toBe('none')
    expect(r.calls.map((c) => c.paths)).toEqual([
      ['/ws/a.mov', '/Users/me/Desktop/elsewhere.mp3', '/ws/b.wav'],
      ['/ws/a.mov'],
      ['/Users/me/Desktop/elsewhere.mp3'],
      ['/ws/b.wav'],
    ])
  })

  it('no conform endpoint (404) is none for everything, with no split and no retry', async () => {
    const r = rig({ post: () => ({ status: 404 }) })
    r.client.request(['/m/a.mov', '/m/b.wav'])
    await r.settle()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.client.state('/m/b.wav')).toBe('none')
    expect(r.calls).toHaveLength(1)
    expect(r.timers).toHaveLength(0)
  })

  it('a 200 that is not JSON (a shell answering with its index page) is none, not retried', async () => {
    const r = rig({ post: () => ({ status: 200, unreadable: true }) })
    r.client.request(['/m/a.mov'])
    await r.settle()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.timers).toHaveLength(0)
  })

  it('a status poll refused (403) is none', async () => {
    const r = rig({ get: () => ({ status: 403 }) })
    r.client.request(['/m/a.mov'])
    await r.settle()
    await r.tick()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.timers).toHaveLength(0)
  })

  it('network errors are retried with the backoff, then given up on', async () => {
    const r = rig({ post: () => 'network-error' }, { maxErrors: 3 })
    r.client.request(['/m/a.mov'])
    await r.settle()
    for (let i = 0; i < 10 && r.client.state('/m/a.mov') === 'pending'; i++) await r.tick()
    expect(r.client.state('/m/a.mov')).toBe('none')
    expect(r.calls).toHaveLength(3)
    expect(r.delays).toEqual([250, 500])
  })

  it('a 5xx poll is a transport failure, and a good answer after it resets the count', async () => {
    const r = rig(
      { get: (path, n) => (n % 2 === 1 ? { status: 503 } : n < 6 ? { status: 200, body: { path, status: 'running' } } : { status: 200, body: READY(path) }) },
      { maxErrors: 2 },
    )
    r.client.request(['/m/a.mov'])
    await r.settle()
    for (let i = 0; i < 12 && r.client.state('/m/a.mov') === 'pending'; i++) await r.tick()
    // 503, running, 503, running, 503, ready: never two failures in a row.
    expect(r.client.state('/m/a.mov')).toBe('ready')
  })
})

describe('conformedFrom', () => {
  it('rejects a ready answer it could not hand the mixer', () => {
    expect(conformedFrom({ status: 'ready', url: '', format: 'pcm_s16le', frames: 1 })).toBeNull()
    expect(conformedFrom({ status: 'ready', url: '/x', format: 'mp3', frames: 1 })).toBeNull()
    expect(conformedFrom({ status: 'ready', url: '/x', format: 'pcm_s16le', frames: 'many' })).toBeNull()
    expect(conformedFrom({ status: 'running' })).toBeNull()
  })

  it('defaults rate and channels the way the conform writes them', () => {
    expect(conformedFrom({ status: 'ready', url: '/x', format: 'pcm_f32le', frames: 10 })).toEqual({
      url: '/x',
      format: 'pcm_f32le',
      sampleRate: 48000,
      channels: 2,
      frames: 10,
    })
  })
})

/**
 * §660: the preview's loudness level, against a scripted serve and hand-run
 * timers. The level is the gain the export's loudnorm brings the mix to
 * (`target - inputI`), clamped; 0 dB whenever it is not known. The client asks
 * once per settled change of the mix (debounced), polls while serve measures,
 * and ignores an answer for a mix that has since changed. The response shapes
 * are serve's (`serve/routes/audio.py`, `serve/mix_loudness.py`).
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject } from '../../../schema'
import {
  LOUDNESS_DEBOUNCE_MS,
  LOUDNESS_MAX_GAIN_DB,
  LOUDNESS_MIN_GAIN_DB,
  createLoudnessClient,
  mixGainDb,
  mixSignature,
  type LoudnessClientOptions,
  type LoudnessResponse,
} from '../loudness-client'

const READY = (inputI: number, targetI = -14) => ({ status: 'ready', inputI, targetI, gainDb: targetI - inputI })

function project(over: { loudness?: number | null; volume?: number; name?: string } = {}): EditorProject {
  return {
    id: 'p1',
    name: over.name ?? 'n',
    settings: { resolution: [1080, 1920], fps: 30, ...(over.loudness === null ? {} : { loudness: over.loudness ?? -14 }) },
    tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: '/m/a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }] }],
    audio: { tracks: [{ id: 'vo', src: '/m/vo.wav', start: 0, end: 4, volume: over.volume ?? 1 }] },
  } as unknown as EditorProject
}

type Reply = { status: number; body?: unknown } | 'network-error'

function rig(replies: Reply[] | ((n: number) => Reply), over: Partial<LoudnessClientOptions> = {}) {
  const calls: Array<{ url: string; method: string }> = []
  const timers: Array<{ cb: () => void; ms: number; cancelled: boolean; fired: boolean }> = []
  const pending: Array<Promise<unknown>> = []
  const fetch = (url: string, init: RequestInit): Promise<LoudnessResponse> => {
    calls.push({ url, method: String(init.method) })
    const reply = typeof replies === 'function' ? replies(calls.length) : (replies[calls.length - 1] ?? replies[replies.length - 1])
    const p =
      reply === 'network-error'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ ok: reply.status < 300, status: reply.status, json: () => Promise.resolve(reply.body) })
    pending.push(p.catch(() => {}))
    return p
  }
  const client = createLoudnessClient({
    projectId: 'p1',
    fetch,
    setTimer: (cb, ms) => {
      const t = { cb, ms, cancelled: false, fired: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cancelled: boolean }).cancelled = true
    },
    ...over,
  })
  const gains: number[] = []
  client.onGain((db) => gains.push(db))
  /** Fire every live timer once, then let the replies land. */
  const tick = async () => {
    for (const t of timers.filter((x) => !x.cancelled && !x.fired)) {
      t.fired = true
      t.cb()
    }
    for (let i = 0; i < 5; i++) {
      await Promise.all(pending)
      await Promise.resolve()
    }
  }
  return { client, calls, timers, gains, tick }
}

describe('the gain', () => {
  it('is the target minus the mix\'s integrated loudness', () => {
    expect(mixGainDb(READY(-26))).toBe(12)
    expect(mixGainDb(READY(-9, -16))).toBe(-7)
  })

  it('is clamped to the range a preview may move, both ways', () => {
    expect(LOUDNESS_MIN_GAIN_DB).toBe(-30)
    expect(LOUDNESS_MAX_GAIN_DB).toBe(30)
    expect(mixGainDb(READY(-60))).toBe(30)
    expect(mixGainDb(READY(20, -30))).toBe(-30)
  })

  it('is 0 dB for off, silent, failed, running and anything malformed', () => {
    for (const body of [
      { status: 'off' },
      { status: 'silent', targetI: -14 },
      { status: 'failed', error: 'x' },
      { status: 'running' },
      { status: 'ready', inputI: null, targetI: -14 },
      { status: 'ready', inputI: '-20', targetI: -14 },
      { status: 'ready', inputI: -Infinity, targetI: -14 },
      null,
      'nope',
    ]) {
      expect(mixGainDb(body)).toBe(0)
    }
  })
})

describe('the signature', () => {
  it('follows the mix and the target, not the rest of the project', () => {
    const base = mixSignature(project())
    expect(mixSignature(project({ name: 'other' }))).toBe(base)
    expect(mixSignature(project({ volume: 0.5 }))).not.toBe(base)
    expect(mixSignature(project({ loudness: -16 }))).not.toBe(base)
  })
})

describe('asking serve', () => {
  it('asks once per settled change, after the debounce, at the project\'s route', async () => {
    const r = rig([{ status: 200, body: READY(-20) }])
    r.client.update(project({ volume: 0.5 }))
    r.client.update(project({ volume: 0.6 }))
    r.client.update(project({ volume: 0.7 }))
    expect(r.calls).toEqual([])
    const live = r.timers.filter((t) => !t.cancelled)
    expect(live).toHaveLength(1)
    expect(live[0].ms).toBe(LOUDNESS_DEBOUNCE_MS)
    await r.tick()
    expect(r.calls).toEqual([{ url: '/api/projects/p1/mix-loudness', method: 'POST' }])
    expect(r.gains).toEqual([6])
    expect(r.client.gainDb).toBe(6)
  })

  it('an unchanged mix asks nothing again', async () => {
    const r = rig([{ status: 200, body: READY(-20) }])
    r.client.update(project())
    await r.tick()
    r.client.update(project({ name: 'renamed' }))
    r.client.update(project())
    await r.tick()
    expect(r.calls).toHaveLength(1)
  })

  it('polls while serve measures, then takes the answer', async () => {
    const r = rig([{ status: 200, body: { status: 'running' } }, { status: 200, body: { status: 'running' } }, { status: 200, body: READY(-24) }])
    r.client.update(project())
    await r.tick()
    await r.tick()
    await r.tick()
    expect(r.calls).toHaveLength(3)
    expect(r.gains).toEqual([10])
  })

  it('no target: 0 dB at once, and serve is never asked', async () => {
    const r = rig([{ status: 200, body: READY(-20) }])
    r.client.update(project())
    await r.tick()
    expect(r.client.gainDb).toBe(6)
    r.client.update(project({ loudness: null }))
    expect(r.client.gainDb).toBe(0)
    await r.tick()
    expect(r.calls).toHaveLength(1)
    expect(r.gains).toEqual([6, 0])
  })

  it('keeps the current level while a changed mix is measured, and drops an answer for a stale mix', async () => {
    let n = 0
    const r = rig(() => (++n === 1 ? { status: 200, body: READY(-20) } : { status: 200, body: READY(-26) }))
    r.client.update(project())
    await r.tick()
    expect(r.gains).toEqual([6])
    r.client.update(project({ volume: 0.5 }))
    // The ask for the 0.5 mix is under way; the mix changes again before it answers.
    r.timers.filter((t) => !t.cancelled && !t.fired).forEach((t) => {
      t.fired = true
      t.cb()
    })
    r.client.update(project({ volume: 0.4 }))
    await r.tick()
    await r.tick()
    expect(r.client.gainDb).toBe(12)
    // 6 held through the change; the stale answer never landed on its own.
    expect(r.gains).toEqual([6, 12])
  })

  it('failed, a refused route or a dead serve all settle at 0 dB', async () => {
    for (const reply of [{ status: 200, body: { status: 'failed', error: 'x' } }, { status: 404 }] as Reply[]) {
      const r = rig([{ status: 200, body: READY(-20) }, reply])
      r.client.update(project())
      await r.tick()
      r.client.update(project({ volume: 0.5 }))
      await r.tick()
      expect(r.client.gainDb).toBe(0)
    }
    const dead = rig(['network-error'], { maxErrors: 3 })
    dead.client.update(project())
    for (let i = 0; i < 5; i++) await dead.tick()
    expect(dead.calls).toHaveLength(3)
    expect(dead.client.gainDb).toBe(0)
  })

  it('dispose stops every timer and every answer', async () => {
    const r = rig([{ status: 200, body: READY(-20) }])
    r.client.update(project())
    r.client.dispose()
    await r.tick()
    expect(r.calls).toEqual([])
    expect(r.gains).toEqual([])
  })
})

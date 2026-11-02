/**
 * §660: the preview's master bus. Every path the preview plays sound through
 * ends in ONE chain on the shared context: the loudness gain, then a limiter
 * standing in for the export's -1 dBTP ceiling, then a trim taking the
 * compressor's own makeup gain back off, then the destination. A new level is
 * ramped (setTargetAtTime), never jumped to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LIMITER,
  LIMITER_LOOKAHEAD_S,
  MASTER_RAMP_TAU_S,
  createMasterBus,
  dbToGain,
  limiterMakeupDb,
  masterBusLatencyS,
  masterInput,
  masterLevelDb,
  releaseMasterLevel,
  setMasterLevel,
} from '../master-bus'
import type { MontajWindow } from '../audio-context'

interface Call {
  fn: string
  args: unknown[]
}

class FakeParam {
  value = 0
  calls: Call[] = []
  setTargetAtTime(...args: unknown[]) {
    this.calls.push({ fn: 'setTargetAtTime', args })
    return this
  }
  setValueAtTime(...args: unknown[]) {
    this.calls.push({ fn: 'setValueAtTime', args })
    return this
  }
  linearRampToValueAtTime(...args: unknown[]) {
    this.calls.push({ fn: 'linearRampToValueAtTime', args })
    return this
  }
  cancelScheduledValues(...args: unknown[]) {
    this.calls.push({ fn: 'cancelScheduledValues', args })
    return this
  }
}

class FakeNode {
  readonly outs: FakeNode[] = []
  constructor(readonly kind: string) {}
  connect(to: FakeNode) {
    this.outs.push(to)
    return to
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
  constructor() {
    super('gain')
    this.gain.value = 1
  }
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam()
  knee = new FakeParam()
  ratio = new FakeParam()
  attack = new FakeParam()
  release = new FakeParam()
  constructor() {
    super('compressor')
  }
}

function fakeContext(currentTime = 12) {
  const destination = new FakeNode('destination')
  const made = { gains: [] as FakeGain[], compressors: [] as FakeCompressor[] }
  const ctx = {
    currentTime,
    destination,
    createGain: () => {
      const g = new FakeGain()
      made.gains.push(g)
      return g
    },
    createDynamicsCompressor: () => {
      const c = new FakeCompressor()
      made.compressors.push(c)
      return c
    },
  }
  return { ctx, destination, made }
}

const asCtx = (c: unknown) => c as Parameters<typeof createMasterBus>[0]

afterEach(() => {
  delete (window as Window & MontajWindow).__montajSharedCtx
})

describe('the chain', () => {
  it('runs input gain, limiter, trim, destination, in that order', () => {
    const { ctx, destination, made } = fakeContext()
    const bus = createMasterBus(asCtx(ctx))
    const [gain, trim] = made.gains
    const [limiter] = made.compressors
    expect(bus.input).toBe(gain)
    expect(gain.outs).toEqual([limiter])
    expect(limiter.outs).toEqual([trim])
    expect(trim.outs).toEqual([destination])
  })

  it('sets the limiter as a hard, fast ceiling just under the export\'s -1 dBTP', () => {
    const { ctx, made } = fakeContext()
    createMasterBus(asCtx(ctx))
    const [limiter] = made.compressors
    expect(limiter.threshold.value).toBe(-1.5)
    expect(limiter.knee.value).toBe(0)
    expect(limiter.ratio.value).toBe(20)
    expect(limiter.attack.value).toBeLessThanOrEqual(0.003)
    expect(limiter.release.value).toBeGreaterThan(0)
    expect(limiter.release.value).toBeLessThanOrEqual(0.25)
    expect(LIMITER).toEqual({
      thresholdDb: limiter.threshold.value,
      kneeDb: limiter.knee.value,
      ratio: limiter.ratio.value,
      attackS: limiter.attack.value,
      releaseS: limiter.release.value,
    })
  })

  it('trims off the compressor\'s automatic makeup gain, so a level under the ceiling passes unchanged', () => {
    // Web Audio: makeup = (1 / gain at 0 dBFS)^0.6. Hard knee: 0 dBFS comes out
    // at threshold * (1 - 1/ratio) = -1.425 dB, so makeup is +0.855 dB.
    expect(limiterMakeupDb()).toBeCloseTo(0.855, 3)
    const { ctx, made } = fakeContext()
    createMasterBus(asCtx(ctx))
    const trim = made.gains[1]
    expect(trim.gain.value).toBeCloseTo(dbToGain(-0.855), 6)
  })

  it('starts at the level asked for, set outright before anything plays through it', () => {
    const { ctx, made } = fakeContext()
    createMasterBus(asCtx(ctx), 6)
    expect(made.gains[0].gain.value).toBeCloseTo(dbToGain(6), 9)
    expect(made.gains[0].gain.calls).toEqual([])
  })
})

describe('a new level', () => {
  it('ramps with setTargetAtTime from now, with a time constant that settles in about a second', () => {
    const { ctx, made } = fakeContext(12)
    const bus = createMasterBus(asCtx(ctx))
    bus.setGainDb(9)
    const gain = made.gains[0].gain
    expect(gain.calls).toEqual([{ fn: 'setTargetAtTime', args: [dbToGain(9), 12, MASTER_RAMP_TAU_S] }])
    // 95% of the way in 3 time constants: between half a second and a second.
    expect(3 * MASTER_RAMP_TAU_S).toBeGreaterThanOrEqual(0.5)
    expect(3 * MASTER_RAMP_TAU_S).toBeLessThanOrEqual(1)
  })

  it('never jumps: no setValueAtTime, no cancel, and the same level twice schedules nothing', () => {
    const { ctx, made } = fakeContext()
    const bus = createMasterBus(asCtx(ctx))
    bus.setGainDb(4)
    bus.setGainDb(4)
    bus.setGainDb(-3)
    const fns = made.gains[0].gain.calls.map((c) => c.fn)
    expect(fns).toEqual(['setTargetAtTime', 'setTargetAtTime'])
  })
})

describe('the page\'s bus', () => {
  it('masterInput gives one bus per context, at the current level', () => {
    const { ctx, made } = fakeContext()
    ;(window as Window & MontajWindow).__montajSharedCtx = ctx as unknown as AudioContext
    const owner = {}
    setMasterLevel(owner, 5)
    const a = masterInput(asCtx(ctx))
    const b = masterInput(asCtx(ctx))
    expect(a).toBe(b)
    expect(made.gains[0].gain.value).toBeCloseTo(dbToGain(5), 9)
    releaseMasterLevel(owner)
  })

  it('setMasterLevel ramps the shared context\'s bus; release by its owner returns it to 0 dB', () => {
    const { ctx, made } = fakeContext()
    ;(window as Window & MontajWindow).__montajSharedCtx = ctx as unknown as AudioContext
    masterInput(asCtx(ctx))
    const owner = {}
    setMasterLevel(owner, 7)
    expect(masterLevelDb()).toBe(7)
    releaseMasterLevel({}) // not the owner: nothing changes
    expect(masterLevelDb()).toBe(7)
    releaseMasterLevel(owner)
    expect(masterLevelDb()).toBe(0)
    expect(made.gains[0].gain.calls.map((c) => c.args[0])).toEqual([dbToGain(7), 1])
  })

  it('a context without a compressor plays straight to its destination', () => {
    const destination = new FakeNode('destination')
    const createGain = vi.fn()
    expect(masterInput(asCtx({ currentTime: 0, destination, createGain }))).toBe(destination)
    expect(createGain).not.toHaveBeenCalled()
  })
})

describe('the limiter\'s look-ahead', () => {
  it('is the compressor\'s fixed 6 ms, reported for a context only once its bus is in the path', () => {
    expect(LIMITER_LOOKAHEAD_S).toBe(0.006)
    const { ctx } = fakeContext()
    expect(masterBusLatencyS(ctx)).toBe(0)
    masterInput(asCtx(ctx))
    expect(masterBusLatencyS(ctx)).toBe(LIMITER_LOOKAHEAD_S)
    expect(masterBusLatencyS(null)).toBe(0)
  })

  it('is never reported for a context that plays straight to its destination', () => {
    const ctx = { currentTime: 0, destination: new FakeNode('destination') }
    masterInput(asCtx(ctx))
    expect(masterBusLatencyS(ctx)).toBe(0)
  })
})

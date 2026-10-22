import { describe, it, expect, beforeEach, vi } from 'vitest'
import { subscribeProjectStream, _resetProjectStreamForTests } from '../sse'

// §482 U-1: serve sends a guarded save's frame as a named `writer` event
// (`<writer class>[;origin=<origin>]`) immediately followed by the project frame.
// The pool hands that stamp to the frame listeners with the very next project
// frame, and with no other: a stamp whose frame never came (the connection
// dropped, the frame was malformed) must not reach a later frame.

type Listener = (e: { data: string }) => void

// EventSource fake that dispatches as the real one does: an unnamed event reaches
// `onmessage` (and 'message' listeners) only; a named event reaches only the
// listeners registered for its name.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onmessage: Listener | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  private listeners = new Map<string, Listener[]>()
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() { this.closed = true }
  dispatch(type: string, data = '') {
    if (type === 'message') this.onmessage?.({ data })
    if (type === 'error') this.onerror?.()
    if (type === 'open') this.onopen?.()
    for (const fn of this.listeners.get(type) ?? []) fn({ data })
  }
}

const es = () => FakeEventSource.instances[0]
const project = (name: string) => JSON.stringify({ id: 'p1', name })

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  _resetProjectStreamForTests()
})

function record() {
  const seen: Array<[unknown, unknown]> = []
  subscribeProjectStream('p1', { onFrame: (p, stamp) => seen.push([p.name, stamp]) })
  return seen
}

describe('subscribeProjectStream: writer stamps (§482)', () => {
  it('a stamp reaches every frame listener with the next project frame only', () => {
    const seen = record()
    const other = vi.fn()
    subscribeProjectStream('p1', { onFrame: other })
    es().dispatch('writer', 'tool;origin=sync')
    es().dispatch('message', project('pulled'))
    es().dispatch('message', project('later'))
    expect(seen).toEqual([['pulled', { writer: 'tool', origin: 'sync' }], ['later', undefined]])
    expect(other.mock.calls[0][1]).toEqual({ writer: 'tool', origin: 'sync' })
    expect(other.mock.calls[1][1]).toBeUndefined()
  })

  it('a frame with no stamp before it carries none', () => {
    const seen = record()
    es().dispatch('message', project('plain'))
    expect(seen).toEqual([['plain', undefined]])
  })

  it.each([
    ['editor', { writer: 'editor' }],
    ['tool;origin=sync', { writer: 'tool', origin: 'sync' }],
    ['tool;later=1;origin=sync', { writer: 'tool', origin: 'sync' }],
    ['ai;origin=', { writer: 'ai' }],
  ])('parses %j', (data, stamp) => {
    const seen = record()
    es().dispatch('writer', data)
    es().dispatch('message', project('x'))
    expect(seen).toEqual([['x', stamp]])
  })

  it('an empty stamp is no stamp', () => {
    const seen = record()
    es().dispatch('writer', '')
    es().dispatch('message', project('x'))
    expect(seen).toEqual([['x', undefined]])
  })

  it.each(['error', 'open'])('a stamp left dangling by a connection %s never reaches a later frame', (event) => {
    const seen = record()
    es().dispatch('writer', 'tool;origin=sync')
    es().dispatch(event)
    es().dispatch('message', project('after reconnect'))
    expect(seen).toEqual([['after reconnect', undefined]])
  })

  it('a stamp is spent on a malformed frame, never carried to the next', () => {
    const seen = record()
    es().dispatch('writer', 'tool;origin=sync')
    es().dispatch('message', '{not json')
    es().dispatch('message', project('next'))
    expect(seen).toEqual([['next', undefined]])
  })

  it('a writer event reaches no frame or log listener by itself, and a log event leaves the stamp for its frame', () => {
    const onFrame = vi.fn()
    const onLog = vi.fn()
    subscribeProjectStream('p1', { onFrame, onLog })
    es().dispatch('writer', 'tool;origin=sync')
    expect(onFrame).not.toHaveBeenCalled()
    expect(onLog).not.toHaveBeenCalled()
    es().dispatch('log', JSON.stringify({ message: 'working' }))
    es().dispatch('message', project('pulled'))
    expect(onLog).toHaveBeenCalledWith('working')
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame.mock.calls[0][1]).toEqual({ writer: 'tool', origin: 'sync' })
  })
})

// §482 U-1 FIX 1: a teammate's pull that lands while the stream is down is stamped
// to no listener, so the first frame on the reopened connection (serve's current
// state, unstamped) may carry it. The pool marks that one frame `{ gap: true }` so
// the editor core can treat it as possibly a pull. The mark is separate from the
// writer stamp: a gap never becomes a stamp and a stamp never becomes a gap.
describe('subscribeProjectStream: the first frame after a reconnect is marked as a gap (§482)', () => {
  function recordInfo() {
    const seen: Array<[unknown, unknown, unknown]> = []
    subscribeProjectStream('p1', { onFrame: (p, stamp, info) => seen.push([p.name, stamp, info]) })
    return seen
  }

  it('frames on the first connection carry no gap', () => {
    const seen = recordInfo()
    es().dispatch('open')
    es().dispatch('message', project('initial'))
    es().dispatch('message', project('later'))
    expect(seen).toEqual([['initial', undefined, undefined], ['later', undefined, undefined]])
  })

  it('after an error and a reopen, the first frame carries gap and the next does not', () => {
    const seen = recordInfo()
    es().dispatch('open')
    es().dispatch('message', project('initial'))
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('message', project('reconnect'))
    es().dispatch('message', project('later'))
    expect(seen).toEqual([
      ['initial', undefined, undefined],
      ['reconnect', undefined, { gap: true }],
      ['later', undefined, undefined],
    ])
  })

  it('every frame listener sees the gap on that frame', () => {
    const seen = recordInfo()
    const other = vi.fn()
    subscribeProjectStream('p1', { onFrame: other })
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('message', project('reconnect'))
    expect(seen).toEqual([['reconnect', undefined, { gap: true }]])
    expect(other.mock.calls[0][2]).toEqual({ gap: true })
  })

  it('two drops before a frame give one gap frame', () => {
    const seen = recordInfo()
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('message', project('reconnect'))
    es().dispatch('message', project('later'))
    expect(seen).toEqual([['reconnect', undefined, { gap: true }], ['later', undefined, undefined]])
  })

  it('a reopen with no error before it is no gap', () => {
    const seen = recordInfo()
    es().dispatch('open')
    es().dispatch('open')
    es().dispatch('message', project('x'))
    expect(seen).toEqual([['x', undefined, undefined]])
  })

  it('a malformed first frame does not spend the gap: frames were missed before the next good one too', () => {
    const seen = recordInfo()
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('message', '{not json')
    es().dispatch('message', project('next'))
    es().dispatch('message', project('later'))
    expect(seen).toEqual([['next', undefined, { gap: true }], ['later', undefined, undefined]])
  })

  it('a gap is never a stamp: the gap frame carries the stamp it came with, and none is invented', () => {
    const seen = recordInfo()
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('writer', 'ai')
    es().dispatch('message', project('stamped reconnect'))
    es().dispatch('error')
    es().dispatch('open')
    es().dispatch('message', project('plain reconnect'))
    expect(seen).toEqual([
      ['stamped reconnect', { writer: 'ai' }, { gap: true }],
      ['plain reconnect', undefined, { gap: true }],
    ])
  })
})

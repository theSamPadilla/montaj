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

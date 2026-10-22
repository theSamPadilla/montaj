import { describe, it, expect, vi } from 'vitest'

// §482 U-1: the editor core decides from a frame's writer stamp whether a reload
// prunes its undo history, so the adapter's `subscribe` must hand the stamp from
// the SSE pool to the core unchanged, with the frame it belongs to.

const { subscribeProjectStream } = vi.hoisted(() => ({
  subscribeProjectStream: vi.fn((_id: string, _handlers: { onFrame?: (...args: unknown[]) => void }) => () => {}),
}))

vi.mock('@/lib/api', () => ({ api: {}, fileUrl: (p: string) => p }))
vi.mock('@/lib/overlay-eval', () => ({ compileOverlay: vi.fn(), clearOverlayCache: vi.fn() }))
vi.mock('@/lib/file-watch', () => ({ watchWorkspaceFile: vi.fn(() => () => {}) }))
vi.mock('@/lib/sse', () => ({ subscribeProjectStream }))

import { createMontajAdapter } from '../montajAdapter'

describe('montajAdapter.subscribe', () => {
  it('passes each frame and its writer stamp to the editor core', () => {
    const onFrame = vi.fn()
    createMontajAdapter().subscribe('p1', onFrame)
    const handlers = subscribeProjectStream.mock.calls[0][1]
    const frame = { id: 'p1', name: 'pulled' }
    handlers.onFrame?.(frame, { writer: 'tool', origin: 'sync' })
    handlers.onFrame?.(frame)
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(onFrame.mock.calls[0]).toEqual([frame, { writer: 'tool', origin: 'sync' }])
    expect(onFrame.mock.calls[1][0]).toBe(frame)
    expect(onFrame.mock.calls[1][1]).toBeUndefined()
  })
})

describe('montajAdapter.subscribe: the gap mark (§482 U-1 FIX 1)', () => {
  it('passes the pool\'s gap mark to the editor core with its frame, and no mark when there is none', () => {
    const onFrame = vi.fn()
    subscribeProjectStream.mockClear()
    createMontajAdapter().subscribe('p1', onFrame)
    const handlers = subscribeProjectStream.mock.calls[0][1]
    const frame = { id: 'p1', name: 'reconnect' }
    handlers.onFrame?.(frame, undefined, { gap: true })
    handlers.onFrame?.(frame)
    expect(onFrame.mock.calls[0]).toEqual([frame, undefined, { gap: true }])
    expect(onFrame.mock.calls[1][2]).toBeUndefined()
  })
})

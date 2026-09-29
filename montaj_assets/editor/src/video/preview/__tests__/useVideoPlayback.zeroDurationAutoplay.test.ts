/**
 * Repro: a pending project's init placeholders (tracks[0] video items with
 * start = end = 0 and no outPoint, project/init.py) must never start playback.
 *
 * Chromium 140 (Electron 38.8.6) queues a `timeupdate` on EVERY src
 * reassignment of an element that already had one (InvokeLoadAlgorithm step
 * 4.8, unconditional at 140.0.7339.249). PreviewPlayer routes the active slot's
 * `timeupdate` into `handleTimeUpdate`. So an agent write that changes clip
 * identity (proxySrc arriving, src normalized) -> clip-identity effect reloads
 * slot 0 -> timeupdate -> handleTimeUpdate, with nobody having pressed play.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

let playCalls: HTMLMediaElement[] = []
let playImpl: (el: HTMLMediaElement) => Promise<void> = () => Promise.resolve()

Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get(this: HTMLMediaElement & { __paused?: boolean }) { return this.__paused !== false },
})
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement & { __paused?: boolean }) {
  playCalls.push(this)
  this.__paused = false
  return playImpl(this)
}
HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = true
}

function fakeVideo(): HTMLVideoElement {
  const el = document.createElement('video')
  let t = 0
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => { t = v }, configurable: true })
  // Pre-wired gain so ensureVideoGain never needs a real AudioContext (jsdom has none).
  ;(el as unknown as { __montajGain: unknown }).__montajGain = { gain: { value: 1 } }
  return el
}

// Exactly init.py's placeholder shape.
const placeholder = (i: number, src: string): VisualItem =>
  ({ id: `clip-${i}`, type: 'video', src, start: 0, end: 0 }) as VisualItem

function pendingProject(items: VisualItem[]): EditorProject {
  return { id: 'p', status: 'pending', settings: { resolution: [1080, 1920] }, tracks: [{ id: 'trk-0', items }] } as unknown as EditorProject
}

function mount(project: EditorProject) {
  const h = renderHook(
    ({ p }: { p: EditorProject }) => useVideoPlayback(p, 0, () => {}, (path) => path),
    { initialProps: { p: project } },
  )
  const v0 = fakeVideo()
  const v1 = fakeVideo()
  h.result.current.video0Ref.current = v0
  h.result.current.video1Ref.current = v1
  h.rerender({ p: { ...project } })
  return { ...h, v0, v1 }
}

beforeEach(() => {
  playCalls = []
  playImpl = () => Promise.resolve()
})

describe('pending placeholders never autoplay', () => {
  it('a paused timeupdate on the active slot (agent write reloads slot 0) does not call play()', () => {
    const items = [placeholder(0, '/w/clip_0.mp4'), placeholder(1, '/w/clip_1.mp4')]
    const h = mount(pendingProject(items))
    // Agent write: clip identity changes (here src -> normalized path).
    h.rerender({ p: pendingProject([placeholder(0, '/w/clip_0.norm.mp4'), placeholder(1, '/w/clip_1.norm.mp4')]) })
    playCalls = []
    // What PreviewPlayer's slot-0 onTimeUpdate does for the reload's timeupdate.
    h.result.current.handleTimeUpdate()
    expect(playCalls).toEqual([])
    expect(h.v0.paused && h.v1.paused).toBe(true)
  })

  it('a rejected play() never replays later on a slot that is no longer active', async () => {
    const items = [placeholder(0, '/w/a.mp4'), placeholder(1, '/w/b.mp4'), placeholder(2, '/w/c.mp4')]
    const h = mount(pendingProject(items))
    h.rerender({ p: pendingProject(items.map((c) => ({ ...c, src: `${c.src}?v2` }))) })
    // First play() is interrupted (pause() or a new load before data): AbortError.
    playImpl = () => Promise.reject(new DOMException('interrupted', 'AbortError'))
    h.result.current.handleTimeUpdate() // reload timeupdate on slot 0
    h.result.current.handleTimeUpdate() // next rAF pump / timeupdate on the new active slot
    await Promise.resolve(); await Promise.resolve()
    playImpl = () => Promise.resolve()
    playCalls = []
    // Media finishes loading on each slot.
    h.v0.dispatchEvent(new Event('canplay'))
    h.v1.dispatchEvent(new Event('canplay'))
    const active = h.result.current.activeSlotRef.current === 0 ? h.v0 : h.v1
    const stray = playCalls.filter((el) => el !== active)
    expect(stray).toEqual([])
    expect(playCalls).toEqual([])
  })
})

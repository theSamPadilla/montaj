import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { probeVideoDuration, PROBE_TIMEOUT_MS } from '../videoDuration'

// jsdom implements neither media loading (`<video>.src = url` never fires
// `loadedmetadata`/`error` on its own) nor `URL.createObjectURL` — see
// montaj_assets/editor/src/engine/frame-server.ts's own comment on the same
// gap. So this harness stubs both: `createObjectURL`/`revokeObjectURL` as
// plain spies, and `document.createElement('video')` intercepted so each
// test can reach into the real (jsdom) <video> element it produced and fire
// the DOM events by hand.

let created: HTMLVideoElement[]
let revoked: string[]
let realCreateElement: typeof document.createElement
let realCreateObjectURL: typeof URL.createObjectURL
let realRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  created = []
  revoked = []
  realCreateObjectURL = URL.createObjectURL
  realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name ?? 'blob'}`)
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url) })

  realCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) => {
    const el = realCreateElement(tag, opts)
    if (tag === 'video') created.push(el as HTMLVideoElement)
    return el
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

function videoFile(name = 'clip.mp4'): File {
  return new File(['x'], name, { type: 'video/mp4' })
}

describe('probeVideoDuration', () => {
  it('resolves with the metadata duration and revokes the object URL', async () => {
    const promise = probeVideoDuration(videoFile('a.mp4'))
    await Promise.resolve() // let the executor run and create the <video>
    const video = created[0]
    Object.defineProperty(video, 'duration', { value: 12.5, configurable: true })
    video.dispatchEvent(new Event('loadedmetadata'))

    await expect(promise).resolves.toBe(12.5)
    expect(revoked).toEqual(['blob:a.mp4'])
  })

  it('rejects (and still revokes) when the reported duration is non-finite', async () => {
    const promise = probeVideoDuration(videoFile('b.mp4'))
    await Promise.resolve()
    const video = created[0]
    Object.defineProperty(video, 'duration', { value: NaN, configurable: true })
    video.dispatchEvent(new Event('loadedmetadata'))

    await expect(promise).rejects.toThrow(/duration/i)
    expect(revoked).toEqual(['blob:b.mp4'])
  })

  it('rejects (and still revokes) when the reported duration is zero or negative', async () => {
    const promise = probeVideoDuration(videoFile('c.mp4'))
    await Promise.resolve()
    const video = created[0]
    Object.defineProperty(video, 'duration', { value: 0, configurable: true })
    video.dispatchEvent(new Event('loadedmetadata'))

    await expect(promise).rejects.toThrow()
    expect(revoked).toEqual(['blob:c.mp4'])
  })

  it('rejects (and still revokes) on a media error event', async () => {
    const promise = probeVideoDuration(videoFile('d.mp4'))
    await Promise.resolve()
    created[0].dispatchEvent(new Event('error'))

    await expect(promise).rejects.toThrow(/probe/i)
    expect(revoked).toEqual(['blob:d.mp4'])
  })

  it('rejects (and still revokes) if metadata never arrives within the timeout', async () => {
    vi.useFakeTimers()
    const promise = probeVideoDuration(videoFile('e.mp4'))
    const assertion = expect(promise).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await assertion
    expect(revoked).toEqual(['blob:e.mp4'])
  })

  it('never resolves or rejects twice, and only revokes once, if both events somehow fire', async () => {
    const promise = probeVideoDuration(videoFile('f.mp4'))
    await Promise.resolve()
    const video = created[0]
    Object.defineProperty(video, 'duration', { value: 3, configurable: true })
    video.dispatchEvent(new Event('loadedmetadata'))
    video.dispatchEvent(new Event('error')) // must be a no-op — already settled

    await expect(promise).resolves.toBe(3)
    expect(revoked).toEqual(['blob:f.mp4']) // exactly once, not twice
  })
})

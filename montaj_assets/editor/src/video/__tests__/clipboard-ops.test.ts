import { describe, it, expect } from 'vitest'
import { copySelection, pasteAt, duplicateSelection, pasteAttributes } from '../clipboard-ops'
import type { EditorProject as Project, VisualItem, VisualTrack, AudioTrack } from '../../schema'

/** Object-shape visual tracks, carrying the ids `normalizeTracks` would hand
 *  out — mirrors `cuts.test.ts`'s `vtracks` helper. */
function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

// Minimal project factory — only the fields the clipboard ops touch.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

describe('copySelection', () => {
  it('returns null for an empty selection', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(copySelection(p, [])).toBeNull()
  })

  it('returns null when selectedIds names only caption ids', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]),
      captions: { style: 'subtitle', segments: [{ id: 'c1', text: 'hi', start: 0, end: 1 }] },
    })
    expect(copySelection(p, ['c1'])).toBeNull()
  })

  it('captures visual items with their source track id, deep-cloned', () => {
    const item: VisualItem = { id: 'a', type: 'video', start: 0, end: 5, inPoint: 0, outPoint: 5 }
    const p = makeProject({ tracks: vtracks([item]) })
    const payload = copySelection(p, ['a'])
    expect(payload).not.toBeNull()
    expect(payload!.items).toEqual([{ item, sourceTrackId: 'trk-0' }])
    expect(payload!.items[0].item).not.toBe(item) // deep clone, not the same reference
  })

  it('captures audio tracks, deep-cloned', () => {
    const track: AudioTrack = { id: 'aud1', src: 'x.mp3', start: 0, end: 5 }
    const p = makeProject({ audio: { tracks: [track] } })
    const payload = copySelection(p, ['aud1'])
    expect(payload!.audioTracks).toEqual([track])
    expect(payload!.audioTracks[0]).not.toBe(track)
  })

  it('drops caption ids from a mixed selection, keeping only the visual item', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]),
      captions: { style: 'subtitle', segments: [{ id: 'c1', text: 'hi', start: 0, end: 1 }] },
    })
    const payload = copySelection(p, ['a', 'c1'])!
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].item.id).toBe('a')
    expect(payload.audioTracks).toHaveLength(0)
  })
})

describe('pasteAt', () => {
  it('returns the same project reference for a null payload', () => {
    const p = makeProject()
    expect(pasteAt(p, null, 5)).toBe(p)
  })

  it('returns the same project reference for an empty payload', () => {
    const p = makeProject()
    expect(pasteAt(p, { items: [], audioTracks: [] }, 5)).toBe(p)
  })

  it('pastes a single item verbatim at the anchor with a fresh id', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5, inPoint: 2, outPoint: 7, volume: 0.5 },
      ]),
    })
    const payload = copySelection(p, ['a'])!
    const out = pasteAt(p, payload, 20)
    const items = out.tracks![0].items
    expect(items).toHaveLength(2)
    const pasted = items.find(i => i.id !== 'a')!
    expect(pasted.id).not.toBe('a')
    expect(pasted).toMatchObject({ type: 'video', start: 20, end: 25, inPoint: 2, outPoint: 7, volume: 0.5 })
  })

  it('preserves relative offsets across multiple pasted items, earliest at the anchor', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 10, end: 12 },
      ]),
    })
    const payload = copySelection(p, ['a', 'b'])!
    const out = pasteAt(p, payload, 100)
    const items = out.tracks![0].items
    expect(items.some(i => i.id !== 'a' && i.id !== 'b' && i.start === 100 && i.end === 105)).toBe(true)
    expect(items.some(i => i.id !== 'a' && i.id !== 'b' && i.start === 110 && i.end === 112)).toBe(true)
  })

  it('lands back on the source track when it still exists', () => {
    const p = makeProject({
      tracks: vtracks(
        [{ id: 'a', type: 'video', start: 0, end: 5 }],
        [{ id: 'b', type: 'overlay', start: 0, end: 5 }],
      ),
    })
    const payload = copySelection(p, ['b'])!
    const out = pasteAt(p, payload, 20)
    expect(out.tracks![0].items).toHaveLength(1) // track 0 untouched
    expect(out.tracks![1].items).toHaveLength(2) // pasted back onto trk-1
  })

  it('falls back to track 0 when the source track no longer exists', () => {
    const item: VisualItem = { id: 'a', type: 'video', start: 0, end: 5 }
    const source = makeProject({ tracks: vtracks([], [item]) })
    const payload = copySelection(source, ['a'])!
    expect(payload.items[0].sourceTrackId).toBe('trk-1')

    // Paste into a DIFFERENT project that has no trk-1 at all.
    const target = makeProject({ tracks: vtracks([{ id: 'x', type: 'video', start: 0, end: 3 }]) })
    const out = pasteAt(target, payload, 50)
    expect(out.tracks).toHaveLength(1)
    const ids = out.tracks![0].items.map(i => i.id)
    expect(ids).toContain('x')
    expect(out.tracks![0].items).toHaveLength(2)
  })

  it('shifts right to the earliest gap that fits when the target span collides', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'blocker', type: 'video', start: 10, end: 13 },
      ]),
    })
    const payload = copySelection(p, ['a'])! // duration 5
    const out = pasteAt(p, payload, 10) // collides with blocker (10-13)
    const pasted = out.tracks![0].items.find(i => i.id !== 'a' && i.id !== 'blocker')!
    expect(pasted.start).toBe(13) // earliest fitting gap: blocker's end
    expect(pasted.end).toBe(18)
  })

  it('clones an audio track verbatim with a fresh id, shifted to the anchor', () => {
    const track: AudioTrack = { id: 'aud1', src: 'x.mp3', start: 0, end: 4, volume: 0.8, muted: true }
    const p = makeProject({ audio: { tracks: [track] } })
    const payload = copySelection(p, ['aud1'])!
    const out = pasteAt(p, payload, 30)
    const pasted = out.audio!.tracks.find(t => t.id !== 'aud1')!
    expect(pasted).toMatchObject({ src: 'x.mp3', start: 30, end: 34, volume: 0.8, muted: true })
    expect(pasted.id).not.toBe('aud1')
  })

  it('preserves the original relative offset between a visual item and an audio track pasted together, earliest landing exactly on the anchor', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]),
      audio: { tracks: [{ id: 'aud1', src: 'x.mp3', start: 20, end: 23 }] }, // 20s gap from the visual item
    })
    const payload = copySelection(p, ['a', 'aud1'])!
    const out = pasteAt(p, payload, 100)

    const pastedVisual = out.tracks![0].items.find(i => i.id !== 'a')!
    const pastedAudio = out.audio!.tracks.find(t => t.id !== 'aud1')!

    expect(pastedVisual.start).toBe(100)                 // earliest member lands exactly on the anchor
    expect(pastedAudio.start).toBe(120)                  // later member keeps its original 20s offset from the anchor
    expect(pastedAudio.end - pastedAudio.start).toBe(3)  // duration preserved
  })
})

describe('duplicateSelection', () => {
  it('returns the same project reference for an empty selection', () => {
    const p = makeProject()
    expect(duplicateSelection(p, [])).toBe(p)
  })

  it('returns the same project reference when selectedIds names only captions', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]),
      captions: { style: 'subtitle', segments: [{ id: 'c1', text: 'hi', start: 0, end: 1 }] },
    })
    expect(duplicateSelection(p, ['c1'])).toBe(p)
  })

  it('duplicates a visual item verbatim at its own end', () => {
    const p = makeProject({
      tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5, inPoint: 0, outPoint: 5 }]),
    })
    const out = duplicateSelection(p, ['a'])
    const items = out.tracks![0].items
    expect(items).toHaveLength(2)
    const dup = items.find(i => i.id !== 'a')!
    expect(dup).toMatchObject({ type: 'video', start: 5, end: 10, inPoint: 0, outPoint: 5 })
    expect(dup.id).not.toBe('a')
  })

  it('gap-resolves a duplicate that collides with a following clip', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 5 },
        { id: 'b', type: 'video', start: 5, end: 10 },
      ]),
    })
    const out = duplicateSelection(p, ['a'])
    const dup = out.tracks![0].items.find(i => i.id !== 'a' && i.id !== 'b')!
    expect(dup.start).toBe(10) // shifted past 'b'
    expect(dup.end).toBe(15)
  })

  it('duplicates an audio track verbatim at its own end', () => {
    const track: AudioTrack = { id: 'aud1', src: 'x.mp3', start: 0, end: 4, volume: 0.6 }
    const p = makeProject({ audio: { tracks: [track] } })
    const out = duplicateSelection(p, ['aud1'])
    const dup = out.audio!.tracks.find(t => t.id !== 'aud1')!
    expect(dup).toMatchObject({ src: 'x.mp3', start: 4, end: 8, volume: 0.6 })
  })

  it('mints fresh, unique ids for every duplicated item, colliding with nothing', () => {
    const p = makeProject({
      tracks: vtracks([
        { id: 'a', type: 'video', start: 0, end: 2 },
        { id: 'b', type: 'video', start: 2, end: 4 },
        { id: 'c', type: 'video', start: 4, end: 6 },
      ]),
    })
    const out = duplicateSelection(p, ['a', 'b', 'c'])
    const ids = out.tracks![0].items.map(i => i.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })
})

describe('pasteAttributes', () => {
  it('returns the same project reference for an empty selection', () => {
    const p = makeProject()
    expect(pasteAttributes(p, { items: [], audioTracks: [] }, [])).toBe(p)
  })

  it('returns the same project reference for a null payload', () => {
    const p = makeProject({ tracks: vtracks([{ id: 'a', type: 'video', start: 0, end: 5 }]) })
    expect(pasteAttributes(p, null, ['a'])).toBe(p)
  })

  it('returns the same project reference when selectedIds names only captions', () => {
    const source: VisualItem = { id: 's', type: 'video', start: 0, end: 5, offsetX: 10 }
    const p = makeProject({
      tracks: vtracks([source]),
      captions: { style: 'subtitle', segments: [{ id: 'c1', text: 'hi', start: 0, end: 1 }] },
    })
    const payload = copySelection(p, ['s'])!
    expect(pasteAttributes(p, payload, ['c1'])).toBe(p)
  })

  it('returns the same project reference when the gated patch is empty for every target', () => {
    // source carries only video-only fields; target is an overlay, which qualifies for none of them.
    const source: VisualItem = { id: 's', type: 'video', start: 0, end: 5, volume: 0.5, speed: 2, muted: true }
    const target: VisualItem = { id: 't', type: 'overlay', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    expect(pasteAttributes(p, payload, ['t'])).toBe(p)
  })

  it('transfers common look fields to every visual item type', () => {
    const source: VisualItem = {
      id: 's', type: 'video', start: 0, end: 5,
      offsetX: 10, offsetY: 20, scale: 1.5, opacity: 0.9, rotation: 45,
    }
    const target: VisualItem = { id: 't', type: 'overlay', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    const patched = out.tracks![0].items.find(i => i.id === 't')!
    expect(patched).toMatchObject({ offsetX: 10, offsetY: 20, scale: 1.5, opacity: 0.9, rotation: 45 })
  })

  it('never lands image-only `fit` on a video target', () => {
    const source: VisualItem = { id: 's', type: 'image', start: 0, end: 5, fit: 'contain' }
    const target: VisualItem = { id: 't', type: 'video', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    expect(out.tracks![0].items.find(i => i.id === 't')!.fit).toBeUndefined()
  })

  it('lands `fit` only on an image target', () => {
    const source: VisualItem = { id: 's', type: 'image', start: 0, end: 5, fit: 'contain' }
    const target: VisualItem = { id: 't', type: 'image', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    expect(out.tracks![0].items.find(i => i.id === 't')!.fit).toBe('contain')
  })

  it('never lands video-only `speed` on an image or overlay target', () => {
    const source: VisualItem = { id: 's', type: 'video', start: 0, end: 5, speed: 2 }
    const image: VisualItem = { id: 'img', type: 'image', start: 10, end: 15 }
    const overlay: VisualItem = { id: 'ov', type: 'overlay', start: 20, end: 25 }
    const p = makeProject({ tracks: vtracks([source, image, overlay]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['img', 'ov'])
    const items = out.tracks![0].items
    expect(items.find(i => i.id === 'img')!.speed).toBeUndefined()
    expect(items.find(i => i.id === 'ov')!.speed).toBeUndefined()
  })

  it('lands volume/muted/speed on a video target', () => {
    const source: VisualItem = { id: 's', type: 'video', start: 0, end: 5, volume: 0.4, muted: true, speed: 1.5 }
    const target: VisualItem = { id: 't', type: 'video', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    expect(out.tracks![0].items.find(i => i.id === 't')).toMatchObject({ volume: 0.4, muted: true, speed: 1.5 })
  })

  it('never transfers sourceCrop', () => {
    const source: VisualItem = {
      id: 's', type: 'video', start: 0, end: 5, sourceCrop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    }
    const target: VisualItem = { id: 't', type: 'video', start: 10, end: 15 }
    const p = makeProject({ tracks: vtracks([source, target]) })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    expect(out.tracks![0].items.find(i => i.id === 't')!.sourceCrop).toBeUndefined()
  })

  it('transfers audio look fields from the first copied audio track to selected audio targets', () => {
    const source: AudioTrack = {
      id: 's', src: 'a.mp3', start: 0, end: 5, volume: 0.3, muted: true, fadeIn: 1, fadeOut: 2,
    }
    const target: AudioTrack = { id: 't', src: 'b.mp3', start: 10, end: 15 }
    const p = makeProject({ audio: { tracks: [source, target] } })
    const payload = copySelection(p, ['s'])!
    const out = pasteAttributes(p, payload, ['t'])
    expect(out.audio!.tracks.find(t => t.id === 't')).toMatchObject({
      volume: 0.3, muted: true, fadeIn: 1, fadeOut: 2,
    })
  })
})

describe('verbatim clone (type + inPoint/outPoint survive copy/paste and duplicate)', () => {
  it('never coerces type to video, and preserves inPoint/outPoint on a trimmed clip, through both pasteAt and duplicateSelection', () => {
    // The reason `pasteAt`/`duplicateSelection` don't route through `insertClipAt`
    // (cuts.ts) is that it unconditionally mints a whole-source `type:'video'`
    // item, which would coerce an image/overlay's type and un-trim a video clip.
    // This pins the negative: none of that happens here.
    const image: VisualItem = { id: 'img', type: 'image', start: 0, end: 3, offsetX: 5 }
    const overlay: VisualItem = { id: 'ov', type: 'overlay', start: 3, end: 6, props: { text: 'hi' } }
    const trimmedVideo: VisualItem = { id: 'v', type: 'video', start: 6, end: 9, inPoint: 2, outPoint: 5 }
    const p = makeProject({ tracks: vtracks([image, overlay, trimmedVideo]) })
    const originalIds = new Set(['img', 'ov', 'v'])

    const payload = copySelection(p, ['img', 'ov', 'v'])!
    const pasted = pasteAt(p, payload, 100)
    const pastedItems = pasted.tracks![0].items.filter(i => !originalIds.has(i.id))
    expect(pastedItems.find(i => i.type === 'image')).toMatchObject({ type: 'image', offsetX: 5 })
    expect(pastedItems.find(i => i.type === 'overlay')).toMatchObject({ type: 'overlay', props: { text: 'hi' } })
    expect(pastedItems.find(i => i.type === 'video')).toMatchObject({ type: 'video', inPoint: 2, outPoint: 5 })

    const duplicated = duplicateSelection(p, ['img', 'ov', 'v'])
    const dupItems = duplicated.tracks![0].items.filter(i => !originalIds.has(i.id))
    expect(dupItems.find(i => i.type === 'image')).toMatchObject({ type: 'image', offsetX: 5 })
    expect(dupItems.find(i => i.type === 'overlay')).toMatchObject({ type: 'overlay', props: { text: 'hi' } })
    expect(dupItems.find(i => i.type === 'video')).toMatchObject({ type: 'video', inPoint: 2, outPoint: 5 })
  })
})

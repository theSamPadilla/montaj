import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ImageElement } from '../../types'
import { newImageElement } from '../newImage'
import { loadImageNaturalSize } from '../imageGeometry'

// ── newImageElement (§556 M7) ────────────────────────────────────────────────
//
// A new image element for a file already on the host: its size is read through
// the adapter's own URL for it, and the box is shaped like the image. jsdom
// never loads an image, so the loader is mocked; `placeImageBox` stays real.

vi.mock('../imageGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../imageGeometry')>()
  return { ...actual, loadImageNaturalSize: vi.fn() }
})
const loadSize = vi.mocked(loadImageNaturalSize)

const adapter = { resolveImageSrc: (el: ImageElement) => `url:${el.src}` }
const portrait: [number, number] = [1080, 1350]

beforeEach(() => {
  loadSize.mockResolvedValue({ width: 2000, height: 1000 })
})
afterEach(() => {
  loadSize.mockReset()
})

describe('newImageElement', () => {
  it('reads the size from the URL the adapter gives the new source, and shapes the box like the image', async () => {
    const el = await newImageElement(adapter, portrait, '/p/a.png')
    expect(loadSize).toHaveBeenCalledTimes(1)
    expect(loadSize).toHaveBeenCalledWith('url:/p/a.png')
    expect(el).toEqual({ id: expect.any(String), type: 'image', src: '/p/a.png', x: 108, y: 459, w: 864, h: 432, rotation: 0 })
  })

  it('hands the adapter an image element that carries the source and no media id', async () => {
    const seen: ImageElement[] = []
    await newImageElement({ resolveImageSrc: (el) => { seen.push(el); return el.src } }, portrait, '/p/a.png')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'image', src: '/p/a.png', rotation: 0 })
    expect('mediaId' in seen[0]).toBe(false)
  })

  it('centres on the point it is given', async () => {
    const el = await newImageElement(adapter, portrait, '/p/a.png', { x: 600, y: 700 })
    expect(el).toMatchObject({ x: 168, y: 484, w: 864, h: 432 })
  })

  it('is the old centred square when the size cannot be read', async () => {
    loadSize.mockResolvedValue(null)
    const el = await newImageElement(adapter, portrait, '/p/a.png')
    expect(el).toEqual({ id: expect.any(String), type: 'image', src: '/p/a.png', x: 108, y: 243, w: 864, h: 864, rotation: 0 })
  })

  it('is the old square when the adapter throws, and it never rejects', async () => {
    const el = await newImageElement({ resolveImageSrc: () => { throw new Error('no url') } }, portrait, '/p/a.png')
    expect(loadSize).not.toHaveBeenCalled()
    expect(el).toMatchObject({ x: 108, y: 243, w: 864, h: 864 })
  })

  it('has no crop and no media id, and each element its own id', async () => {
    const a = await newImageElement(adapter, portrait, '/p/a.png')
    const b = await newImageElement(adapter, portrait, '/p/a.png')
    expect('crop' in a).toBe(false)
    expect('mediaId' in a).toBe(false)
    expect(a.id).not.toBe(b.id)
  })
})

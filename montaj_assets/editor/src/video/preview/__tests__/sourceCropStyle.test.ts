import { describe, it, expect } from 'vitest'
import { sourceCropVideoStyle } from '../sourceCropStyle'

describe('sourceCropVideoStyle', () => {
  it('returns null for a full-frame (default) crop', () => {
    expect(
      sourceCropVideoStyle({
        crop: { x: 0, y: 0, w: 1, h: 1 },
        sourceWidth: 1920, sourceHeight: 1080,
        frameWidth: 1080, frameHeight: 1920,
      }),
    ).toBeNull()
  })

  it('returns null without source dims', () => {
    expect(
      sourceCropVideoStyle({
        crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
        sourceWidth: 0, sourceHeight: 0,
        frameWidth: 1080, frameHeight: 1920,
      }),
    ).toBeNull()
  })

  it('center vertical-strip crop of a landscape source fills a portrait frame', () => {
    // 1920x1080 source, crop the centre 50% width / full height → 960x1080 region
    // (aspect 0.888...). Portrait frame 1080x1920 (aspect 0.5625). Crop aspect >
    // frame aspect → crop fills frame WIDTH, letterboxed vertically.
    const style = sourceCropVideoStyle({
      crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
      sourceWidth: 1920, sourceHeight: 1080,
      frameWidth: 1080, frameHeight: 1920,
    })!
    expect(style).not.toBeNull()
    // videoWRatio = cropWRatio(1) / crop.w(0.5) = 2 → 200% wide
    expect(style.width).toBe('200%')
    // cropAspect = (1920*0.5)/(1080*1) = 0.8889; frameAspect = 0.5625
    // cropHRatio = frameAspect/cropAspect = 0.6328; videoHRatio = /h(1) = 0.6328
    expect(parseFloat(style.height as string)).toBeCloseTo(63.28, 1)
    // leftRatio = (1-1)/2 - 0.25*2 = -0.5 → -50%
    expect(style.left).toBe('-50%')
    // topRatio = (1-0.6328)/2 - 0*... = 0.1836 → ~18.36%
    expect(parseFloat(style.top as string)).toBeCloseTo(18.36, 1)
    expect(style.objectFit).toBe('fill')
  })

  it('crop region matching frame aspect fills the frame exactly (no letterbox)', () => {
    // Portrait source 1080x1920, crop a centred 9:16 sub-rect → same aspect as a
    // 1080x1920 frame. Should fill edge-to-edge.
    const style = sourceCropVideoStyle({
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      sourceWidth: 1080, sourceHeight: 1920,
      frameWidth: 1080, frameHeight: 1920,
    })!
    expect(style.width).toBe('125%')   // 1/0.8
    expect(style.height).toBe('125%')  // 1/0.8
    // left/top = (1-1)/2 - 0.1*1.25 = -0.125 → -12.5%
    expect(style.left).toBe('-12.5%')
    expect(style.top).toBe('-12.5%')
  })
})

import { sourceCropImageStyle } from '../sourceCropStyle'

describe('sourceCropImageStyle (PV55)', () => {
  const crop = { x: 0.5, y: 0, w: 0.25, h: 1 } // 500x1000 px of a 2000x1000 image: aspect 0.5
  const base = { crop, sourceWidth: 2000, sourceHeight: 1000, boxWidth: 1080, boxHeight: 1920 } // box aspect 0.5625

  it('no crop or the full frame: null (the caller keeps its plain <img>)', () => {
    expect(sourceCropImageStyle({ ...base, crop: { x: 0, y: 0, w: 1, h: 1 }, fit: 'cover' })).toBeNull()
    expect(sourceCropImageStyle({ ...base, crop: { x: 0, y: 0, w: 0, h: 1 }, fit: 'cover' })).toBeNull()
  })
  it('the image is placed so the crop region exactly fills the clip box', () => {
    expect(sourceCropImageStyle({ ...base, fit: 'cover' })!.img).toMatchObject({ left: '-200%', top: '0%', width: '400%', height: '100%', objectFit: 'fill' })
  })
  it('cover: a crop taller than the box overflows it vertically, centred', () => {
    expect(sourceCropImageStyle({ ...base, fit: 'cover' })!.clip).toMatchObject({ left: '0%', top: '-6.25%', width: '100%', height: '112.5%', overflow: 'hidden' })
  })
  it('contain: the same crop is letterboxed left and right', () => {
    const clip = sourceCropImageStyle({ ...base, fit: 'contain' })!.clip
    expect(parseFloat(clip.width as string)).toBeCloseTo(88.888888, 4)
    expect(parseFloat(clip.left as string)).toBeCloseTo(5.555555, 4)
  })
  it('fill: the crop stretches to the box and needs no size', () => {
    const s = sourceCropImageStyle({ ...base, sourceWidth: 0, sourceHeight: 0, fit: 'fill' })!
    expect(s.clip).toMatchObject({ left: '0%', top: '0%', width: '100%', height: '100%' })
    expect(s.ready).toBe(true)
  })
  it('cover/contain are not ready until the natural size is known', () => {
    expect(sourceCropImageStyle({ ...base, sourceWidth: 0, sourceHeight: 0, fit: 'cover' })!.ready).toBe(false)
  })
})

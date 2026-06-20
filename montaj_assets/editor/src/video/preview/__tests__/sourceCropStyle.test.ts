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

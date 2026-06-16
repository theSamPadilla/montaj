import { describe, it, expect } from 'vitest'
import type {
  EditorProject,
  ImageElement,
  OverlayElement,
  Slide,
} from '../schema'

// Compile-time assignability helper: if the argument doesn't satisfy T,
// this fails to type-check (and thus fails `tsc`/build, which vitest runs through).
function expectAssignable<T>(value: T): T {
  return value
}

describe('editor schema', () => {
  it('accepts an object with the editor-facing fields as EditorProject', () => {
    const project: EditorProject = {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1080], fps: 30 },
      name: 'My carousel',
      editingPrompt: 'make it pop',
      slides: [],
      captions: { style: 'subtitle', segments: [] },
      assets: [],
      carousel: { aspect: 'square' },
      profile: 'default',
    }
    expectAssignable<EditorProject>(project)
    expect(project.id).toBe('p1')
    expect(project.status).toBe('draft')
  })

  it('allows a minimal EditorProject (only required fields)', () => {
    const minimal: EditorProject = {
      id: 'p2',
      status: 'pending',
      settings: { resolution: [1920, 1080] },
    }
    // Index signature lets host-only fields pass through.
    minimal.hostOnlyField = { anything: true }
    expectAssignable<EditorProject>(minimal)
    expect(minimal.settings.resolution).toEqual([1920, 1080])
  })

  it('type-checks an ImageElement with and without a mediaId', () => {
    const withMedia: ImageElement = {
      id: 'img1',
      type: 'image',
      src: 'media://1',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotation: 0,
      mediaId: 'media-123',
    }
    const withoutMedia: ImageElement = {
      id: 'img2',
      type: 'image',
      src: 'https://example.com/a.png',
      x: 10,
      y: 10,
      w: 50,
      h: 50,
      rotation: 0,
    }
    expectAssignable<ImageElement>(withMedia)
    expectAssignable<ImageElement>(withoutMedia)
    expect(withMedia.mediaId).toBe('media-123')
    expect(withoutMedia.mediaId).toBeUndefined()
  })

  it('type-checks a Slide with mixed image + overlay elements', () => {
    const image: ImageElement = {
      id: 'img',
      type: 'image',
      src: 's',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
    }
    const overlay: OverlayElement = {
      id: 'ov',
      type: 'overlay',
      overlay: { template: 'title', props: { text: 'hi' } },
      frame: 0,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
    }
    const slide: Slide = {
      id: 's1',
      base_color: '#000000',
      elements: [image, overlay],
    }
    expectAssignable<Slide>(slide)
    expect(slide.elements).toHaveLength(2)
  })
})

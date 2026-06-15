import { describe, it, expect } from 'vitest'
import type {
  EditorAdapter,
  RenderEvent,
  RenderOptions,
  MediaItem,
  MediaScope,
} from '../types'
import type { Project, ImageElement } from '../types'
import { defaultMontajTheme, applyTheme } from '../theme'

// ── (a) A fake adapter literal must satisfy the EditorAdapter interface ──────
// This test is purely structural: it type-checks at build time. The runtime
// assertions below also exercise the methods to keep the fake honest.
function makeFakeAdapter(): EditorAdapter {
  const project: Project = {
    version: '1',
    id: 'p1',
    status: 'draft' as Project['status'],
    name: 'Fake',
    workflow: 'carousel',
    editingPrompt: '',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides: [],
  }

  return {
    loadProject: async (_id: string): Promise<Project> => project,
    saveProject: async (_id: string, _project: Project): Promise<void> => {},
    subscribe: (_id: string, _onFrame: (p: Project) => void): (() => void) => {
      return () => {}
    },
    render: async function* (
      _id: string,
      _opts?: RenderOptions,
    ): AsyncIterable<RenderEvent> {
      yield { type: 'log', message: 'starting' }
      yield { type: 'done', outputPath: '/out/p1.mp4' }
    },
    // (b) Montaj-style resolver: returns a workspace/files URL string.
    resolveImageSrc: (element: ImageElement): string =>
      `/api/files?path=${encodeURIComponent(element.src)}`,
    // Optional method present.
    listMedia: async (_scope: MediaScope): Promise<MediaItem[]> => [],
  }
}

describe('EditorAdapter', () => {
  it('a fake adapter literal satisfies the interface', () => {
    const adapter = makeFakeAdapter()
    expect(typeof adapter.loadProject).toBe('function')
    expect(typeof adapter.saveProject).toBe('function')
    expect(typeof adapter.subscribe).toBe('function')
    expect(typeof adapter.render).toBe('function')
    expect(typeof adapter.resolveImageSrc).toBe('function')
  })

  it('subscribe returns an unsubscribe function', () => {
    const adapter = makeFakeAdapter()
    const unsub = adapter.subscribe('p1', () => {})
    expect(typeof unsub).toBe('function')
    // Calling it must not throw.
    unsub()
  })

  it('loadProject resolves to a Project', async () => {
    const adapter = makeFakeAdapter()
    const p = await adapter.loadProject('p1')
    expect(p.id).toBe('p1')
  })

  // (b) resolveImageSrc: both a workspace path string and an https presigned
  // URL must satisfy the same signature (string in, string out).
  it('resolveImageSrc supports a Montaj workspace path resolver', () => {
    const montajResolver: EditorAdapter['resolveImageSrc'] = (el) =>
      `/api/files?path=${encodeURIComponent(el.src)}`
    const el: ImageElement = {
      id: 'img1',
      type: 'image',
      src: '/workspace/p1/photo.jpg',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotation: 0,
    }
    const out = montajResolver(el)
    expect(out.startsWith('/api/files?path=')).toBe(true)
  })

  it('resolveImageSrc supports a Hub presigned-URL resolver', () => {
    const presigned = 'https://bucket.s3.amazonaws.com/media/abc?X-Amz-Signature=xyz'
    const hubResolver: EditorAdapter['resolveImageSrc'] = (_el) => presigned
    const el: ImageElement = {
      id: 'img2',
      type: 'image',
      src: 'mediaId:abc',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotation: 0,
    }
    const out = hubResolver(el)
    expect(out.startsWith('https://')).toBe(true)
  })
})

// ── (d) RenderEvent union must narrow correctly per discriminant ─────────────
describe('RenderEvent discriminated union', () => {
  function describeEvent(e: RenderEvent): string {
    switch (e.type) {
      case 'log':
        return e.message
      case 'done':
        return e.outputPath
      case 'error':
        return e.message
    }
  }

  it('narrows on the `type` discriminant', () => {
    expect(describeEvent({ type: 'log', message: 'hi' })).toBe('hi')
    expect(describeEvent({ type: 'done', outputPath: '/o.mp4' })).toBe('/o.mp4')
    expect(describeEvent({ type: 'error', message: 'boom' })).toBe('boom')
  })
})

// ── (c) applyTheme writes the expected CSS custom properties onto an element ─
describe('applyTheme', () => {
  it('writes editor CSS vars onto a div', () => {
    const el = document.createElement('div')
    applyTheme(el, defaultMontajTheme)

    expect(el.style.getPropertyValue('--editor-bg')).toBe(
      defaultMontajTheme.colors.background,
    )
    expect(el.style.getPropertyValue('--editor-surface')).toBe(
      defaultMontajTheme.colors.surface,
    )
    expect(el.style.getPropertyValue('--editor-accent')).toBe(
      defaultMontajTheme.colors.accent,
    )
    expect(el.style.getPropertyValue('--editor-text')).toBe(
      defaultMontajTheme.colors.text,
    )
    expect(el.style.getPropertyValue('--editor-border')).toBe(
      defaultMontajTheme.colors.border,
    )
    expect(el.style.getPropertyValue('--editor-selection')).toBe(
      defaultMontajTheme.colors.selection,
    )
    expect(el.style.getPropertyValue('--editor-font-sans')).toBe(
      defaultMontajTheme.fonts.sans,
    )
  })

  it('writes serif/display font vars only when present', () => {
    const el = document.createElement('div')
    applyTheme(el, {
      ...defaultMontajTheme,
      fonts: { sans: 'Inter' },
    })
    expect(el.style.getPropertyValue('--editor-font-serif')).toBe('')
    expect(el.style.getPropertyValue('--editor-font-display')).toBe('')
  })

  it('writes radii and spacing scale vars', () => {
    const el = document.createElement('div')
    applyTheme(el, defaultMontajTheme)
    expect(el.style.getPropertyValue('--editor-radius-md')).toBe(
      defaultMontajTheme.radii.md,
    )
    expect(el.style.getPropertyValue('--editor-space-2')).toBe(
      defaultMontajTheme.spacing[2],
    )
  })
})

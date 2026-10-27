import { describe, it, expect } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { EditorAdapter, GlobalOverlay, Project } from '../../types'
import { useOverlaySchemas } from '../ElementControls'
import { shippedTemplateKey } from '../shippedTemplate'

// §587 r2 #7: a shape stores the maker's absolute runtime path; on another Mac
// its schema (fill, stroke, width) must still be found.

const A = '/Users/A/Library/Application Support/Montaj/runtime-home/.cache/montaj/render/templates/overlays/shape-rect/shape-rect.jsx'
const B = '/Users/B/Library/Application Support/Montaj/runtime-home/.cache/montaj/render/templates/overlays/shape-rect/shape-rect.jsx'
const RECT = {
  name: 'shape-rect', description: 'Rectangle', jsxPath: A, category: 'shape',
  props: [{ name: 'fill', type: 'string', default: '#bdbdbd', format: 'color' }],
} as GlobalOverlay

const adapter = (global: GlobalOverlay[] = []) => ({
  listSystemOverlays: async () => [RECT],
  listGlobalOverlays: async () => global,
}) as unknown as EditorAdapter<Project>

describe('shippedTemplateKey', () => {
  it('keys a path under render/templates/overlays', () => {
    expect(shippedTemplateKey(A)).toBe('templates/overlays/shape-rect/shape-rect.jsx')
    expect(shippedTemplateKey('C:\\Users\\B\\render\\templates\\overlays\\shape-rect\\shape-rect.jsx')).toBe('templates/overlays/shape-rect/shape-rect.jsx')
    expect(shippedTemplateKey('/x/render/templates/overlays/line-arrow.jsx')).toBe('templates/overlays/line-arrow.jsx')
  })
  it('is null for anything else', () => {
    for (const p of ['', '/x/templates/overlays/a/a.jsx', '/x/render/templates/overlays/a/b.jsx', '/x/render/templates/overlays/../a/a.jsx', '/x/render/templates/overlays/a/a.tsx']) {
      expect(shippedTemplateKey(p)).toBeNull()
    }
  })
})

describe('useOverlaySchemas on another Mac', () => {
  it('finds a shape schema by the exact path, and by the shipped key when the path is another Mac\'s', async () => {
    const { result } = renderHook(() => useOverlaySchemas(adapter(), undefined))
    await waitFor(() => expect(result.current.schemas.size).toBeGreaterThan(0))
    expect(result.current.schemas.get(A)).toBe(RECT)
    expect(result.current.schemas.get(B)).toBe(RECT)
    expect(result.current.schemas.get('/Users/B/proj/overlays/custom.jsx')).toBeUndefined()
  })
  it('an exact path always wins over the shipped key', async () => {
    const own = { ...RECT, jsxPath: B, description: 'Mine' } as GlobalOverlay
    const { result } = renderHook(() => useOverlaySchemas(adapter([own]), undefined))
    await waitFor(() => expect(result.current.schemas.size).toBeGreaterThan(0))
    expect(result.current.schemas.get(B)).toBe(own)
  })
})

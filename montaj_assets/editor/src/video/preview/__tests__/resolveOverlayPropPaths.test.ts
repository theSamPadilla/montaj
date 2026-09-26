import { describe, it, expect } from 'vitest'
import { resolveOverlayPropPaths } from '../OverlayItemsLayer'

// Stand-in for the Hub adapter's fileUrl: workspace path → servable proxy URL.
const fileUrl = (p: string) => `/api/hub/montaj/files?path=${encodeURIComponent(p)}`

describe('resolveOverlayPropPaths', () => {
  it('rewrites a top-level workspace path string (photo_card.src case)', () => {
    const out = resolveOverlayPropPaths(
      { src: '/var/hub-scratch/p1/assets/a.jpg', text: 'hi' },
      fileUrl,
    )
    expect(out).toEqual({
      src: '/api/hub/montaj/files?path=' + encodeURIComponent('/var/hub-scratch/p1/assets/a.jpg'),
      text: 'hi',
    })
  })

  it('rewrites workspace paths nested in an array of objects (player_trio.players case)', () => {
    const out = resolveOverlayPropPaths(
      {
        players: [
          { src: '/var/hub-scratch/p1/assets/a.jpg', name: 'A' },
          { src: '/var/hub-scratch/p1/assets/b.jpg', name: 'B' },
        ],
      },
      fileUrl,
    ) as { players: Array<{ src: string; name: string }> }
    expect(out.players[0].src).toBe(fileUrl('/var/hub-scratch/p1/assets/a.jpg'))
    expect(out.players[1].src).toBe(fileUrl('/var/hub-scratch/p1/assets/b.jpg'))
    expect(out.players[0].name).toBe('A')
  })

  it('leaves already-proxied /api/ URLs and remote URLs untouched (idempotent)', () => {
    const proxied = '/api/hub/montaj/files?path=%2Fx.jpg'
    const remote = 'https://cdn.example.com/x.jpg'
    const out = resolveOverlayPropPaths(
      { items: [{ src: proxied }, { src: remote }] },
      fileUrl,
    ) as { items: Array<{ src: string }> }
    expect(out.items[0].src).toBe(proxied)
    expect(out.items[1].src).toBe(remote)
  })

  it('preserves non-string scalars and nesting depth', () => {
    const out = resolveOverlayPropPaths(
      { duration: 90, nested: { deep: [{ src: '/var/x.png' }] } },
      fileUrl,
    ) as { duration: number; nested: { deep: Array<{ src: string }> } }
    expect(out.duration).toBe(90)
    expect(out.nested.deep[0].src).toBe(fileUrl('/var/x.png'))
  })

  // Windows: an absolute image prop is a drive-letter path. It must reach
  // fileUrl like a posix absolute path does; a UNC path stays refused.
  it('rewrites drive-letter absolute paths in either slash style', () => {
    expect(resolveOverlayPropPaths('C:\\a\\x.png', fileUrl)).toBe(fileUrl('C:\\a\\x.png'))
    expect(resolveOverlayPropPaths('C:/a/x.png', fileUrl)).toBe(fileUrl('C:/a/x.png'))
    expect(resolveOverlayPropPaths('d:\\x.png', fileUrl)).toBe(fileUrl('d:\\x.png'))
  })

  it('leaves UNC, drive-relative and relative paths untouched', () => {
    for (const v of ['\\\\server\\x', 'C:x.png', 'a\\x.png', 'a/x.png']) {
      expect(resolveOverlayPropPaths(v, fileUrl)).toBe(v)
    }
  })

  it('keeps posix behaviour exactly: /abs and //host rewritten, /api/ untouched', () => {
    expect(resolveOverlayPropPaths('/abs/x.png', fileUrl)).toBe(fileUrl('/abs/x.png'))
    expect(resolveOverlayPropPaths('//host/x.png', fileUrl)).toBe(fileUrl('//host/x.png'))
    expect(resolveOverlayPropPaths('/api/x', fileUrl)).toBe('/api/x')
    expect(resolveOverlayPropPaths('/apix', fileUrl)).toBe(fileUrl('/apix'))
  })
})

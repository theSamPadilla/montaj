import { describe, expect, it } from 'vitest'
import { loadOverlays } from '../overlayElement'

// serve lists an overlay group folder with nothing in it as { group, empty: true }: no name and no jsxPath. The picker
// drew it as a blank card that added an overlay with no file.
describe('loadOverlays', () => {
  it('skips an empty group folder and keeps the real overlays, deduped', async () => {
    const adapter = {
      listGlobalOverlays: async () => [
        { group: 'brand', empty: true },
        { name: 'Title', jsxPath: '/o/title.jsx' },
      ],
      listProfileOverlays: async () => [{ name: 'Title', jsxPath: '/o/title.jsx' }, { name: 'Pill', jsxPath: '/o/pill.jsx' }],
    } as never
    const out = await loadOverlays(adapter, { profile: 'p1' } as never)
    expect(out.map((o) => o.jsxPath)).toEqual(['/o/title.jsx', '/o/pill.jsx'])
  })
})

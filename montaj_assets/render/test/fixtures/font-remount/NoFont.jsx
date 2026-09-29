// System font only, so no webfont ever loads. Counts its mounts: the shim must
// never remount an overlay that loads no font.
import { useLayoutEffect } from 'react'
export default function NoFont({ frame }) {
  useLayoutEffect(() => { window.__mounts = (window.__mounts ?? 0) + 1 }, [])
  return (
    <div id="ov" data-frame={frame} style={{ position: 'absolute', inset: 0, background: '#223' }}>
      <span style={{ position: 'absolute', left: 60 + frame, top: 200, font: '80px sans-serif', color: 'white' }}>No webfont</span>
    </div>
  )
}

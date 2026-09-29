// Uses Bebas Neue and counts its mounts: a failed font load must not remount it.
import { useLayoutEffect } from 'react'
export default function BebasMounts({ frame }) {
  useLayoutEffect(() => { window.__mounts = (window.__mounts ?? 0) + 1 }, [])
  return <div style={{ position: 'absolute', inset: 0, background: '#223' }}>
    <span style={{ position: 'absolute', left: 60, top: 200, font: "160px 'Bebas Neue'", color: 'white' }}>Label {frame}</span>
  </div>
}

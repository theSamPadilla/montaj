import { useEffect, useState } from 'react'

type Size = { w: number; h: number }

const cache = new Map<string, Size>()

/** The display size of the video at `src` (`videoWidth`/`videoHeight` on loaded
 *  metadata, as the crop tool reads it), or null until it has loaded. Probed
 *  once per src and cached. The Crop tab's diamond needs it: a video's crop keys
 *  carry `sourceWidth`/`sourceHeight`, and until it is known the diamond does
 *  nothing (PV55 phase 2). */
export function useVideoNaturalSize(src: string | undefined): Size | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!src || cache.has(src)) return
    let live = true
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) cache.set(src, { w: v.videoWidth, h: v.videoHeight })
      if (live) bump(n => n + 1)
    }
    v.src = src
    return () => { live = false; v.onloadedmetadata = null; v.removeAttribute('src') }
  }, [src])
  return (src && cache.get(src)) || null
}

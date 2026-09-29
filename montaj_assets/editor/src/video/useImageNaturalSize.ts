import { useEffect, useState } from 'react'

type Size = { w: number; h: number }

const cache = new Map<string, Size>()

/** The natural size of the image at `src` (EXIF applied, as the browser
 *  decodes it), or null until it has loaded. Probed once per src and cached. */
export function useImageNaturalSize(src: string | undefined): Size | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!src || cache.has(src)) return
    let live = true
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) cache.set(src, { w: img.naturalWidth, h: img.naturalHeight })
      if (live) bump(n => n + 1)
    }
    img.src = src
    return () => { live = false }
  }, [src])
  return (src && cache.get(src)) || null
}

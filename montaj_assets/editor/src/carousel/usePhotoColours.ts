import { useEffect, useState } from 'react'
import { photoColoursOf } from './photoColours'
import type { PhotoColours } from './ColourPanel'

/**
 * The colour panel's photo colours (§587 R9): each image's dominant colours,
 * read while `enabled` (the panel is open). An image that cannot be read is
 * left out without a word; the list keeps `srcs`' order.
 */
export function usePhotoColours(srcs: string[], enabled: boolean): PhotoColours[] {
  const [found, setFound] = useState<Record<string, string[]>>({})
  const key = srcs.join('\n')
  useEffect(() => {
    if (!enabled) return
    let live = true
    for (const src of new Set(srcs)) {
      photoColoursOf(src).then(
        (colours) => { if (live) setFound((f) => (f[src] === colours ? f : { ...f, [src]: colours })) },
        () => {},
      )
    }
    return () => { live = false }
    // `key` stands for `srcs`.
  }, [key, enabled])
  if (!enabled) return []
  return [...new Set(srcs)].filter((src) => found[src]?.length).map((src) => ({ src, colours: found[src] }))
}

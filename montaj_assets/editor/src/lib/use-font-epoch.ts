// A counter that increments each time the document finishes loading a font.
// Text an overlay positions by measuring it (a mount-time or per-frame
// useLayoutEffect) is measured with fallback metrics if its webfont has not
// arrived yet, and nothing re-runs that measurement when it does. Hosts key the
// overlay body on this epoch so it remounts once per font load. See PV50.
import { useEffect, useState } from 'react'

export function useFontEpoch(): number {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts || typeof fonts.addEventListener !== 'function') return
    const onDone = () => setEpoch((n) => n + 1)
    fonts.addEventListener('loadingdone', onDone)
    return () => fonts.removeEventListener('loadingdone', onDone)
  }, [])
  return epoch
}

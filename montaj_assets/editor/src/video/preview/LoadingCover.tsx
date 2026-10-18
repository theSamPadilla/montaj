import { useEffect, useState, type RefObject } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * A heavy overlay at the playhead that has not drawn yet (a 3D scene item fetching its scene and decoding its
 * textures takes seconds) marks itself in the DOM, and the preview covers the picture until it has drawn:
 *
 *   data-montaj-loading="<what>"     still loading: the preview shows "Loading <what>…" on its dark ground, over
 *                                    the clips, the other overlays and the captions, so nothing looks finished on
 *                                    a black frame. The overlay keeps loading underneath; the attribute goes when
 *                                    its first frame is on screen.
 *   data-montaj-load-error="<what>"  it could not load: "Couldn't load the <what>" shows, small, and the rest of the
 *                                    picture is no longer covered. Never a spinner that runs forever.
 *
 * The overlay decides (the host's stage knows when it has drawn); the editor only reads the attributes, so any
 * overlay can use them. Only mounted overlays count, and the preview mounts an overlay only at the playhead.
 */
export interface LoadState { loading: string | null; error: string | null }

const NONE: LoadState = { loading: null, error: null }

/** What the markers under `root` say: the first loading one wins, then the first error. */
export function readLoadState(root: Element | null): LoadState {
  if (!root) return NONE
  const loading = root.querySelector('[data-montaj-loading]')
  if (loading) return { loading: loading.getAttribute('data-montaj-loading') || 'overlay', error: null }
  const error = root.querySelector('[data-montaj-load-error]')
  if (error) return { loading: null, error: error.getAttribute('data-montaj-load-error') || 'overlay' }
  return NONE
}

/** The markers under `ref`, kept current by a MutationObserver (an overlay mounting, drawing, or failing). */
export function useLoadState(ref: RefObject<Element | null>): LoadState {
  const [state, setState] = useState<LoadState>(NONE)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const update = () => {
      const next = readLoadState(root)
      setState((prev) => (prev.loading === next.loading && prev.error === next.error ? prev : next))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-montaj-loading', 'data-montaj-load-error'] })
    return () => observer.disconnect()
  }, [ref])
  return state
}

/** Above the clips, every overlay track and the captions (45 to 50); clicks pass through to the preview. */
export const LOADING_COVER_Z = 200

export default function LoadingCover({ containerRef }: { containerRef: RefObject<Element | null> }) {
  const { loading, error } = useLoadState(containerRef)
  if (loading) {
    return (
      <div
        data-testid="preview-loading-cover"
        role="status"
        className="absolute inset-0 flex items-center justify-center gap-2 bg-black text-sm text-white/80 pointer-events-none"
        style={{ zIndex: LOADING_COVER_Z }}
      >
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        <span>Loading {loading}…</span>
      </div>
    )
  }
  if (error) {
    return (
      <div
        data-testid="preview-load-error"
        role="status"
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{ zIndex: LOADING_COVER_Z }}
      >
        <span className="rounded bg-black/70 px-3 py-1.5 text-sm text-white/90">Couldn't load the {error}</span>
      </div>
    )
  }
  return null
}

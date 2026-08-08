/**
 * CaptionPreview — renders the active caption style on top of the video player.
 *
 * Loads the exact same JSX template used by the render engine
 * (render/templates/captions/<style>.jsx) so preview and final output
 * are a single source of truth. Receives `compileOverlay` as a prop from
 * PreviewPlayer (sourced from adapter.compileOverlay) so the package has no
 * direct dependency on the host's overlay-eval module.
 *
 * The caption layer is sized at the native render resolution (1080 × 1920) and
 * scaled down to fit the player via ResizeObserver so pixel values are 1:1 with
 * the render output.
 *
 * Per-segment positioning
 * -----------------------
 * The caption layer itself stays `pointer-events-none` at all times — the
 * template DOM is arbitrary per style AND changes per frame (word-by-word swaps
 * its content every few frames), so it is not something that can be hit-tested
 * reliably. Instead the rendered caption's bounding box is *measured* and a
 * separate interactive selection box is drawn over it (z 50, the same layer the
 * overlay handles use). That box is the only interactive element: clicking it
 * selects the segment active at the playhead, dragging it moves the segment
 * (offsetX/offsetY), and dragging a corner scales it (scale).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Captions } from '../../schema'
import type { OverlayFactory } from '../../types'
import OverlayErrorBoundary from '../../carousel/OverlayErrorBoundary'
import type { CaptionEditPatch } from '../timeline/makeCaptionEdit'
import {
  captionDragGeometry,
  captionDragPatch,
  hasEscapedClickSlop,
  readCaptionGeometry,
  type CaptionDragState,
  type CaptionGeometry,
} from './captionDragState'

const RENDER_W = 1080
const RENDER_H = 1920

// Screen-px padding added around the measured text so the selection box is
// comfortably grabbable and its outline clears the templates' glyph shadows.
const BOX_PAD = 6

// Corner handles, as [corner, x fraction, y fraction] of the selection box.
const CORNERS = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]] as const

// Screen px of the selection box that must stay inside the frame — see the
// clamp in the layout effect for why a fully-offscreen box is unrecoverable.
const BOX_KEEP_VISIBLE = 24

/**
 * Clamp one axis of the selection box so at least `BOX_KEEP_VISIBLE` px of it
 * overlaps the frame. `pos` is the box's leading edge relative to the frame,
 * `size` its extent on that axis, `extent` the frame's.
 *
 * A box entirely inside the frame is returned untouched: the clamp range
 * [KEEP - size, extent - KEEP] contains every such position, since a fitting
 * box has 0 >= KEEP - size and pos <= extent - size <= extent - KEEP.
 */
export function clampVisible(pos: number, size: number, extent: number): number {
  const min = BOX_KEEP_VISIBLE - size
  const max = extent - BOX_KEEP_VISIBLE
  // A frame smaller than the keep-visible margin inverts the range; leave the
  // position alone rather than snapping it to a meaningless bound.
  if (max < min) return pos
  return Math.max(min, Math.min(max, pos))
}

interface Rect { left: number; top: number; width: number; height: number }

/**
 * Union of the client rects of every painted text run (and replaced element)
 * under `root`.
 *
 * Deliberately NOT `root.getBoundingClientRect()`: the template's own outermost
 * element is a frame-sized `position: fixed; inset: 0` box (captionOuterStyle),
 * so its rect — and the rect of any wrapper we put around it — is the entire
 * preview, which would put the selection box around the whole frame. Walking to
 * the text nodes is the only markup-agnostic way to find where the caption
 * actually paints, and it costs nothing on a subtree this small.
 *
 * Returns null when nothing is painted (e.g. `pop` renders no word between two
 * word windows), which is the signal to hide the selection box entirely.
 */
export function measureCaptionContentRect(root: HTMLElement): Rect | null {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const range = doc.createRange()
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let rect: DOMRect | null = null
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.nodeValue?.trim()) continue
      range.selectNodeContents(node)
      rect = range.getBoundingClientRect()
    } else {
      // Replaced elements paint without text nodes. Everything else is a
      // container whose box is either the frame-sized outer wrapper or a
      // full-width anchor box — including them would defeat the point.
      const tag = (node as Element).tagName?.toUpperCase()
      if (tag !== 'IMG' && tag !== 'SVG' && tag !== 'VIDEO' && tag !== 'CANVAS') continue
      rect = (node as Element).getBoundingClientRect()
    }
    if (!rect || (!rect.width && !rect.height)) continue
    left   = Math.min(left,   rect.left)
    top    = Math.min(top,    rect.top)
    right  = Math.max(right,  rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }

  if (!Number.isFinite(left)) return null
  return { left, top, width: right - left, height: bottom - top }
}

interface CaptionPreviewProps {
  track:                    Captions
  currentTime:              number
  fps:                      number
  compileOverlay:           (src: string) => Promise<OverlayFactory>
  resolveCaptionTemplate?:  (style: string) => string
  /** Currently-selected caption segment id (shared with the timeline row). */
  selectedCaptionId?:       string
  /** Click on the selection box — selects the segment active at the playhead.
   *  Accepts null for symmetry with the timeline row's copy of this callback
   *  (VideoEditor supplies one handler to both); the preview only ever passes
   *  an id, since it has no deselect affordance of its own. */
  onSelectCaption?:         (id: string | null) => void
  /** Commit a finished drag/resize onto one segment. */
  onCaptionSegmentChange?:  (segmentId: string, patch: CaptionEditPatch) => void
}

export default function CaptionPreview({
  track,
  currentTime,
  fps,
  compileOverlay,
  resolveCaptionTemplate,
  selectedCaptionId,
  onSelectCaption,
  onCaptionSegmentChange,
}: CaptionPreviewProps) {
  const wrapRef            = useRef<HTMLDivElement>(null)
  const contentRef         = useRef<HTMLDivElement>(null)
  const boxRef             = useRef<HTMLDivElement>(null)
  const [scale, setScale]  = useState<number | null>(null)
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [hovered, setHovered] = useState(false)

  // In-flight gesture + its live geometry. `live` is applied to the segment we
  // hand the template (not to the project) so the caption moves under the
  // cursor; the project is written once, on mouseup.
  const [drag, setDrag] = useState<CaptionDragState | null>(null)
  const [live, setLive] = useState<({ id: string } & CaptionGeometry) | null>(null)
  const liveRef = useRef<typeof live>(null)
  // Read through a ref so a host that passes a fresh callback identity per
  // render can't re-subscribe the document listeners mid-gesture.
  const changeRef = useRef(onCaptionSegmentChange)
  changeRef.current = onCaptionSegmentChange

  // Scale the 1080×1920 render layer to fit the actual player size
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / RENDER_W)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Load the render-engine template for the active style.
  // If the host did not supply resolveCaptionTemplate, render nothing (graceful
  // no-op — host does not support captions).
  useEffect(() => {
    setFactory(null)
    if (!resolveCaptionTemplate) return
    const templateSrc = resolveCaptionTemplate(track.style)
    compileOverlay(templateSrc)
      .then(f  => setFactory(() => f))
      .catch(e => console.warn('[CaptionPreview] failed to load template:', e))
  }, [track.style, compileOverlay, resolveCaptionTemplate])

  const frame    = Math.round(currentTime * fps)
  const lastSeg  = track.segments[track.segments.length - 1]

  // The segment the template is showing. Computed from `frame / fps` (not from
  // currentTime) with the templates' own `>= start && < end` predicate, so the
  // selection box can never address a different segment than the one on screen.
  const t = fps > 0 ? frame / fps : 0
  const activeSeg = track.segments.find(s => t >= s.start && t < s.end) ?? null

  // Interactivity requires a stable segment id (backfilled by VideoEditor) and a
  // host that wired at least one caption callback. Without both, the layer stays
  // exactly as it was: a passive, click-through caption overlay.
  const activeId    = activeSeg?.id
  const canInteract = !!activeId && !!(onSelectCaption || onCaptionSegmentChange)
  const isSelected  = canInteract && selectedCaptionId === activeId

  // The box unmounts when the playhead leaves a segment, so a pending
  // mouseleave never arrives and the hover hairline would carry over onto the
  // next segment's box. Drop it whenever the target segment changes; a pointer
  // that really is over the new box gets its mouseenter back on the next move.
  useEffect(() => { setHovered(false) }, [activeId])

  // Theme props for the template: everything on the track except style/segments
  // (handled separately) and googleFonts (a render-time font-loading hint, not
  // a template prop). Normalize the legacy lowercase `fontsize` key to the
  // camelCase `fontSize` templates actually read.
  const { style: _style, segments: _segments, googleFonts: _googleFonts, fontsize, ...theme } = track
  const themeProps: Record<string, unknown> = { ...theme }
  if (fontsize != null) themeProps.fontSize = fontsize

  // Live drag preview: overlay the in-flight geometry onto the dragged segment
  // only. The templates read offsetX/offsetY/scale straight off the segment, so
  // this is all it takes for the caption to follow the cursor.
  const segments = live
    ? track.segments.map(s => (s.id === live.id ? { ...s, offsetX: live.offsetX, offsetY: live.offsetY, scale: live.scale } : s))
    : track.segments

  const element  = (factory && scale !== null)
    ? factory(frame, fps, Math.round((lastSeg?.end ?? 0) * fps), { segments, ...themeProps })
    : null

  // ── Gesture lifecycle ──────────────────────────────────────────────────────
  // Mirrors useDragOverlay's shape (document-level listeners for the life of the
  // gesture, live state during, one commit on mouseup) — see captionDragState.ts
  // for why the maths is duplicated rather than shared.
  useEffect(() => {
    const d = drag
    // `scale === null` is defensive only — a gesture can start only from the
    // box, which renders only when `element` exists, which requires a measured
    // scale. Kept so the metrics below can never be built from a null scale.
    if (!d || scale === null) return
    const metrics = { previewScale: scale, renderW: RENDER_W, renderH: RENDER_H }

    function onMove(e: MouseEvent) {
      // Inside the click slop the press is still just a selection click, so
      // clear any live geometry — that also makes "drag out and back" cancel.
      const next = hasEscapedClickSlop(d!, e.clientX, e.clientY)
        ? { id: d!.id, ...captionDragGeometry(d!, e.clientX, e.clientY, metrics) }
        : null
      setLive(next)
      liveRef.current = next
    }
    function onUp() {
      // Only commit if the pointer actually moved — a bare click selects and
      // must not push an undo step or queue a save.
      const l = liveRef.current
      if (l) changeRef.current?.(l.id, captionDragPatch(d!, l))
      setDrag(null)
      setLive(null)
      liveRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [drag, scale])

  function startGesture(type: CaptionDragState['type'], e: React.MouseEvent) {
    if (!activeId) return
    // Keep the mousedown from starting a text selection and from reaching the
    // player's play/pause layer underneath.
    e.preventDefault()
    e.stopPropagation()
    // Select and begin the gesture in the same press: unlike overlays (selected
    // from the timeline) the preview box IS the caption's selection affordance,
    // so requiring a separate click first would just cost a click.
    if (selectedCaptionId !== activeId) onSelectCaption?.(activeId)
    if (!onCaptionSegmentChange) return
    const g = readCaptionGeometry(activeSeg)
    setDrag({
      id: activeId, type,
      initX: e.clientX, initY: e.clientY,
      initOffsetX: g.offsetX, initOffsetY: g.offsetY, initScale: g.scale,
    })
  }

  // ── Selection box placement ────────────────────────────────────────────────
  // Positioned imperatively (style writes on a ref) rather than through state:
  // the caption content is re-measured after every render — which for
  // word-by-word means every frame of playback — and routing that through
  // setState would cost an extra render per frame and risk a measure→render→
  // measure loop. No dependency array on purpose: it must run after *every*
  // commit, since any of them (new frame, resize, live drag) can move the text.
  useLayoutEffect(() => {
    const box = boxRef.current
    const root = wrapRef.current
    const content = contentRef.current
    if (!box || !root || !content) return
    const rect = measureCaptionContentRect(content)
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      box.style.display = 'none'
      return
    }
    // Both rects are in client coords; the root is inset-0 of the player frame,
    // so subtracting it gives offsets in the box's own positioning context.
    const rootRect = root.getBoundingClientRect()
    const w = rect.width  + BOX_PAD * 2
    const h = rect.height + BOX_PAD * 2
    // Keep a grabbable sliver of the box inside the frame. offsetX/offsetY are
    // unbounded and there is no numeric reset control for captions (unlike
    // overlays, which have OverlayPropsModal), so a segment dragged fully past
    // the frame edge would have BOTH its text and its selection box clipped
    // away by this wrapper's `overflow-hidden` — leaving no way to drag it back
    // short of hand-editing project.json. Dragging is delta-based (see
    // captionDragState.ts), so a clamped box still moves the segment correctly.
    // Captions inside the frame are never clamped, so nothing else changes.
    const left = clampVisible(rect.left - rootRect.left - BOX_PAD, w, rootRect.width)
    const top  = clampVisible(rect.top  - rootRect.top  - BOX_PAD, h, rootRect.height)
    box.style.display = 'block'
    box.style.left    = `${left}px`
    box.style.top     = `${top}px`
    box.style.width   = `${w}px`
    box.style.height  = `${h}px`
  })

  return (
    // zIndex 45 keeps captions above the active <video> (z 1) and overlay items
    // (z `trackIdx + 12`, ≈12–20) — mirroring the final render, where the caption
    // track composites on top — while staying below the editing affordances
    // (selection handles z 50, play button z 100). Without an explicit z-index the
    // root sits at `auto`, so the opaque active video paints over it and captions
    // never appear in the preview.
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 45 }}>
      <OverlayErrorBoundary label={`caption: ${track.style}`} resetKey={track.style}>
        {element && scale !== null && (
          <div ref={contentRef} style={{
            position:        'absolute',
            top: 0, left: 0,
            width:           RENDER_W,
            height:          RENDER_H,
            transform:       `scale(${scale})`,
            transformOrigin: 'top left',
          }}>
            {element}
          </div>
        )}
      </OverlayErrorBoundary>

      {/* Centre/middle snap guides. Same amber hairlines, same z 50, and the
          same `drag.type === 'move'` gate the overlay layer uses, so a snapped
          caption reads identically to a snapped overlay. Only the centre pair
          exists here — caption edge snap is deliberately not implemented (its
          geometry does not transfer; see captionDragState.ts). */}
      {drag?.type === 'move' && live?.snapX && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-400 pointer-events-none" style={{ zIndex: 50 }} />
      )}
      {drag?.type === 'move' && live?.snapY && (
        <div className="absolute left-0 right-0 top-1/2 h-px bg-amber-400 pointer-events-none" style={{ zIndex: 50 }} />
      )}

      {/* Selection box — the only interactive part of the caption layer. z 50
          matches the overlay selection handles (see the layering note above);
          the wrapper stays click-through so only the box itself catches events. */}
      {element && canInteract && (
        <div className="absolute inset-0" style={{ zIndex: 50, pointerEvents: 'none' }}>
          <div
            ref={boxRef}
            onMouseDown={(e) => startGesture('move', e)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              // left/top/width/height are written by the layout effect above.
              position:      'absolute',
              display:       'none',
              pointerEvents: 'auto',
              touchAction:   'none',
              cursor:        isSelected ? (drag?.type === 'move' ? 'grabbing' : 'grab') : 'pointer',
              // Unselected captions show a hairline on hover only — a permanent
              // outline around every caption would be noise during review.
              outline:       isSelected ? '2px solid var(--editor-selection)'
                           : hovered    ? '1px dashed var(--editor-selection)'
                           : 'none',
            }}
          >
            {isSelected && onCaptionSegmentChange && CORNERS.map(([corner, fx, fy]) => (
              <div
                key={corner}
                onMouseDown={(e) => startGesture(`resize-${corner}`, e)}
                style={{
                  position: 'absolute',
                  left: `calc(${fx * 100}% - 6px)`,
                  top:  `calc(${fy * 100}% - 6px)`,
                  width: 12, height: 12, backgroundColor: '#fff',
                  border: '1.5px solid var(--editor-selection)', borderRadius: 2,
                  cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                  pointerEvents: 'auto', touchAction: 'none',
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

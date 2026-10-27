import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { AskAiRequest, CarouselBrand, EditorAdapter, GlobalOverlay, CarouselElement, Project, Slide } from '../types'
import { cn } from '../ui'
import { Loader } from '../ui/Loader'
import ReadOnlySlide from './ReadOnlySlide'
import OverlayErrorBoundary from './OverlayErrorBoundary'
import { ensureGoogleFontsLoaded } from '../lib/google-fonts'
import { TEXT_PRESETS, newTextElement, type TextPresetId } from './newText'
import { railField, railKeycap, railNote, railPrimaryBtn, railTile, railTitle } from './railStyles'
import { ELEMENT_CATEGORIES, elementCategory, loadOverlays, newOverlayBox, newOverlayElement, orderElements, OVERLAY_BOX, overlayTileLabel, TEMPLATE_DND_MIME, type ElementCategory } from './overlayElement'

// §587 M4b: the Text, Elements and AI image rail panels. Each adds to the slide
// it was opened for through `onAddElement` (the editor's own add, which applies
// a pending crop first), with the same element builders the classic add menu uses.

interface PanelProps {
  project: Project
  adapter: EditorAdapter<Project>
  /** The active slide, or null when there is none to add to. */
  slideId: string | null
  onAddElement: (slideId: string, element: CarouselElement) => void
}

function PanelTitle({ children }: { children: string }) {
  return <h2 className={railTitle}>{children}</h2>
}

const PRESET_STYLE: Record<TextPresetId, { fontSize: number; fontWeight: number }> = {
  heading: { fontSize: 24, fontWeight: 700 },
  subheading: { fontSize: 18, fontWeight: 600 },
  body: { fontSize: 14, fontWeight: 400 },
}

export function TextPanel({ project, slideId, onAddElement, textTemplate, fonts }: Omit<PanelProps, 'adapter'> & { textTemplate: GlobalOverlay | null; fonts?: CarouselBrand['fonts'] }) {
  // The presets show in the brand's fonts, so those load here too.
  useEffect(() => { ensureGoogleFontsLoaded(fonts?.googleFonts) }, [fonts?.googleFonts])
  const disabled = !slideId || !textTemplate
  const add = (preset?: TextPresetId) => {
    if (!slideId || !textTemplate) return
    onAddElement(slideId, newTextElement(textTemplate, project.settings.resolution, preset, fonts))
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      <PanelTitle>Text</PanelTitle>
      {!textTemplate && <div className={railNote}>No text template available</div>}
      <button type="button" disabled={disabled} onClick={() => add()} className={cn(railPrimaryBtn, 'w-full justify-between pr-2.5')}>
        <span>Add a text box</span>
        <kbd className={railKeycap}>T</kbd>
      </button>
      <div className="flex flex-col gap-2">
        <span className={railNote}>Your brand&apos;s styles</span>
        {(Object.keys(TEXT_PRESETS) as TextPresetId[]).map((id) => (
          // A specimen: the frame is Montaj's, the words show the brand's own type.
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => add(id)}
            className={cn(railTile, 'w-full px-4 py-2 text-left text-[var(--editor-text)] rounded-xl')}
            style={{ ...PRESET_STYLE[id], fontFamily: (id === 'body' ? fonts?.body ?? fonts?.heading : fonts?.heading ?? fonts?.body) }}
          >
            {TEXT_PRESETS[id].label}
          </button>
        ))}
      </div>
    </div>
  )
}

const PREVIEW_SCALE = 0.17

/** A small, non-interactive render of one overlay template, as it would be added.
 *  Its slide is built once per template, with a stable element id: a fresh id
 *  would remount the element, and the overlay would compile again, on every
 *  editor render. */
const OverlayThumb = memo(function OverlayThumb({ overlay, projectId, adapter }: { overlay: GlobalOverlay; projectId: string; adapter: EditorAdapter<Project> }) {
  const slide = useMemo<Slide>(() => {
    const el = newOverlayElement(overlay, [OVERLAY_BOX.w, OVERLAY_BOX.h])
    return { id: 'preview', base_color: 'transparent', elements: [{ ...el, id: `preview:${overlay.jsxPath}`, x: 0, y: 0 }] }
  }, [overlay])
  const compileOverlay = useMemo(() => (template: string) => adapter.compileOverlay(template, projectId), [adapter, projectId])
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-md bg-[var(--editor-bg)]"
      style={{ width: OVERLAY_BOX.w * PREVIEW_SCALE, height: OVERLAY_BOX.h * PREVIEW_SCALE }}
    >
      <OverlayErrorBoundary label={overlay.name} resetKey={overlay.jsxPath}>
        <ReadOnlySlide
          slide={slide}
          width={OVERLAY_BOX.w}
          height={OVERLAY_BOX.h}
          scale={PREVIEW_SCALE}
          resolveImageSrc={adapter.resolveImageSrc}
          compileOverlay={compileOverlay}
          watchFile={adapter.watchFile}
        />
      </OverlayErrorBoundary>
    </div>
  )
})

/** A tile's thumbnail slot: a plain box until the tile has been near view, then the live thumb for good. */
function PreviewSlot({ shown, ...thumb }: { shown: boolean; overlay: GlobalOverlay; projectId: string; adapter: EditorAdapter<Project> }) {
  if (shown) return <OverlayThumb {...thumb} />
  return <div aria-hidden="true" className="rounded-md bg-[var(--editor-bg)]" style={{ width: OVERLAY_BOX.w * PREVIEW_SCALE, height: OVERLAY_BOX.h * PREVIEW_SCALE }} />
}

// §587: the shipped shapes, arrows, lines, frames and callouts, drawn small in their own tiles.
const SHAPE_TILE = 48
const THUMB_SLIDE = [1080, 1350] as const
const SHAPE_SECTIONS: Record<ElementCategory, { title: string; preview: { w: number; h: number } }> = {
  shape: { title: 'Shapes', preview: { w: 100, h: 100 } },
  arrow: { title: 'Arrows', preview: { w: 100, h: 100 } },
  line: { title: 'Lines', preview: { w: 200, h: 40 } },
  frame: { title: 'Frames', preview: { w: 100, h: 100 } },
  callout: { title: 'Callouts', preview: { w: 100, h: 100 } },
}

/** A shipped shape's thumbnail: the template itself at its defaults, in a small box of its kind's shape (and its own aspect). */
const ShapeThumb = memo(function ShapeThumb({ overlay, projectId, adapter }: { overlay: GlobalOverlay; projectId: string; adapter: EditorAdapter<Project> }) {
  const category = elementCategory(overlay) ?? 'shape'
  const section = SHAPE_SECTIONS[category].preview
  // Shapes, arrows and callouts preview in the box they are added in (their px props are in scale), then shrink to the tile.
  const { w, h } = category === 'line' || category === 'frame' ? section : newOverlayBox(overlay, THUMB_SLIDE)
  const scale = Math.min(SHAPE_TILE / w, SHAPE_TILE / h)
  const slide = useMemo<Slide>(() => {
    const el = newOverlayElement({ ...overlay, category: undefined }, [w, h])
    return { id: 'preview', base_color: 'transparent', elements: [{ ...el, id: `preview:${overlay.jsxPath}`, x: 0, y: 0, w, h }] }
  }, [overlay, w, h])
  const compileOverlay = useMemo(() => (template: string) => adapter.compileOverlay(template, projectId), [adapter, projectId])
  return (
    <div aria-hidden="true" className="overflow-hidden" style={{ width: w * scale, height: h * scale }}>
      <OverlayErrorBoundary label={overlay.name} resetKey={overlay.jsxPath}>
        <ReadOnlySlide slide={slide} width={w} height={h} scale={scale} resolveImageSrc={adapter.resolveImageSrc} compileOverlay={compileOverlay} watchFile={adapter.watchFile} />
      </OverlayErrorBoundary>
    </div>
  )
})


export interface ElementsPanelProps {
  projectId: string
  profile: Project['profile']
  /** The slide's size, px: a template is added centred on it. */
  width: number
  height: number
  adapter: EditorAdapter<Project>
  /** The active slide, or null when there is none to add to. */
  slideId: string | null
  /** Keep it stable: the panel is memoised on plain props, so it renders again only when one of them changes. */
  onAddElement: (slideId: string, element: CarouselElement) => void
  /** A shipped shape's tile drag starts (its template) and ends (null). Keep it stable. */
  onTemplateDrag?: (overlay: GlobalOverlay | null) => void
  /** The "Ask your AI for a shape" pill at the top; absent, no pill. Keep it stable. */
  onAskAi?: (request: AskAiRequest) => void
}

export const ElementsPanel = memo(function ElementsPanel({ projectId, profile, width, height, adapter, slideId, onAddElement, onTemplateDrag, onAskAi }: ElementsPanelProps) {
  const [overlays, setOverlays] = useState<GlobalOverlay[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The shipped shapes, lines and frames (§587), for every user, signed in or not.
  const [shapes, setShapes] = useState<GlobalOverlay[]>([])
  // Tiles that have been near view: set once, kept, so scrolling back never recompiles.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const tileRefs = useRef(new Map<string, HTMLElement>())
  const hasIO = typeof IntersectionObserver !== 'undefined'
  useEffect(() => {
    if (!overlays || !hasIO) return
    const io = new IntersectionObserver((entries) => {
      const fresh = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.tile!)
      if (fresh.length) setSeen((prev) => (fresh.every((k) => prev.has(k)) ? prev : new Set([...prev, ...fresh])))
    }, { root: rootRef.current?.closest('section') ?? null, rootMargin: '200px' })
    for (const el of tileRefs.current.values()) io.observe(el)
    return () => io.disconnect()
  }, [overlays, shapes, hasIO])
  useEffect(() => {
    let live = true
    Promise.resolve(adapter.listSystemOverlays?.())
      .then((list) => { if (live) setShapes((list ?? []).filter((o) => !o.empty && elementCategory(o) !== null)) })
      .catch(() => { if (live) setShapes([]) })
    return () => { live = false }
  }, [adapter])
  useEffect(() => {
    let live = true
    setOverlays(null)
    setError(null)
    loadOverlays(adapter, { profile })
      .then((list) => { if (live) setOverlays(list.filter((o) => !o.empty)) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [adapter, profile])
  const tileRef = (key: string) => (el: HTMLElement | null) => { if (el) tileRefs.current.set(key, el); else tileRefs.current.delete(key) }
  // With shapes to show, an empty list of the person's own graphics says nothing.
  const showGraphics = !(overlays && overlays.length === 0 && shapes.length > 0)
  return (
    <div ref={rootRef} className="flex flex-col gap-3 p-4">
      {onAskAi && (
        // The host opens its own modal (prompt, references): the editor hands it the slide and no text.
        <button type="button" onClick={() => onAskAi({ kind: 'shape', slideId, text: '' })} className={cn(railPrimaryBtn, 'w-full')}>
          <Sparkles size={16} aria-hidden="true" />
          Ask your AI for a shape
        </button>
      )}
      {ELEMENT_CATEGORIES.map((category) => {
        const list = orderElements(shapes.filter((o) => elementCategory(o) === category))
        if (list.length === 0) return null
        return (
          <section key={category} className="flex flex-col gap-2">
            <PanelTitle>{SHAPE_SECTIONS[category].title}</PanelTitle>
            <div className="grid grid-cols-4 gap-2">
              {list.map((overlay) => (
                <button
                  key={overlay.jsxPath}
                  data-tile={overlay.jsxPath}
                  ref={tileRef(overlay.jsxPath)}
                  type="button"
                  disabled={!slideId}
                  draggable={!!slideId}
                  aria-label={overlayTileLabel(overlay)}
                  title={overlayTileLabel(overlay)}
                  onClick={() => slideId && onAddElement(slideId, newOverlayElement(overlay, [width, height]))}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TEMPLATE_DND_MIME, overlay.jsxPath)
                    e.dataTransfer.effectAllowed = 'copy'
                    onTemplateDrag?.(overlay)
                  }}
                  onDragEnd={() => onTemplateDrag?.(null)}
                  className={cn(railTile, 'flex aspect-square items-center justify-center rounded-xl p-1')}
                >
                  {!hasIO || seen.has(overlay.jsxPath)
                    ? <ShapeThumb overlay={overlay} projectId={projectId} adapter={adapter} />
                    : <div aria-hidden="true" style={{ width: SHAPE_TILE, height: SHAPE_TILE }} />}
                </button>
              ))}
            </div>
          </section>
        )
      })}
      {showGraphics && <PanelTitle>Graphics</PanelTitle>}
      {!overlays && !error && <div className="flex justify-center py-6"><Loader size="md" label="Loading graphics" /></div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {overlays && overlays.length === 0 && showGraphics && <div className={railNote}>No graphics available</div>}
      {overlays && overlays.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {overlays.map((overlay) => (
            <button
              key={overlay.jsxPath}
              data-tile={overlay.jsxPath}
              ref={tileRef(overlay.jsxPath)}
              type="button"
              disabled={!slideId}
              title={overlay.description || undefined}
              onClick={() => slideId && onAddElement(slideId, newOverlayElement(overlay, [width, height]))}
              className={cn(railTile, 'flex flex-col items-stretch gap-1.5 p-2 text-left')}
            >
              <PreviewSlot shown={!hasIO || seen.has(overlay.jsxPath)} overlay={overlay} projectId={projectId} adapter={adapter} />
              <span className="truncate text-xs font-semibold text-[var(--editor-text)]">{overlay.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export interface AiImageState { prompt: string; generating: boolean; error: string | null }

/** The editor owns the state, so a close and reopen of the panel neither loses a prompt nor starts a second run. */
export function AiImagePanel({ adapter, slideId, state, onChange, onGenerate }: {
  adapter: EditorAdapter<Project>
  slideId: string | null
  state: AiImageState
  onChange: (patch: Partial<AiImageState>) => void
  onGenerate: (slideId: string, prompt: string) => void
}) {
  const { prompt, generating, error } = state
  if (!adapter.generateImage) {
    return <div className="flex flex-col gap-2 p-4"><PanelTitle>AI image</PanelTitle><div className={railNote}>Not available</div></div>
  }
  const generate = () => { if (slideId && prompt.trim() && !generating) onGenerate(slideId, prompt.trim()) }
  return (
    <div className="flex flex-col gap-3 p-4">
      <PanelTitle>AI image</PanelTitle>
      <textarea
        className={cn(railField, 'resize-none py-2')}
        rows={4}
        aria-label="Describe the image to generate"
        placeholder="Describe the image to generate…"
        value={prompt}
        disabled={generating}
        onChange={(e) => onChange({ prompt: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate() }}
      />
      {error && <div className="text-xs text-red-600">{error}</div>}
      <button type="button" onClick={generate} disabled={generating || !slideId || !prompt.trim()} className={railPrimaryBtn}>
        {generating ? 'Generating…' : 'Generate'}
      </button>
    </div>
  )
}

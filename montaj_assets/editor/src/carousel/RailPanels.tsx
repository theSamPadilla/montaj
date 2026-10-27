import { useEffect, useState } from 'react'
import type { EditorAdapter, GlobalOverlay, CarouselElement, Project, Slide } from '../types'
import { Button } from '../ui'
import { Loader } from '../ui/Loader'
import ReadOnlySlide from './ReadOnlySlide'
import OverlayErrorBoundary from './OverlayErrorBoundary'
import { TEXT_PRESETS, newTextElement, type TextPresetId } from './newText'
import { loadOverlays, newOverlayElement, OVERLAY_BOX } from './overlayElement'
import { generateImageElement } from './newImage'

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

const muted = 'text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]'

function PanelTitle({ children }: { children: string }) {
  return <h2 className="text-sm font-semibold text-[var(--editor-text)]">{children}</h2>
}

const PRESET_STYLE: Record<TextPresetId, { fontSize: number; fontWeight: number }> = {
  heading: { fontSize: 24, fontWeight: 700 },
  subheading: { fontSize: 18, fontWeight: 600 },
  body: { fontSize: 14, fontWeight: 400 },
}

export function TextPanel({ project, slideId, onAddElement, textTemplate }: Omit<PanelProps, 'adapter'> & { textTemplate: GlobalOverlay | null }) {
  const disabled = !slideId || !textTemplate
  const add = (preset?: TextPresetId) => {
    if (!slideId || !textTemplate) return
    onAddElement(slideId, newTextElement(textTemplate, project.settings.resolution, preset))
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      <PanelTitle>Text</PanelTitle>
      <Button disabled={disabled} onClick={() => add()} className="w-full justify-between">
        <span>Add a text box</span>
        <kbd className="rounded border border-current px-1.5 text-[11px] leading-5 opacity-80">T</kbd>
      </Button>
      <div className="flex flex-col gap-2">
        <span className={`text-xs ${muted}`}>Your brand&apos;s styles</span>
        {(Object.keys(TEXT_PRESETS) as TextPresetId[]).map((id) => (
          <Button
            key={id}
            variant="outline"
            disabled={disabled}
            onClick={() => add(id)}
            className="h-auto w-full justify-start py-2"
            style={PRESET_STYLE[id]}
          >
            {TEXT_PRESETS[id].label}
          </Button>
        ))}
      </div>
    </div>
  )
}

const PREVIEW_SCALE = 0.17

/** A small, non-interactive render of one overlay template, as it would be added. */
function OverlayThumb({ overlay, project, adapter }: { overlay: GlobalOverlay; project: Project; adapter: EditorAdapter<Project> }) {
  const el = newOverlayElement(overlay, [OVERLAY_BOX.w, OVERLAY_BOX.h])
  const slide: Slide = { id: 'preview', base_color: 'transparent', elements: [{ ...el, x: 0, y: 0 }] }
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded bg-[var(--editor-bg)]"
      style={{ width: OVERLAY_BOX.w * PREVIEW_SCALE, height: OVERLAY_BOX.h * PREVIEW_SCALE }}
    >
      <OverlayErrorBoundary label={overlay.name} resetKey={overlay.jsxPath}>
        <ReadOnlySlide
          slide={slide}
          width={OVERLAY_BOX.w}
          height={OVERLAY_BOX.h}
          scale={PREVIEW_SCALE}
          resolveImageSrc={adapter.resolveImageSrc}
          compileOverlay={(template) => adapter.compileOverlay(template, project.id)}
          watchFile={adapter.watchFile}
        />
      </OverlayErrorBoundary>
    </div>
  )
}

export function ElementsPanel({ project, adapter, slideId, onAddElement }: PanelProps) {
  const [overlays, setOverlays] = useState<GlobalOverlay[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setOverlays(null)
    setError(null)
    loadOverlays(adapter, project)
      .then((list) => { if (live) setOverlays(list.filter((o) => !o.empty)) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [adapter, project.profile])
  return (
    <div className="flex flex-col gap-3 p-4">
      <PanelTitle>Graphics</PanelTitle>
      {!overlays && !error && <div className="flex justify-center py-6"><Loader size="md" label="Loading graphics" /></div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {overlays && overlays.length === 0 && <div className={`text-sm ${muted}`}>No graphics available</div>}
      {overlays && overlays.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {overlays.map((overlay) => (
            <button
              key={overlay.jsxPath}
              type="button"
              disabled={!slideId}
              title={overlay.description || undefined}
              onClick={() => slideId && onAddElement(slideId, newOverlayElement(overlay, project.settings.resolution))}
              className="flex flex-col items-stretch gap-1.5 rounded-lg border border-[var(--editor-border)] bg-[var(--editor-surface)] p-2 text-left hover:border-[var(--editor-accent)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]"
            >
              <OverlayThumb overlay={overlay} project={project} adapter={adapter} />
              <span className="truncate text-xs text-[var(--editor-text)]">{overlay.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function AiImagePanel({ project, adapter, slideId, onAddElement }: PanelProps) {
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!adapter.generateImage) {
    return <div className="flex flex-col gap-2 p-4"><PanelTitle>AI image</PanelTitle><div className={`text-sm ${muted}`}>Not available</div></div>
  }
  async function generate() {
    // The slide it was asked on: the image lands there even if the person moves on meanwhile.
    if (!slideId || !prompt.trim()) return
    setGenerating(true)
    setError(null)
    try {
      onAddElement(slideId, await generateImageElement(adapter, project, prompt.trim()))
      setPrompt('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <PanelTitle>AI image</PanelTitle>
      <textarea
        className="w-full resize-none rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2 py-1.5 text-xs text-[var(--editor-text)] placeholder-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] focus:border-[var(--editor-accent)] focus:outline-none"
        rows={4}
        aria-label="Describe the image to generate"
        placeholder="Describe the image to generate…"
        value={prompt}
        disabled={generating}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate() }}
      />
      {error && <div className="text-xs text-red-600">{error}</div>}
      <Button onClick={() => void generate()} disabled={generating || !slideId || !prompt.trim()}>
        {generating ? 'Generating…' : 'Generate'}
      </Button>
    </div>
  )
}

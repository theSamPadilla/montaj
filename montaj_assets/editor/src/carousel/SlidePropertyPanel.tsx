import { useEffect, useState } from 'react'
import { Crop, Eye, EyeOff } from 'lucide-react'
import type {
  Project,
  Slide,
  CarouselElement,
  OverlayElement,
  GlobalOverlay,
  GlobalOverlayProp,
  EditorAdapter,
} from '../types'
import { Button, cn, inspectorInputClass } from '../ui'
import { TextFormattingToolbar } from '../text/TextFormattingToolbar'

function parseNumber(v: string): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Shared small muted label that sits just above an inspector control.
const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[var(--editor-text)]/55'

// Section header: SLIDE / OVERLAY / IMAGE.
const sectionHeaderClass =
  'text-xs font-semibold uppercase tracking-wider text-[var(--editor-text)]/70'

interface Props {
  project: Project
  slide?: Slide
  element?: CarouselElement
  onSlideChange: (patch: Partial<Slide>) => void
  onElementChange: (patch: Partial<CarouselElement>) => void
  onDeleteSlide: (id: string) => void
  onDuplicateSlide: (id: string) => void
  onDeleteElement: (slideId: string, elementId: string) => void
  onDuplicateElement: (slideId: string, elementId: string) => void
  onReorderElement: (slideId: string, elementId: string, direction: 'forward' | 'backward') => void
  // Crop entry: enabled only for unrotated image elements.
  onEnterCrop?: (slideId: string, elementId: string) => void
  // editor-core text mutator for the formatting toolbar.
  updateOverlayProp?: (slideId: string, elementId: string, key: string, value: string) => Promise<void>
  // Adapter supplies overlay-schema listing (global + profile-scoped).
  adapter: EditorAdapter<Project>
  // Editor-only element visibility (host-owned, non-persisted). When
  // `onToggleElementVisibility` is supplied, an eye toggle is shown for the
  // selected element; `hiddenElementIds` reflects the current hidden set.
  hiddenElementIds?: string[]
  onToggleElementVisibility?: (elementId: string) => void
  // Override the panel's root container classes. Hosts that stack the panel
  // full-width (e.g. below the canvas) pass this to drop the default `w-80`
  // sidebar constraint.
  className?: string
}

// Small eye toggle to hide/show the selected element in the editor preview only
// (never persisted). Absent host callback → not rendered.
function HideToggle({
  elementId,
  isHidden,
  onToggle,
}: {
  elementId: string
  isHidden: boolean
  onToggle?: (elementId: string) => void
}) {
  if (!onToggle) return null
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle(elementId) }}
      title={isHidden ? 'Show in editor' : 'Hide from editor'}
      aria-label={isHidden ? 'Show in editor' : 'Hide from editor'}
      aria-pressed={isHidden}
      className="flex h-7 w-7 items-center justify-center rounded text-[var(--editor-text)]/60 hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
    >
      {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  )
}

function numInput(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts?: { min?: number; max?: number; step?: number }
) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <input
        type="number"
        value={value}
        min={opts?.min}
        max={opts?.max}
        step={opts?.step ?? 1}
        onChange={e => {
          const parsed = parseNumber(e.target.value)
          if (parsed !== null) onChange(parsed)
        }}
        className={cn(inspectorInputClass, 'text-right')}
      />
    </label>
  )
}

function PropEditor({
  prop,
  value,
  onChange,
}: {
  prop: GlobalOverlayProp
  value: unknown
  onChange: (v: unknown) => void
}) {
  const { name, type, description } = prop

  if (type === 'bool') {
    return (
      <label className="flex cursor-pointer items-center gap-2" title={description}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={e => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--editor-accent)]"
        />
        <span className="text-sm text-[var(--editor-text)]">{name}</span>
      </label>
    )
  }

  if (type === 'color') {
    return (
      <div className="flex flex-col gap-1" title={description}>
        <span className={fieldLabelClass}>{name}</span>
        <SwatchInput
          value={String(value ?? '#000000')}
          onChange={v => onChange(v)}
          ariaLabel={name}
        />
      </div>
    )
  }

  if (type === 'int' || type === 'float') {
    return (
      <label className="flex flex-col gap-1" title={description}>
        <span className={fieldLabelClass}>{name}</span>
        <input
          type="number"
          value={Number(value ?? 0)}
          step={type === 'float' ? 0.1 : 1}
          onChange={e => {
            const parsed = parseNumber(e.target.value)
            if (parsed !== null) onChange(parsed)
          }}
          className={cn(inspectorInputClass, 'text-right')}
        />
      </label>
    )
  }

  // string fallback
  return (
    <label className="flex flex-col gap-1" title={description}>
      <span className={fieldLabelClass}>{name}</span>
      <input
        type="text"
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
        className={inspectorInputClass}
      />
    </label>
  )
}

// Color control that actually reads as one: a filled rounded swatch (the live
// value) sitting next to the hex string, the whole row clickable to open the
// native color picker. The transparent <input type="color"> overlays the
// swatch so the OS picker anchors there.
function SwatchInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
}) {
  return (
    <div className="flex items-center gap-2.5">
      <label className="relative h-7 w-7 shrink-0 cursor-pointer">
        <span
          className="block h-full w-full rounded-md border border-[var(--editor-border)] shadow-sm"
          style={{ backgroundColor: value }}
          aria-hidden
        />
        <input
          type="color"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={ariaLabel}
        />
      </label>
      <span className="font-mono text-sm uppercase text-[var(--editor-text)]/80">{value}</span>
    </div>
  )
}

export default function SlidePropertyPanel({
  project,
  slide,
  element,
  onSlideChange,
  onElementChange,
  onDeleteSlide,
  onDuplicateSlide,
  onDeleteElement,
  onDuplicateElement,
  onReorderElement,
  onEnterCrop,
  updateOverlayProp,
  adapter,
  hiddenElementIds,
  onToggleElementVisibility,
  className,
}: Props) {
  // Map of jsxPath → GlobalOverlay for overlay prop schemas
  const [overlaySchemas, setOverlaySchemas] = useState<Map<string, GlobalOverlay>>(new Map())
  const [schemasLoading, setSchemasLoading] = useState(false)

  useEffect(() => {
    setSchemasLoading(true)
    const promises: Promise<GlobalOverlay[]>[] = [adapter.listGlobalOverlays()]
    if (project.profile) {
      promises.push(adapter.listProfileOverlays?.(project.profile) ?? Promise.resolve([]))
    }
    Promise.all(promises)
      .then(results => {
        const map = new Map<string, GlobalOverlay>()
        for (const list of results) {
          for (const o of list) {
            map.set(o.jsxPath, o)
          }
        }
        setOverlaySchemas(map)
      })
      .catch(() => {})
      .finally(() => setSchemasLoading(false))
  }, [project.profile])

  if (!slide) {
    return (
      <div className={cn('w-80 flex-shrink-0 flex items-center justify-center text-[var(--editor-text)]/40 text-xs p-4', className)}>
        Select a slide
      </div>
    )
  }

  const overlayEl = element?.type === 'overlay' ? (element as OverlayElement) : null
  const overlaySchema = overlayEl ? overlaySchemas.get(overlayEl.overlay.template) : null

  return (
    <div className={cn('w-80 flex-shrink-0 border-l border-[var(--editor-border)] flex flex-col overflow-y-auto bg-[var(--editor-bg)]', className)}>
      {/* Slide section */}
      <div className="flex flex-col gap-4 p-4">
        <div className={sectionHeaderClass}>Slide</div>
        <div className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Background color</span>
          <SwatchInput
            value={slide.base_color || '#ffffff'}
            onChange={v => onSlideChange({ base_color: v })}
            ariaLabel="Background color"
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={() => onDuplicateSlide(slide.id)}
          >
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="flex-1"
            onClick={() => onDeleteSlide(slide.id)}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Element section */}
      {element && (
        <div className="flex flex-col gap-4 border-t border-[var(--editor-border)] p-4">
          <div className="flex items-center justify-between">
            <span className={sectionHeaderClass}>
              {element.type === 'image' ? 'Image' : 'Overlay'}
            </span>
            <div className="flex items-center gap-0.5">
              <HideToggle
                elementId={element.id}
                isHidden={hiddenElementIds?.includes(element.id) ?? false}
                onToggle={onToggleElementVisibility}
              />
              <button
                onClick={() => onReorderElement(slide.id, element.id, 'forward')}
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--editor-text)]/60 hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
                title="Bring forward"
              >
                ↑
              </button>
              <button
                onClick={() => onReorderElement(slide.id, element.id, 'backward')}
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--editor-text)]/60 hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
                title="Send backward"
              >
                ↓
              </button>
            </div>
          </div>

          {/* Transform */}
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {numInput('X', element.x, v => onElementChange({ x: v }))}
              {numInput('Y', element.y, v => onElementChange({ y: v }))}
              {numInput('W', element.w, v => onElementChange({ w: v }), { min: 1 })}
              {numInput('H', element.h, v => onElementChange({ h: v }), { min: 1 })}
            </div>
            {numInput('Rotation', element.rotation ?? 0, v => onElementChange({ rotation: v }), { min: -360, max: 360 })}
          </div>

          {/* Image-specific */}
          {element.type === 'image' && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className={fieldLabelClass}>Source</span>
                <span className="truncate text-sm text-[var(--editor-text)]" title={element.src}>
                  {element.src.split('/').pop() || element.src}
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="flex items-center gap-1.5"
                disabled={(element.rotation ?? 0) !== 0 || !onEnterCrop}
                title={
                  (element.rotation ?? 0) !== 0
                    ? 'Reset rotation to 0 before cropping'
                    : 'Crop image'
                }
                onClick={() => onEnterCrop?.(slide.id, element.id)}
              >
                <Crop className="h-3.5 w-3.5" />
                Crop
              </Button>
            </div>
          )}

          {/* Overlay-specific */}
          {overlayEl && (
            <div className="flex flex-col gap-4">
              {/* Rich-text formatting (bold/italic/case/color/align + font family
                  & size pickers) for overlays exposing the standard text contract. */}
              {updateOverlayProp && (
                <TextFormattingToolbar
                  slideId={slide.id}
                  element={overlayEl}
                  updateOverlayProp={updateOverlayProp}
                />
              )}

              <div className="grid grid-cols-2 gap-3">
                {numInput('Frame', overlayEl.frame, v => onElementChange({ frame: v }), { min: 0 })}
              </div>

              {schemasLoading && (
                <div className="text-xs text-[var(--editor-text)]/55">Loading overlay props…</div>
              )}

              {!schemasLoading && overlaySchema && overlaySchema.props.length > 0 && (
                <div className="flex flex-col gap-3">
                  <span className={fieldLabelClass}>Props</span>
                  {overlaySchema.props.map(prop => (
                    <PropEditor
                      key={prop.name}
                      prop={prop}
                      value={overlayEl.overlay.props[prop.name]}
                      onChange={v => {
                        onElementChange({
                          overlay: {
                            ...overlayEl.overlay,
                            props: { ...overlayEl.overlay.props, [prop.name]: v },
                          },
                        } as Partial<CarouselElement>)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Element actions */}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              onClick={() => onDuplicateElement(slide.id, element.id)}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="flex-1"
              onClick={() => onDeleteElement(slide.id, element.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

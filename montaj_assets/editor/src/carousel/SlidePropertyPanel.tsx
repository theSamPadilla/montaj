import { useEffect, useRef, useState } from 'react'
import { Crop, Eye, EyeOff, Replace } from 'lucide-react'
import type {
  Project,
  Slide,
  CarouselElement,
  OverlayElement,
  GlobalOverlay,
  GlobalOverlayProp,
  EditorAdapter,
} from '../types'
import { Button, cn, inspectorInputClass, NumberField, stepValue, SwatchInput } from '../ui'
import { Loader } from '../ui/Loader'
import { TextFormattingToolbar } from '../text/TextFormattingToolbar'
import { TextEffectControls } from '../text/TextEffectControls'
import { AlignControls } from './AlignControls'

// Shared small muted label that sits just above an inspector control.
const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]'

// Section header: SLIDE / OVERLAY / IMAGE.
const sectionHeaderClass =
  'text-xs font-semibold uppercase tracking-wider text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)]'

interface Props {
  project: Project
  slide?: Slide
  element?: CarouselElement
  onSlideChange: (patch: Partial<Slide>) => void
  onElementChange: (patch: Partial<CarouselElement>) => void
  /**
   * A typed X, Y, W, H or rotation, as it is typed: a preview only, nothing
   * recorded. `onElementCommit` then writes it once (Enter or blur) and
   * `onElementCancel` (Esc) gives it up. Without them the boxes write once on
   * commit through `onElementChange`, with no preview.
   */
  onElementPreview?: (patch: Partial<CarouselElement>) => void
  onElementCommit?: () => void
  onElementCancel?: () => void
  /**
   * Every selected element (§156). With two or more, the panel shows only the
   * align buttons, aligning them to the box they cover, through
   * `onAlignSelection`.
   */
  selection?: CarouselElement[]
  onAlignSelection?: (patches: Array<{ id: string } & ({ x: number } | { y: number })>) => void
  onDeleteSlide: (id: string) => void
  onDuplicateSlide: (id: string) => void
  onDeleteElement: (slideId: string, elementId: string) => void
  onDuplicateElement: (slideId: string, elementId: string) => void
  onReorderElement: (slideId: string, elementId: string, direction: 'forward' | 'backward') => void
  // Crop entry: enabled only for unrotated image elements.
  onEnterCrop?: (slideId: string, elementId: string) => void
  /**
   * Replace the selected image's file, keeping its box (§556 M5). The panel
   * owns the file picker and hands the picked file here; the host uploads it
   * and writes the element. The panel's Replace button is off until the
   * returned promise settles, and off for good when this is absent. The host
   * reports its own failures: a rejection is not caught here.
   */
  onReplaceImage?: (slideId: string, elementId: string, file: File) => void | Promise<void>
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
  /** Editor theme mode — light/dark. Threaded to `TextFormattingToolbar`'s
   *  delete-icon hover hue. Absent -> dark, matching every existing
   *  caller. */
  mode?: 'light' | 'dark'
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
      className="flex h-7 w-7 items-center justify-center rounded text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
    >
      {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  )
}

// `label` doubles as NumberField's accessible `name` — there is no separate
// visible `<label htmlFor>` wired to the box, just the wrapping `<label>`
// element below (which already associates the two natively), so reusing the
// same string keeps the accessible name identical to what a screen reader
// announced before this converted from a bare `<input>`.
//
// A typed number is ONE edit: `onPreview` shows it as it is typed (a transient,
// nothing recorded) and `onCommit` writes it once, on Enter or blur. A box with
// no `onPreview` shows nothing until then. `onCancel` (Esc) gives the typed
// value up: it drops the preview, then blurs so NumberField releases its draft
// and shows the value the project holds. A stepper click is its own discrete
// edit (`onStep`), one write per click.
interface NumInputHandlers {
  onPreview?: (v: number) => void
  onCommit: (v: number) => void
  onCancel?: () => void
  onStep: (v: number) => void
}

function numInput(
  label: string,
  value: number,
  h: NumInputHandlers,
  opts?: { min?: number; max?: number; step?: number }
) {
  const step = opts?.step ?? 1
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelClass}>{label}</span>
      <div
        onKeyDown={e => {
          if (e.key !== 'Escape' || !h.onCancel) return
          h.onCancel()
          e.stopPropagation()
          ;(e.target as HTMLElement).blur()
        }}
      >
        <NumberField
          name={label}
          value={value}
          onPreview={h.onPreview ?? (() => {})}
          onCommit={h.onCommit}
          min={opts?.min}
          max={opts?.max}
          step={step}
          onStep={d => h.onStep(stepValue(value, d, { step, min: opts?.min, max: opts?.max }))}
        />
      </div>
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
        {/* Still writes per keystroke through the committed mutator — unlike
            the transform boxes (see `numInput`), which write once on commit. */}
        <NumberField
          name={name}
          value={Number(value ?? 0)}
          step={type === 'float' ? 0.1 : 1}
          onPreview={onChange}
          onCommit={() => {}}
          onStep={d => onChange(stepValue(Number(value ?? 0), d, { step: type === 'float' ? 0.1 : 1 }))}
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

export default function SlidePropertyPanel({
  project,
  slide,
  element,
  onSlideChange,
  onElementChange,
  onElementPreview,
  onElementCommit,
  onElementCancel,
  selection,
  onAlignSelection,
  onDeleteSlide,
  onDuplicateSlide,
  onDeleteElement,
  onDuplicateElement,
  onReorderElement,
  onEnterCrop,
  onReplaceImage,
  updateOverlayProp,
  adapter,
  hiddenElementIds,
  onToggleElementVisibility,
  className,
  mode = 'dark',
}: Props) {
  // Map of jsxPath → GlobalOverlay for overlay prop schemas
  const [overlaySchemas, setOverlaySchemas] = useState<Map<string, GlobalOverlay>>(new Map())
  const [schemasLoading, setSchemasLoading] = useState(false)
  // Replace image: the hidden file input its button opens, and whether a
  // replace is in flight (the button is off until it settles).
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState(false)

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
      <div className={cn('w-80 flex-shrink-0 flex items-center justify-center text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)] text-xs p-4', className)}>
        Select a slide
      </div>
    )
  }

  const overlayEl = element?.type === 'overlay' ? (element as OverlayElement) : null

  // X, Y, W, H and rotation: preview while typing, one write on Enter or blur.
  // Without the preview hooks (a host panel with only `onElementChange`) the
  // write still happens once, on commit.
  const transformInput = (
    label: string,
    value: number,
    key: 'x' | 'y' | 'w' | 'h' | 'rotation',
    opts?: { min?: number; max?: number },
  ) =>
    numInput(
      label,
      value,
      {
        onPreview: onElementPreview ? v => onElementPreview({ [key]: v }) : undefined,
        onCommit: onElementPreview ? () => onElementCommit?.() : v => onElementChange({ [key]: v }),
        onCancel: onElementPreview ? onElementCancel : undefined,
        onStep: v => onElementChange({ [key]: v }),
      },
      opts,
    )
  const overlaySchema = overlayEl ? overlaySchemas.get(overlayEl.overlay.template) : null

  const slideId = slide.id
  async function handleReplacePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    // Cleared so the same file can be picked again.
    input.value = ''
    if (!file || !element || !onReplaceImage) return
    setReplacing(true)
    try {
      await onReplaceImage(slideId, element.id, file)
    } finally {
      setReplacing(false)
    }
  }

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

      {/* Several elements selected: only the align buttons, aligning to the selection. */}
      {!element && selection && selection.length > 1 && onAlignSelection && (
        <div className="flex flex-col gap-4 border-t border-[var(--editor-border)] p-4">
          <AlignControls
            elements={selection}
            width={project.settings.resolution[0]}
            height={project.settings.resolution[1]}
            onChange={onAlignSelection}
          />
        </div>
      )}

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
                className="flex h-7 w-7 items-center justify-center rounded text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
                title="Bring forward"
              >
                ↑
              </button>
              <button
                onClick={() => onReorderElement(slide.id, element.id, 'backward')}
                className="flex h-7 w-7 items-center justify-center rounded text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]"
                title="Send backward"
              >
                ↓
              </button>
            </div>
          </div>

          {/* Transform */}
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {transformInput('X', element.x, 'x')}
              {transformInput('Y', element.y, 'y')}
              {transformInput('W', element.w, 'w', { min: 1 })}
              {transformInput('H', element.h, 'h', { min: 1 })}
            </div>
            {transformInput('Rotation', element.rotation ?? 0, 'rotation', { min: -360, max: 360 })}
          </div>

          <AlignControls
            element={element}
            width={project.settings.resolution[0]}
            height={project.settings.resolution[1]}
            onChange={onElementChange}
          />

          {/* Image-specific */}
          {element.type === 'image' && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className={fieldLabelClass}>Source</span>
                <span className="truncate text-sm text-[var(--editor-text)]" title={element.src}>
                  {element.src.split('/').pop() || element.src}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex flex-1 items-center gap-1.5"
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
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex flex-1 items-center gap-1.5"
                  disabled={!onReplaceImage || replacing}
                  title="Replace image"
                  onClick={() => replaceInputRef.current?.click()}
                >
                  <Replace className="h-3.5 w-3.5" />
                  Replace
                </Button>
              </div>
              <input
                ref={replaceInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                data-testid="replace-image-input"
                onChange={handleReplacePicked}
              />
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
                  mode={mode}
                />
              )}

              {/* Effect presets and Fit, for a template that takes them (static-text). */}
              {updateOverlayProp && (
                <TextEffectControls
                  slideId={slide.id}
                  element={overlayEl}
                  updateOverlayProp={updateOverlayProp}
                  mode={mode}
                />
              )}

              <div className="grid grid-cols-2 gap-3">
                {numInput(
                  'Frame',
                  overlayEl.frame,
                  {
                    // No preview: the frame is not a transient the state layer takes.
                    onCommit: v => { if (v !== overlayEl.frame) onElementChange({ frame: v }) },
                    onStep: v => onElementChange({ frame: v }),
                  },
                  { min: 0 },
                )}
              </div>

              {schemasLoading && (
                <Loader size="sm" label="Loading overlay props" />
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

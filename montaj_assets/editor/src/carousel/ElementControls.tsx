import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Eye, EyeOff, type LucideIcon } from 'lucide-react'
import type { CarouselElement, EditorAdapter, GlobalOverlay, GlobalOverlayProp, ImageElement, OverlayElement, Project, Slide } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { STANDARD_TEXT_PROPS } from '../overlays/contract'
import { cn, inspectorInputClass, NumberField, Select, stepValue, SwatchInput } from '../ui'
import { Loader } from '../ui/Loader'
import { elementCategory } from './overlayElement'
import { shippedTemplateKey } from './shippedTemplate'
import { railEyebrow, railFieldShape, railOutlineTool } from './railStyles'

// The element controls the classic SlidePropertyPanel and the rail layout's
// element toolbar (§587 M3) share: the typed transform fields, the image's
// Replace picker and Crop rule, the four layer-order buttons, an overlay's
// schema props and Frame, the editor-only hide toggle, and the slide's
// background colour (for the Background rail panel).

/** Small muted label above an inspector control. */
export const fieldLabelClass = railEyebrow

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
export interface NumInputHandlers {
  onPreview?: (v: number) => void
  onCommit: (v: number) => void
  onCancel?: () => void
  onStep: (v: number) => void
}

export function numInput(
  label: string,
  value: number,
  h: NumInputHandlers,
  opts?: { min?: number; max?: number; step?: number; disabled?: boolean }
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
          disabled={opts?.disabled}
          onPreview={h.onPreview ?? (() => {})}
          onCommit={h.onCommit}
          min={opts?.min}
          max={opts?.max}
          step={step}
          onStep={d => h.onStep(stepValue(value, d, { step, min: opts?.min, max: opts?.max }))}
          className={railFieldShape}
        />
      </div>
    </label>
  )
}

export interface TransformFieldsProps {
  element: CarouselElement
  /** The fields are off (a locked element). */
  disabled?: boolean
  /** A stepper click, or (without `onPreview`) a typed value on commit: one write. */
  onChange: (patch: Partial<CarouselElement>) => void
  /** A typed value as it is typed: a preview only. `onCommit` writes it once
   *  (Enter or blur) and `onCancel` (Esc) gives it up. */
  onPreview?: (patch: Partial<CarouselElement>) => void
  onCommit?: () => void
  onCancel?: () => void
}

/** X, Y, W, H and rotation: preview while typing, one write on Enter or blur.
 *  Without the preview hooks the write still happens once, on commit. */
export function TransformFields({ element, disabled, onChange, onPreview, onCommit, onCancel }: TransformFieldsProps) {
  const field = (
    label: string,
    value: number,
    key: 'x' | 'y' | 'w' | 'h' | 'rotation',
    opts?: { min?: number; max?: number },
  ) =>
    numInput(
      label,
      value,
      {
        onPreview: onPreview ? v => onPreview({ [key]: v }) : undefined,
        onCommit: onPreview ? () => onCommit?.() : v => onChange({ [key]: v }),
        onCancel: onPreview ? onCancel : undefined,
        onStep: v => onChange({ [key]: v }),
      },
      { ...opts, disabled },
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {field('X', element.x, 'x')}
        {field('Y', element.y, 'y')}
        {field('W', element.w, 'w', { min: 1 })}
        {field('H', element.h, 'h', { min: 1 })}
      </div>
      {field('Rotation', element.rotation ?? 0, 'rotation', { min: -360, max: 360 })}
    </div>
  )
}

/** Why an image cannot be cropped now, or null when it can. */
export function cropBlockedReason(element: ImageElement): string | null {
  return (element.rotation ?? 0) !== 0 ? 'Reset rotation to 0 before cropping' : null
}

/**
 * Replace image (§556 M5): the hidden file input a Replace button opens, and
 * whether a replace is in flight (the button is off until it settles). The
 * host uploads the picked file and writes the element; its failures are its
 * own to report (a rejection is not caught here).
 */
export function useReplaceImagePicker(
  slideId: string | undefined,
  elementId: string | undefined,
  onReplaceImage?: (slideId: string, elementId: string, file: File) => void | Promise<void>,
): { replacing: boolean; open: () => void; input: ReactNode } {
  const inputRef = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState(false)
  async function picked(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    // Cleared so the same file can be picked again.
    input.value = ''
    if (!file || !slideId || !elementId || !onReplaceImage) return
    setReplacing(true)
    try {
      await onReplaceImage(slideId, elementId, file)
    } finally {
      setReplacing(false)
    }
  }
  return {
    replacing,
    open: () => inputRef.current?.click(),
    input: (
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="replace-image-input"
        onChange={picked}
      />
    ),
  }
}

const LAYER_BUTTONS: { direction: ReorderDirection; label: string; Icon: LucideIcon }[] = [
  { direction: 'front', label: 'Bring to front', Icon: ArrowUpToLine },
  { direction: 'forward', label: 'Bring forward', Icon: ArrowUp },
  { direction: 'backward', label: 'Send backward', Icon: ArrowDown },
  { direction: 'back', label: 'Send to back', Icon: ArrowDownToLine },
]

const layerButtonClass = cn(railOutlineTool, 'h-7 flex-1')

/** Front, forward, backward, back: the layer-order keys' four moves. A locked element may still be layered. */
export function LayerOrderButtons({ onMove, disabled }: { onMove: (direction: ReorderDirection) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClass}>Layer</span>
      <div role="group" aria-label="Layer order" className="flex gap-1">
        {LAYER_BUTTONS.map(({ direction, label, Icon }) => (
          <button key={direction} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => onMove(direction)} className={layerButtonClass}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

/** The slide's background colour. The classic panel's Slide section uses it;
 *  the rail layout's Background panel is its other home. */
export function SlideBackgroundField({ slide, onSlideChange }: { slide: Slide; onSlideChange: (patch: Partial<Slide>) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={fieldLabelClass}>Background color</span>
      <SwatchInput
        value={slide.base_color || '#ffffff'}
        onChange={v => onSlideChange({ base_color: v })}
        ariaLabel="Background color"
      />
    </div>
  )
}

/** Schemas by `jsxPath`. A shipped shape, line or frame is also found by its
 *  shipped key (§569) when the exact path misses: it stores the maker's own
 *  runtime path, which another Mac does not have. */
class OverlaySchemaMap extends Map<string, GlobalOverlay> {
  private shipped = new Map<string, GlobalOverlay>()
  addShipped(o: GlobalOverlay) {
    const key = shippedTemplateKey(o.jsxPath)
    if (key && !this.shipped.has(key)) this.shipped.set(key, o)
  }
  override get(path: string): GlobalOverlay | undefined {
    const exact = super.get(path)
    if (exact) return exact
    const key = shippedTemplateKey(path)
    return key ? this.shipped.get(key) : undefined
  }
}

/**
 * The overlay prop schemas, by template path (`jsxPath`): the shipped shapes,
 * lines and frames, the global ones and the project profile's. `enabled` false loads nothing (a layout that has
 * another loader).
 */
export function useOverlaySchemas(
  adapter: EditorAdapter<Project>,
  profile: string | undefined,
  enabled = true,
): { schemas: Map<string, GlobalOverlay>; loading: boolean } {
  const [schemas, setSchemas] = useState<Map<string, GlobalOverlay>>(new Map())
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    setLoading(true)
    const promises: Promise<GlobalOverlay[]>[] = [
      // The shipped shapes, lines and frames (§587). The shipped text template
      // is left out: the text controls write its props.
      Promise.resolve(adapter.listSystemOverlays?.())
        .then(list => (list ?? []).filter(o => elementCategory(o) !== null))
        .catch(() => []),
      adapter.listGlobalOverlays(),
    ]
    if (profile) {
      promises.push(adapter.listProfileOverlays?.(profile) ?? Promise.resolve([]))
    }
    Promise.all(promises)
      .then(results => {
        const map = new OverlaySchemaMap()
        for (const o of results[0]) map.addShipped(o)
        for (const list of results) {
          for (const o of list) {
            map.set(o.jsxPath, o)
          }
        }
        setSchemas(map)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [profile, enabled])
  return { schemas, loading }
}

/** The props a text overlay's controls already write (the text toolbar and the
 *  effect controls): its Edit list leaves them out. */
export const TEXT_CONTROL_PROPS: ReadonlySet<string> = new Set([
  ...STANDARD_TEXT_PROPS,
  'effect', 'effectColor', 'effectStrength', 'fit', 'runs',
])

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
          checked={value === true || value === 'true'}
          onChange={e => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--editor-accent-text,var(--editor-accent))]"
        />
        <span className="text-sm text-[var(--editor-text)]">{name}</span>
      </label>
    )
  }

  if (type === 'color' || prop.format === 'color') {
    return (
      <div className="flex flex-col gap-1" title={description}>
        <span className={fieldLabelClass}>{name}</span>
        <SwatchInput
          value={String(value ?? '#000000')}
          onChange={v => onChange(v)}
          ariaLabel={name}
          // A string colour can be see-through (an 8-digit hex): a shape with no fill.
          alpha={prop.format === 'color' ? true : undefined}
        />
      </div>
    )
  }

  if (prop.enum && prop.enum.length > 0) {
    const current = String(value ?? prop.default ?? '')
    const options = (prop.enum.includes(current) ? prop.enum : [current, ...prop.enum]).map(v => ({ value: v, label: v }))
    return (
      <label className="flex flex-col gap-1" title={description}>
        <span className={fieldLabelClass}>{name}</span>
        <Select value={current} options={options} onChange={e => onChange(e.target.value)} className={cn(inspectorInputClass, railFieldShape)} />
      </label>
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
          className={railFieldShape}
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
        className={cn(inspectorInputClass, railFieldShape)}
      />
    </label>
  )
}

export interface OverlayPropsSectionProps {
  element: OverlayElement
  /** The template's schema; absent while loading or when it has none. */
  schema?: GlobalOverlay | null
  loading?: boolean
  /** Frame and prop edits, through the panel's element handler. */
  onElementChange: (patch: Partial<CarouselElement>) => void
  /** Props another control already writes, left out of the list. */
  exclude?: ReadonlySet<string>
}

/** The props of an overlay's schema that `exclude` leaves. */
export function schemaPropsFor(schema: GlobalOverlay | null | undefined, exclude?: ReadonlySet<string>): GlobalOverlayProp[] {
  return (schema?.props ?? []).filter(prop => !exclude?.has(prop.name))
}

/** An overlay's Frame (not a shape's) and its schema-driven props. */
export function OverlayPropsSection({ element, schema, loading, onElementChange, exclude }: OverlayPropsSectionProps) {
  const props = schemaPropsFor(schema, exclude)
  // A shipped shape, line or frame does not animate: its Frame does nothing.
  // Not shown while the schema loads either, so it does not flash and go.
  const showFrame = !loading && !(schema && elementCategory(schema) !== null)
  return (
    <>
      {showFrame && <div className="grid grid-cols-2 gap-3">
        {numInput(
          'Frame',
          element.frame,
          {
            // No preview: the frame is not a transient the state layer takes.
            onCommit: v => { if (v !== element.frame) onElementChange({ frame: v }) },
            onStep: v => onElementChange({ frame: v }),
          },
          { min: 0 },
        )}
      </div>}

      {loading && (
        <Loader size="sm" label="Loading overlay props" />
      )}

      {!loading && props.length > 0 && (
        <div className="flex flex-col gap-3">
          <span className={fieldLabelClass}>Props</span>
          {props.map(prop => (
            <PropEditor
              key={prop.name}
              prop={prop}
              value={element.overlay.props[prop.name]}
              onChange={v => {
                onElementChange({
                  overlay: {
                    ...element.overlay,
                    props: { [prop.name]: v },
                  },
                } as Partial<CarouselElement>)
              }}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** The eye: hides or shows the element in the editor only (never saved).
 *  Not drawn without the host's callback. A locked element may still be hidden. */
export function HideToggle({
  elementId,
  isHidden,
  onToggle,
  className,
}: {
  elementId: string
  isHidden: boolean
  onToggle?: (elementId: string) => void
  className?: string
}) {
  if (!onToggle) return null
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle(elementId) }}
      title={isHidden ? 'Show in editor' : 'Hide from editor'}
      aria-label={isHidden ? 'Show in editor' : 'Hide from editor'}
      aria-pressed={isHidden}
      className={className ?? cn('flex h-7 w-7 items-center justify-center rounded text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] hover:bg-[var(--editor-surface)] hover:text-[var(--editor-text)]')}
    >
      {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  )
}

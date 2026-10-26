import { Crop, Replace } from 'lucide-react'
import type {
  Project,
  Slide,
  CarouselElement,
  OverlayElement,
  EditorAdapter,
} from '../types'
import { Button, cn } from '../ui'
import { TextFormattingToolbar } from '../text/TextFormattingToolbar'
import { TextEffectControls } from '../text/TextEffectControls'
import { AlignControls } from './AlignControls'
import { cropBlockedReason, fieldLabelClass, HideToggle, OverlayPropsSection, SlideBackgroundField, TransformFields, useOverlaySchemas, useReplaceImagePicker } from './ElementControls'

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
  const { schemas: overlaySchemas, loading: schemasLoading } = useOverlaySchemas(adapter, project.profile)
  // Replace image: the hidden file input its button opens, and whether a
  // replace is in flight (the button is off until it settles).
  const replace = useReplaceImagePicker(slide?.id, element?.id, onReplaceImage)

  if (!slide) {
    return (
      <div className={cn('w-80 flex-shrink-0 flex items-center justify-center text-[color-mix(in_srgb,var(--editor-text)_40%,transparent)] text-xs p-4', className)}>
        Select a slide
      </div>
    )
  }

  const overlayEl = element?.type === 'overlay' ? (element as OverlayElement) : null
  // A locked element's place, content and existence are fixed (§586 M5): its
  // text and overlay controls sit in a disabled fieldset.
  const locked = element?.locked === true

  const overlaySchema = overlayEl ? overlaySchemas.get(overlayEl.overlay.template) : null

  return (
    <div className={cn('w-80 flex-shrink-0 border-l border-[var(--editor-border)] flex flex-col overflow-y-auto bg-[var(--editor-bg)]', className)}>
      {/* Slide section */}
      <div className="flex flex-col gap-4 p-4">
        <div className={sectionHeaderClass}>Slide</div>
        <SlideBackgroundField slide={slide} onSlideChange={onSlideChange} />
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
          <TransformFields
            element={element}
            disabled={locked}
            onChange={onElementChange}
            onPreview={onElementPreview}
            onCommit={onElementCommit}
            onCancel={onElementCancel}
          />

          <AlignControls
            element={element}
            width={project.settings.resolution[0]}
            height={project.settings.resolution[1]}
            disabled={locked}
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
                  disabled={locked || cropBlockedReason(element) !== null || !onEnterCrop}
                  title={cropBlockedReason(element) ?? 'Crop image'}
                  onClick={() => onEnterCrop?.(slide.id, element.id)}
                >
                  <Crop className="h-3.5 w-3.5" />
                  Crop
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex flex-1 items-center gap-1.5"
                  disabled={locked || !onReplaceImage || replace.replacing}
                  title="Replace image"
                  onClick={replace.open}
                >
                  <Replace className="h-3.5 w-3.5" />
                  Replace
                </Button>
              </div>
              {replace.input}
            </div>
          )}

          {/* Overlay-specific */}
          {overlayEl && (
            <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
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

              <OverlayPropsSection
                element={overlayEl}
                schema={overlaySchema}
                loading={schemasLoading}
                onElementChange={onElementChange}
              />
            </fieldset>
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
              disabled={locked}
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

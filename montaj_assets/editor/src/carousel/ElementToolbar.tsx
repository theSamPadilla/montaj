import { useEffect, useRef, type ReactNode } from 'react'
import { Bold, Copy, Crop, Italic, Lock, LockOpen, Replace, Trash2 } from 'lucide-react'
import type { CarouselElement, GlobalOverlay, OverlayElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { cn } from '../ui'
import { FontFamilyPicker, FontSizePicker } from '../text/FontPicker'
import { caseLabel, TEXT_ALIGNS, TextBackgroundControl, TextColorControl, textFormatting } from '../text/TextFormattingToolbar'
import { supportsEffects, supportsFit, TextEffectControls } from '../text/TextEffectControls'
import { AlignControls, type AlignPatch } from './AlignControls'
import { cropBlockedReason, HideToggle, LayerOrderButtons, OverlayPropsSection, schemaPropsFor, TEXT_CONTROL_PROPS, TransformFields, useReplaceImagePicker } from './ElementControls'
import { isLocked } from './lock'
import { isTextOverlay } from './textStyle'

// The rail layout's element toolbar (§587 M3): what the selection can do,
// centred along the top of the canvas. Every control drives the same handler
// the classic panel or a key does; nothing here writes on its own.

/** The toolbar's popovers; one is open at a time. */
export type ElementToolbarPopover = 'position' | 'effects' | 'edit'

type UpdateOverlayProp = (slideId: string, elementId: string, key: string, value: string) => Promise<void>

export interface ElementToolbarProps {
  slideId: string
  /** The selected elements, in click order; one or more. */
  selection: CarouselElement[]
  /** The slide's size, for align to page. */
  resolution: [number, number]
  /** Whether the project can be edited now. */
  canEdit: boolean
  /** The selected image is in crop mode. */
  cropping: boolean
  popover: ElementToolbarPopover | null
  onPopoverChange: (popover: ElementToolbarPopover | null) => void
  /** Runs before every action but Crop: it applies a pending crop (and ends
   *  an open nudge burst), so each action is its own undo step after it. */
  beforeAction: () => void
  updateOverlayProp: UpdateOverlayProp
  /** The single element's typed transform and align: the classic panel's handlers. */
  onElementChange: (patch: Partial<CarouselElement>) => void
  onElementPreview: (patch: Partial<CarouselElement>) => void
  onElementCommit: () => void
  onElementCancel: () => void
  /** Align or distribute several: one undo step. */
  onAlignSelection: (patches: Array<{ id: string } & AlignPatch>) => void
  onMoveInStack: (direction: ReorderDirection) => void
  onToggleLock: () => void
  onDuplicate: () => void
  onDelete: () => void
  /** Crop: enter crop mode for the image, or (while cropping) apply and leave it. */
  onToggleCrop: () => void
  onReplaceImage?: (slideId: string, elementId: string, file: File) => void | Promise<void>
  /** The overlay prop schemas by template path, for the Edit popover. */
  overlaySchemas?: Map<string, GlobalOverlay>
  schemasLoading?: boolean
  /** Editor-only visibility (the host's): the eye shows only with the callback. */
  hiddenElementIds?: string[]
  onToggleElementVisibility?: (elementId: string) => void
  mode?: 'light' | 'dark'
  /** The text colour opens the colour panel (§587 M5) instead of the OS picker. */
  onOpenTextColour?: () => void
  /** The profile's font, for the font picker's "Use brand default". */
  brandFont?: string
}

const iconBtn =
  'flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-sm text-[var(--editor-text)] transition-colors hover:bg-[var(--editor-surface)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]'
const textBtn = cn(iconBtn, 'px-3 text-[13px] font-medium')
const onClass = 'bg-[color-mix(in_srgb,var(--editor-accent)_15%,transparent)] text-[var(--editor-accent-text,var(--editor-accent))]'
const stepBtn =
  'flex h-7 w-7 items-center justify-center rounded-full text-sm text-[var(--editor-text)] hover:bg-[var(--editor-surface)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]'

function Sep() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px flex-shrink-0 bg-[var(--editor-border)]" />
}

function Popover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className="absolute left-1/2 top-full z-40 mt-2 flex w-[300px] -translate-x-1/2 flex-col gap-4 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-bg)] p-4 text-[var(--editor-text)] shadow-lg"
    >
      {children}
    </div>
  )
}

/** The text group: font, size, colour, bold, italic, alignment and Effects. Off for a locked element. */
function TextGroup({
  slideId,
  element,
  update,
  disabled,
  effectsOpen,
  onToggleEffects,
  onOpenTextColour,
  brandFont,
}: {
  slideId: string
  element: OverlayElement
  update: UpdateOverlayProp
  disabled: boolean
  effectsOpen: boolean
  onToggleEffects: () => void
  onOpenTextColour?: () => void
  brandFont?: string
}) {
  const fmt = textFormatting(slideId, element, update)
  const { supported } = fmt
  const alignAt = Math.max(0, TEXT_ALIGNS.findIndex((a) => a.value === fmt.currentAlign))
  const align = TEXT_ALIGNS[alignAt]
  const nextAlign = TEXT_ALIGNS[(alignAt + 1) % TEXT_ALIGNS.length]
  const hasEffects = supportsEffects(element) || supportsFit(element) || supported.has('textTransform') || supported.has('bgColor')
  const hasStyle = supported.has('color') || supported.has('fontWeight') || supported.has('fontStyle') || supported.has('textAlign')
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0">
      {supported.has('fontFamily') && (
        <FontFamilyPicker
          value={fmt.fontFamilyValue}
          onChange={fmt.setFontFamily}
          disabled={disabled}
          brandFont={brandFont}
          className="w-32"
          buttonClassName="flex h-8 w-full items-center gap-1 rounded-full border border-[var(--editor-border)] px-3 text-[13px] text-[var(--editor-text)] hover:bg-[var(--editor-surface)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]"
        />
      )}
      {supported.has('fontSize') && (
        <div className="ml-1 flex h-8 items-center rounded-full border border-[var(--editor-border)] px-0.5">
          <FontSizePicker
            value={fmt.fontSizeValue}
            onChange={fmt.setFontSize}
            disabled={disabled}
            steppers="plusMinus"
            stepperClassName={stepBtn}
            className="h-7 w-11 border-0 bg-transparent px-0 text-center"
          />
        </div>
      )}
      {hasStyle && <Sep />}
      {supported.has('color') && (
        <TextColorControl value={fmt.colorValue} onChange={fmt.setColor} onOpenPanel={onOpenTextColour} className={cn(iconBtn, 'flex-col gap-px', disabled && 'cursor-not-allowed opacity-40')}>
          <span aria-hidden="true" className="text-sm font-bold leading-none">A</span>
          <span aria-hidden="true" className="h-[3px] w-4 rounded-sm border border-[var(--editor-border)]" style={{ backgroundColor: fmt.colorValue }} />
        </TextColorControl>
      )}
      {supported.has('fontWeight') && (
        <button type="button" aria-label="Bold" title="Bold" aria-pressed={fmt.boldActive} onClick={fmt.toggleBold} className={cn(iconBtn, fmt.boldActive && onClass)}>
          <Bold className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {supported.has('fontStyle') && (
        <button type="button" aria-label="Italic" title="Italic" aria-pressed={fmt.italicActive} onClick={fmt.toggleItalic} className={cn(iconBtn, fmt.italicActive && onClass)}>
          <Italic className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {supported.has('textAlign') && (
        <button
          type="button"
          aria-label={`Text alignment: ${align.value}`}
          title={`Text alignment: ${align.value} (click for ${nextAlign.value})`}
          onClick={() => fmt.setAlign(nextAlign.value)}
          className={iconBtn}
        >
          <align.Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {hasEffects && (
        <>
          <Sep />
          <button type="button" aria-haspopup="dialog" aria-expanded={effectsOpen} onClick={onToggleEffects} className={cn(textBtn, effectsOpen && onClass)}>
            Effects
          </button>
        </>
      )}
    </fieldset>
  )
}

/** The Effects popover: today's effect controls, with the text case and background the board's toolbar has no room for. */
function EffectsContent({ slideId, element, update, disabled, mode }: { slideId: string; element: OverlayElement; update: UpdateOverlayProp; disabled: boolean; mode: 'light' | 'dark' }) {
  const fmt = textFormatting(slideId, element, update)
  const textTransform = typeof fmt.textTransform === 'string' ? fmt.textTransform : 'none'
  const hasRow = fmt.supported.has('textTransform') || fmt.supported.has('bgColor')
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
      {hasRow && (
        <div className="flex items-center gap-2">
          {fmt.supported.has('textTransform') && (
            <button
              type="button"
              aria-label={`Text case (currently ${textTransform})`}
              onClick={fmt.cycleCase}
              className={cn('h-7 min-w-[2rem] rounded-md border border-[var(--editor-border)] px-1.5 font-mono text-xs', fmt.caseActive && onClass)}
            >
              {caseLabel(fmt.textTransform)}
            </button>
          )}
          {fmt.supported.has('bgColor') && <TextBackgroundControl slideId={slideId} element={element} updateOverlayProp={update} />}
        </div>
      )}
      <TextEffectControls slideId={slideId} element={element} updateOverlayProp={update} mode={mode} />
    </fieldset>
  )
}

export default function ElementToolbar({
  slideId,
  selection,
  resolution,
  canEdit,
  cropping,
  popover,
  onPopoverChange,
  beforeAction,
  updateOverlayProp,
  onElementChange,
  onElementPreview,
  onElementCommit,
  onElementCancel,
  onAlignSelection,
  onMoveInStack,
  onToggleLock,
  onDuplicate,
  onDelete,
  onToggleCrop,
  onReplaceImage,
  overlaySchemas,
  schemasLoading,
  hiddenElementIds,
  onToggleElementVisibility,
  mode = 'dark',
  onOpenTextColour,
  brandFont,
}: ElementToolbarProps) {
  const element = selection.length === 1 ? selection[0] : undefined
  const image = element?.type === 'image' ? element : undefined
  const text = element && isTextOverlay(element) ? element : undefined
  const locked = element ? isLocked(element) : false
  const anyLocked = selection.some(isLocked)
  const allLocked = selection.length > 0 && selection.every(isLocked)
  const replace = useReplaceImagePicker(slideId, image?.id, onReplaceImage)
  // Edit: an overlay's Frame and its schema props; for a text overlay only the
  // props its text controls do not already write.
  const overlay = element?.type === 'overlay' ? element : undefined
  const overlaySchema = overlay ? overlaySchemas?.get(overlay.overlay.template) : undefined
  const editExclude = text ? TEXT_CONTROL_PROPS : undefined
  const canOpenEdit = !!overlay && (typeof overlay.frame === 'number' || schemaPropsFor(overlaySchema, editExclude).length > 0)

  // A press outside the toolbar and its popovers closes the open one.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!popover) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return
      onPopoverChange(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [popover, onPopoverChange])

  /** Every action but Crop applies a pending crop first. */
  const run = (action: () => void) => () => {
    beforeAction()
    action()
  }
  const update: UpdateOverlayProp = (...args) => {
    beforeAction()
    return updateOverlayProp(...args)
  }
  const toggle = (which: ElementToolbarPopover) => run(() => onPopoverChange(popover === which ? null : which))
  const [w, h] = resolution
  const cropReason = image ? cropBlockedReason(image) : null

  return (
    <div ref={rootRef} className="relative">
      <div
        role="toolbar"
        aria-label="Element"
        className="flex max-w-full flex-wrap items-center gap-0.5 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-bg)] px-1.5 py-1 text-[var(--editor-text)] shadow-md"
      >
        {text && (
          <>
            <TextGroup slideId={slideId} element={text} update={update} disabled={locked || !canEdit} effectsOpen={popover === 'effects'} onToggleEffects={toggle('effects')} onOpenTextColour={onOpenTextColour && run(onOpenTextColour)} brandFont={brandFont} />
            <Sep />
          </>
        )}
        {image && (
          <>
            <button
              type="button"
              aria-pressed={cropping}
              title={cropReason ?? 'Crop image'}
              disabled={!cropping && (locked || !canEdit || cropReason !== null)}
              onClick={() => {
                // Crop is the one action that does not apply the crop first: it
                // starts one, or applies the one in progress and leaves.
                onPopoverChange(null)
                onToggleCrop()
              }}
              className={cn(textBtn, 'gap-1.5', cropping && onClass)}
            >
              <Crop className="h-4 w-4" aria-hidden="true" />
              Crop
            </button>
            <button
              type="button"
              title="Replace image"
              disabled={locked || !canEdit || !onReplaceImage || replace.replacing}
              onClick={run(() => { onPopoverChange(null); replace.open() })}
              className={cn(textBtn, 'gap-1.5')}
            >
              <Replace className="h-4 w-4" aria-hidden="true" />
              Replace
            </button>
            {replace.input}
            <Sep />
          </>
        )}
        {canOpenEdit && (
          <button type="button" aria-haspopup="dialog" aria-expanded={popover === 'edit'} onClick={toggle('edit')} className={cn(textBtn, popover === 'edit' && onClass)}>
            Edit
          </button>
        )}
        <button type="button" aria-haspopup="dialog" aria-expanded={popover === 'position'} onClick={toggle('position')} className={cn(textBtn, popover === 'position' && onClass)}>
          Position
        </button>
        <Sep />
        <button
          type="button"
          aria-label={anyLocked ? 'Unlock' : 'Lock'}
          title={anyLocked ? 'Unlock' : 'Lock'}
          disabled={!canEdit}
          onClick={run(onToggleLock)}
          className={cn(iconBtn, anyLocked && onClass)}
        >
          {anyLocked ? <Lock className="h-4 w-4" aria-hidden="true" /> : <LockOpen className="h-4 w-4" aria-hidden="true" />}
        </button>
        {element && (
          <HideToggle
            elementId={element.id}
            isHidden={hiddenElementIds?.includes(element.id) ?? false}
            onToggle={onToggleElementVisibility}
            className={iconBtn}
          />
        )}
        <button type="button" aria-label="Duplicate" title="Duplicate" disabled={!canEdit} onClick={run(onDuplicate)} className={iconBtn}>
          <Copy className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Delete" title="Delete" disabled={!canEdit || allLocked} onClick={run(onDelete)} className={iconBtn}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {popover === 'position' && (
        <Popover label="Position">
          {element ? (
            <>
              <TransformFields
                element={element}
                disabled={locked || !canEdit}
                onChange={onElementChange}
                onPreview={onElementPreview}
                onCommit={onElementCommit}
                onCancel={onElementCancel}
              />
              <AlignControls element={element} width={w} height={h} disabled={locked || !canEdit} onChange={onElementChange} />
            </>
          ) : (
            <AlignControls elements={selection} width={w} height={h} disabled={allLocked || !canEdit} onChange={(patches: Array<{ id: string } & AlignPatch>) => { beforeAction(); onAlignSelection(patches) }} />
          )}
          <LayerOrderButtons onMove={(d) => { beforeAction(); onMoveInStack(d) }} disabled={!canEdit} />
        </Popover>
      )}
      {popover === 'edit' && overlay && (
        <Popover label="Edit">
          <fieldset disabled={locked || !canEdit} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
            <OverlayPropsSection
              element={overlay}
              schema={overlaySchema}
              loading={schemasLoading}
              onElementChange={onElementChange}
              exclude={editExclude}
            />
          </fieldset>
        </Popover>
      )}
      {popover === 'effects' && text && (
        <Popover label="Effects">
          <EffectsContent slideId={slideId} element={text} update={update} disabled={locked || !canEdit} mode={mode} />
        </Popover>
      )}
    </div>
  )
}


import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Bold, Copy, Crop, Group, Italic, Lock, LockOpen, Replace, Trash2, Ungroup } from 'lucide-react'
import type { CarouselElement, GlobalOverlay, OverlayElement } from '../types'
import type { ReorderDirection } from '../state/project-reducer'
import { cn, NumberField, Slider, Switch } from '../ui'
import { shortcutText } from '../ui/modifierKeys'
import { FontFamilyPicker, FontSizePicker } from '../text/FontPicker'
import { caseLabel, TEXT_ALIGNS, TextBackgroundControl, TextColorControl, textFormatting } from '../text/TextFormattingToolbar'
import { supportsEffects, supportsFit, TextEffectControls } from '../text/TextEffectControls'
import { AlignControls, type AlignPatch } from './AlignControls'
import { cropBlockedReason, HideToggle, LayerOrderButtons, OverlayPropsSection, schemaPropsFor, TEXT_CONTROL_PROPS, useReplaceImagePicker } from './ElementControls'
import { isLocked } from './lock'
import { elementColourTarget } from './colours'
import { isTextOverlay } from './textStyle'
import { railEyebrow, railFieldShape, railFocus, railHoverBg, railIconBtn, railIconBtnSm, railInk, railToolBtn, railToolOn } from './railStyles'
import { hasArrow, STROKE_STYLES, strokeStateOf, toggleArrowhead, type StrokeState, type StrokeStyle } from './stroke'

// The rail layout's element toolbar (§587 M3): what the selection can do,
// centred along the top of the canvas. Every control drives the same handler
// the classic panel or a key does; nothing here writes on its own.

/** The toolbar's popovers; one is open at a time. */
export type ElementToolbarPopover = 'position' | 'effects' | 'edit' | 'stroke'

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
  /** Align or distribute several: one undo step. */
  onAlignSelection: (patches: Array<{ id: string } & AlignPatch>) => void
  onMoveInStack: (direction: ReorderDirection) => void
  onToggleLock: () => void
  /** Group the selection (§587). Absent: no Group button. */
  onGroup?: () => void
  /** Ungroup the selected group. Absent: no Ungroup button. */
  onUngroup?: () => void
  /** Group or Ungroup is off (a locked element in it). */
  groupDisabled?: boolean
  /** The selected group's box: Position aligns the group as one box. */
  groupBox?: { x: number; y: number; w: number; h: number }
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
  /** The colour swatch (§587 R9): opens the colour panel on the element's own colour
   *  (text colour, a shape's fill or stroke). Absent: no swatch. */
  onOpenElementColour?: () => void
  /** The colour panel is open on a colour of this element: the colour it shows now.
   *  The swatch shows that one, and a click on it closes the panel. */
  colourShown?: string | null
  onCloseColour?: () => void
  /** The profile's font, for the font picker's "Use brand default". */
  brandFont?: string
  brandGoogleFonts?: string[]
  /** A font pick: the family and its `googleFonts` in one write (locked elements are refused by the host). */
  onSetFont?: (slideId: string, elementId: string, fontFamily: string, googleFonts: string[]) => void
  /** A live overlay prop write with no undo step (a stroke weight drag); `onCommitPropPreview`
   *  then saves what was previewed as one step. Absent: the weight writes on each change. */
  onPreviewOverlayProp?: (slideId: string, elementId: string, key: string, value: string) => void
  onCommitPropPreview?: () => void
  /** Escape in the weight field: drop the preview, write nothing. */
  onCancelPropPreview?: () => void
}

// Montaj's tools: 10px squares, muted at rest, ink on hover; on = the brand tint.
const iconBtn = cn(railIconBtn, 'w-auto min-w-8 px-2 disabled:hover:bg-transparent')
const textBtn = cn(railToolBtn, 'disabled:hover:bg-transparent')
const onClass = railToolOn
const stepBtn = cn(railIconBtnSm, 'text-sm')
/** The font and size fields: a 32px field with 10px corners. */
const fieldBox = 'border border-[var(--editor-border)] rounded-[10px]'

function Sep() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px flex-shrink-0 bg-[var(--editor-border)]" />
}

function Popover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={label}
      className="absolute left-1/2 top-full z-40 mt-2 flex w-[300px] -translate-x-1/2 flex-col gap-4 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-surface)] p-4 text-[var(--editor-text)] shadow-lg"
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
  brandGoogleFonts,
  onSetFont,
  swatch,
}: {
  slideId: string
  element: OverlayElement
  update: UpdateOverlayProp
  disabled: boolean
  effectsOpen: boolean
  onToggleEffects: () => void
  onOpenTextColour?: () => void
  brandFont?: string
  brandGoogleFonts?: string[]
  onSetFont?: (fontFamily: string, googleFonts: string[]) => void
  /** The colour swatch, before Effects; outside the fieldset, so a locked element's still opens the panel. */
  swatch?: ReactNode
}) {
  const fmt = textFormatting(slideId, element, update)
  const { supported } = fmt
  const alignAt = Math.max(0, TEXT_ALIGNS.findIndex((a) => a.value === fmt.currentAlign))
  const align = TEXT_ALIGNS[alignAt]
  const nextAlign = TEXT_ALIGNS[(alignAt + 1) % TEXT_ALIGNS.length]
  const hasEffects = supportsEffects(element) || supportsFit(element) || supported.has('textTransform') || supported.has('bgColor')
  const hasStyle = supported.has('color') || supported.has('fontWeight') || supported.has('fontStyle') || supported.has('textAlign')
  return (
    <div className="flex min-w-0 items-center gap-0.5">
    <fieldset disabled={disabled} className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0">
      {supported.has('fontFamily') && (
        <FontFamilyPicker
          value={fmt.fontFamilyValue}
          onChange={(family, specs) => (onSetFont ? onSetFont(family, specs ?? []) : fmt.setFontFamily(family))}
          disabled={disabled}
          brandFont={brandFont}
          brandGoogleFonts={brandGoogleFonts}
          variant="rail"
          className="w-32"
          buttonClassName={`flex h-8 w-full items-center gap-1 ${fieldBox} px-3 text-[13px] ${railInk} ${railHoverBg} disabled:cursor-not-allowed disabled:opacity-40 ${railFocus}`}
        />
      )}
      {supported.has('fontSize') && (
        <div className={`ml-1 flex h-8 items-center ${fieldBox} px-0.5`}>
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
          {/* An "A" over a thick bar of the text's colour (§587 R9). */}
          <span aria-hidden="true" className="text-[15px] font-bold leading-none">A</span>
          <span aria-hidden="true" data-colour-bar className={colourBar} style={{ backgroundColor: fmt.colorValue }} />
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
    </fieldset>
      {swatch}
      {hasEffects && (
        <fieldset disabled={disabled} className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0">
          <Sep />
          <button type="button" aria-haspopup="dialog" aria-expanded={effectsOpen} onClick={onToggleEffects} className={cn(textBtn, effectsOpen && onClass)}>
            Effects
          </button>
        </fieldset>
      )}
    </div>
  )
}

/** The text colour's bar: thick, rounded, with a hairline so white still shows. */
const colourBar = 'mt-[3px] h-[5px] w-[18px] rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editor-text)_20%,transparent)]'

/** The element's colour as a round swatch (§587 R9). A click opens the colour panel on it. */
function ColourSwatch({ value, label, open, onClick }: { value: string; label: string; open: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label="Color" title={label} aria-haspopup="dialog" aria-expanded={open} onClick={onClick} className={cn(iconBtn, open && onClass)}>
      <span
        aria-hidden="true"
        data-colour-swatch
        className="block h-5 w-5 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editor-text)_20%,transparent)]"
        style={{ backgroundColor: value }}
      />
    </button>
  )
}

/** The stroke button's icon: three bars, thick to thin. */
function StrokeWeightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true" className="h-4 w-4">
      <path d="M4 6h16" strokeWidth={3.5} />
      <path d="M4 12h16" strokeWidth={2.25} />
      <path d="M4 18h16" strokeWidth={1.25} />
    </svg>
  )
}

/** A style tile's sample: the pattern the templates draw, at a 3 px weight. */
const TILE_DASH: Record<StrokeStyle, string | undefined> = { solid: undefined, 'long-dash': '9 6', 'short-dash': '4.5 3', dotted: '0 6' }

/** The props the stroke popover writes: the Edit popover leaves them out. */
const STROKE_CONTROL_PROPS: ReadonlySet<string> = new Set(['strokeStyle', 'roundCaps', 'roundJoins', 'strokeWidth', 'arrowhead'])

/** The Stroke popover: style tiles, rounded ends or corners, and the weight. */
function StrokeContent({
  stroke,
  disabled,
  mode,
  set,
  previewWidth,
  commitWidth,
  cancelWidth,
}: {
  stroke: StrokeState
  disabled: boolean
  mode: 'light' | 'dark'
  /** One write, one undo step. */
  set: (key: string, value: string) => void
  /** The weight live, then once on release or Enter. */
  previewWidth: (value: number) => void
  commitWidth: (value: number) => void
  /** Escape in the weight field: drop the live weight. */
  cancelWidth?: () => void
}) {
  const roundLabel = stroke.kind === 'line' ? 'Rounded end points' : 'Rounded corners'
  const min = stroke.kind === 'line' ? 1 : 0
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
      <div className="grid grid-cols-4 gap-2">
        {STROKE_STYLES.map(({ value, label }) => {
          const on = stroke.style === value
          return (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => { if (!on) set('strokeStyle', value) }}
              className={cn(
                'flex h-10 items-center justify-center rounded-[10px] border bg-[var(--editor-surface)] text-[var(--editor-text)] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                railFocus,
                on ? 'border-[var(--editor-accent)] ring-1 ring-[var(--editor-accent)]' : 'border-[var(--editor-border)] hover:border-[var(--editor-text)]',
              )}
            >
              <svg viewBox="0 0 40 8" aria-hidden="true" className="h-2 w-10">
                <line x1={3} y1={4} x2={37} y2={4} stroke="currentColor" strokeWidth={3} strokeDasharray={TILE_DASH[value]} strokeLinecap={value === 'dotted' ? 'round' : 'butt'} />
              </svg>
            </button>
          )
        })}
      </div>
      {stroke.roundKey && (
        <div className="flex items-center justify-between">
          <span className={cn('text-sm', railInk)}>{roundLabel}</span>
          <Switch
            checked={stroke.round}
            onCheckedChange={(on) => set(stroke.roundKey!, on ? 'true' : 'false')}
            aria-label={roundLabel}
            disabled={disabled}
            mode={mode}
          />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className={railEyebrow}>Stroke weight</span>
        <div className="flex items-center gap-3">
          <Slider
            value={stroke.width}
            min={min}
            max={100}
            step={1}
            onChange={previewWidth}
            onCommit={commitWidth}
            aria-label="Stroke weight"
            className="min-w-0 flex-1"
            disabled={disabled}
          />
          <NumberField
            name="Stroke weight"
            value={stroke.width}
            min={min}
            step={1}
            onPreview={(v) => previewWidth(Math.max(min, Math.round(v)))}
            onCommit={(v) => commitWidth(Math.max(min, Math.round(v)))}
            onCancel={cancelWidth}
            disabled={disabled}
            className={cn('h-8 w-14', railFieldShape)}
          />
        </div>
      </div>
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
              className={cn('h-7 min-w-[2rem] rounded-[10px] border border-[var(--editor-border)] px-1.5 font-mono text-xs', fmt.caseActive && onClass)}
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
  onAlignSelection,
  onMoveInStack,
  onToggleLock,
  onGroup,
  onUngroup,
  groupDisabled,
  groupBox,
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
  onOpenElementColour,
  colourShown,
  onCloseColour,
  brandFont,
  brandGoogleFonts,
  onSetFont,
  onPreviewOverlayProp,
  onCommitPropPreview,
  onCancelPropPreview,
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
  const stroke = strokeStateOf(element)
  const editExclude = text ? TEXT_CONTROL_PROPS : stroke ? STROKE_CONTROL_PROPS : undefined
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
  // The colour swatch: the element's own colour, or the one the open panel is on.
  const colourTarget = element && onOpenElementColour ? elementColourTarget(element) : null
  const colourOpen = colourShown != null
  const swatch = colourTarget && (
    <ColourSwatch
      value={colourShown ?? colourTarget.value}
      label={colourTarget.label}
      open={colourOpen}
      onClick={colourOpen ? () => onCloseColour?.() : run(onOpenElementColour!)}
    />
  )

  return (
    <div ref={rootRef} className="relative">
      <div
        role="toolbar"
        aria-label="Element"
        className="flex max-w-full flex-wrap items-center gap-0.5 rounded-xl border border-[var(--editor-border)] bg-[var(--editor-surface)] px-1.5 py-1 text-[var(--editor-text)] shadow-md"
      >
        {text && (
          <>
            <TextGroup slideId={slideId} element={text} update={update} disabled={locked || !canEdit} effectsOpen={popover === 'effects'} onToggleEffects={toggle('effects')} onOpenTextColour={onOpenTextColour && (colourOpen ? () => onCloseColour?.() : run(onOpenTextColour))} brandFont={brandFont} brandGoogleFonts={brandGoogleFonts} onSetFont={onSetFont && ((family, specs) => { beforeAction(); onSetFont(slideId, text.id, family, specs) })} swatch={swatch} />
            <Sep />
          </>
        )}
        {!text && (swatch || stroke) && (
          <>
            {swatch}
            {stroke && (
              <button type="button" aria-label="Stroke" title="Stroke" aria-haspopup="dialog" aria-expanded={popover === 'stroke'} onClick={toggle('stroke')} className={cn(iconBtn, popover === 'stroke' && onClass)}>
                <StrokeWeightIcon />
              </button>
            )}
            {stroke?.kind === 'line' && element && (['start', 'end'] as const).map((side) => {
              const on = hasArrow(stroke.arrowhead, side)
              const Icon = side === 'start' ? ArrowLeft : ArrowRight
              const label = side === 'start' ? 'Start arrow' : 'End arrow'
              return (
                <button
                  key={side}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={on}
                  disabled={locked || !canEdit}
                  onClick={() => void update(slideId, element.id, 'arrowhead', toggleArrowhead(stroke.arrowhead, side))}
                  className={cn(iconBtn, on && onClass)}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </button>
              )
            })}
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
        {(onGroup || onUngroup) && (
          <button
            type="button"
            aria-label={onUngroup ? 'Ungroup' : 'Group'}
            title={`${onUngroup ? 'Ungroup' : 'Group'} (${shortcutText(onUngroup ? ['⌘', '⇧', 'G'] : ['⌘', 'G'])})`}
            disabled={!canEdit || groupDisabled}
            onClick={run((onUngroup ?? onGroup)!)}
            className={iconBtn}
          >
            {onUngroup ? <Ungroup className="h-4 w-4" aria-hidden="true" /> : <Group className="h-4 w-4" aria-hidden="true" />}
          </button>
        )}
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
          {/* Align and layer order only: the canvas handles place, size and turn
              (Sam, 2026-10-26); the AI sets exact numbers through its tools. */}
          {element ? (
            <AlignControls element={element} width={w} height={h} disabled={locked || !canEdit} onChange={onElementChange} />
          ) : groupBox ? (
            // A group aligns to the slide as one box: every member moves by the same step.
            <AlignControls
              element={groupBox}
              width={w}
              height={h}
              disabled={anyLocked || !canEdit}
              onChange={(patch: AlignPatch) => {
                beforeAction()
                const dx = 'x' in patch ? patch.x - Math.round(groupBox.x) : 0
                const dy = 'y' in patch ? patch.y - Math.round(groupBox.y) : 0
                onAlignSelection(selection.map((el) => ({ id: el.id, ...('x' in patch ? { x: el.x + dx } : { y: el.y + dy }) })))
              }}
            />
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
      {popover === 'stroke' && stroke && element && (
        <Popover label="Stroke">
          <StrokeContent
            stroke={stroke}
            disabled={locked || !canEdit}
            mode={mode}
            set={(key, value) => void update(slideId, element.id, key, value)}
            previewWidth={(v) => (onPreviewOverlayProp ? onPreviewOverlayProp(slideId, element.id, 'strokeWidth', String(v)) : void update(slideId, element.id, 'strokeWidth', String(v)))}
            cancelWidth={onCancelPropPreview}
            commitWidth={(v) => (onCommitPropPreview ? onCommitPropPreview() : void update(slideId, element.id, 'strokeWidth', String(v)))}
          />
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


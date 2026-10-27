import { useEffect, useState, type ReactNode } from 'react'
import { Ban, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Trash2 } from 'lucide-react'
import type { OverlayElement } from '../types'
import { FontFamilyPicker, FontSizePicker } from './FontPicker'
import { getSupportedProps, readPropAsString } from '../overlays/contract'
import { Button, SwatchInput } from '../ui'

export const HEX_PATTERN = /^#[0-9a-fA-F]{3,8}$/

export function isColorProp(key: string, value: string): boolean {
  if (HEX_PATTERN.test(value.trim())) return true
  const k = key.toLowerCase()
  return /color|accent|primary|secondary|bg|background|fg|foreground|fill|ink|cream/.test(k)
}

export function isBold(weight: unknown): boolean {
  if (weight === 'bold') return true
  const n = Number(weight)
  return Number.isFinite(n) && n >= 600
}

export function isItalic(style: unknown): boolean {
  return style === 'italic'
}

const CASE_CYCLE = ['none', 'uppercase', 'lowercase', 'capitalize'] as const
type TextTransformValue = 'none' | 'uppercase' | 'lowercase' | 'capitalize'

export function nextCase(current: unknown): TextTransformValue {
  const idx = CASE_CYCLE.indexOf(current as TextTransformValue)
  if (idx === -1) return 'uppercase'
  return CASE_CYCLE[(idx + 1) % CASE_CYCLE.length]
}

export function isStyleProp(key: string): boolean {
  return (
    // `runs` (§587 round 3) is the text's styled ranges, written by the inline editor.
    key === 'runs' ||
    key === 'fontWeight' ||
    key === 'fontStyle' ||
    key === 'textTransform' ||
    key === 'textAlign' ||
    key === 'fontFamily' ||
    key === 'fontSize'
  )
}

export function nonColorTextEntries(props: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(props).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && !isColorProp(entry[0], entry[1]) && !isStyleProp(entry[0]),
  )
}

export function caseLabel(current: unknown): string {
  if (current === 'uppercase') return 'AA'
  if (current === 'lowercase') return 'aa'
  if (current === 'capitalize') return 'Aa·'
  return 'Aa'
}

export type TextFormattingToolbarProps = {
  slideId: string
  element: OverlayElement
  updateOverlayProp: (slideId: string, elementId: string, key: string, value: string) => Promise<unknown>
  onDelete?: () => void
  /** Editor theme mode — light/dark. Only affects the delete button's hover
   *  hue (red-400 is sub-AA on a light `--editor-surface`). Absent -> dark,
   *  matching every existing caller. */
  mode?: 'light' | 'dark'
}

// What the background picker shows while the box has no solid color: bgColor
// is `transparent`, empty, or a CSS color the native picker cannot show. Mid
// grey on purpose, not white or black: the native picker fires nothing when a
// pick equals the color it already shows, so a white (or black) start would
// make that color impossible to choose in one go.
const NEUTRAL_BG = '#808080'

/** An empty or `transparent` background draws nothing, so there is nothing to clear. */
function isTransparentBackground(raw: string): boolean {
  const v = raw.trim().toLowerCase()
  return v === '' || v === 'transparent'
}

/** The text box's background: a swatch, and a button that clears it. Written
 *  as hex from the picker and as the literal `transparent` from the button. */
export function TextBackgroundControl({
  slideId,
  element,
  updateOverlayProp,
}: Pick<TextFormattingToolbarProps, 'slideId' | 'element' | 'updateOverlayProp'>) {
  const raw = readPropAsString(element, 'bgColor')
  const saved = HEX_PATTERN.test(raw) && (raw.length === 7 || raw.length === 9) ? raw : NEUTRAL_BG

  // Like the text effect color: the swatch previews a pick locally and the
  // overlay is written once, when the picker closes, so one pick is one undo step.
  const [color, setColor] = useState(saved)
  useEffect(() => setColor(saved), [element.id, saved])

  const write = (value: string) => void updateOverlayProp(slideId, element.id, 'bgColor', value)

  return (
    <>
      <SwatchInput
        value={color}
        onChange={setColor}
        onCommit={write}
        ariaLabel="Text background"
        title="Text background"
        showValue={false}
        size="sm"
        alpha
      />
      {!isTransparentBackground(raw) && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          aria-label="No text background"
          title="No text background"
          onClick={() => write('transparent')}
        >
          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </>
  )
}

/**
 * A text overlay's formatting state and its writes, one `updateOverlayProp`
 * call (one save, one undo step) per action. The classic panel's toolbar and
 * the rail layout's element toolbar (§587 M3) both drive these.
 */
export function textFormatting(
  slideId: string,
  element: OverlayElement,
  updateOverlayProp: TextFormattingToolbarProps['updateOverlayProp'],
) {
  const props = element.overlay.props
  const write = (key: string, value: string) => void updateOverlayProp(slideId, element.id, key, value)
  const boldActive = isBold(props.fontWeight)
  const italicActive = isItalic(props.fontStyle)
  const rawColor = readPropAsString(element, 'color')
  return {
    supported: getSupportedProps(element),
    boldActive,
    italicActive,
    caseActive: props.textTransform !== undefined && props.textTransform !== 'none',
    textTransform: props.textTransform,
    currentAlign: typeof props.textAlign === 'string' ? props.textAlign : undefined,
    fontSizeValue: readPropAsString(element, 'fontSize'),
    fontFamilyValue: readPropAsString(element, 'fontFamily'),
    colorValue: HEX_PATTERN.test(rawColor) && (rawColor.length === 7 || rawColor.length === 9) ? rawColor : '#111111',
    toggleBold: () => write('fontWeight', boldActive ? '400' : '700'),
    toggleItalic: () => write('fontStyle', italicActive ? 'normal' : 'italic'),
    cycleCase: () => write('textTransform', nextCase(props.textTransform)),
    setAlign: (v: TextAlignValue) => write('textAlign', v),
    setFontSize: (v: string) => write('fontSize', v),
    setFontFamily: (v: string) => write('fontFamily', v),
    setColor: (v: string) => write('color', v),
  }
}

export type TextAlignValue = 'left' | 'center' | 'right'

/** The text alignments, in the order the rail toolbar's one button cycles them. */
export const TEXT_ALIGNS: ReadonlyArray<{ value: TextAlignValue; Icon: typeof AlignLeft; label: string }> = [
  { value: 'left', Icon: AlignLeft, label: 'Align left' },
  { value: 'center', Icon: AlignCenter, label: 'Align center' },
  { value: 'right', Icon: AlignRight, label: 'Align right' },
]

/** The text colour: a native colour input over `children` (the swatch the caller draws). */
/** A button that keeps the inline text edit open: no focus taken on press, marked for the editor. */
export function keepEditProps(keep: boolean | undefined) {
  return keep ? { 'data-keep-text-edit': '', onMouseDown: (e: React.MouseEvent) => e.preventDefault() } : {}
}

export function TextColorControl({
  value,
  onChange,
  onOpenPanel,
  className,
  keepTextEdit,
  children,
}: {
  value: string
  onChange: (v: string) => void
  /** The rail layout: the control opens the colour panel instead of the OS picker. */
  onOpenPanel?: () => void
  className?: string
  /** A press keeps the inline text edit (and its selection) open: a range is selected. */
  keepTextEdit?: boolean
  children: ReactNode
}) {
  if (onOpenPanel) {
    return (
      <button type="button" className={className} title="Text color" aria-label="Text color" onClick={onOpenPanel} {...keepEditProps(keepTextEdit)}>
        {children}
      </button>
    )
  }
  return (
    <label className={`${className ?? ''} relative cursor-pointer`} title="Text color">
      {children}
      <input
        type="color"
        value={value.length === 9 ? value.slice(0, 7) : value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="Text color"
      />
    </label>
  )
}

export function TextFormattingToolbar({
  slideId,
  element,
  updateOverlayProp,
  onDelete,
  mode = 'dark',
}: TextFormattingToolbarProps) {
  const fmt = textFormatting(slideId, element, updateOverlayProp)
  const { supported, boldActive, italicActive, caseActive, currentAlign, fontSizeValue, fontFamilyValue, colorValue } = fmt
  const props = element.overlay.props

  // `text` is content, not a toolbar control — it's edited inline. A non-compliant
  // overlay that happens to carry a `text` key (sometimes with a garbage value
  // like a color hex left over from legacy naming) would otherwise hide the
  // fallback hint and leave the operator staring at an empty toolbar.
  const hasAnyControlProp = [...supported].some((k) => k !== 'text')
  const textTransformDisplay = typeof props.textTransform === 'string' ? props.textTransform : 'none'

  // Themed toggle styles: consistent square buttons. Active = solid accent fill
  // with accent-foreground text; inactive = themed surface + border that hovers
  // toward the surface tone. One look for B / I / case / align across the bar.
  const toolbarBtnBase = 'flex h-7 min-w-[1.75rem] items-center justify-center rounded-md border px-1.5 text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]'
  const toolbarBtnActive = 'border-[var(--editor-accent)] bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)]'
  const toolbarBtnInactive = 'border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)] hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)]'

  // Segment visibility helpers — group toggles vs size/font vs alignment.
  const hasLeftGroup = supported.has('fontWeight') || supported.has('fontStyle') || supported.has('textTransform') || supported.has('color') || supported.has('bgColor')
  const hasMidGroup = supported.has('fontSize') || supported.has('fontFamily')

  return (
    <div
      role="presentation"
      className="rounded-lg border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)] shadow-md"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 p-2"
      >
        {/* Segment 1: B / I / case / text color / text background */}
        {hasLeftGroup && (
          <div className="flex items-center gap-1">
            {supported.has('fontWeight') && (
              <button
                type="button"
                aria-label="Bold"
                aria-pressed={boldActive}
                onClick={fmt.toggleBold}
                className={`${toolbarBtnBase} ${boldActive ? toolbarBtnActive : toolbarBtnInactive}`}
              >
                <Bold className="h-3.5 w-3.5" />
              </button>
            )}

            {supported.has('fontStyle') && (
              <button
                type="button"
                aria-label="Italic"
                aria-pressed={italicActive}
                onClick={fmt.toggleItalic}
                className={`${toolbarBtnBase} ${italicActive ? toolbarBtnActive : toolbarBtnInactive}`}
              >
                <Italic className="h-3.5 w-3.5" />
              </button>
            )}

            {supported.has('textTransform') && (
              <button
                type="button"
                aria-label={`Text case (currently ${textTransformDisplay})`}
                onClick={fmt.cycleCase}
                className={`${toolbarBtnBase} font-mono text-xs ${caseActive ? toolbarBtnActive : toolbarBtnInactive}`}
              >
                {caseLabel(props.textTransform)}
              </button>
            )}

            {supported.has('color') && (
              <TextColorControl value={colorValue} onChange={fmt.setColor} className={`${toolbarBtnBase} ${toolbarBtnInactive}`}>
                <span
                  className="block h-4 w-4 rounded-sm border border-[var(--editor-border)]"
                  style={{ backgroundColor: colorValue }}
                  aria-hidden
                />
              </TextColorControl>
            )}

            {supported.has('bgColor') && (
              <TextBackgroundControl
                slideId={slideId}
                element={element}
                updateOverlayProp={updateOverlayProp}
              />
            )}
          </div>
        )}

        {/* Segment 2: size + font */}
        {hasMidGroup && (
          <div className="flex items-center gap-1.5">
            {supported.has('fontSize') && (
              <FontSizePicker
                value={fontSizeValue}
                onChange={fmt.setFontSize}
              />
            )}

            {supported.has('fontFamily') && (
              <FontFamilyPicker
                value={fontFamilyValue}
                onChange={fmt.setFontFamily}
                className="w-32"
              />
            )}
          </div>
        )}

        {/* Segment 3: alignment */}
        {supported.has('textAlign') && (
          <div role="radiogroup" aria-label="Text alignment" className="flex items-center gap-1">
            {TEXT_ALIGNS.map(({ value, Icon, label }) => {
              const checked = currentAlign === value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={label}
                  onClick={() => fmt.setAlign(value)}
                  className={`${toolbarBtnBase} ${checked ? toolbarBtnActive : toolbarBtnInactive}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            })}
          </div>
        )}

        {!hasAnyControlProp && (
          <span className="px-1 py-1 text-xs text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]">
            Edit via property panel
          </span>
        )}

        {onDelete && (
          <button
            type="button"
            aria-label="Delete text overlay"
            onClick={onDelete}
            className={`${toolbarBtnBase} border-[var(--editor-border)] bg-[var(--editor-surface)] text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] ${mode === 'light' ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700' : 'hover:border-red-500/50 hover:bg-red-900/30 hover:text-red-400'}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

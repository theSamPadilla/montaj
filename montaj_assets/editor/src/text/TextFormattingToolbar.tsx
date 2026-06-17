import { Bold, Italic, AlignLeft, AlignCenter, AlignRight, Trash2 } from 'lucide-react'
import type { OverlayElement } from '../types'
import { FontFamilyPicker, FontSizePicker } from './FontPicker'
import { getSupportedProps, readPropAsString } from '../overlays/contract'

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

function caseLabel(current: unknown): string {
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
}

export function TextFormattingToolbar({
  slideId,
  element,
  updateOverlayProp,
  onDelete,
}: TextFormattingToolbarProps) {
  const props = element.overlay.props

  const supported = getSupportedProps(element)
  // `text` is content, not a toolbar control — it's edited inline. A non-compliant
  // overlay that happens to carry a `text` key (sometimes with a garbage value
  // like a color hex left over from legacy naming) would otherwise hide the
  // fallback hint and leave the operator staring at an empty toolbar.
  const hasAnyControlProp = [...supported].some((k) => k !== 'text')

  const boldActive = isBold(props.fontWeight)
  const italicActive = isItalic(props.fontStyle)
  const caseActive = props.textTransform !== undefined && props.textTransform !== 'none'
  const currentAlign = typeof props.textAlign === 'string' ? props.textAlign : undefined
  const textTransformDisplay = typeof props.textTransform === 'string' ? props.textTransform : 'none'

  const handleBoldClick = () => void updateOverlayProp(slideId, element.id, 'fontWeight', boldActive ? '400' : '700')
  const handleItalicClick = () => void updateOverlayProp(slideId, element.id, 'fontStyle', italicActive ? 'normal' : 'italic')
  const handleCaseClick = () => void updateOverlayProp(slideId, element.id, 'textTransform', nextCase(props.textTransform))
  const handleAlignClick = (v: 'left' | 'center' | 'right') => void updateOverlayProp(slideId, element.id, 'textAlign', v)
  const handleFontSizeChange = (v: string) => void updateOverlayProp(slideId, element.id, 'fontSize', v)
  const handleFontFamilyChange = (v: string) => void updateOverlayProp(slideId, element.id, 'fontFamily', v)
  const handleColorChange = (v: string) => void updateOverlayProp(slideId, element.id, 'color', v)

  const fontSizeValue = readPropAsString(element, 'fontSize')
  const fontFamilyValue = readPropAsString(element, 'fontFamily')
  const rawColor = readPropAsString(element, 'color')
  const colorValue = HEX_PATTERN.test(rawColor) && rawColor.length === 7 ? rawColor : '#111111'

  // Themed toggle styles: consistent square buttons. Active = solid accent fill
  // with accent-foreground text; inactive = themed surface + border that hovers
  // toward the surface tone. One look for B / I / case / align across the bar.
  const toolbarBtnBase = 'flex h-7 min-w-[1.75rem] items-center justify-center rounded-md border px-1.5 text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]'
  const toolbarBtnActive = 'border-[var(--editor-accent)] bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)]'
  const toolbarBtnInactive = 'border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)]'

  // Segment visibility helpers — group toggles vs size/font vs alignment.
  const hasLeftGroup = supported.has('fontWeight') || supported.has('fontStyle') || supported.has('textTransform') || supported.has('color')
  const hasMidGroup = supported.has('fontSize') || supported.has('fontFamily')

  return (
    <div
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
        {/* Segment 1: B / I / case / color toggles */}
        {hasLeftGroup && (
          <div className="flex items-center gap-1">
            {supported.has('fontWeight') && (
              <button
                type="button"
                aria-label="Bold"
                aria-pressed={boldActive}
                onClick={handleBoldClick}
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
                onClick={handleItalicClick}
                className={`${toolbarBtnBase} ${italicActive ? toolbarBtnActive : toolbarBtnInactive}`}
              >
                <Italic className="h-3.5 w-3.5" />
              </button>
            )}

            {supported.has('textTransform') && (
              <button
                type="button"
                aria-label={`Text case (currently ${textTransformDisplay})`}
                onClick={handleCaseClick}
                className={`${toolbarBtnBase} font-mono text-xs ${caseActive ? toolbarBtnActive : toolbarBtnInactive}`}
              >
                {caseLabel(props.textTransform)}
              </button>
            )}

            {supported.has('color') && (
              <label
                className={`${toolbarBtnBase} ${toolbarBtnInactive} relative cursor-pointer`}
                title="Text color"
              >
                <span
                  className="block h-4 w-4 rounded-sm border border-[var(--editor-border)]"
                  style={{ backgroundColor: colorValue }}
                  aria-hidden
                />
                <input
                  type="color"
                  value={colorValue}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Text color"
                />
              </label>
            )}
          </div>
        )}

        {/* Segment 2: size + font */}
        {hasMidGroup && (
          <div className="flex items-center gap-1.5">
            {supported.has('fontSize') && (
              <FontSizePicker
                value={fontSizeValue}
                onChange={handleFontSizeChange}
              />
            )}

            {supported.has('fontFamily') && (
              <FontFamilyPicker
                value={fontFamilyValue}
                onChange={handleFontFamilyChange}
                className="w-32"
              />
            )}
          </div>
        )}

        {/* Segment 3: alignment */}
        {supported.has('textAlign') && (
          <div role="radiogroup" aria-label="Text alignment" className="flex items-center gap-1">
            {(
              [
                { value: 'left', Icon: AlignLeft, label: 'Align left' },
                { value: 'center', Icon: AlignCenter, label: 'Align center' },
                { value: 'right', Icon: AlignRight, label: 'Align right' },
              ] as const
            ).map(({ value, Icon, label }) => {
              const checked = currentAlign === value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={label}
                  onClick={() => handleAlignClick(value)}
                  className={`${toolbarBtnBase} ${checked ? toolbarBtnActive : toolbarBtnInactive}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            })}
          </div>
        )}

        {!hasAnyControlProp && (
          <span className="px-1 py-1 text-xs text-[var(--editor-text)]/55">
            Edit via property panel
          </span>
        )}

        {onDelete && (
          <button
            type="button"
            aria-label="Delete text overlay"
            onClick={onDelete}
            className={`${toolbarBtnBase} border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/60 hover:border-red-500/50 hover:bg-red-900/30 hover:text-red-400`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

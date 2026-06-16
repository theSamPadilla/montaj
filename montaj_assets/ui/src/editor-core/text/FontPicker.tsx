import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export type FontOption = {
  label: string
  value: string
  isGoogleFont: boolean
}

export const FONT_OPTIONS: FontOption[] = [
  { label: 'System', value: 'system-ui, -apple-system, "Helvetica Neue", sans-serif', isGoogleFont: false },
  { label: 'Inter', value: '"Inter", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Roboto', value: '"Roboto", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Open Sans', value: '"Open Sans", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Lato', value: '"Lato", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Montserrat', value: '"Montserrat", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Poppins', value: '"Poppins", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Raleway', value: '"Raleway", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Nunito', value: '"Nunito", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Work Sans', value: '"Work Sans", system-ui, sans-serif', isGoogleFont: true },
  { label: 'DM Sans', value: '"DM Sans", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Rubik', value: '"Rubik", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Oswald', value: '"Oswald", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Bebas Neue', value: '"Bebas Neue", system-ui, sans-serif', isGoogleFont: true },
  { label: 'Playfair Display', value: '"Playfair Display", Georgia, serif', isGoogleFont: true },
  { label: 'Merriweather', value: '"Merriweather", Georgia, serif', isGoogleFont: true },
  { label: 'Source Serif 4', value: '"Source Serif 4", Georgia, serif', isGoogleFont: true },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, monospace', isGoogleFont: true },
]

const GOOGLE_FONTS_URL = (() => {
  const params = FONT_OPTIONS
    .filter((f) => f.isGoogleFont)
    .map((f) => `family=${f.label.replace(/ /g, '+')}:wght@400;700`)
    .join('&')
  return `https://fonts.googleapis.com/css2?${params}&display=swap`
})()

let fontsInjected = false
function ensureGoogleFontsLoaded(): void {
  if (fontsInjected || typeof document === 'undefined') return
  fontsInjected = true
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = GOOGLE_FONTS_URL
  document.head.appendChild(link)
}

function firstFontToken(value: string): string {
  return value.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase()
}

export function findFontOption(cssValue: string): FontOption | null {
  if (!cssValue) return null
  const key = firstFontToken(cssValue)
  return FONT_OPTIONS.find((opt) => firstFontToken(opt.value) === key) ?? null
}

type FontFamilyPickerProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  buttonClassName?: string
}

export function FontFamilyPicker({ value, onChange, disabled, className, buttonClassName }: FontFamilyPickerProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    ensureGoogleFontsLoaded()
  }, [])

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const current = findFontOption(value)
  const displayLabel = current?.label ?? (value ? 'Custom' : 'Default')
  const displayStyle = current ? { fontFamily: current.value } : undefined

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={
          buttonClassName ??
          'flex w-full items-center gap-1 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 hover:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50'
        }
        style={displayStyle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Font family"
        title={value || 'Default font'}
      >
        <span className="flex-1 truncate text-left">{displayLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border border-gray-600 bg-gray-800 shadow-xl ring-1 ring-black/20"
        >
          <ul className="py-1">
            {FONT_OPTIONS.map((opt) => {
              const isActive = opt.value === current?.value
              return (
                <li key={opt.label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      onChange(opt.value)
                      setOpen(false)
                    }}
                    style={{ fontFamily: opt.value }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-[15px] leading-tight text-gray-100 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none ${
                      isActive ? 'bg-gray-700 font-medium' : ''
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isActive && (
                      <span
                        className="ml-2 shrink-0 text-xs text-gray-400"
                        style={{ fontFamily: 'system-ui, sans-serif' }}
                      >
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

type FontSizePickerProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  min?: number
  max?: number
  className?: string
}

// Extract the numeric portion of a stored fontSize. Tolerates "25", "25px",
// " 25px ", "25 px", or a bare number. Returns '' when no numeric prefix is
// present so the <input type="number"> can render empty instead of NaN-empty.
function parseFontSizeNumeric(value: string): string {
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(value)
  return m ? m[1] : ''
}

export function FontSizePicker({ value, onChange, disabled, min = 8, max = 9999, className }: FontSizePickerProps) {
  const [local, setLocal] = useState(parseFontSizeNumeric(value))
  const isFocused = useRef(false)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!isFocused.current) setLocal(parseFontSizeNumeric(value))
  }, [value])

  // Commit immediately on every keystroke. Debouncing here is the wrong call
  // for typography — the rendered text is the live preview, so delaying the
  // PUT delays user feedback.
  //
  // CSS font-size requires a unit; a unitless value is invalid and the
  // overlay template falls back to its default. The picker is number-only
  // for the operator, so we attach `px` here before writing — never asking
  // the user to type the unit themselves.
  function commit(next: string): void {
    setLocal(next)
    if (next === '') return
    const outgoing = `${next}px`
    if (outgoing !== value) onChangeRef.current(outgoing)
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={local}
      placeholder="size"
      onChange={(e) => commit(e.target.value)}
      onFocus={() => {
        isFocused.current = true
      }}
      onBlur={() => {
        isFocused.current = false
      }}
      className={
        className ??
        'w-14 rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50'
      }
      aria-label="Font size"
    />
  )
}

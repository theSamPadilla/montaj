import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export type FontOption = {
  label: string
  value: string
  isGoogleFont: boolean
  /** The `googleFonts` fetch spec for this family (e.g. 'Baloo+2:wght@400;700').
   *  A caller that persists `fontFamily` must persist this alongside it — a
   *  family whose file is never fetched renders as the fallback face. Absent
   *  for the non-Google System option. */
  spec?: string
}

// No spec below requests a weight above 800, even though `highlight-box` and
// `outline` (captionStyleDefaults.ts) default to 900 — deliberate, not an
// oversight. Requesting a weight a family doesn't publish makes Google Fonts
// drop that family from the returned CSS ENTIRELY, so a synthesized
// (browser-faked) 900 is strictly better than a font that silently fails to
// load. Do not "fix" this by adding 900 to any spec.
export const FONT_OPTIONS: FontOption[] = [
  { label: 'System', value: 'system-ui, -apple-system, "Helvetica Neue", sans-serif', isGoogleFont: false },
  { label: 'Inter', value: '"Inter", system-ui, sans-serif', isGoogleFont: true, spec: 'Inter:wght@400;700' },
  { label: 'Roboto', value: '"Roboto", system-ui, sans-serif', isGoogleFont: true, spec: 'Roboto:wght@400;700' },
  { label: 'Open Sans', value: '"Open Sans", system-ui, sans-serif', isGoogleFont: true, spec: 'Open+Sans:wght@400;700' },
  { label: 'Lato', value: '"Lato", system-ui, sans-serif', isGoogleFont: true, spec: 'Lato:wght@400;700' },
  { label: 'Montserrat', value: '"Montserrat", system-ui, sans-serif', isGoogleFont: true, spec: 'Montserrat:wght@400;700' },
  { label: 'Poppins', value: '"Poppins", system-ui, sans-serif', isGoogleFont: true, spec: 'Poppins:wght@400;700' },
  { label: 'Raleway', value: '"Raleway", system-ui, sans-serif', isGoogleFont: true, spec: 'Raleway:wght@400;700' },
  { label: 'Nunito', value: '"Nunito", system-ui, sans-serif', isGoogleFont: true, spec: 'Nunito:wght@400;700' },
  { label: 'Work Sans', value: '"Work Sans", system-ui, sans-serif', isGoogleFont: true, spec: 'Work+Sans:wght@400;700' },
  { label: 'DM Sans', value: '"DM Sans", system-ui, sans-serif', isGoogleFont: true, spec: 'DM+Sans:wght@400;700' },
  { label: 'Rubik', value: '"Rubik", system-ui, sans-serif', isGoogleFont: true, spec: 'Rubik:wght@400;700' },
  { label: 'Oswald', value: '"Oswald", system-ui, sans-serif', isGoogleFont: true, spec: 'Oswald:wght@400;700' },
  { label: 'Bebas Neue', value: '"Bebas Neue", system-ui, sans-serif', isGoogleFont: true, spec: 'Bebas+Neue:wght@400;700' },
  { label: 'Playfair Display', value: '"Playfair Display", Georgia, serif', isGoogleFont: true, spec: 'Playfair+Display:wght@400;700' },
  { label: 'Merriweather', value: '"Merriweather", Georgia, serif', isGoogleFont: true, spec: 'Merriweather:wght@400;700' },
  { label: 'Source Serif 4', value: '"Source Serif 4", Georgia, serif', isGoogleFont: true, spec: 'Source+Serif+4:wght@400;700' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, monospace', isGoogleFont: true, spec: 'JetBrains+Mono:wght@400;700' },
  // Rounded / display group — approved for the @cruxthedoberman account.
  { label: 'Baloo 2', value: '"Baloo 2", system-ui, sans-serif', isGoogleFont: true, spec: 'Baloo+2:wght@400;500;600;700;800' },
  { label: 'Fredoka', value: '"Fredoka", system-ui, sans-serif', isGoogleFont: true, spec: 'Fredoka:wght@300;400;500;600;700' },
  { label: 'Sniglet', value: '"Sniglet", system-ui, sans-serif', isGoogleFont: true, spec: 'Sniglet:wght@400;800' },
]

// Fetches exactly the weights each family publishes, via the `spec` carried
// on every Google-font option — the same spec a caller persists alongside
// fontFamily. Falls back to the old label-derived guess only if `spec` is
// somehow missing, so a stale/partial FontOption still resolves to a URL.
// The list is now a slightly bigger stylesheet than the old flat
// wght@400;700-everywhere version (Baloo 2/Fredoka/Sniglet pull in
// 300/500/600/800), but that's the correct trade: the picker preview and
// the persisted spec fetch identical weights, so what you see in the
// dropdown is what actually renders.
const GOOGLE_FONTS_URL = (() => {
  const params = FONT_OPTIONS
    .filter((f) => f.isGoogleFont)
    .map((f) => `family=${f.spec ?? `${f.label.replace(/ /g, '+')}:wght@400;700`}`)
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
          'flex h-8 w-full items-center gap-1 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2.5 text-sm text-[var(--editor-text)] hover:border-[var(--editor-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)] disabled:opacity-50'
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
          className="absolute right-0 z-50 mt-1 max-h-80 w-60 overflow-y-auto rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] shadow-xl ring-1 ring-black/20"
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
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-[15px] leading-tight text-[var(--editor-text)] hover:bg-[var(--editor-accent)]/20 focus:bg-[var(--editor-accent)]/20 focus:outline-none ${
                      isActive ? 'bg-[var(--editor-accent)]/20 font-medium' : ''
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isActive && (
                      <span
                        className="ml-2 shrink-0 text-xs text-[var(--editor-text)]/60"
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
        'h-8 w-14 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2.5 text-sm text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)] focus:ring-1 focus:ring-[var(--editor-accent)] disabled:opacity-50'
      }
      aria-label="Font size"
    />
  )
}

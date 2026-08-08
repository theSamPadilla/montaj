import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Palette } from 'lucide-react'
import { IMAGE_TONES, DEFAULT_IMAGE_TONE, type ImageTone } from './imageTone'
import { TONE_EXAMPLES } from './imageToneExamples'

export interface ImageToneMenuProps {
  /** Currently selected tone (undefined resolves to the default). */
  value: ImageTone | undefined
  /** Persist a new tone into project settings. */
  onChange: (tone: ImageTone) => void
  /**
   * Presentation:
   *   'icon'   - compact palette icon button, menu opens upward. Fits the
   *              editor's bottom toolbar (the package-internal fallback).
   *   'header' - labeled pill showing the current tone, menu opens downward.
   *              For host chrome at the top of the page.
   */
  variant?: 'icon' | 'header'
}

/**
 * Popover for choosing the image color mapping of HDR renders.
 *
 * Rendered only for HDR projects (the tone has no effect on SDR renders; the
 * caller gates on settings.colorSpace). Each option shows an example: the same
 * generic photo converted through the actual render pipeline under that mode.
 */
export default function ImageToneMenu({ value, onChange, variant = 'icon' }: ImageToneMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const current = value ?? DEFAULT_IMAGE_TONE
  const currentInfo = IMAGE_TONES.find(t => t.id === current) ?? IMAGE_TONES[0]

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const menuPosition = variant === 'header'
    ? 'absolute right-0 top-9'
    : 'absolute right-0 bottom-7'

  return (
    <div ref={rootRef} className="relative">
      {variant === 'header' ? (
        <button
          onClick={() => setOpen(o => !o)}
          title="How photos and logos are converted for the HDR render"
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] text-[var(--editor-text)]/80 hover:text-[var(--editor-text)] transition-colors"
        >
          <Palette size={12} className="opacity-70" />
          <span className="opacity-60">Image color:</span>
          <span className="font-semibold">{currentInfo.label}</span>
          <ChevronDown size={12} className="opacity-60" />
        </button>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          title="Image color mapping: how photos and logos are converted for the HDR render"
          aria-pressed={open}
          aria-haspopup="menu"
          className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
            open
              ? 'text-violet-400 bg-violet-400/15 hover:bg-violet-400/25'
              : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
          }`}
        >
          <Palette size={12} />
        </button>
      )}

      {open && (
        <div
          role="menu"
          className={`${menuPosition} z-40 w-[300px] rounded-xl border border-[var(--editor-border)] bg-[var(--editor-surface)] shadow-2xl p-2 flex flex-col gap-1`}
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold text-[var(--editor-text)]/80">
            Image color mapping
            <span className="block font-normal text-[10px] text-[var(--editor-text)]/50">
              How photos and logos are converted for the HDR render.
            </span>
          </p>
          {IMAGE_TONES.map(tone => {
            const active = tone.id === current
            return (
              <button
                key={tone.id}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { onChange(tone.id); setOpen(false) }}
                className={`flex items-start gap-2.5 rounded-lg p-2 text-left transition-colors border ${
                  active
                    ? 'border-violet-400/60 bg-violet-400/10'
                    : 'border-transparent hover:bg-[var(--editor-text)]/5'
                }`}
              >
                <img
                  src={TONE_EXAMPLES[tone.id]}
                  alt={`${tone.label} example`}
                  className="w-[88px] h-[53px] rounded-md object-cover shrink-0 border border-[var(--editor-border)]"
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-semibold text-[var(--editor-text)] flex items-center gap-1.5">
                    {tone.label}
                    {tone.id === DEFAULT_IMAGE_TONE && (
                      <span className="text-[9px] font-normal px-1 py-px rounded bg-[var(--editor-text)]/10 text-[var(--editor-text)]/55">default</span>
                    )}
                  </span>
                  <span className="text-[10px] leading-snug text-[var(--editor-text)]/60">
                    {tone.summary}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ColourRequest } from '../ui'
import { fieldLabelClass } from './ElementControls'
import { normalizeHex, splitAlpha, withAlphaHex } from './colours'

// The colour panel (§587 M5): it takes the rail layout's side panel while a
// colour is being picked. Hex, transparency, the brand palette, this carousel's
// colours, and "Change on every slide". A swatch or a typed hex writes once; the
// slider previews and writes once on release; Esc reverts what is uncommitted.

export interface ColourPanelProps {
  request: ColourRequest
  /** The target is locked: the colour shows, nothing changes. */
  disabled: boolean
  brandColours: string[]
  usedColours: string[]
  /** "Change on every slide": show `to` in place of `from` everywhere (a transient preview). */
  onPreviewEverywhere: (from: string, to: string) => void
  /** Write that replacement: one undo step. */
  onCommitEverywhere: (from: string, to: string) => void
  /** Give up the transient preview. */
  onDiscardPreview: () => void
  onClose: () => void
}

/** The header: the control's label, in the editor's spelling ("color"). */
export function colourTitle(label: string): string {
  return label
}

const swatchBtn =
  'h-7 w-7 rounded-md border border-[var(--editor-border)] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40'
const fieldClass =
  'h-8 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2 text-sm text-[var(--editor-text)] focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)] disabled:opacity-40'

export default function ColourPanel({
  request, disabled, brandColours, usedColours, onPreviewEverywhere, onCommitEverywhere, onDiscardPreview, onClose,
}: ColourPanelProps) {
  const alphaOk = request.alpha === true
  // `current` is the colour the target holds (what "every slide" replaces); `draft`
  // is what the fields show; `dirty` is an uncommitted preview.
  const [current, setCurrent] = useState(request.value)
  const [draft, setDraft] = useState(request.value)
  const [hexText, setHexText] = useState(request.value)
  const [everywhere, setEverywhere] = useState(false)
  const dirty = useRef(false)
  const rootRef = useRef<HTMLElement>(null)
  const live = useRef({ current, everywhere })
  live.current = { current, everywhere }
  // The latest props, for the unmount cleanup below.
  const latest = useRef({ request, onDiscardPreview })
  latest.current = { request, onDiscardPreview }

  const norm = (v: string) => normalizeHex(v) ?? v
  const fit = (v: string) => {
    const n = normalizeHex(v)
    if (!n) return null
    return alphaOk || n.length === 7 ? n : n.slice(0, 7)
  }

  function preview(v: string) {
    setDraft(v)
    setHexText(v)
    dirty.current = true
    if (live.current.everywhere) onPreviewEverywhere(live.current.current, v)
    else request.preview?.(v)
  }
  function commit(v: string) {
    if (disabled) return
    const same = norm(v) === norm(live.current.current)
    if (!same) {
      if (live.current.everywhere) {
        onPreviewEverywhere(live.current.current, v)
        onCommitEverywhere(live.current.current, v)
      } else {
        request.preview?.(v)
        request.commit(v)
      }
    } else if (dirty.current) {
      revert()
    }
    dirty.current = false
    setCurrent(v)
    setDraft(v)
    setHexText(v)
  }
  function revert() {
    if (!dirty.current) return
    dirty.current = false
    if (live.current.everywhere) onDiscardPreview()
    else {
      request.preview?.(live.current.current)
      request.cancel?.()
    }
    setDraft(live.current.current)
    setHexText(live.current.current)
  }

  // Esc reverts an uncommitted preview and closes; so does closing by the button.
  const closeRef = useRef(() => {})
  closeRef.current = () => { revert(); onClose() }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc in a field outside the panel stays that field's.
      const t = e.target
      if (
        t instanceof HTMLElement &&
        !rootRef.current?.contains(t) &&
        (t.isContentEditable || t.closest('input, textarea, select, [contenteditable="true"]'))
      ) return
      e.stopPropagation()
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    // The panel goes (selection moved, another rail item): a preview left open is given up.
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (dirty.current) {
        dirty.current = false
        if (live.current.everywhere) latest.current.onDiscardPreview()
        else {
          latest.current.request.preview?.(live.current.current)
          latest.current.request.cancel?.()
        }
      }
    }
  }, [])

  const { base, alpha } = splitAlpha(fit(draft) ?? draft)
  const pct = Math.round((1 - alpha) * 100)
  const applyHexText = () => {
    const n = fit(hexText)
    if (!n) { setHexText(draft); return }
    commit(n)
  }
  const setTransparency = (p: number) => preview(withAlphaHex(base, 1 - Math.min(100, Math.max(0, p)) / 100))
  const releaseSlider = () => { if (dirty.current) commit(fit(draft) ?? draft) }

  const swatches = (title: string, colours: string[], kind: string) => (
    <section key={title} className="flex flex-col gap-2" aria-label={title}>
      <span className={fieldLabelClass}>{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {colours.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-label={`${kind} color ${c}`}
            title={c}
            className={swatchBtn}
            style={{ backgroundColor: c }}
            onClick={() => commit(fit(c) ?? c)}
          />
        ))}
      </div>
    </section>
  )

  return (
    <section ref={rootRef} aria-label="Colour panel" className="flex min-h-0 flex-col">
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--editor-border)] px-3">
        <h2 className="text-sm font-semibold">{colourTitle(request.label)}</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeRef.current()}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--editor-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-4 p-3">
        {brandColours.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => commit(fit(brandColours[0]) ?? brandColours[0])}
            className="flex h-9 items-center gap-2 rounded-md border border-[var(--editor-accent)] bg-[color-mix(in_srgb,var(--editor-accent)_15%,transparent)] px-3 text-[13px] font-medium text-[var(--editor-text)] hover:bg-[color-mix(in_srgb,var(--editor-accent)_25%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true" className="h-4 w-4 flex-shrink-0 rounded-sm border border-[var(--editor-border)]" style={{ backgroundColor: brandColours[0] }} />
            Use brand default
          </button>
        )}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="colour-hex" className={fieldLabelClass}>Hex</label>
            <input
              id="colour-hex"
              type="text"
              aria-label="Hex"
              disabled={disabled}
              value={hexText}
              spellCheck={false}
              className={`${fieldClass} w-full font-mono uppercase`}
              onChange={(e) => setHexText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.stopPropagation(); applyHexText() }
              }}
              onBlur={() => { if (hexText !== draft) applyHexText() }}
            />
          </div>
          <span aria-hidden="true" className="h-8 w-8 flex-shrink-0 rounded-md border border-[var(--editor-border)]" style={{ backgroundColor: draft }} />
        </div>

        {alphaOk && (
          <div className="flex flex-col gap-1">
            <span className={fieldLabelClass}>Transparency</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                aria-label="Transparency"
                min={0}
                max={100}
                step={1}
                disabled={disabled}
                value={pct}
                className="min-w-0 flex-1 accent-[var(--editor-accent)]"
                onChange={(e) => setTransparency(Number(e.target.value))}
                onPointerUp={releaseSlider}
                onMouseUp={releaseSlider}
                onKeyUp={releaseSlider}
                onBlur={releaseSlider}
              />
              <input
                type="number"
                aria-label="Transparency percent"
                min={0}
                max={100}
                disabled={disabled}
                value={pct}
                className={`${fieldClass} w-16`}
                onChange={(e) => { if (e.target.value !== '') setTransparency(Number(e.target.value)) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); releaseSlider() } }}
                onBlur={releaseSlider}
              />
            </div>
          </div>
        )}

        {brandColours.length > 0 && swatches('Brand', brandColours, 'Brand')}
        {usedColours.length > 0 && swatches('In this carousel', usedColours, 'In this carousel')}

        <button
          type="button"
          aria-pressed={everywhere}
          disabled={disabled}
          onClick={() => { revert(); setEverywhere((e) => !e) }}
          className={`h-8 rounded-md border px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)] disabled:cursor-not-allowed disabled:opacity-40 ${
            everywhere
              ? 'border-[var(--editor-accent)] bg-[color-mix(in_srgb,var(--editor-accent)_15%,transparent)] text-[var(--editor-accent-text,var(--editor-accent))]'
              : 'border-[var(--editor-border)] text-[var(--editor-text)] hover:bg-[var(--editor-surface)]'
          }`}
        >
          Change on every slide
        </button>
      </div>
    </section>
  )
}

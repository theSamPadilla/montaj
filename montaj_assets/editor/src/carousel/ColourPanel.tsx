import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ColourRequest } from '../ui'
import { cn } from '../ui'
import { fieldLabelClass } from './ElementControls'
import { railBrandRow, railFaint, railField, railIconBtn, railInvalid, railSecondaryBtn, railSwatch, railTitle } from './railStyles'
import { DEFAULT_SOLIDS, normalizeHex, resolveColourQuery, splitAlpha, withAlphaHex } from './colours'
import { namedColour } from './colourNames'

// The colour panel (§587 M5, sections §587 R9): it takes the rail layout's side
// panel while a colour is being picked. Top to bottom: a search field (a colour
// name or a hex), the target's own colours with its hex, transparency and
// "Change on every slide", this carousel's colours, the brand palette ("Use
// brand default" first), the slide's photo colours, and the default solids.
// A swatch, a search or a typed hex writes once; the slider previews and writes
// once on release; Esc reverts what is uncommitted.

/** One image on the slide and its dominant colours. */
export interface PhotoColours {
  src: string
  colours: string[]
}

export interface ColourPanelProps {
  request: ColourRequest
  /** The target is locked: the colour shows, nothing changes. */
  disabled: boolean
  brandColours: string[]
  usedColours: string[]
  /** The target element's own colours (the current one among them); none for the slide. */
  targetColours?: string[]
  /** The slide's images and their colours; an image with none is not listed. */
  photoColours?: PhotoColours[]
  /** The colour the panel shows now (each preview, pick and revert): the toolbar swatch follows it. */
  onShow?: (value: string) => void
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

const swatchBtn = `${railSwatch} h-7 w-7`
const fieldClass = `${railField} h-8`

export default function ColourPanel({
  request, disabled, brandColours, usedColours, targetColours = [], photoColours = [], onShow, onPreviewEverywhere, onCommitEverywhere, onDiscardPreview, onClose,
}: ColourPanelProps) {
  const alphaOk = request.alpha === true
  // `current` is the colour the target holds (what "every slide" replaces); `draft`
  // is what the fields show; `dirty` is an uncommitted preview.
  const [current, setCurrent] = useState(request.value)
  const [draft, setDraft] = useState(request.value)
  const [hexText, setHexText] = useState(request.value)
  const [everywhere, setEverywhere] = useState(false)
  const [query, setQuery] = useState('')
  const [queryBad, setQueryBad] = useState(false)
  const dirty = useRef(false)
  const rootRef = useRef<HTMLElement>(null)
  const live = useRef({ current, everywhere })
  live.current = { current, everywhere }
  // The latest props, for the unmount cleanup below.
  const latest = useRef({ request, onDiscardPreview, onShow })
  latest.current = { request, onDiscardPreview, onShow }
  useEffect(() => { latest.current.onShow?.(draft) }, [draft])

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

  const applyQuery = () => {
    const c = resolveColourQuery(query, namedColour)
    const n = c && fit(c)
    if (!n) { setQueryBad(query.trim() !== ''); return }
    setQuery('')
    setQueryBad(false)
    commit(n)
  }

  const swatch = (c: string, kind: string, pressed?: boolean) => (
    <button
      key={c}
      type="button"
      disabled={disabled}
      aria-label={`${kind} color ${c}`}
      aria-pressed={pressed}
      title={c}
      className={cn(swatchBtn, pressed && 'ring-2 ring-[var(--editor-accent)] ring-offset-2 ring-offset-[var(--editor-bg)]')}
      style={{ backgroundColor: c }}
      onClick={() => commit(fit(c) ?? c)}
    />
  )
  const swatches = (title: string, colours: string[], kind: string) => (
    <section key={title} className="flex flex-col gap-2" aria-label={title}>
      <span className={fieldLabelClass}>{title}</span>
      <div className="flex flex-wrap gap-1.5">{colours.map((c) => swatch(c, kind))}</div>
    </section>
  )
  const shown = norm(fit(draft) ?? draft)
  const photos = photoColours.filter((p) => p.colours.length > 0)

  return (
    <section ref={rootRef} aria-label="Colour panel" className="flex min-h-0 flex-col">
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-[var(--editor-border)] px-3">
        <h2 className={railTitle}>{colourTitle(request.label)}</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeRef.current()}
          className={railIconBtn}
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-5 p-3">
        <div className="relative">
          <Search aria-hidden="true" size={15} className={cn('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2', railFaint)} />
          <input
            type="search"
            aria-label="Search colors"
            aria-invalid={queryBad || undefined}
            placeholder='Try "blue" or "#00b4d8"'
            disabled={disabled}
            value={query}
            spellCheck={false}
            className={cn(fieldClass, 'pl-9', queryBad && railInvalid)}
            onChange={(e) => { setQuery(e.target.value); setQueryBad(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.stopPropagation(); applyQuery() }
            }}
          />
        </div>

        <section aria-label={request.target === 'slide' ? 'This slide' : 'This element'} className="flex flex-col gap-2">
          <span className={fieldLabelClass}>{request.target === 'slide' ? 'This slide' : 'This element'}</span>
          {targetColours.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {targetColours.map((c) => swatch(c, 'This element', norm(fit(c) ?? c) === shown))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              id="colour-hex"
              type="text"
              aria-label="Hex"
              disabled={disabled}
              value={hexText}
              spellCheck={false}
              className={`${fieldClass} font-mono text-[13px] uppercase`}
              onChange={(e) => setHexText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.stopPropagation(); applyHexText() }
              }}
              onBlur={() => { if (hexText !== draft) applyHexText() }}
            />
            <span aria-hidden="true" className="h-8 w-8 flex-shrink-0 rounded-[10px] border border-[var(--editor-border)]" style={{ backgroundColor: draft }} />
          </div>

          {alphaOk && (
            <div className="flex flex-col gap-1 pt-1">
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
                  className={cn(fieldClass, 'w-16')}
                  onChange={(e) => { if (e.target.value !== '') setTransparency(Number(e.target.value)) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); releaseSlider() } }}
                  onBlur={releaseSlider}
                />
              </div>
            </div>
          )}

          <button
            type="button"
            aria-pressed={everywhere}
            disabled={disabled}
            onClick={() => { revert(); setEverywhere((e) => !e) }}
            className={cn(railSecondaryBtn, 'mt-1 self-start', everywhere && 'ring-1 ring-[var(--editor-text)]')}
          >
            Change on every slide
          </button>
        </section>

        {usedColours.length > 0 && swatches('In this carousel', usedColours, 'In this carousel')}

        {brandColours.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="Brand">
            <span className={fieldLabelClass}>Brand</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => commit(fit(brandColours[0]) ?? brandColours[0])}
              className={`${railBrandRow} h-9 gap-2 px-3`}
            >
              <span aria-hidden="true" className="h-4 w-4 flex-shrink-0 rounded-md border border-[var(--editor-border)]" style={{ backgroundColor: brandColours[0] }} />
              Use brand default
            </button>
            <div className="flex flex-wrap gap-1.5">{brandColours.map((c) => swatch(c, 'Brand'))}</div>
          </section>
        )}

        {photos.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="Photo colors">
            <span className={fieldLabelClass}>Photo colors</span>
            {photos.map((p) => (
              <div key={p.src} className="flex flex-wrap items-center gap-1.5">
                <img src={p.src} alt="" aria-hidden="true" className="h-7 w-7 flex-shrink-0 rounded-[10px] border border-[var(--editor-border)] object-cover" />
                {p.colours.map((c) => swatch(c, 'Photo'))}
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2" aria-label="Default colors">
          <span className={fieldLabelClass}>Default colors</span>
          <div className="grid grid-cols-7 gap-1.5">
            {DEFAULT_SOLIDS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={disabled}
                aria-label={`Default color ${c}`}
                title={c}
                className={cn(railSwatch, 'aspect-square w-full')}
                style={{ backgroundColor: c }}
                onClick={() => commit(fit(c) ?? c)}
              />
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

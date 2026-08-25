/**
 * CaptionSpecimen — the live font-and-size specimen strip for the caption
 * styling panel. Shows the ACTIVE WORD from the user's own video (via
 * `captionActiveWord`), rendered in the candidate typeface at a size
 * proportional to the real caption render size, so a font choice is judged
 * against real content and real scale rather than fixed-size placeholder
 * text.
 *
 * This is deliberately NOT a duplicate of `FontFamilyPicker`'s dropdown
 * (src/text/FontPicker.tsx), which already previews every option in its own
 * face, at a small fixed UI size, inside the list itself. This strip is the
 * larger, in-context confirmation of the CURRENT pick — real word, real
 * relative size.
 *
 * Presentational only: takes caption/time/style data in, owns no state
 * beyond the width measurement below, and never touches the project.
 */
import { useEffect, useRef, useState } from 'react'
import type { Captions } from '../schema'
import { activeCaptionWord } from './captionActiveWord'
import { findFontOption } from '../text/FontPicker'
import { CAPTION_STYLE_FONT_FAMILY, CAPTION_STYLE_FONT_WEIGHT } from './captionStyleDefaults'

// Captions render against a fixed 1080-wide frame — a `fontsize` of 46 is
// 46px OF THAT 1080-wide frame, not 46 real screen px (see RENDER_W in
// preview/CaptionPreview.tsx, the source of truth for this constant).
// Duplicated rather than imported: CaptionPreview.tsx is being edited
// elsewhere in this change and must not gain a new export for this.
const RENDER_W = 1080

// Readable floor / blow-out ceiling for the specimen word's on-screen size.
// The floor covers two degenerate cases: before the first ResizeObserver
// callback fires the measured width is 0, and in a test environment where
// no callback ever fires (or jsdom, which never lays anything out) it STAYS
// 0 — both would otherwise compute a 0px, invisible specimen. The ceiling
// keeps an unexpectedly wide host row from blowing the specimen past a
// normal caption-panel row height.
const MIN_SPECIMEN_PX = 11
const MAX_SPECIMEN_PX = 64

export interface CaptionSpecimenProps {
  captions: Captions | undefined
  currentTime: number
  selectedSegmentId?: string
  /** The candidate family being previewed — `captions.fontFamily`, or the
   *  style's default when unset. */
  fontFamily?: string
  /** The caption's real render font size, in project pixels (`captions.fontsize`). */
  fontSize: number
  textTransform?: string
  letterSpacing?: string
  /** `captions.fontWeight` — absent means the active style's own designed
   *  weight (the browser/template default), so leaving this unset is what
   *  the specimen should show for "bold on". */
  fontWeight?: number | string
}

export default function CaptionSpecimen({
  captions,
  currentTime,
  selectedSegmentId,
  fontFamily,
  fontSize,
  textTransform,
  letterSpacing,
  fontWeight,
}: CaptionSpecimenProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [measuredWidth, setMeasuredWidth] = useState(0)

  // Measure the strip's own width so the specimen can be scaled the same way
  // CaptionPreview scales the caption layer: `measuredWidth / RENDER_W`.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      setMeasuredWidth(entry.contentRect.width)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const active = activeCaptionWord(captions, currentTime, selectedSegmentId)

  // Mirrors captionActiveWord's own `currentTime >= seg.start && currentTime
  // < seg.end` predicate (captionActiveWord.ts) rather than importing a
  // helper for it — used only to tell whether the resolved word came from
  // directly under the playhead (some segment is active) or from the
  // selectedSegmentId fallback (activeCaptionWord only reaches for that
  // fallback when no segment is active at all).
  const anySegmentActive = (captions?.segments ?? []).some(
    (seg) => currentTime >= seg.start && currentTime < seg.end,
  )
  const isFallback = !!active && !anySegmentActive

  const scale = measuredWidth / RENDER_W
  const specimenPx = Math.min(MAX_SPECIMEN_PX, Math.max(MIN_SPECIMEN_PX, fontSize * scale))

  const fontOption = fontFamily ? findFontOption(fontFamily) : null
  const familyLabel = fontFamily ? fontOption?.label ?? 'Custom' : 'Default'

  // The specimen must show what will ACTUALLY render, not just what was
  // explicitly picked — `fontWeight`/`fontFamily` are absent by default
  // (each style's own designed weight/face), so falling back to the raw
  // props here would always preview weight 400 in the editor's own UI font,
  // never the style's real look. `captionStyleDefaults.ts` is the duplicated
  // source of truth for what each style's template actually defaults to; a
  // style string this table doesn't recognize (or no `captions` at all)
  // resolves to `undefined` here, same as before this fallback existed.
  const styleDefaultWeight = captions ? CAPTION_STYLE_FONT_WEIGHT[captions.style] : undefined
  const styleDefaultFamily = captions ? CAPTION_STYLE_FONT_FAMILY[captions.style] : undefined
  const resolvedFontWeight = fontWeight ?? styleDefaultWeight
  const resolvedFontFamily = fontFamily ?? styleDefaultFamily

  return (
    <div
      ref={wrapRef}
      data-testid="caption-specimen"
      className="flex flex-col gap-1 rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] px-2.5 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        {active ? (
          <span
            data-testid="caption-specimen-word"
            className="flex-1 min-w-0 truncate leading-tight text-[var(--editor-text)]"
            style={{
              fontFamily: resolvedFontFamily,
              fontSize: `${specimenPx}px`,
              fontWeight: resolvedFontWeight,
              textTransform,
              letterSpacing,
            }}
          >
            {active.word}
          </span>
        ) : (
          <span
            data-testid="caption-specimen-word"
            className="flex-1 min-w-0 truncate text-xs italic text-[var(--editor-text)] opacity-50"
          >
            Move the playhead over a caption to preview it
          </span>
        )}
        {isFallback && (
          <span className="shrink-0 rounded border border-[var(--editor-border)] px-1 py-px text-[9px] text-[var(--editor-text)] opacity-60">
            Selected caption
          </span>
        )}
      </div>

      {/* Family + size stay visible in the empty state too, so the row does
          not change height when the playhead moves on/off a caption. */}
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--editor-text)] opacity-50">
        <span className="truncate">{familyLabel}</span>
        <span aria-hidden="true">&middot;</span>
        <span className="font-mono">{fontSize}px</span>
      </div>
    </div>
  )
}

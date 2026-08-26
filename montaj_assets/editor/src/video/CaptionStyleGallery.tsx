/**
 * CaptionStyleGallery — the Style tab's preset picker: one card per caption
 * style, each a LIVE, animated preview of that style.
 *
 * Replaces the row of text chips (`word-by-word`, `pop`, `karaoke`, …), which
 * asked the operator to know from a kebab-case identifier what seven different
 * animations look like. Each card here runs the SAME JSX template the render
 * engine runs (`render/templates/captions/<style>.jsx`, fetched through the
 * host's `compileOverlay` / `resolveCaptionTemplate` adapter pair, exactly as
 * `preview/CaptionPreview.tsx` does for the active style) against a synthetic
 * four-word sample, so what a card shows is what the export will actually
 * produce.
 *
 * Cost control, in three parts:
 *   - Compiles are kicked off EAGERLY on mount for all seven cards, not on
 *     first hover, so hovering never stutters waiting on a fetch+transpile.
 *   - Compiled factories are cached per template src (see `templateCache`), so
 *     re-mounting the gallery — every switch back to the Style tab — is free.
 *   - The per-frame `requestAnimationFrame` loop runs ONLY while a card is
 *     hovered. Seven templates re-rendering at 30fps forever would burn the
 *     main thread the whole time the panel is open; an unhovered card is a
 *     static poster frame and costs nothing.
 *
 * A host with no overlay compiler (Hub / LP) degrades to a static
 * `CaptionSpecimen` per card rather than breaking — same graceful-absence
 * contract `CaptionPreview` already honours for `resolveCaptionTemplate`.
 */
import { useEffect, useRef, useState } from 'react'
import type { CaptionSegment, Captions } from '../schema'
import type { OverlayFactory, Project } from '../types'
import OverlayErrorBoundary from '../carousel/OverlayErrorBoundary'
import { ensureGoogleFontsLoaded } from '../lib/google-fonts'
import CaptionSpecimen from './CaptionSpecimen'
import { CAPTION_STYLE_LETTER_SPACING, CAPTION_STYLE_TEXT_TRANSFORM } from './captionStyleDefaults'

type CaptionStyle = Captions['style']
type CompileOverlay = (src: string) => Promise<OverlayFactory>

/** Every caption style, in gallery order — the per-word animated ones first,
 *  the calmer block styles after. Typed against the schema union rather than
 *  as a bare string tuple so adding a style to `Captions['style']` without
 *  adding it here is at least a type error at the `CAPTION_STYLE_LABELS`
 *  record below. This is the single source of truth for the list; the chip row
 *  in `CaptionListPanel.tsx` had its own private copy, which is retired when
 *  this gallery is mounted in its place. */
export const CAPTION_STYLES: readonly CaptionStyle[] = [
  'word-by-word', 'pop', 'karaoke', 'subtitle', 'highlight-box', 'outline', 'clean',
]

/** Human labels for the cards. The kebab-case identifier is a code name, not a
 *  UI string — it went straight onto the old chips only because the chips had
 *  no room for anything better. */
export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = {
  'word-by-word': 'Word by word',
  pop: 'Pop',
  karaoke: 'Karaoke',
  subtitle: 'Subtitle',
  'highlight-box': 'Highlight box',
  outline: 'Outline',
  clean: 'Clean',
}

// The caption templates position themselves against the native render frame
// (percent anchors and `position: fixed` inside a transformed wrapper — see
// `captionOuterStyle` in montaj_assets/overlay-runtime/position.js), so the
// preview layer has to BE that frame and be scaled down, exactly as
// CaptionPreview does. Same constants, same reason.
const RENDER_W = 1080
const RENDER_H = 1920

/** Card geometry. A card is a BAND across the bottom of the frame (BAND_H tall,
 *  ~90px at rail width), not the whole 1080×1920 — the templates all anchor
 *  their text near the bottom edge (`bottom: '25%'` for five, 17% for `clean`,
 *  15% for `subtitle`), so a full-frame thumbnail would be mostly empty and
 *  shrink the text to a few illegible pixels.
 *
 *  All seven caption templates now anchor at the SAME 25% (see
 *  `render/templates/captions/*.jsx`), so one fixed window frames every card
 *  identically — no per-style offset needed. BAND_TOP is tuned so the
 *  full-sentence block styles (five of the seven, two lines at CARD_FONT_SIZE)
 *  sit roughly centred; the two single-word styles (word-by-word, pop) then sit
 *  a touch low, which is fine for a one-word specimen. BAND_H sets the card's
 *  aspect ratio. */
const BAND_TOP = 950
const BAND_H = 720

/** Font size handed to every card's template, overriding both the project's
 *  `fontsize` and each template's own default.
 *
 *  Deliberately NOT faithful: at rail width a card scales the frame by ~1/8,
 *  so a real 46px caption would render at ~6 screen px — unreadable, and
 *  identically unreadable on all seven cards, which defeats the point of a
 *  gallery. Size is chosen elsewhere in this panel (the fontsize slider and
 *  `CaptionSpecimen`, which IS pixel-faithful); a card answers "which
 *  animation", and answers it best when all seven are drawn at one comparable,
 *  legible size.
 *
 *  130 (the two-word-sample value) was trimmed to 108 when the sample grew to
 *  four words: the three block styles that lay every word out at once
 *  (`highlight-box`, `outline`, `subtitle`/`clean`-style full-sentence
 *  layouts) wrap "The quick brown fox" onto two lines inside the card's
 *  crop band (see BAND_TOP), and `highlight-box` — two lines plus its
 *  word-gap — is the tightest: at 130 its top line cleared BAND_TOP by only
 *  ~10px of the 1920-tall frame, one bad font metric from being clipped. 108
 *  restores a comfortable ~72px margin there (measured headlessly against the
 *  fallback sans stack; see the plan's legibility check) while every other
 *  style keeps far more room to spare. This does not protect against an
 *  unusually wide user-chosen Google Font pushing `highlight-box` to a THIRD
 *  line — no font size in a fixed-width card can — but that risk already
 *  existed at two words and two-line wraps are the overwhelming case for
 *  caption-style typefaces. */
const CARD_FONT_SIZE = 108

/** Playback rate for the sample loop. Fixed rather than the project's fps: the
 *  card is a specimen, and every template's animation is defined in seconds
 *  (`t = frame / fps`), so the look is fps-independent. */
const SAMPLE_FPS = 30

/** The sample the cards animate. Four words — "The quick brown fox" — because
 *  two cannot show what distinguishes half these styles: `word-by-word`/`pop`
 *  step through one word at a time and read as a stutter (entrance, hold,
 *  exit, done) rather than as the effect with only one step to take;
 *  `karaoke`'s left-to-right sweep and `highlight-box`/`outline`'s box
 *  hopping both read as a single jump rather than a run across a sentence.
 *  Four words gives every per-word style room to actually demonstrate
 *  itself — CapCut's own style-picker cards use a comparable four-word
 *  sample for the same reason.
 *
 *  The timings are chosen so no template's short-word guard fires: `pop`
 *  only runs its exit fade on words longer than 6 frames, and every word
 *  here is 19.5 frames at 30fps (`SAMPLE_FPS`) — identical to the original
 *  two-word sample's first word — so every card shows the complete entry
 *  AND exit of the animation rather than a clipped one. */
export const SAMPLE_SEGMENT: CaptionSegment = {
  id: 'caption-style-sample',
  text: 'The quick brown fox',
  start: 0,
  end: 2.6,
  words: [
    { word: 'The', start: 0, end: 0.65 },
    { word: 'quick', start: 0.65, end: 1.3 },
    { word: 'brown', start: 1.3, end: 1.95 },
    { word: 'fox', start: 1.95, end: 2.6 },
  ],
}
const SAMPLE_SEGMENTS: CaptionSegment[] = [SAMPLE_SEGMENT]
const SAMPLE_TOTAL_FRAMES = Math.round(SAMPLE_SEGMENT.end * SAMPLE_FPS)

/** Length of one hover loop, in seconds. Longer than the sample (2.6s) on
 *  purpose: the tail leaves the card empty for ~0.4s so the replay reads as a
 *  replay, and so the entrance — which is the whole animation for `subtitle`,
 *  `clean` and `karaoke` — is visible on every pass rather than only the
 *  first. Same 0.4s tail as the original two-word sample, just added onto the
 *  now-longer 2.6s sample. */
const LOOP_SECONDS = 3

/** The still every card shows when it is NOT hovered: 1.0s into the sample,
 *  where all seven have finished their entrance and the SECOND word is the
 *  active one — so a resting card already shows the style's distinguishing
 *  treatment (accent fill, highlight box, karaoke split) rather than a blank
 *  frame or a mid-fade. */
const POSTER_FRAME = Math.round(1.0 * SAMPLE_FPS)

/** Width assumed for a card before/without a real measurement.
 *
 *  `CaptionPreview` renders NOTHING until its ResizeObserver has fired, which
 *  is correct there (it overlays a real player and a wrong scale would put the
 *  caption in the wrong place) but wrong here: jsdom never lays anything out,
 *  and the package's test-setup ResizeObserver stub never fires, so a
 *  null-scale gate would mean the gallery renders no caption at all under test
 *  and every assertion about it would pass vacuously. A card is a
 *  self-contained specimen with nothing to line up against, so it renders
 *  immediately at this nominal width and corrects itself on the first real
 *  measurement. Same reasoning as `CaptionSpecimen`'s MIN/MAX clamps.
 *
 *  The value is one card of a 2-column grid in the ~300px right rail. */
const FALLBACK_CARD_W = 135

/** `Captions.fontsize`'s default, mirroring CaptionListPanel's slider seed.
 *  Used only by the static-specimen fallback, which IS size-faithful. */
const DEFAULT_FONT_SIZE = 46

// ── Compiled-template cache ─────────────────────────────────────────────────
// Module-level, so it survives the gallery unmounting — which happens on every
// switch to the Captions tab — and keyed by template src, which is what
// `compileOverlay` actually consumes.
//
// The cached compiler function is part of the key check, not just the src: a
// host that swaps `compileOverlay` (a re-created adapter, a template hot
// reload, a different fake in a test) must not be served the previous one's
// output for the same src. Same-identity hits are the common case and stay
// free.
const templateCache = new Map<string, { compile: CompileOverlay; promise: Promise<OverlayFactory> }>()

function compileCached(src: string, compile: CompileOverlay): Promise<OverlayFactory> {
  const hit = templateCache.get(src)
  if (hit && hit.compile === compile) return hit.promise
  const entry = { compile, promise: compile(src) }
  templateCache.set(src, entry)
  // A failed compile must not be cached forever — a transient fetch error
  // would otherwise leave that style's card permanently blank for the rest of
  // the session. Evict only if this entry is still the current one, so a
  // newer compile that has already replaced it survives.
  entry.promise.catch(() => {
    if (templateCache.get(src) === entry) templateCache.delete(src)
  })
  return entry.promise
}

export interface CaptionStyleGalleryProps {
  /** The active caption track: supplies the selected style and the theme props
   *  (colour, family, case, spacing, …) every card's template is fed, so a
   *  card previews what THIS project would look like in that style. */
  captions: Captions
  /** The whole project — a card click commits `captions.style` onto it. */
  project: Project
  /** Whole-project commit, the same channel the retired chip row used. */
  onCaptionEdit?: (project: Project) => void
  /** Compile a JSX template into an `OverlayFactory` (from
   *  `adapter.compileOverlay`). Absent — or `resolveCaptionTemplate` absent —
   *  ⇒ static specimen cards. */
  compileOverlay?: CompileOverlay
  /** Resolve a style name to the template src `compileOverlay` expects (from
   *  `adapter.resolveCaptionTemplate`). */
  resolveCaptionTemplate?: (style: string) => string
}

export default function CaptionStyleGallery({
  captions,
  project,
  onCaptionEdit,
  compileOverlay,
  resolveCaptionTemplate,
}: CaptionStyleGalleryProps) {
  // Theme props for the templates: everything on the track except `style` and
  // `segments` (each card supplies its own), `googleFonts` (loaded below, not
  // a template prop) and `fontsize` (deliberately overridden per card — see
  // CARD_FONT_SIZE). The legacy lowercase `fontsize` key is what the project
  // stores; templates read camelCase `fontSize`, which is set explicitly on
  // the card.
  const { style: _style, segments: _segments, googleFonts, fontsize: _fontsize, ...rest } = captions
  // Spread into a fresh literal rather than passing `rest` straight through:
  // `Captions` is an interface, so its rest type has no index signature and
  // does not assign to `Record<string, unknown>` — the same shape
  // CaptionPreview builds its `themeProps` with.
  const theme: Record<string, unknown> = { ...rest }

  // Load the track's Google Fonts once for the whole gallery rather than once
  // per card — same URL, same injected <link>, and `ensureGoogleFontsLoaded`
  // dedupes anyway. Without it every card would preview in a fallback face and
  // misreport what the export will look like. Keyed on the joined list because
  // `captions` is a fresh object on every project edit (see CaptionPreview).
  useEffect(() => { ensureGoogleFontsLoaded(googleFonts) }, [String(googleFonts)])

  function selectStyle(style: CaptionStyle) {
    // Guarded on `project.captions`, not the `captions` prop: the commit below
    // spreads the project's own track, and this is byte-for-byte the write the
    // chip row performed.
    if (!project.captions) return
    onCaptionEdit?.({ ...project, captions: { ...project.captions, style } })
  }

  return (
    <div role="group" aria-label="Caption style" className="grid grid-cols-2 gap-1.5">
      {CAPTION_STYLES.map(style => (
        <CaptionStyleCard
          key={style}
          style={style}
          selected={captions.style === style}
          captions={captions}
          theme={theme}
          compileOverlay={compileOverlay}
          resolveCaptionTemplate={resolveCaptionTemplate}
          onSelect={selectStyle}
        />
      ))}
    </div>
  )
}

export interface CaptionStyleCardProps {
  style: CaptionStyle
  selected: boolean
  /** The project's caption track — read for the static fallback's per-style
   *  look. The live path uses `theme` instead. */
  captions: Captions
  /** Track-level theme fields, already stripped of style/segments/googleFonts/
   *  fontsize by the gallery. */
  theme: Record<string, unknown>
  compileOverlay?: CompileOverlay
  resolveCaptionTemplate?: (style: string) => string
  onSelect: (style: CaptionStyle) => void
}

export function CaptionStyleCard({
  style,
  selected,
  captions,
  theme,
  compileOverlay,
  resolveCaptionTemplate,
  onSelect,
}: CaptionStyleCardProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [measuredWidth, setMeasuredWidth] = useState(0)
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [frame, setFrame] = useState(POSTER_FRAME)
  const [hovered, setHovered] = useState(false)
  // A compile that REJECTS (bad template, network hiccup) must not leave the
  // card stuck on the live branch rendering `element === null` forever — an
  // empty black band with a label under it. Falling back to the static
  // specimen on failure matches the already-built compiler-less path.
  const [failed, setFailed] = useState(false)

  const live = !!compileOverlay && !!resolveCaptionTemplate && !failed

  // Measure the card so the 1080-wide layer can be scaled to it, same trick as
  // CaptionPreview / CaptionSpecimen. Never fires in jsdom — see
  // FALLBACK_CARD_W for why that is handled by a fallback rather than a gate.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setMeasuredWidth(entry.contentRect.width))
    obs.observe(el)
    return () => obs.disconnect()
  }, [live])

  // Compile on MOUNT, not on first hover: a card that starts fetching and
  // transpiling when the pointer arrives spends the first frames of the
  // animation blank, which reads as a broken card.
  useEffect(() => {
    if (!compileOverlay || !resolveCaptionTemplate) {
      setFactory(null)
      return
    }
    let cancelled = false
    setFailed(false)
    compileCached(resolveCaptionTemplate(style), compileOverlay)
      .then(f => { if (!cancelled) setFactory(() => f) })
      .catch(e => {
        if (cancelled) return
        console.warn(`[CaptionStyleGallery] failed to load template for ${style}:`, e)
        setFailed(true)
      })
    return () => { cancelled = true }
  }, [style, compileOverlay, resolveCaptionTemplate])

  // Hover-gated frame loop. Driven off the rAF timestamp rather than a frame
  // counter so the sample plays at real speed on any refresh rate, and modulo
  // LOOP_SECONDS so it replays for as long as the pointer stays. Torn down by
  // the cleanup below on unhover AND on unmount, so no frame is left pending.
  useEffect(() => {
    if (!hovered) return
    let raf = 0
    let startedAt: number | null = null
    const tick = (now: number) => {
      if (startedAt === null) startedAt = now
      const elapsed = ((now - startedAt) / 1000) % LOOP_SECONDS
      setFrame(Math.round(elapsed * SAMPLE_FPS))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [hovered])

  const scale = (measuredWidth > 0 ? measuredWidth : FALLBACK_CARD_W) / RENDER_W

  // Templates are pure functions of `frame`, so re-rendering IS the animation.
  const element = factory
    ? factory(frame, SAMPLE_FPS, SAMPLE_TOTAL_FRAMES, {
        segments: SAMPLE_SEGMENTS,
        ...theme,
        fontSize: CARD_FONT_SIZE,
      })
    : null

  return (
    <button
      type="button"
      data-style={style}
      aria-pressed={selected}
      onClick={() => onSelect(style)}
      onMouseEnter={() => setHovered(true)}
      // Snap straight back to the poster frame rather than freezing wherever
      // the loop happened to stop — a card left mid-fade reads as broken.
      onMouseLeave={() => { setHovered(false); setFrame(POSTER_FRAME) }}
      // Keyboard/touch/pen parity with the mouse handlers above: without these
      // a card only ever advances for a mouse hover, so a keyboard user
      // tabbing through the grid never sees anything but the poster frame.
      onFocus={() => setHovered(true)}
      onBlur={() => { setHovered(false); setFrame(POSTER_FRAME) }}
      className={`flex flex-col gap-1 rounded-md border p-1 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--editor-accent)] ${
        selected
          // Same selected treatment as RenderModal's option cards: accent
          // border plus a 1px ring, so the pick reads at a glance in a grid.
          ? 'border-[var(--editor-accent)] ring-1 ring-[var(--editor-accent)] bg-[var(--editor-surface)]'
          : 'border-[var(--editor-border)] bg-[var(--editor-surface)] hover:border-[var(--editor-accent)]'
      }`}
    >
      {/* The preview is decorative: the label below is the button's accessible
          name, and a screen reader gaining "The quick brown fox" seven times
          over adds nothing. */}
      {live ? (
        <div
          ref={wrapRef}
          aria-hidden="true"
          className="relative w-full overflow-hidden rounded bg-black"
          style={{ aspectRatio: `${RENDER_W} / ${BAND_H}` }}
        >
          {/* Per card, so one template that throws costs one card rather than
              the whole gallery. `resetKey` clears a caught error if this card's
              style is ever re-pointed at a different template. */}
          <OverlayErrorBoundary label={`caption style: ${style}`} resetKey={style}>
            {element && (
              <div style={{
                position:        'absolute',
                // Slide the full-height layer up so BAND_TOP lands on the card's
                // top edge; `overflow-hidden` above crops the rest. Every caption
                // template now anchors at the same 25% (see the render templates),
                // so one fixed window frames all seven cards identically.
                top:             -BAND_TOP * scale,
                left:            0,
                width:           RENDER_W,
                height:          RENDER_H,
                transform:       `scale(${scale})`,
                transformOrigin: 'top left',
              }}>
                {element}
              </div>
            )}
          </OverlayErrorBoundary>
        </div>
      ) : (
        <div aria-hidden="true" className="w-full">
          {/* No compiler on this host: fall back to the static type specimen,
              seeded with THIS card's style so it reports that style's own
              default face and weight. `textTransform` / `letterSpacing` have no
              fallback inside CaptionSpecimen, so the style defaults are applied
              here. */}
          <CaptionSpecimen
            captions={{ ...captions, style, segments: SAMPLE_SEGMENTS }}
            currentTime={POSTER_FRAME / SAMPLE_FPS}
            fontFamily={captions.fontFamily}
            fontSize={captions.fontsize ?? DEFAULT_FONT_SIZE}
            textTransform={captions.textTransform ?? CAPTION_STYLE_TEXT_TRANSFORM[style]}
            letterSpacing={captions.letterSpacing ?? CAPTION_STYLE_LETTER_SPACING[style]}
            fontWeight={captions.fontWeight}
          />
        </div>
      )}

      {/* NOT `text-[var(--editor-text)]/60` — Tailwind cannot generate an
          opacity modifier on an arbitrary var() colour, so that class is a
          silent no-op. See the long note in CaptionListPanel.tsx. */}
      <span
        className={`truncate px-0.5 text-[10px] leading-none ${
          selected
            ? 'text-[var(--editor-accent)]'
            : 'text-[var(--editor-text)] opacity-60'
        }`}
      >
        {CAPTION_STYLE_LABELS[style]}
      </span>
    </button>
  )
}

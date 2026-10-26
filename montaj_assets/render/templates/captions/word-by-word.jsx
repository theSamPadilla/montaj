import { interpolate, spring, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * One word visible at a time. Each word pops in with a spring scale.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function WordByWord({
  frame, fps,
  segments = [],
  color    = '#ffffff',
  fontSize = 72,
  fontFamily    = 'system-ui, -apple-system, sans-serif',
  fontWeight    = 800,
  textAlign     = 'center',
  letterSpacing = '-0.02em',
  lineHeight,
  textTransform,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  const theme = { fps, t, color, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }
  return <>{captionGroups(active).map((g, i) => renderSegment(g.seg, g.seg.id ?? i, segmentTheme(g.seg, theme), g.lines.map(l => renderLine(l, segmentTheme(l, theme), frame, fps, isDark(g.seg)))))}</>
}

/**
 * Every segment active at `t`, ordered by lane ascending — which IS the
 * z-order, since the blocks paint in this order and a higher lane therefore
 * lands on top. There is deliberately NO vertical offset per row: two
 * simultaneous captions draw at their own offsetX/offsetY and may overlap.
 * `sort` is stable, so segments sharing a lane keep document order.
 *
 * `seg.lane ?? 0` is duplicated here rather than imported from the editor's
 * `laneOf()` or from `@bycrux/timeline-core`'s `activeCaptionSegments`: a
 * caption template is standalone JSX compiled into the browser/Puppeteer
 * bundle and can import nothing but `montaj/render`. Deliberate duplication —
 * change the predicate or the lane default in timeline-core/src/captions.js
 * and in all eight templates together, never in one alone.
 */
function activeSegments(segments, t) {
  return segments
    .filter(s => t >= s.start && t < s.end)
    .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
}

/**
 * §244, caption translations. A translated segment carries `lang` and
 * `translationOf` (the ids of the source segments it translates) and no
 * words. It is never drawn as a caption of its own: it stacks under the
 * source segment it translates, as a plain line inside that segment's
 * anchored box (renderLine, below), so the browser measures the stack in
 * every style and the rows never collide. A translation whose source is not
 * on screen draws alone, as the only line of its own block. Duplicated in all
 * eight templates (they can import nothing but montaj/render); keep
 * isTranslation, captionGroups, stack and lineOpacity identical in each.
 */
function isTranslation(seg) {
  return typeof seg.lang === 'string' && Array.isArray(seg.translationOf)
}

function captionGroups(active) {
  const groups = active.filter(s => !isTranslation(s)).map(seg => ({ seg, lines: [] }))
  for (const tr of active) {
    if (!isTranslation(tr)) continue
    const group = groups.find(g => g.seg.id != null && tr.translationOf.includes(g.seg.id))
    if (group) group.lines.push(tr)
    else groups.push({ seg: tr, lines: [tr] })
  }
  return groups
}

/** The caption, then its translations under it, aligned like the caption.
 *  With no translations it is the caption itself, so nothing else changes. */
function stack(content, lines, textAlign) {
  if (!lines.length) return content
  const alignItems = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center'
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems, width: '100%', gap: 10 }}>{content}{lines}</div>
}

/** A plain line's fade, for templates whose box does not fade by itself. */
function lineOpacity(seg, frame, fps) {
  return Math.min(
    interpolate(frame - Math.round(seg.start * fps), [0, 5], [0, 1]),
    interpolate(Math.round(seg.end * fps) - frame, [0, 4], [0, 1]),
  )
}

/**
 * One segment's block — everything below the old `segments.find(...)`, moved
 * verbatim. A plain function, NOT a `<Component/>`: render/test/*.test.mjs call
 * these templates as plain functions and read style objects straight off the
 * returned element tree, which only works while every node is a host element.
 *
 * The per-word entry envelope below is LOAD-BEARING and must not be
 * "simplified" during any restructuring of this file — its non-zero floor is
 * the only thing that makes a one-frame word visible at all. See the comment
 * at the `opacity` line and test/caption-short-words.test.mjs.
 *
 * `data-caption-id` marks the subtree so the editor preview can measure ONE
 * caption's rect instead of the union of everything on screen (see
 * measureCaptionContentRect in editor/src/video/preview/captionDragState.ts).
 */
function renderSegment(seg, key, theme, lines = []) {
  const word = isTranslation(seg) ? null : renderWord(seg, theme)
  if (!word && !lines.length) return null
  const { textAlign } = theme
  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      {/* Segment scale lives on this middle anchor box, not the word <span> below —
          that span already carries its own spring pop-in `transform: scale(...)`, and
          merging the two transforms would corrupt the pop animation. */}
      <div style={captionInnerStyle(seg, {
        // 24%, one point below the 25% group: this style's large single word
        // stands taller, so a slightly lower anchor lines its TOP up with every
        // other style's caption (Sam, 2026-08-25).
        bottom: '24%',
        left: 0,
        right: 0,
        textAlign,
        padding: '0 8%',
      })}>
        {stack(word, lines, textAlign)}
      </div>
    </div>
  )
}

/** The word being spoken, or null between words. Moved verbatim out of
 *  renderSegment (§244), so the block can still draw a translation line
 *  under a caption while no word is up. */
function renderWord(seg, { fps, t, color, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }) {
  const words = seg.words || []
  if (!words.length) return null

  // Active word: the one being spoken right now, or the last spoken in this segment
  const activeWord = words.find(w => t >= w.start && t < w.end)
    ?? (t >= seg.start ? words[words.length - 1] : null)
  if (!activeWord) return null

  // Frames elapsed since this word started
  const wordFrame = Math.max(0, Math.round((t - activeWord.start) * fps))
  const sc = spring({ frame: wordFrame, fps, stiffness: 420, damping: 28 })
  // Entry envelope with a NON-ZERO FLOOR. History, because the floor looks
  // arbitrary without it: a 4-frame fade from 0 meant any word shorter than
  // ~130ms was replaced before its fade reached visibility; shrinking to 2
  // frames helped two-frame words but still opened at 0, so a one-frame word
  // rendered once, at opacity 0, and was simply never seen. Measured on real
  // projects, about 1 caption word in 20 lasts under two frames on a
  // word-by-word project (robotics-ban 14/287, ai-safety 15/278).
  //
  // Starting at 0.55 means a word is legible on its very first frame, which is
  // the only frame some words get. The spring `sc` still carries the entrance,
  // so this reads as a snappier pop rather than a missing fade — and every word
  // past frame 2 is unchanged at full opacity.
  //
  // A generation-time floor now exists: steps/lyrics/caption.py's
  // `floor_word_durations` (MIN_WORD_DURATION_S = 0.05s), applied at the
  // transcript word-flatten before phrase/segment grouping. Measured across
  // 8 real projects on 2026-08-23: it rescues 27 of 30 sub-frame words
  // found there (90%).
  //
  // It is PARTIAL, and three sources of sub-frame words survive it:
  //   - By design, it leaves a fully-starved run of adjacent sub-floor
  //     words unchanged — its donation gate refuses to rob a successor to
  //     save its predecessor, so no donation in such a run is ever
  //     accepted. The 3 unrescued words above are exactly this case.
  //   - Captions written via a project PUT bypass the generator entirely;
  //     montaj stores whatever word timings it receives.
  //   - Caption text edited in the browser editor is spread uniformly
  //     across the segment's EXISTING duration; the floor call made there
  //     is inert by construction (a uniform spread can never satisfy the
  //     donation gate), and that is deliberate — editing a caption's text never
  //     changes its duration.
  //
  // So this opacity floor is still load-bearing and must NOT be removed as
  // redundant with the generation-time one: the two are jointly necessary.
  // The generator floor reduces how often a sub-frame word reaches render;
  // this one is what saves it the times one still does. Removing either
  // brings the invisible-word bug back for a subset of captions — which
  // reads as flakiness, not a regression, and is harder to diagnose than
  // the original bug was.
  //
  // Regression coverage: test/caption-short-words.test.mjs, which now
  // proves both halves — that a floor-rescued 50ms word draws on at least
  // one frame at 30fps, and that a deliberately-unrescued starved run
  // still does not.
  const opacity = interpolate(wordFrame, [0, 2], [0.55, 1])

  return (
    <span style={{
      display: 'inline-block',
      fontSize,
      fontWeight,
      fontFamily,
      // §558: a word's own colour (words[].color) beats the segment's and the track's
      color: activeWord.color ? inkOf(seg, activeWord.color) : (isDark(seg) ? INK : (seg.color ?? color)),
      textShadow: isDark(seg) ? 'none' : '0 2px 12px rgba(0,0,0,0.85)',
      letterSpacing,
      lineHeight,
      textTransform,
      opacity,
      transform: `scale(${sc})`,
      transformOrigin: 'center bottom',
    }}>
      {activeWord.word}
    </span>
  )
}

/** §244: a translation under its caption, as word-by-word's plain line: the
 *  style's font and colour at a line size (its own size is meant for one
 *  word), no per-word animation. */
const LINE_SCALE = 0.6
function renderLine(seg, { color, fontSize, fontFamily, fontWeight, letterSpacing, lineHeight, textTransform }, frame, fps, dark = isDark(seg)) {
  return (
    <div key={seg.id ?? seg.start} data-caption-id={seg.id} style={{
      fontSize: Math.round(fontSize * LINE_SCALE),
      fontWeight,
      fontFamily,
      color: dark ? INK : (seg.color ?? color),
      textShadow: dark ? 'none' : '0 2px 12px rgba(0,0,0,0.85)',
      letterSpacing,
      lineHeight: lineHeight ?? 1.2,
      textTransform,
      opacity: lineOpacity(seg, frame, fps),
    }}>
      {seg.text}
    </div>
  )
}

/**
 * Caption ink. A segment with `ink: "dark"` (written by the caption_ink step
 * or chosen by a person) is drawn as dark ink on paper: the base text takes
 * INK and loses its outline and shadow. Accents (the spoken word, a word's
 * own colour) is darkened in its own hue to 4.5:1 (darkSafe); highlight-box's box stays. A translation stacked
 * under a caption takes the ink of the caption it sits under. Duplicated in
 * the seven text-over-picture templates (plate and subtitle draw their own
 * box and ignore it); keep INK and isDark identical in each.
 */
const INK = '#1c1c1e'
const isDark = seg => seg.ink === 'dark'

/**
 * Under dark ink a colour drawn as text (the spoken word, a word's own
 * colour, an accent run) is darkened in its own hue until it reaches 4.5:1
 * against the backdrop, so a yellow keyword on paper becomes a deep amber.
 * Backdrop: the caption_ink step's measured luminance (`inkAuto.backdrop`),
 * else 0.5, the step's threshold for light. A colour that already passes is
 * returned as given; one it cannot parse falls back to INK. Duplicated in
 * the templates that draw an accent; keep identical in each.
 */
const backdropOf = seg => {
  const b = seg.inkAuto?.backdrop
  return Number.isFinite(b) && b >= 0 && b <= 1 ? b : 0.5
}
const inkOf = (seg, color) => (isDark(seg) ? darkSafe(color, backdropOf(seg)) : color)
function darkSafe(color, backdrop) {
  const s = String(color ?? '').trim().toLowerCase()
  let rgb = null
  let m = /^#([0-9a-f]{3,4})$/.exec(s)
  if (m) rgb = [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16))
  else if ((m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s))) rgb = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16))
  else if ((m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,[^)]*)?\)$/.exec(s))) rgb = [m[1], m[2], m[3]].map(Number)
  if (!rgb || rgb.some(c => c > 255)) return INK
  const lin = rgb.map(c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = v => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  const target = Math.max(0, (backdrop + 0.05) / 4.5 - 0.05)
  if (lum(lin) <= target) return color
  let k = target / lum(lin)
  for (let i = 0; i < 60; i++, k *= 0.98) {
    const out = lin.map(c => Math.round(255 * (c * k <= 0.0031308 ? c * k * 12.92 : 1.055 * (c * k) ** (1 / 2.4) - 0.055)))
    if (lum(out.map(c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) <= target || k < 1e-6) {
      return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('')
    }
  }
  return INK
}

/**
 * One segment's theme: a styling field set on the segment wins over the
 * track's (the props above), which wins over this template's default. Only
 * fields this template's theme already carries are taken, and a segment with
 * none of them gets the theme object itself, so a project without per-caption
 * styling renders exactly as before. Duplicated in all nine templates (they
 * can import nothing but montaj/render); keep the list identical in each and
 * in step with the editor's video/captionSegmentStyle.ts.
 */
const SEGMENT_STYLE_FIELDS = ['color', 'fontSize', 'fontFamily', 'fontWeight', 'textTransform', 'textAlign', 'letterSpacing', 'lineHeight', 'accentColor', 'highlightColor', 'activeColor', 'backgroundColor', 'plateOpacity', 'platePadding', 'plateRadius']
function segmentTheme(seg, theme) {
  let out = theme
  for (const k of SEGMENT_STYLE_FIELDS) {
    if (seg[k] == null || !(k in theme)) continue
    if (out === theme) out = { ...theme }
    out[k] = seg[k]
  }
  return out
}

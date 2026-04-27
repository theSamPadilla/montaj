/**
 * lyric-phrase.jsx — Per-phrase lyric overlay.
 *
 * Used in the JSX render path. Each lyric phrase is a separate overlay entry
 * in tracks[1] with its own start/end. This component handles a single phrase's
 * timing and animation.
 *
 * The render engine injects `frame` and `fps` as props. All other props come
 * from the overlay entry's `props` field in project.json.
 *
 * Props:
 *   frame            Current frame number (injected by render engine)
 *   fps              Frames per second (injected by render engine)
 *   words            Array of {word, start, end} — word-level timestamps for THIS phrase only
 *   variant          'pop' | 'accumulate' | 'fade' | 'typewriter'  (default: 'pop')
 *   transparent      boolean — if true, background is transparent (for use over background video)
 *   bg1              First background color   (default: '#ffffff')
 *   bg2              Second background color  (default: '#efefef')
 *   bgStyle          Background style:
 *                    'solid'    — flat color, alternates bg1/bg2 per word (default)
 *                    'gradient' — linear gradient bg1→bg2, angle drifts over time
 *                    'radial'   — radial gradient, bg1 at center fading to bg2 at edges
 *                    'vignette' — solid bg1 with dark radial edge darkening
 *                    'wave'     — gradient angle oscillates sinusoidally (±60° at ~1.5 Hz)
 *                    'strobe'   — rapidly alternates bg1/bg2 at bgStrobeHz (default 8 Hz)
 *                    'flash'    — cuts to bg2 on each new word, fades back to bg1 over bgFlashDur
 *                                 Note: requires hex colors (#rrggbb) for smooth interpolation
 *   bgAngle          Starting gradient angle in degrees (default: 135)
 *   bgDriftSpeed     Degrees per second for 'gradient' rotation (default: 20)
 *   bgStrobeHz       Alternation frequency for 'strobe' in Hz (default: 8)
 *   bgFlashDur       Fade-back duration for 'flash' in seconds (default: 0.12)
 *   bgOpacity        Background layer opacity 0–1 (default: 1). Text stays fully opaque.
 *                    Set < 1 to let background video show through while keeping crisp text.
 *                    Has no effect when transparent: true.
 *   textColor        Text color               (default: '#111111')
 *   fontWeight       CSS font weight          (default: 300)
 *   fontSize         Base font size px        (default: 80)
 *   fontFamily       CSS font family string   (default: system-ui stack)
 *                    For Google Fonts, also set googleFonts: ['Font Name'] on the overlay
 *                    entry in project.json so the render engine loads the font.
 *   fontStyle        'normal' | 'italic'      (default: 'normal')
 *   textTransform    CSS text-transform        (default: 'lowercase')
 *   textAlign        'left' | 'center' | 'right'  (default: 'left')
 *   strokeColor      Text outline color       (default: null — no stroke)
 *   strokeWidth      Text outline width px    (default: 0)
 *   wordsPerLine     For 'static' variant: wrap every N words onto a new line  (default: 0 — no wrap)
 *   wordEntrance     Per-word entrance animation:
 *                    'none' | 'scale' | 'slide-up' | 'blur' | 'flicker'  (default: 'none')
 *                    'drift'  — word floats up 40px while fading in (ease-in-out, slow)
 *                    'rise'   — word rises 80px while fading in (more dramatic)
 *   entranceDuration Entrance animation duration in seconds  (default: 0.1)
 *   activeWordColor  In 'accumulate': color for the most recently appeared word.
 *                    null = same as textColor.  (default: null)
 *   passedWordOpacity In 'accumulate': opacity for words that have already appeared (0–1).
 *                    Creates a karaoke-style dimming effect.  (default: 1 — no dimming)
 *   autoScale        Shrink font as words accumulate to prevent overflow  (default: true)
 *   minFontSize      Floor for autoScale in px  (default: fontSize * 0.35)
 *   position         'center' | 'top-left' | 'bottom-left'  (default: 'center')
 *   textStyle        Raw CSS object spread onto the <p> element (escape hatch)
 */
export default function LyricPhrase({
  frame,
  fps,
  words              = [],
  variant            = 'pop',
  transparent        = false,
  bg1                = '#ffffff',
  bg2                = '#efefef',
  bgStyle            = 'solid',
  bgAngle            = 135,
  bgDriftSpeed       = 20,
  bgStrobeHz         = 8,
  bgFlashDur         = 0.12,
  bgOpacity          = 1,
  textColor          = '#111111',
  fontWeight         = 300,
  fontSize           = 80,
  fontFamily         = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontStyle          = 'normal',
  textTransform      = 'lowercase',
  textAlign          = 'left',
  strokeColor        = null,
  strokeWidth        = 0,
  wordsPerLine       = 0,
  wordEntrance       = 'none',
  entranceDuration   = 0.1,
  activeWordColor    = null,
  passedWordOpacity  = 1,
  autoScale          = true,
  minFontSize,
  position           = 'center',
  textStyle          = {},
}) {
  const t = frame / fps

  const positionStyle = {
    'center':      { alignItems: 'center',     justifyContent: 'center' },
    'top-left':    { alignItems: 'flex-start', justifyContent: 'flex-start' },
    'bottom-left': { alignItems: 'flex-end',   justifyContent: 'flex-start' },
  }[position] ?? { alignItems: 'center', justifyContent: 'center' }

  if (!words.length) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        backgroundColor: transparent ? 'transparent' : bg1,
        display: 'flex', padding: '7% 8%',
        ...positionStyle,
      }} />
    )
  }

  const phraseStart = words[0].start
  const phraseEnd   = words[words.length - 1].end
  const fullText    = words.map(w => w.word).join(' ')

  // ---------------------------------------------------------------------------
  // Entrance animation
  // ---------------------------------------------------------------------------
  function entranceStyle(wordStart) {
    if (wordEntrance === 'none') return {}
    const elapsed  = t - wordStart
    const progress = Math.min(1, Math.max(0, elapsed / Math.max(entranceDuration, 0.001)))
    const easeOut  = Math.sqrt(progress)

    if (wordEntrance === 'scale') {
      const scale = (1 + 0.3 * (1 - easeOut)).toFixed(4)
      return { display: 'inline-block', transform: `scale(${scale})`, opacity: easeOut }
    }
    if (wordEntrance === 'slide-up') {
      const y = (20 * (1 - easeOut)).toFixed(2)
      return { display: 'inline-block', transform: `translateY(${y}px)`, opacity: easeOut }
    }
    if (wordEntrance === 'blur') {
      const blur = (8 * (1 - easeOut)).toFixed(2)
      return { display: 'inline-block', filter: `blur(${blur}px)`, opacity: easeOut }
    }
    if (wordEntrance === 'flicker') {
      const noise   = Math.abs(Math.sin(elapsed * 377 + wordStart * 13))
      const visible = noise > (1 - progress) * 0.85
      return { display: 'inline-block', opacity: visible ? 1 : 0 }
    }
    // ease-in-out for the smooth float entrances
    const easeInOut = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2
    if (wordEntrance === 'drift') {
      const y = (40 * (1 - easeInOut)).toFixed(2)
      return { display: 'inline-block', transform: `translateY(${y}px)`, opacity: easeInOut }
    }
    if (wordEntrance === 'rise') {
      const y = (80 * (1 - easeInOut)).toFixed(2)
      return { display: 'inline-block', transform: `translateY(${y}px)`, opacity: easeInOut }
    }
    return {}
  }

  // ---------------------------------------------------------------------------
  // Base text style
  // ---------------------------------------------------------------------------
  const strokeStyle = strokeColor && strokeWidth > 0 ? {
    WebkitTextStroke: `${strokeWidth}px ${strokeColor}`,
    paintOrder: 'stroke fill',
  } : {}

  const baseText = {
    margin:        0,
    fontSize,
    fontWeight,
    fontStyle,
    fontFamily,
    color:         textColor,
    letterSpacing: '-0.02em',
    lineHeight:    1.15,
    textTransform,
    textAlign,
    width:         '100%',
    wordBreak:     'normal',
    overflowWrap:  'normal',
    position:      'relative',
    zIndex:        1,
    ...strokeStyle,
    ...textStyle,
  }

  const textShadow = transparent
    ? '0 2px 8px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.9)'
    : undefined

  // ---------------------------------------------------------------------------
  // Font sizing
  // ---------------------------------------------------------------------------
  const _minFontSize = minFontSize ?? fontSize * 0.35

  function scaledFontSize(wordCount) {
    if (!autoScale || wordCount <= 2) return fontSize
    return Math.max(_minFontSize, fontSize / Math.sqrt(Math.max(1, (wordCount - 2) / 2)))
  }

  const _canvasW         = typeof window !== 'undefined' ? window.innerWidth : 720
  const _availW          = _canvasW * (1 - 2 * 0.08)
  const _charWidthFactor = 0.65

  function fitFontSize(ws, baseFontSize) {
    const longestLen = Math.max(...ws.map(w => w.word.length), 1)
    const maxFont    = _availW / (longestLen * _charWidthFactor)
    return Math.min(baseFontSize, maxFont)
  }

  // ---------------------------------------------------------------------------
  // Color utilities — used by 'flash'. Works with #rgb and #rrggbb hex colors.
  // ---------------------------------------------------------------------------
  function hexToRgb(hex) {
    const h = hex.replace('#', '')
    return h.length === 3
      ? [parseInt(h[0]+h[0], 16), parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16)]
      : [parseInt(h.slice(0,2), 16), parseInt(h.slice(2,4), 16), parseInt(h.slice(4,6), 16)]
  }

  function lerpColor(hexA, hexB, p) {
    try {
      const [r1,g1,b1] = hexToRgb(hexA)
      const [r2,g2,b2] = hexToRgb(hexB)
      return `rgb(${Math.round(r1+(r2-r1)*p)},${Math.round(g1+(g2-g1)*p)},${Math.round(b1+(b2-b1)*p)})`
    } catch (_) {
      return p < 0.5 ? hexA : hexB
    }
  }

  // ---------------------------------------------------------------------------
  // Background builder
  // ---------------------------------------------------------------------------
  const _alternates = bgStyle === 'solid' || bgStyle === 'strobe'

  function buildBackground(primary, lastWordStart) {
    if (transparent) return 'transparent'
    const secondary = primary === bg1 ? bg2 : bg1

    switch (bgStyle) {
      case 'gradient': {
        const angle = ((bgAngle + t * bgDriftSpeed) % 360).toFixed(1)
        return `linear-gradient(${angle}deg, ${primary}, ${secondary})`
      }
      case 'radial':
        return `radial-gradient(ellipse at center, ${primary} 0%, ${secondary} 100%)`
      case 'wave': {
        const angle = (bgAngle + Math.sin(t * Math.PI * 1.5) * 60).toFixed(1)
        return `linear-gradient(${angle}deg, ${primary}, ${secondary})`
      }
      case 'strobe':
        return Math.sin(t * bgStrobeHz * Math.PI * 2) > 0 ? primary : secondary
      case 'flash': {
        if (lastWordStart != null) {
          const elapsed = t - lastWordStart
          if (elapsed >= 0 && elapsed < bgFlashDur) {
            const ease = Math.sqrt(elapsed / bgFlashDur)
            return lerpColor(secondary, primary, ease)
          }
        }
        return primary
      }
      case 'vignette':
      case 'solid':
      default:
        return primary
    }
  }

  // ---------------------------------------------------------------------------
  // Variants
  // ---------------------------------------------------------------------------
  let bg            = transparent ? 'transparent' : bg1
  let lastWordStart = phraseStart
  let opacity       = 1
  let content       = null

  // ── pop ────────────────────────────────────────────────────────────────────
  if (variant === 'pop') {
    const reached = words.filter(w => t >= w.start)
    if (reached.length > 0) {
      const current = reached[reached.length - 1]
      if (!transparent && _alternates) bg = reached.length % 2 === 0 ? bg1 : bg2
      lastWordStart = current.start
      const fs = fitFontSize([current], scaledFontSize(1))
      content = (
        <p style={{ ...baseText, fontSize: fs, textShadow }}>
          {wordEntrance === 'none'
            ? current.word
            : <span style={entranceStyle(current.start)}>{current.word}</span>
          }
        </p>
      )
    }

  // ── accumulate ─────────────────────────────────────────────────────────────
  } else if (variant === 'accumulate') {
    const reached = words.filter(w => t >= w.start)
    if (reached.length > 0) {
      if (!transparent && _alternates) bg = reached.length % 2 === 0 ? bg1 : bg2
      lastWordStart = reached[reached.length - 1].start
      const fs = fitFontSize(reached, fontSize)

      const useKaraoke = activeWordColor != null || passedWordOpacity !== 1

      content = (
        <p style={{ ...baseText, fontSize: fs, textShadow }}>
          {wordEntrance === 'none' && !useKaraoke
            ? reached.map(w => w.word).join(' ')
            : reached.map((w, i) => {
                const isLatest  = i === reached.length - 1
                const animated  = (t - w.start) < entranceDuration
                const spanStyle = animated
                  ? { ...entranceStyle(w.start), display: 'inline-block' }
                  : {
                      display: 'inline-block',
                      ...(useKaraoke && {
                        color:   isLatest && activeWordColor ? activeWordColor : undefined,
                        opacity: isLatest ? 1 : passedWordOpacity,
                      }),
                    }
                return (
                  <span key={i} style={{
                    ...spanStyle,
                    marginRight: i < reached.length - 1 ? '0.25em' : 0,
                  }}>
                    {w.word}
                  </span>
                )
              })
          }
        </p>
      )
    }

  // ── fade ───────────────────────────────────────────────────────────────────
  } else if (variant === 'fade') {
    const FADE_DURATION = 0.15
    if (t >= phraseStart) {
      const fadeIn    = Math.min(1, (t - phraseStart) / FADE_DURATION)
      const fadeOutAt = phraseEnd - FADE_DURATION
      const fadeOut   = t >= fadeOutAt
        ? Math.max(0, 1 - (t - fadeOutAt) / FADE_DURATION)
        : 1
      opacity = Math.min(fadeIn, fadeOut)
      if (!transparent) bg = bg1
      const fs = scaledFontSize(words.length)
      content = <p style={{ ...baseText, fontSize: fs, textShadow }}>{fullText}</p>
    }

  // ── static ─────────────────────────────────────────────────────────────────
  // Shows all words immediately for the full segment duration, optionally
  // split into N-word lines. Designed to match the ffmpeg words-per-line render.
  } else if (variant === 'static') {
    const allWords = words.map(w => w.word)
    let lines
    if (wordsPerLine > 0) {
      lines = []
      for (let i = 0; i < allWords.length; i += wordsPerLine) {
        lines.push(allWords.slice(i, i + wordsPerLine).join(' '))
      }
    } else {
      lines = [allWords.join(' ')]
    }
    // Auto-size: scale font down so the longest line fits within available width
    const longestLen = Math.max(...lines.map(l => l.length), 1)
    const maxFsForWidth = _availW / (longestLen * _charWidthFactor)
    const fs = Math.max(40, Math.min(fontSize, maxFsForWidth))

    if (!transparent) bg = bg1
    content = (
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start',
        gap:            '0.1em',
      }}>
        {lines.map((line, i) => (
          <p key={i} style={{ ...baseText, fontSize: fs, textShadow }}>{line}</p>
        ))}
      </div>
    )

  // ── typewriter ─────────────────────────────────────────────────────────────
  } else if (variant === 'typewriter') {
    if (t >= phraseStart) {
      const duration    = Math.max(0.001, phraseEnd - phraseStart)
      const progress    = Math.min(1, (t - phraseStart) / duration)
      const chars       = Math.floor(progress * fullText.length)
      const displayText = fullText.slice(0, chars)
      if (!transparent && _alternates) bg = chars % 2 === 0 ? bg1 : bg2
      const fs = scaledFontSize(words.length)
      content = <p style={{ ...baseText, fontSize: fs, textShadow }}>{displayText}</p>
    }
  }

  const finalBg = buildBackground(bg, lastWordStart)

  return (
    <div style={{
      position: 'fixed',
      inset:    0,
      overflow: 'hidden',
      display:  'flex',
      padding:  '7% 8%',
      opacity,
      ...positionStyle,
    }}>
      {!transparent && (
        <div style={{
          position:      'absolute',
          inset:         0,
          background:    finalBg,
          opacity:       bgOpacity,
          pointerEvents: 'none',
        }} />
      )}
      {bgStyle === 'vignette' && !transparent && (
        <div style={{
          position:      'absolute',
          inset:         0,
          background:    'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.65) 100%)',
          pointerEvents: 'none',
        }} />
      )}
      {content}
    </div>
  )
}

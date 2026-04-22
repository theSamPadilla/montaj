# lyric-phrase.jsx — Props Reference

> `render/templates/overlays/lyric-phrase.jsx`

The standard overlay template for lyrics video projects. One instance per lyric segment in `tracks[1]`. The render engine injects `frame` and `fps`; all other props come from the overlay item's `props` field in project.json.

Word timestamps in `props.words` must be **relative to the overlay's own `start`** — subtract `segment.start` from every word timestamp when converting from `lyrics_sync` output.

---

## Core props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `words` | `{word, start, end}[]` | `[]` | Word-level timestamps for this phrase. Times are relative to overlay start. |
| `variant` | string | `'pop'` | Animation variant — see [Variants](#variants) |
| `position` | string | `'center'` | Layout position: `'center'` · `'top-left'` · `'bottom-left'` |
| `fontSize` | number | `80` | Base font size in px |
| `fontFamily` | string | system-ui stack | CSS font-family string. For Google Fonts, also set `googleFonts: ['Font Name']` on the overlay item. |
| `fontWeight` | number | `300` | CSS font-weight |
| `fontStyle` | string | `'normal'` | `'normal'` or `'italic'` |
| `textTransform` | string | `'lowercase'` | CSS text-transform (`'uppercase'`, `'none'`, etc.) |
| `textAlign` | string | `'left'` | `'left'` · `'center'` · `'right'` |
| `textColor` | string | `'#111111'` | Text fill color |
| `strokeColor` | string \| null | `null` | Text outline color. Painted under the fill (`paint-order: stroke fill`). |
| `strokeWidth` | number | `0` | Text outline width in px |
| `textStyle` | object | `{}` | Raw CSS spread onto the `<p>` element — escape hatch for anything not covered by props |
| `transparent` | boolean | `false` | Skip background entirely — text floats over `tracks[0]` footage. Auto-applies a drop shadow for readability. |

---

## Background props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `bg1` | string | `'#ffffff'` | Primary background color |
| `bg2` | string | `'#efefef'` | Secondary background color |
| `bgStyle` | string | `'solid'` | Background style — see [Background styles](#background-styles) |
| `bgOpacity` | number | `1` | Opacity of the background layer (0–1). Text stays fully opaque. Set < 1 to let background video show through. No effect when `transparent: true`. |
| `bgAngle` | number | `135` | Starting gradient angle in degrees (used by `gradient` and `wave`) |
| `bgDriftSpeed` | number | `20` | Degrees per second the gradient angle rotates (used by `gradient`) |
| `bgStrobeHz` | number | `8` | Alternation frequency in Hz (used by `strobe`) |
| `bgFlashDur` | number | `0.12` | Fade-back duration in seconds after each word cut (used by `flash`). Requires hex colors. |

---

## Word entrance animations

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `wordEntrance` | string | `'none'` | Per-word entrance animation — see table below. Only applies to `pop` and `accumulate`. |
| `entranceDuration` | number | `0.1` | Animation duration in seconds (~3 frames at 30fps). Increase to `0.15–0.2` for a more visible effect. |

| Value | Effect |
|-------|--------|
| `'none'` | Hard cut — word appears instantly |
| `'scale'` | Scales from 1.3× to 1× while fading in |
| `'slide-up'` | Slides up 20px while fading in |
| `'blur'` | Unblurs from 8px to sharp while fading in |
| `'flicker'` | Rapid noise flicker that resolves to visible |
| `'drift'` | Floats up 40px while fading in (ease-in-out, slow) |
| `'rise'` | Rises 80px while fading in (more dramatic) |

---

## Accumulate-only props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `activeWordColor` | string \| null | `null` | Color for the most recently appeared word. `null` = same as `textColor`. |
| `passedWordOpacity` | number | `1` | Opacity for words that have already appeared (0–1). Creates a karaoke-style dimming effect. |
| `autoScale` | boolean | `true` | Shrink font as words accumulate to prevent overflow |
| `minFontSize` | number | `fontSize * 0.35` | Floor for autoScale in px |

---

## Static-only props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `wordsPerLine` | number | `0` | Wrap every N words onto a new line. `0` = no wrap (all words on one line). Used with `variant: 'static'` to match `lyrics_render.py`'s `words_per_line` output. |

---

## Variants

| Variant | Best for | Notes |
|---------|----------|-------|
| `'pop'` | Most lyrics, punchy phrases | One word at a time. Background alternates `bg1`/`bg2` per word. |
| `'accumulate'` | Building phrases, emphasis | Words stack at full font size, wrapping across lines. Supports `activeWordColor` and `passedWordOpacity`. |
| `'fade'` | Slow/emotional sections | Full phrase fades in and out over a fixed 0.15s window. |
| `'typewriter'` | Dramatic reveals | Characters reveal progressively across the phrase duration. |
| `'static'` | Match ffmpeg output exactly | All words shown immediately for the full segment. `wordsPerLine` splits into N-word lines. Font is auto-sized so the longest line fits the frame. |

---

## Background styles

| `bgStyle` | Effect | Notes |
|-----------|--------|-------|
| `'solid'` | Flat `bg1`, alternates with `bg2` per word | Default |
| `'gradient'` | Linear gradient `bg1`→`bg2`, angle drifts `bgDriftSpeed` deg/s | Subtle per-frame motion even when text is static |
| `'radial'` | Radial gradient — `bg1` at center, `bg2` at edges | Spotlight effect |
| `'vignette'` | Solid `bg1` with a dark radial edge overlay | Combines with `bgOpacity` well for video compositing |
| `'wave'` | Gradient angle oscillates ±60° at ~1.5 Hz | Slower, more organic feel than `gradient` |
| `'strobe'` | Rapidly cuts between `bg1`/`bg2` at `bgStrobeHz` | Aggressive — use sparingly |
| `'flash'` | Cuts to `bg2` on each new word, fades back to `bg1` over `bgFlashDur` | Requires hex colors (`#rrggbb`) for smooth interpolation |

---

## project.json item shape

```json
{
  "id": "phrase-0",
  "type": "overlay",
  "src": "/abs/path/to/montaj/render/templates/overlays/lyric-phrase.jsx",
  "start": 0.5,
  "end": 3.2,
  "googleFonts": ["Bebas Neue"],
  "props": {
    "words": [
      { "word": "drink", "start": 0.0, "end": 0.4 },
      { "word": "le",    "start": 0.4, "end": 0.8 },
      { "word": "croix", "start": 0.8, "end": 1.3 }
    ],
    "variant": "pop",
    "transparent": false,
    "bg1": "#0A0608",
    "bg2": "#B5102A",
    "bgStyle": "flash",
    "bgOpacity": 0.82,
    "fontSize": 116,
    "fontWeight": 800,
    "fontFamily": "Bebas Neue, system-ui, sans-serif",
    "textColor": "#F5F0EC",
    "textTransform": "uppercase",
    "textAlign": "center",
    "position": "center",
    "wordEntrance": "scale",
    "entranceDuration": 0.08
  }
}
```

`googleFonts` is a field on the overlay item (not inside `props`) — the render engine loads the font before rendering. Set `fontFamily` in props to the same name.

---

## Converting lyrics_sync output

`lyrics_sync` segments have absolute timestamps. Subtract `segment.start` from every word's `start` and `end` before writing into `props.words`:

```js
segment.words.map(w => ({
  word:  w.word,
  start: w.start - segment.start,
  end:   w.end   - segment.start,
}))
```

Set the overlay item's `start` to `segment.start` and `end` to `segment.end`.

Set `audio.tracks[0].inPoint` to the `audioInPoint` value from the `lyrics_sync` output.

---
name: lyrics-video
description: "Agent-authored workflow task: choose a render path (ffmpeg vs JSX), build project.json overlay entries from lyrics_sync output, and set up audio. Load this when you hit montaj/lyrics-video in a workflow."
step: true
---

# Lyrics Video Skill

Use this skill whenever you are working on a `lyrics_video` workflow project in montaj.

## Steps 0a + 0b — Always run first

### 0a: Stem separation (Demucs)

Isolate clean vocals before running Whisper. Running Whisper directly on the full mix gives poor transcription because drums/bass/production mask the vocals.

```bash
montaj stem-separation --input song.mp3 --stems vocals --out-dir /tmp/stems
```

Output JSON: `{ "vocals": "/tmp/stems/htdemucs/song/vocals.wav", ... }`

### 0b: Lyrics sync on clean vocals

Pass the vocals WAV to lyrics_sync, not the full mix. Window auto-detection is built in — only pass `--start`/`--end` if auto-detection fails.

```bash
montaj lyrics-sync --input /tmp/stems/htdemucs/song/vocals.wav --lyrics lyrics.txt --model medium.en --out captions.json
```

Output: `captions.json` with shape `{ segments: [{ text, start, end, words: [{word, start, end}] }], audioInPoint: <seconds> }`.

The `audioInPoint` field tells the render engine where in the source file project `t=0` maps to. Set `audio.music.inPoint` in `project.json` to this value.

---

## Step 1 — Detect inputs

Check the prompt context for:
- `Lyrics file: /path/...` → path to lyrics `.txt` file
- `Background video: /path/...` → background video provided (optional)

---

## Step 2 — Choose render path

There are two paths. If the user's intent isn't obvious from their prompt, **ask**:

> "Do you want **simple captions** — text burned straight into the video, ready to export immediately — or **custom animated captions** that you can preview and adjust in the UI before rendering?"

| Signal in prompt | Path |
|-----------------|------|
| No background video | **JSX** always — hard rule, never use ffmpeg |
| "fast", "quick", "export now", "just burn it in" | **ffmpeg** (needs background video) |
| "preview", "animated", "I want to see it first", "custom style" | **JSX** |
| Background video provided, no other signal | **ffmpeg** (default — simpler) |
| Ambiguous with background video | Ask |

### What each path means

Both paths always build `lyric-phrase.jsx` overlays in `tracks[1]` for UI preview. The difference is what happens at render time.

**ffmpeg — burned-in captions (requires background video)**
At render time, `render.js` sees `renderMode: "ffmpeg-drawtext"` and bypasses Puppeteer entirely — calls `lyrics_render.py` directly. Fast, no Puppeteer, output is a finished MP4. Style limited to font/size/color/position. The overlays in `tracks[1]` are ignored during render but remain visible in the UI preview.

**ffmpeg preview fidelity rule:** Style the `tracks[1]` overlays to match the ffmpeg output as closely as possible so the UI preview is a faithful representation of what will be rendered. Use these props:
- `transparent: true` — text over video, no background
- `variant: "static"` — shows all words immediately for the full segment duration (matches ffmpeg static display)
- `wordsPerLine` — match `captions.wordsPerLine` (e.g. `3`); omit if `captions.wordsPerLine` is not set
- `textColor` — match `captions.color` (e.g. `"white"`); use `"white"` when `captions.color` is `"auto"`
- `fontSize` — match `captions.fontsize` (e.g. `72`)
- `position` — match `captions.position`
- `strokeColor: "#000000"`, `strokeWidth: 4` — matches ffmpeg `borderw=4:bordercolor=black`
- `fontWeight: 400`, `fontFamily: "system-ui, sans-serif"` — closest to ffmpeg default font
- `textTransform: "none"`, `bgStyle: "solid"` (ignored since transparent)
- No entrance animation, no karaoke effects

**JSX — custom animated overlays**
At render time, Puppeteer composites `lyric-phrase.jsx` overlays over `tracks[0]`. Supports animated variants (`pop`, `fade`, `typewriter`), color-flash backgrounds, per-phrase styling. Good when the user wants control or is iterating on the look.

---

## ffmpeg Path

Requires a background video in `tracks[0]`. Both paths always build `lyric-phrase.jsx` overlays in `tracks[1]` for UI preview first.

### project.json setup

```json
{
  "renderMode": "ffmpeg-drawtext",
  "tracks": [
    [
      {
        "id": "bg",
        "type": "video",
        "src": "/abs/path/to/background.mov",
        "start": 0,
        "end": <song_duration>,
        "inPoint": 0,
        "outPoint": <clip_duration>
      }
    ],
    [ ...lyric-phrase overlays styled to match ffmpeg output — see ffmpeg preview fidelity rule above... ]
  ],
  "captions": {
    "style": "word-by-word",
    "segments": [ ...lyrics_sync segments... ],
    "position": "center",
    "color": "white",
    "fontsize": 72
  },
  "audio": { "music": { "src": "/abs/path/to/song.mp3", "inPoint": <audioInPoint> } },
  "status": "final"
}
```

The overlays in `tracks[1]` serve as the UI preview — word-sync is visible in the browser before render. At render time, `render.js` sees `renderMode` and bypasses Puppeteer, calling `lyrics_render.py` directly with the captions params above.

### captions ffmpeg params

| Field | Default | Notes |
|-------|---------|-------|
| `position` | `center` | `center` / `top-left` / `bottom-left` |
| `color` | `white` | Any ffmpeg color string |
| `fontsize` | `72` | Integer pixels |

### Mini-preview before full render

After setting up project.json and verifying overlay timing in the UI, run a short CLI preview before the full render:

```bash
montaj lyrics-render \
  --captions captions.json \
  --audio song.mp3 \
  --input background.mov \
  --position center \
  --color white \
  --fontsize 72 \
  --preview-duration 30 \
  --out preview.mp4
```

Verify the burned-in text looks correct, then trigger the full render with `montaj render project.json`.

---

## JSX Path

### project.json structure

```json
{
  "version": "0.2",
  "workflow": "lyrics_video",
  "settings": { "resolution": [720, 1280], "fps": 30 },
  "tracks": [
    [],
    []
  ],
  "audio": { "music": { "src": "/abs/path/to/song.mp3", "volume": 1.0, "inPoint": <audioInPoint> } },
  "status": "draft"
}
```

`tracks[0]` = background video loop OR empty array
`tracks[1]` = lyric phrase overlays (one per segment from lyrics_sync)

### Preview (mandatory)

After setting up `project.json`, **open the project in the montaj UI and preview before rendering.** The PreviewPlayer scrubs through the overlay timing in real time — verify word sync looks correct and adjust any `start`/`end` values in the overlay entries if needed. Only trigger a full render once the preview looks right.

### tracks[0] — With background video

```json
[
  {
    "id": "bg",
    "type": "video",
    "src": "/abs/path/to/background.mov",
    "start": 0,
    "end": <song_duration_seconds>,
    "inPoint": 0,
    "outPoint": <clip_duration_seconds>,
    "loop": true
  }
]
```

### tracks[0] — Without background video

```json
[]
```

`lyric-phrase.jsx` renders its own full-screen colored background automatically.

### tracks[1] — Overlay entries

One entry per segment from the lyrics_sync output. The `src` must be an **absolute path** to the template:

```
<montaj_root>/render/templates/overlays/lyric-phrase.jsx
```

```json
{
  "id": "phrase-0",
  "type": "overlay",
  "src": "/abs/path/to/montaj/render/templates/overlays/lyric-phrase.jsx",
  "start": 0.5,
  "end": 3.2,
  "props": {
    "words": [
      {"word": "drink", "start": 0.5, "end": 0.9},
      {"word": "le",    "start": 0.9, "end": 1.2},
      {"word": "croix", "start": 1.2, "end": 1.8}
    ],
    "variant": "pop",
    "transparent": false,
    "fontSize": 80,
    "fontFamily": "system-ui, sans-serif",
    "fontStyle": "normal",
    "textColor": "#111111",
    "strokeColor": null,
    "strokeWidth": 0,
    "wordEntrance": "scale",
    "entranceDuration": 0.1,
    "bg1": "#ffffff",
    "bg2": "#efefef",
    "bgStyle": "solid",
    "bgAngle": 135,
    "position": "center"
  }
}
```

For Google Fonts, add `"googleFonts": ["Font Name"]` on the overlay item alongside `"props"`, and set `"fontFamily"` to the font name in props.

### Background styles

| `bgStyle` | Effect |
|-----------|--------|
| `"solid"` | Flat color, alternates between `bg1`/`bg2` per word (default) |
| `"gradient"` | Linear gradient `bg1`→`bg2`, angle drifts 20°/s — gives subtle motion per frame |
| `"radial"` | Radial gradient — `bg1` at center, `bg2` at edges (spotlight effect) |
| `"vignette"` | Solid `bg1` with a dark radial overlay darkening the edges |

`"bgAngle"` sets the starting angle for `"gradient"` (default `135`). The angle slowly drifts over time so adjacent phrases look slightly different even with the same colors.

**Example — dark gradient with slow spin:**
```json
"bg1": "#0d0d0d",
"bg2": "#1a0030",
"bgStyle": "gradient",
"bgAngle": 135
```

**Example — spotlight radial:**
```json
"bg1": "#1a1a2e",
"bg2": "#000000",
"bgStyle": "radial"
```

Set `"transparent": true` when a background video is in `tracks[0]`.

### Variant guide

| Variant | Best for | Notes |
|---------|----------|-------|
| `"pop"` | Most lyrics, punchy phrases | One word at a time, bg flashes per word |
| `"accumulate"` | Building phrases, emphasis | Words stack at full font size, wrapping across lines to use vertical space |
| `"fade"` | Slow/emotional sections | Full phrase fades in/out |
| `"typewriter"` | Dramatic reveals | Characters reveal progressively |
| `"static"` | Match ffmpeg output exactly | All words shown immediately, `wordsPerLine` splits into N-word lines, auto font-sizing |

**Creative tip:** vary `variant` per phrase. Chorus → `"pop"` + `"scale"` entrance, bridge → `"fade"`.

### Word entrance animations

Applied per-word as it appears. Only meaningful for `pop` and `accumulate`.

| Value | Effect |
|-------|--------|
| `"none"` | Hard cut — word appears instantly (default) |
| `"scale"` | Word scales down from 1.3× to 1.0 while fading in |
| `"slide-up"` | Word slides up 20px while fading in |
| `"blur"` | Word unblurs from 8px to sharp while fading in |

`"entranceDuration"` controls speed in seconds (default `0.1` ≈ 3 frames at 30fps). Increase to `0.15`–`0.2` for more visible effect.

### Text stroke

```json
"strokeColor": "#000000",
"strokeWidth": 4
```

Stroke is painted under the fill (`paint-order: stroke fill`), so it doesn't eat into the letterforms.

### Font

```json
"fontFamily": "Montserrat, sans-serif",
"fontStyle": "italic",
"fontWeight": 700
```

For Google Fonts, also add `"googleFonts": ["Montserrat"]` on the overlay item.

### `textStyle` escape hatch

Raw CSS spread onto the `<p>` — for anything not covered by props:

```json
"textStyle": { "textTransform": "uppercase", "letterSpacing": "0.1em" }
```

### Transparent mode (with background video)

When `"transparent": true`, no background color renders — text floats over `tracks[0]`. A text shadow is applied automatically for readability.

Dark footage: `"textColor": "white"`, `"transparent": true`
Bright footage: `"textColor": "#111111"`, `"transparent": true`

---

## Resolution guide

| Format | Resolution | Use when |
|--------|-----------|----------|
| 9:16 portrait | `[720, 1280]` or `[1080, 1920]` | TikTok, Reels, Shorts |
| 1:1 square | `[720, 720]` or `[1080, 1080]` | Feed posts |
| 16:9 landscape | `[1280, 720]` | YouTube |

Always match the background video's native resolution if one is provided. Use `montaj probe --input video.mov` to check.

---

## Converting lyrics_sync output to overlay entries

The `lyrics_sync` output has shape:
```json
{ "segments": [{ "text": "...", "start": 1.0, "end": 3.5, "words": [...] }], "audioInPoint": 26.6 }
```

For each segment, create one overlay entry with:
- `"id": "phrase-<index>"`
- `"start": segment.start`
- `"end": segment.end`
- `"props.words": segment.words` — **subtract `segment.start` from every word's `start` and `end`** so timestamps are relative to the overlay's own start (the render engine injects `frame` starting at 0 for each overlay, not the project timeline)
- All other props set globally (same variant/colors for all phrases, unless varying by intent)

Set `audio.music.inPoint` to the `audioInPoint` value from the lyrics_sync output.

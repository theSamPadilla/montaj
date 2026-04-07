---
name: overlay
description: "Agent-authored workflow task: decide what overlays to write, author the JSX, and add them to the project's overlay track. Load this when you hit montaj/overlay in a workflow."
step: true
---

# Overlay

`montaj/overlay` is an agent-authored task — no CLI step, no API call. You decide what overlays the video needs, write the JSX files, and add them to the project's visual tracks in `project.json`.

**Before writing any JSX, load the write-overlay subskill** — it contains the full JSX authoring reference (globals, `interpolate`/`spring` utilities, canvas rules, examples). Load it with `/write-overlay`.

## Process

### 1. Read the editing prompt and transcripts

The prompt tells you the tone and intent. The transcript tells you the moments worth annotating. Read both before deciding what to write.

### 2. Decide what overlays to write

Ask: what does this video need that isn't already in the footage? Common answers:

- **Opening hook** (0–3s) — almost always right for social content. A punchy text statement that sells the video before the viewer decides to scroll.
- **Lower-thirds** — speaker name, context, stat callouts. Tied to specific transcript moments.
- **Logo/watermark** — if assets include a logo, add it as a persistent or bookend overlay.
- **Stat cards** — when the speaker cites a number ("33 million views"), a card reinforces it visually.

If the prompt says "no overlays" — write nothing. Don't add an opening hook anyway.

### Visual style defaults

**Plain text directly on video is almost always the right call.** Skip the card. Skip the frosted glass. Big, bold text sitting right on the footage is more dynamic and feels native — not slapped on top.

- **Go large** — 96–160px is a starting point, not a ceiling. If it looks a little too big, it's probably right. Small text gets scrolled past.
- **No backgrounds** — avoid dark cards, frosted panels, and semi-transparent boxes unless the prompt asks for them. A text shadow (`textShadow: '0 2px 16px rgba(0,0,0,0.9)'`) is enough to ensure legibility on any footage without boxing the text in.
- **Covering the face is fine** — text is more important than an unobstructed view of the speaker. Don't shrink or reposition text just to avoid the face.
- **Match the energy of the speech** — fast, punchy delivery gets tight entrance animations (4–6 frames). Slower, deliberate speech gets a smoother slide or fade (10–15 frames).
- **Use color sparingly** — one accent color maximum. White text with a colored word or icon reads better than multi-color text.

### 3. Tie overlays to the transcript

Use word-level timings from the transcript JSON to sync overlays to speech. An overlay that appears when the speaker says the word it displays lands harder than one that floats at an arbitrary time.

### 4. Write the JSX files

One JSX file per overlay component. Save to `overlays/<name>.jsx` in the project directory.

**There are no built-in templates.** Every overlay is custom JSX. Style it to match the editing prompt — a "dark, cinematic" prompt gets different typography than "energetic TikTok vibes."

See `/write-overlay` for the full authoring reference.

### 5. Add overlays to project.json

Overlays live in `tracks[1+]` — overlay tracks in the unified tracks array. Each inner array is one track. Items in the same track cannot overlap in time; items in different tracks are z-ordered (higher indexes render on top). `tracks[0]` is always the primary footage track.

```json
{
  "tracks": [
    [],
    [
      {
        "id": "ov-0",
        "type": "overlay",
        "src": "/abs/path/to/project/overlays/hook.jsx",
        "props": { "text": "The source code got leaked" },
        "start": 0.0,
        "end": 3.0
      }
    ]
  ]
}
```

For multiple non-overlapping overlays, add them to the same track. For simultaneous overlays at different z-levels, add them to separate tracks.

Persist via `PUT /api/projects/{id}` (HTTP) or write directly to `project.json` (headless).

## Rules

- **Use icons, not emojis** — `Ph.*` (Phosphor) or `FaIcon` with `FaSolid`/`FaBrands` (Font Awesome). Both are available as globals — no imports needed. Only use emojis if the prompt asks.
- **Always use absolute paths** for `src` — the render engine won't resolve relative paths
- **Don't overlap items at the same position** at the same time
- **To cover footage fully**, set `"opaque": true` on the item — the render engine removes transparency and lets the JSX root's CSS define the background. The audio track is unaffected.
- **Go large** — 96px+ for most text, 120–160px for hooks. Big text beats small text every time
- **No backgrounds by default** — plain text on video with a text shadow is the preferred style. Only use cards or panels when the prompt explicitly asks, or when legibility genuinely requires it
- **Covering the face is acceptable** — don't compromise text size or position to avoid the speaker
- **Keep text short** — 2–6 words for lower-thirds, 4–8 for hooks. Short + large beats long + small
- **Leave `offsetX`, `offsetY`, `scale` at defaults** (`0`, `0`, `1`) — the human positions overlays via the UI drag tool after preview
- **Use assets from `project.assets`** — pass asset `src` paths as `props`, don't hardcode paths inside JSX

## Render Constraints

- Canvas is **1080×1920 CSS pixels** — always, regardless of output resolution. The render pipeline captures segments at design resolution and upscales to the final output resolution (e.g. 2× for 4K) at compose time. All sizing in JSX is authored for 1080×1920.
- **Never apply `transform: translate` or `scale` to the root element** — these are applied by the pipeline at compose time. Applying them in JSX pushes content off-canvas.
- **Animations must complete before the overlay ends** — the last frame is held. If you fade out, opacity must reach 0 before the final frame. No mid-fade endings.
- **HDR output** — when source clips are 10-bit HLG/bt2020, the pipeline encodes the final output at `yuv420p10le` with full bt2020 color metadata. Overlay segments are composited in 10-bit space; no action required in JSX.
- **Split background from animated content** — never put `backdrop-filter: blur()` on a container whose children animate. It creates a GPU compositor layer that Chrome caches, producing stale/flashing frames in the rendered output. Put the frosted-glass card on its own lower track (where it can safely be cached — it's static), and put animated content on a higher track with no `backdrop-filter`. See `/write-overlay` for the full split pattern and when to skip backdrop-filter entirely.

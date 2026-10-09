---
name: overlay
description: "Agent-authored workflow task: decide what overlays to write, author the JSX, and add them to the project's overlay track. Load this when you hit montaj/overlay in a workflow."
step: true
subskills: "write-overlay"
---

# Overlay

`montaj/overlay` is an agent-authored task — no CLI step, no API call. You decide what overlays the video needs, write the JSX files, and add them to the project's visual tracks.

**Before writing any JSX, load skill `write-overlay`** — it contains the full JSX authoring reference (globals, `interpolate`/`spring` utilities, canvas rules, examples).

## Sub-skills

| Name | When to load |
|------|--------------|
| `write-overlay` | Before writing any JSX overlay — globals, `interpolate`/`spring` utilities, canvas rules, examples. |
| `image-search` | When the prompt asks to source outside imagery (a photo of a person, a logo, an event/B-roll still) — find via `search_images` + download via `fetch_image`, then place as an image clip on `tracks[1+]`. |

---

## Process

### 1. Read the editing prompt and transcripts

The prompt tells you the tone and intent. The transcript tells you the moments worth annotating. Read both before deciding what to write.

### 2. Decide what overlays to write

Decide from the prompt and the transcript what the video needs that isn't already in the footage.

**If the prompt asks you to source images** ("add a photo of X", "find images of the IPO"), load skill `image-search` to find them via `search_images` and download via `fetch_image`, then add each as a `type: "image"` clip on `tracks[1+]`. A still photo is an image clip, not an overlay; overlays are animated graphics.

If the prompt says "no overlays" — write nothing.

### Placement and timing constraints

- **Never hardcode frame counts**; projects can be 24, 30 or 60fps. Derive durations from `fps` (for example `Math.round(fps * 0.2)`).
- **Avoid the bottom ~350px** — that's where captions render and where platform UI lives (TikTok progress bar, Instagram controls). Keep `bottom` values above 350px, or use `top`-anchored placement instead.
- **Avoid the right ~200px** — TikTok and Instagram stack action buttons (like, comment, share, follow) down the right edge. Don't push text or icons into that zone.

### 3. Tie overlays to the transcript

Use word-level timings from the transcript JSON to sync overlays to speech.

### 4. Write the JSX files

One JSX file per overlay component. Save to `overlays/<name>.jsx` in the project directory.

**There are no built-in templates.** Every overlay is custom JSX.

See skill `write-overlay` for the full authoring reference.

### 5. Save overlays to the project

Overlays live in `tracks[1+]` — overlay tracks in the unified tracks array. Each track is an object (`{id, items, ...}`); its `items` array holds the track's clips/overlays. Items in the same track cannot overlap in time; items in different tracks are z-ordered (higher indexes render on top). `tracks[0]` is always the primary footage track.

```json
{
  "tracks": [
    { "id": "trk-0", "items": [] },
    {
      "id": "trk-1",
      "items": [
        {
          "id": "ov-0",
          "type": "overlay",
          "src": "/abs/path/to/project/overlays/hook.jsx",
          "props": { "text": "The source code got leaked" },
          "start": 0.0,
          "end": 3.0
        }
      ]
    }
  ]
}
```

For multiple non-overlapping overlays, add them to the same track. For simultaneous overlays at different z-levels, add them to separate tracks.

Follow save discipline: **read the project**, merge the updated `tracks` array into the fresh state, then **save the project (delta)**.

When this is the last editorial pass before the render, the project must be `final` before the render will run — see skill `native` → "Project lifecycle — status, and the render gate".

## Rules

- **Always use absolute paths** for `src` — the render engine won't resolve relative paths
- **Don't overlap items at the same position** at the same time
- **To cover footage fully**, set `"opaque": true` on the item — the render engine removes transparency and lets the JSX root's CSS define the background. The audio track is unaffected.
- **Leave `offsetX`, `offsetY`, `scale` at defaults** (`0`, `0`, `1`) — the human positions overlays via the UI drag tool after preview
- **Use assets from `project.assets`** — pass asset `src` paths as `props`, don't hardcode paths inside JSX
- **Expose text styling as props** — a text overlay you want editable in the editor's properties panel must READ its font, size, weight, style, color, alignment, transform, and background from `props` (the nine standard text props) with sensible defaults, not hardcode them in the JSX. A hardcoded style shows no control in the panel. See skill `write-overlay` → "Make text overlays editable in the properties panel"

## Render Constraints

- Canvas is **1080 on the short edge** with the aspect ratio of `project.settings.resolution` (default `[1080, 1920]` portrait) — always, regardless of output resolution. The render pipeline captures overlay segments at design resolution (Puppeteer viewport = 1080-short-edge) and upscales to the final output resolution (e.g. 2× for 4K) at compose time. All sizing in JSX is authored for 1080-design coordinates.
- **Never apply `transform: translate` or `scale` to the root element** — these are applied by the pipeline at compose time. Applying them in JSX pushes content off-canvas.
- **Animations must complete before the overlay ends** — the last frame is held. If you fade out, opacity must reach 0 before the final frame. No mid-fade endings.
- **HDR output** — when the project's `settings.colorSpace` is `hdr_hlg` or `hdr_pq`, the pipeline encodes the final output as HEVC 10-bit `yuv420p10le` with bt2020 color metadata (transfer `arib-std-b67` for HLG or `smpte2084` for PQ). Overlay segments are composited into the project's working color space at compose time; no action required in JSX.
- **Frosted glass needs `glass_plate`, never `backdrop-filter`** — each overlay item is captured in its own page, so `backdrop-filter` cannot see the footage (or another overlay). Run `glass_plate` for the item and draw its plate frame inside the glass shape; `track_points` pins the shape to moving footage. See skill `write-overlay`, "Frosted glass over footage".

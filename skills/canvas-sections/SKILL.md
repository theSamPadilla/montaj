---
name: canvas-sections
description: "Agent-authored task: build animation-only sections from scratch using opaque overlays. Load when the agent hits montaj/canvas-sections in a workflow."
step: true
---

# Canvas Sections

`montaj/canvas-sections` is an agent-authored task. No CLI step, no API call. You write the JSX overlay files and place them in `overlay_tracks` to build the full video from scratch.

**Before writing any JSX, load the write-overlay subskill** — it has the full authoring reference. Load it with `/write-overlay`.

---

## When to use canvas sections

Canvas sections are the right tool when:

- The project has **no source footage** (canvas workflow) — you build the entire video as animated slides
- You want to **cover a section of existing footage** with a full-frame opaque overlay (stats card, pull quote, title card, transition)

Canvas sections are **not** for transparent lower-thirds or watermarks. Use `montaj/overlay` for those.

---

## Process

### 1. Plan the sections

Read the editing prompt. Decide what sections the video needs:

- **Title card** — project/brand name, intro hook
- **Stat cards** — one strong number per card, 3–5 seconds each
- **Pull quotes** — impactful lines from the transcript or brief
- **Transition slides** — between major chapters
- **Outro** — CTA, social handle, end card

For canvas projects (no footage), plan the full sequence: every second must be covered by at least one overlay.

### 2. Write the JSX files

One JSX file per section. Save to `overlays/<name>.jsx`.

**When writing opaque sections:**
- Set `"opaque": true` on the project.json item
- The JSX root element's CSS controls the entire frame — use background colors, gradients, patterns freely
- Do not call `background: transparent` — that is for regular overlays only
- Source audio is preserved — only the video frame is replaced

**When covering footage sections:**
- Use `opaque: true` to fully cover the underlying video
- Time the section to cover exactly the footage segment you want to replace

See `/write-overlay` for the JSX authoring reference (globals, `interpolate`, `spring`).

### 3. Place items in overlay_tracks

Use `overlay_tracks[0]` for the primary visual layer (opaque sections, backgrounds):

```json
{
  "overlay_tracks": [
    [
      {
        "id": "title-card",
        "type": "custom",
        "src": "/abs/path/to/project/overlays/title-card.jsx",
        "start": 0.0,
        "end": 3.0,
        "opaque": true
      },
      {
        "id": "stat-card",
        "type": "custom",
        "src": "/abs/path/to/project/overlays/stat-card.jsx",
        "start": 5.0,
        "end": 9.0,
        "opaque": true,
        "props": { "value": "33M", "label": "monthly views" }
      }
    ]
  ]
}
```

Use `overlay_tracks[1+]` for **layered animations on top** — text, icons, motion graphics that sit above the background layer. Items in track 1 render on top of track 0.

### 4. No time overlap within a track

Items in the same track must not overlap in time. If you need two overlays at the same time at different z-levels, put them in different tracks.

For canvas projects (no footage), every timestamp must be covered by an item in track 0. Gaps in coverage produce a black frame.

### 5. Persist to project.json

Write `overlay_tracks` to `project.json` — `PUT /api/projects/{id}` (HTTP) or write directly (headless).

---

## Rules

- **Use icons, not emojis** — `Ph.*` (Phosphor) or `FaIcon` with `FaSolid`/`FaBrands` (Font Awesome). Both are available as globals — no imports needed. Only use emojis if the prompt asks.
- **Always use absolute paths** for `src`
- **opaque items fill the full frame** — no `offsetX`, `offsetY`, or `scale` on opaque items (they're set to defaults)
- **Source audio is untouched** — canvas sections only affect video, never audio
- **Duration inference** — for canvas projects, the render engine infers total duration from the highest `end` value across all items. Ensure your last item ends exactly when the video should end.

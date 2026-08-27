---
name: animation-sections
description: "Agent-authored task: build animation-only sections from scratch using opaque overlays. Load when the agent hits montaj/animation-sections in a workflow."
step: true
---

# Animation Sections

`montaj/animation-sections` is an agent-authored task. No CLI step, no API call. You write the JSX overlay files and place them in `tracks` to build the full video from scratch.

**Before writing any JSX, load the write-overlay subskill** — it has the full authoring reference. Load it with `/write-overlay`.

---

## When to use animation sections

Animation sections are the right tool when:

- The project has **no source footage** (animations workflow) — you build the entire video as animated slides
- You want to **cover a section of existing footage** with a full-frame opaque overlay (stats card, pull quote, title card, transition)

Animation sections are **not** for transparent lower-thirds or watermarks. Use `montaj/overlay` for those.

---

## Process

### 1. Plan the sections

Read the editing prompt. Decide what sections the video needs:

- **Title card** — project/brand name, intro hook
- **Stat cards** — one strong number per card, 3–5 seconds each
- **Pull quotes** — impactful lines from the transcript or brief
- **Transition slides** — between major chapters
- **Outro** — CTA, social handle, end card

For animation projects (no footage), plan the full sequence: every second must be covered by at least one overlay.

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

### 3. Place items in tracks

**`tracks[0].items` is always `[]` for animation projects.** The schema enforces that `tracks[0]`'s items must be `type: "video"` (primary footage). Animation projects have no footage, so `tracks[0]`'s items stay empty.

Use `tracks[1]` for the primary visual layer — opaque backgrounds and section slides:

```json
{
  "tracks": [
    { "id": "trk-0", "items": [] },
    {
      "id": "trk-1",
      "items": [
        {
          "id": "title-card",
          "type": "overlay",
          "src": "/abs/path/to/project/overlays/title-card.jsx",
          "start": 0.0,
          "end": 3.0,
          "opaque": true
        },
        {
          "id": "stat-card",
          "type": "overlay",
          "src": "/abs/path/to/project/overlays/stat-card.jsx",
          "start": 5.0,
          "end": 9.0,
          "opaque": true,
          "props": { "value": "33M", "label": "monthly views" }
        }
      ]
    }
  ]
}
```

Use `tracks[2+]` for **layered animations on top** — text, icons, motion graphics that sit above the background layer. Items in higher-numbered tracks render on top.

### 4. A partial overlap is a crossfade — but you have to author it yourself

Two neighbouring items on the same track may now partially overlap; the overlap **is** a dissolve between them. Two shapes are still rejected by the validator (`visual_track_overlap`):

- **Containment** — one item's span fully swallows the other's (identical spans included).
- **Three or more items live at the same instant** — a transition is a pair. If you need two overlays at the same time at different z-levels, put them in different tracks; that guidance still holds.

**The automatic fade is written by the editor, not by this skill.** `montaj/animation-sections` writes `project.json` directly, so overlapping two items with no `opacity` keyframes just draws one on top of the other at full strength — no dissolve. To get a crossfade, write it yourself: give the incoming item a two-point `opacity` keyframe track spanning the overlap, `t` measured in seconds from that item's *own* `start` (not the timeline).

**Sections in this skill are almost always `opaque: true`, and that changes which item gets the keyframes.** An opaque item tells the renderer it covers the whole frame, so whatever is beneath it is skipped rather than composited — fading its own opacity down reveals that skipped-over black, not the item you're transitioning to. So when the OUTGOING item is opaque (the normal case here), leave it out of the fade entirely — no `keyframes` on it at all, holding it at its default `1` — and only the incoming item fades in over it:

```json
{
  "id": "section-a",
  "start": 5.0, "end": 9.5,
  "opaque": true
},
{
  "id": "section-b",
  "start": 9.0, "end": 14.0,
  "opaque": true,
  "keyframes": [
    { "prop": "opacity", "points": [{ "t": 0, "value": 0 }, { "t": 0.5, "value": 1 }] }
  ]
}
```

The overlap here is `9.0`–`9.5`, a 0.5s dissolve: `section-b`'s points run `0 → 0.5`, relative to its own `start` of `9.0`. `section-a` needs no `keyframes` field at all.

If neither item is opaque (layered animations on `tracks[2+]`, for instance), fade both sides symmetrically instead — the outgoing item's own points run `1 → 0` over the same span, in its own item-relative time (here, `4.0 → 4.5`, relative to `section-a`'s `start` of `5.0`).

For animation projects (no footage), every timestamp must be covered by an item in `tracks[1]` or higher. Gaps in coverage produce a black frame.

### 5. Persist to project.json

Write `tracks` to `project.json` — `PUT /api/projects/{id}` (HTTP) or write directly (headless).

---

## Rules

- **Use icons, not emojis** — `Ph.*` (Phosphor) or `FaIcon` with `FaSolid`/`FaBrands` (Font Awesome). Both are available as globals — no imports needed. Only use emojis if the prompt asks.
- **Always use absolute paths** for `src`
- **opaque items fill the full frame** — no `offsetX`, `offsetY`, or `scale` on opaque items (they're set to defaults)
- **Source audio is untouched** — animation sections only affect video, never audio
- **Duration inference** — for animation projects, the render engine infers total duration from the highest `end` value across all items. Ensure your last item ends exactly when the video should end.

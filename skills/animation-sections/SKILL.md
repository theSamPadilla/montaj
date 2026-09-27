---
name: animation-sections
description: "Agent-authored task: build animation-only sections from scratch using opaque overlays. Load when the agent hits montaj/animation-sections in a workflow."
step: true
---

# Animation Sections

`montaj/animation-sections` is an agent-authored task. No CLI step, no API call. You write the JSX overlay files and place them in `tracks` to build the full video from scratch.

**Before writing any JSX, load the write-overlay subskill** — it has the full authoring reference. Load it with `/write-overlay`.

**Then read `skills/write-overlay/MOTION.md`.** An animation project is 100% motion graphics — there is no footage to carry it, so the motion *is* the product. MOTION.md has the easing catalog (`interpolate` is strictly linear, which is why untutored sections look flat), velocity-driven directional motion blur, per-character stagger, and the measurement commands this skill's verification step refers to.

---

## When to use animation sections

Animation sections are the right tool when:

- The project has **no source footage** (animations workflow) — you build the entire video as animated slides
- You want to **cover a section of existing footage** with a full-frame opaque overlay (stats card, pull quote, title card, transition)

Animation sections are **not** for transparent lower-thirds or watermarks. Use `montaj/overlay` for those.

---

## Process

### 1. Plan the sections — in bars, not seconds

Read the editing prompt. Decide what sections the video needs:

- **Title card** — project/brand name, intro hook
- **Stat cards** — one strong number per card
- **Pull quotes** — impactful lines from the transcript or brief
- **Transition slides** — between major chapters
- **Outro** — CTA, social handle, end card

**Length every one of them in bars.** The `animations` workflow generates the music bed first precisely so you have a tempo before you plan: `beat = 60 / BPM` seconds, `bar = 4 beats`. Two bars is the default section, four bars for a section that genuinely carries more information, one bar for a hit or flash cut. At 128 BPM a bar is 1.875s, so a 15-second piece is 8 bars — four 2-bar sections. If `generate_music` failed, the bed is a locally synthesized fallback at the same BPM instead of a Lyria clip — the grid you plan against does not change either way.

This is not decoration. The difference between a motion-graphics piece that reads as designed and one that reads as a slideshow is almost entirely whether its cuts sit on a grid. "About 3 seconds" is a slideshow. "Two bars" is a cut.

For animation projects (no footage), plan the full sequence: every second must be covered by at least one overlay.

### 1a. No dead air — the rule that matters most

**Every section must keep something in continuous motion for its entire span.** Not "animate in, then hold." A section that eases in over 10 frames and then sits perfectly still for the remaining two seconds is the single biggest quality defect this pipeline produces, and it is worth more to fix than any amount of styling.

Measured on a real Montaj promo, against a professionally-directed reference reel sampled at the same rate: 44.5% of the promo's frames were still, versus 15.0% — and its motion energy was 2.32 against 8.96, about a quarter. Nearly half the video was a still image, and the rest barely moved.

The fix is cheap. Every section gets at least one property under continuous motion across its whole duration, on top of whatever entrance animation it has:

```jsx
export default function StatCard() {
  const t = frame / duration                      // 0 → 1 across the whole section
  const enter = spring({ frame, fps, stiffness: 200, damping: 22 })

  // Entrance — finishes early and stops.
  const y = interpolate(enter, [0, 1], [40, 0])

  // Continuous — never stops for as long as the section is on screen.
  const drift = interpolate(t, [0, 1], [0, -28])        // slow parallax
  const breathe = 1 + 0.012 * Math.sin(t * Math.PI * 2) // subtle scale pulse

  return (
    <div style={{ position: 'absolute', inset: 0, transform: `translateY(${drift}px)` }}>
      <div style={{ transform: `translateY(${y}px) scale(${breathe})`, opacity: enter }}>
        …
      </div>
    </div>
  )
}
```

Things that legitimately count as continuous motion: slow positional drift or parallax between layers, a number counting up, a progress arc filling, a gradient or hue rotating, a background pattern scrolling, a rule extending, per-character stagger that is still resolving. Things that do not: a static element with a drop shadow, a blur that already finished, anything driven by `enter` alone.

`frame / duration` is the workhorse — `duration` is a global holding the section's total frames, so `t` is a normalised 0 → 1 progress through the section regardless of how many bars it runs for.

**Before you finish, check your work the way it will be judged** — see "Verify the motion" at the end of this skill.

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

The render engine requires `status: "final"` before it will run — see skill `native` → "Project lifecycle — status, and the render gate". That transition, and the render itself, are the user's call: leave `status` at `"draft"` when your editorial pass is done. See "Rules" below.

---

## Verify the motion

Do not judge an animation by reading its source, and do not judge it from one frame. **Do not render the project to check it, either — rendering is the user's call, not a QA step (see "Rules" below).** Use `sample_frame` instead: it composites one fully-rendered frame of `project.json` — video + image items + active overlay JSXs — at a given timestamp, with no video encode.

**Cut placement.** Sample every section/cut boundary and confirm the timestamp lands on your bar grid (2 bars at 128 BPM = 3.75s, etc.):

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 3.75 --out /tmp/boundary.png
```

A boundary off the grid is a math error in the section plan — that's arithmetic, not something a render would have told you that the plan doesn't already say.

**Dead air.** Inside each section, sample two frames about 0.2–0.3s apart:

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.00 --out /tmp/a.png
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.25 --out /tmp/b.png
```

If the pair looks identical, nothing in that span is moving — go back to §1a and the three traps in MOTION.md § "Continuous motion" (large-area motion, rotationally-symmetric shapes, values that finish early).

For a single overlay mid-authoring, before it's even placed in `tracks`, use `sample_overlay` instead — with `--duration` and `--fps` set, see MOTION.md § "Verify the motion, don't eyeball it". Without `--duration` the `duration` global is undefined and everything driven by `frame / duration` sits frozen at 0, which looks exactly like the bug you are hunting.

This replaces an earlier version of this rule that rendered the full project to `out.mp4` and measured it with ffmpeg (mean luma change between frames, for a motion-energy score; scene-cut detection, for placement). Those numbers were real and are worth knowing as calibration: a Montaj promo we were moving away from measured 2.320 motion energy and 44.5% still frames against a directed reference reel's 8.958 and 15.0%, and a section set built to this skill's rules reached 10.612 and 0.0%. Producing them meant rendering, though, and rendering the project is no longer something the agent does just to check its own work.

---

## Rules

- **Use icons, not emojis** — `Ph.*` (Phosphor) or `FaIcon` with `FaSolid`/`FaBrands` (Font Awesome). Both are available as globals — no imports needed. Only use emojis if the prompt asks.
- **Always use absolute paths** for `src`
- **opaque items fill the full frame** — no `offsetX`, `offsetY`, or `scale` on opaque items (they're set to defaults)
- **Source audio is untouched** — animation sections only affect video, never audio
- **Duration inference** — for animation projects, the render engine infers total duration from the highest `end` value across all items. Ensure your last item ends exactly when the video should end.
- **Do not render.** Rendering is the user's call, not something you trigger to check your own work or to finish the task — render only when the user asks. When the section set is done, set `project.status` to `"draft"` (not `"final"`) and stop there, so the user can preview it in the editor and render when they're ready.

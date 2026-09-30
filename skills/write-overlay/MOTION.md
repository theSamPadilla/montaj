# Motion mechanics reference

Companion to `SKILL.md`. It collects the sandbox facts and the verification procedure that matter once an overlay moves. Each fact here was checked by rendering through `steps/render/sample_overlay.py` against the real sandbox.

---

## SVG filters on HTML elements

`filter: url(#id)` on an HTML element works in the Puppeteer renderer, so an inline `<svg>` with a `<filter>` in its `<defs>` can filter any element in the overlay.

- Give the `<filter>` generous `x`/`y`/`width`/`height` (the `-50% / 200%` pattern) or the blur is clipped at the element's box and you get a hard cut edge.
- Each `<filter>` needs a unique `id`. Generate them with `.map()` when several elements need different filter values.

---

## Offsetting `spring` per element

When you delay one element's `spring` relative to another by an offset, clamp the frame: `Math.max(0, f - i * STAGGER)` is load-bearing. Without the clamp, `spring` gets a negative frame for elements that have not started yet.

---

## The `duration` global

`frame / duration` gives a 0 → 1 progress across the overlay's whole span.

**`duration` is only populated when the harness passes it.** `sample_overlay` needs `--duration <frames>` explicitly or the global is undefined and everything keyed to `frame / duration` sits frozen at 0 — which looks exactly like the bug you are trying to fix. Always guard with `duration ? … : 0`.

---

## Beat math

When a project has a music bed with a known tempo, convert it to frames at the project's fps. `beat = 60 / BPM` seconds; `bar = 4 beats`.

```jsx
const BPM = props.bpm ?? 128
const beat = fps * 60 / BPM          // frames per beat — 28.1 at 128 BPM / 60fps
const bar  = beat * 4
```

A tempo you requested from a music generator is approximate: Lyria honours a requested BPM only roughly. Measure the bed with the `detect_beats` step when the timing has to hold, and do not claim frame-accurate sync from a requested BPM alone.

---

## Verify the motion, don't eyeball it

**Do not render to check this.** Render only to produce the final video; checking is sampling's job. Everything below uses `sample_overlay` (one overlay, isolated) or `sample_frame` (the composited project at a timestamp); neither encodes a video.

```bash
# One frame, with the globals the render will actually use.
python steps/render/sample_overlay.py --overlay /abs/path/to/o.jsx \
  --frame 12 --duration 120 --fps 60 --width 1080 --height 1920 --out /tmp/f.png

# A contact sheet across the move.
for f in 2 6 10 16 24 34; do
  python steps/render/sample_overlay.py --overlay /abs/path/to/o.jsx \
    --frame $f --duration 120 --fps 60 --out /tmp/s_$f.png
done
```

Pass `--fps` to match the project. `spring()` is tuned in wall-clock time, so sampling a 60fps project at the 30 default shows springs settling twice as fast as they really will.

**Once the overlay is placed in a project, two different questions — do not substitute one for the other.** Switch from `sample_overlay` (a frame number inside one isolated JSX) to `sample_frame --project <project.json> --at <seconds>` (a timestamp inside the whole composited timeline) once that distinction matters.

### Motion energy — "is anything actually moving?"

Sample two frames about 0.2–0.3s apart inside the span you're checking. If the pair looks identical, nothing in that span is moving. The check needs no ffmpeg pass over a rendered file:

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.00 --out /tmp/a.png
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.25 --out /tmp/b.png
```

When checking a rendered video (not just overlays), use `steps/render/sample_diff.py` to flag frame differences quantitatively. A held or dropped frame in steady motion is not flagged: the next pair's diff is only about 2x, under the 3x ratio. Look for a near-zero pair between non-zero neighbours.

### Cut rate and placement — "is it cut to the grid?"

Sample every section/cut boundary directly and check the timestamp against your bar grid (2 bars at 128 BPM = 3.75s, etc.) — no cut detector needed, since you already know where you put the cuts:

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 3.75 --out /tmp/boundary.png
```

A boundary off the grid is a math error in the section plan, not a rendering question.

### Do not use scene_score to detect stillness

`scene_score` is a **cut detector**: it compares histograms to find edits. Smooth motion of similarly-coloured elements barely moves a histogram, so a section that sweeps full-frame gradients across the screen can score as "frozen." If you have a render on disk for some other (user-requested) reason and reach for `scene_score`, use it for cut placement only, never for stillness. The frame-pair check above is what stillness needs.

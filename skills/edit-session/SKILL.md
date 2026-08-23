---
name: edit-session
description: "Loaded after a draft is ready for back-and-forth editing: cutting, overlay adjustments, timing fixes. Not a pipeline step — this is the interactive editing reference."
---

# Edit Session

Load this skill when the draft is ready and the user wants to make refinements — cuts, overlay changes, re-timing, new overlays. This is not a workflow step; it covers the tools and conventions for iterative editing.

---

## After every file change: push a UI refresh

After writing `project.json` or any overlay `.jsx` file, call the reload endpoint so the UI updates without a manual refresh:

```bash
curl -s -X POST http://localhost:3000/api/projects/{project_id}/reload
```

The file watcher is unreliable under load. Always call this explicitly after changes.

---

## Before editing anything: verify the transcript

**Always check that the transcript matches the current clip before using timestamps.**

The clip filename tells you which transcript to use. For a clip at:

```
IMG_4900_fillers_concat_cut_cut.mp4
```

The transcript must be named after that exact file — e.g. `IMG_4900_fillers_concat_cut_cut.json`. If only an older transcript exists (e.g. `IMG_4900_fillers_concat.json`), it is stale — its timestamps come from a pre-cut file and will not align with the current video.

**Re-transcribe when in doubt:**

```bash
montaj transcribe "/abs/path/to/clip.mp4" --model base.en
```

Output: `clip.json` (word-level timings) and `clip.srt`. Always read the fresh `clip.json` before deriving overlay or cut timings.

---

## Cutting

**Cuts are pure JSON. Nothing re-encodes until the final render.**

This is the single most important thing to know about editing a v4 draft: a cut, a split, a ripple delete and a trim are all rewrites of `tracks` and `captions` in `project.json`. No intermediate file is produced, no clip file changes, and every edit is reversible by editing the JSON back. The helpers live in `montaj_assets/editor/src/video/cuts.ts` and the operator reaches them from the timeline; you reach the same outcome by writing the same JSON.

The four shapes, and what each does to the timeline:

| Edit | Effect on `tracks[0]` | Gap left behind? |
|------|----------------------|------------------|
| **Trim** an edge | move one item's `start` or `end`, and its matching `inPoint`/`outPoint` by the same amount | yes, unless ripple is on |
| **Split** at time *t* | one item becomes two adjacent items with no gap; `inPoint`/`outPoint` divide at the same source time | no |
| **Lift** a range out of a clip | the clip's remaining fragments keep their positions | yes, renders as black + silence |
| **Ripple delete** | as lift, then every later item shifts left to close the gap | no |

Rules that are easy to get wrong:

- **`end - start` must equal `outPoint - inPoint`** for a clip at normal speed, and `outPoint - inPoint === speed × (end - start)` for one with a `speed` set. Moving a timeline edge without moving the source point stretches the clip past the footage it has: the picture runs out partway along and freezes on its last frame while the waveform underneath draws the real, shorter stretch. Change both, always.
- **Never trim an edge past the source.** An `inPoint` below `0` or an `outPoint` beyond the source's duration is the same fault by a different route.
- **Overlay tracks are absolute.** `tracks[1+]` items carry timeline positions that do not move when you cut `tracks[0]`, which is deliberate — an overlay is meant to sit over whatever ends up underneath it. If a cut should carry its overlays with it, move them yourself.
- **Captions follow the primary track.** A cut that removes a span of `tracks[0]` must remove or shift the caption segments inside it, or the words desynchronise from the picture.
- **`src` never changes.** Cutting does not produce a new file, so the item keeps pointing at the original source — and keeps its `proxySrc` and `normalizedSrc` with it. If you rebuild an item from scratch instead of editing it in place, copy those two fields across or you will silently disable the preview engine.

**When you do need a real file** — `remove_bg` needs one, for instance — that is `materialize_cut`, and it is a deliberate step out of the non-destructive model, not part of ordinary cutting:

```bash
montaj materialize-cut clip.mp4 --inpoint 2.0 --outpoint 8.0   # keep one range
montaj materialize-cut clip.mp4 --cuts '[[1.0,3.5],[12.4,14.0]]'  # remove ranges, one pass
montaj materialize-cut spec.json                                # apply every keep in a trim spec
```

**After a materialize the clip file changes.** Re-transcribe if you need to update overlay timings.

---

## Overlays

### What overlays can do

- **Transparent overlays** — float over footage. Position with `position: absolute`, leave root background alone.
- **Opaque overlays** (`"opaque": true` in project.json) — replace the video frame entirely. Root CSS controls the full frame. Good for title cards, stat cards, full-screen animations.

### Timing overlays from transcript

Read word-level timings from `clip.json`. Each word has a `start` and `end` in seconds relative to the current clip. Use these to set overlay `start`/`end` in project.json and to compute per-item stagger delays inside the JSX.

Example: if "landing" appears at `t=16.70s` in the transcript and the overlay starts at `16.52s`, the item's trigger frame inside the component is:
```js
const ITEM_FRAME = Math.round((16.70 - 16.52) * fps)  // 0.18s * fps
```

### tracks layout

```json
{
  "tracks": [
    {
      // Track 0 — primary footage track
      "id": "trk-0",
      "items": [
        { "id": "clip-0", "type": "video", "src": "/abs/path/clip.mp4", "start": 0.0, "end": 0.0 }
      ]
    },
    {
      // Track 1 — background layer (opaque sections, backgrounds)
      "id": "trk-1",
      "items": [
        { "id": "...", "type": "overlay", "src": "/abs/path.jsx", "start": 0.0, "end": 5.0, "opaque": true }
      ]
    },
    {
      // Track 2+ — renders on top of track 1
      "id": "trk-2",
      "items": [
        { "id": "...", "type": "overlay", "src": "/abs/path.jsx", "start": 2.0, "end": 4.0 }
      ]
    }
  ]
}
```

- No time overlaps within a single track.
- Use separate tracks for simultaneous overlays at different z-levels.
- Always use **absolute paths** for `src`.

---

## Icons

Use icons instead of emojis unless the user explicitly asks for emojis.

### Phosphor Icons — `Ph`

All icons available as `Ph.<Name>`. Browse at [phosphoricons.com](https://phosphoricons.com).

```jsx
<Ph.CheckCircle size={52} weight="fill" color="#34d399" />
<Ph.Lock size={48} weight="fill" color="#f87171" />
<Ph.X size={200} weight="bold" color="#ff1a1a" />
```

Weights: `regular` (default), `bold`, `fill`, `duotone`, `light`, `thin`.

### Font Awesome — `FaIcon` + `FaSolid` / `FaBrands`

`FaIcon` is the renderer. Use `FaSolid` for general icons, `FaBrands` for brand logos (GitHub, YouTube, X/Twitter, TikTok, etc.).

```jsx
<FaIcon icon={FaSolid.faBolt} style={{ fontSize: 48, color: '#fbbf24' }} />
<FaIcon icon={FaBrands.faGithub} style={{ fontSize: 48, color: 'white' }} />
```

### Which to use

- **Phosphor** — default choice. Cleaner API, consistent weight, 9000+ icons.
- **Font Awesome Brands** — brand logos only (Phosphor doesn't have brand icons).
- **Font Awesome Solid** — fallback for anything Phosphor doesn't cover.

All four globals (`Ph`, `FaIcon`, `FaSolid`, `FaBrands`) are injected automatically in both the browser preview and the render pipeline. No imports needed.

---

## JSX authoring quick reference

All overlay JSX has these globals injected — **no imports, ever**:

| Global | Description |
|--------|-------------|
| `frame` | Current frame (0 → duration-1) |
| `fps` | Output frame rate |
| `duration` | Total frames this overlay is visible |
| `props` | The `props` object from project.json |
| `interpolate(frame, inputRange, outputRange, opts?)` | Linear mapping with clamp |
| `spring({ frame, fps, stiffness?, damping?, mass? })` | Physics spring → 0..1 |
| `Ph` | All Phosphor icons |
| `FaIcon` | FontAwesome renderer |
| `FaSolid` | FA Solid icons |
| `FaBrands` | FA Brand logos |

**Rules:**
- Default export only
- No hooks (`useState`, `useEffect`)
- No CSS `animation` or `transition` — all motion from `frame`
- Transparent root by default; opaque overlays set `background` on the root
- Never apply `transform: translate/scale` to the root element
- Animations must complete before the overlay ends (last frame is held)
- **ALL code that references `fps`, `frame`, `duration`, or `props` MUST be inside the component function body.** Top-level module code runs before these globals are injected in the render path (esbuild IIFE) and will throw `ReferenceError`. Style constant objects that don't reference these globals (e.g. `const LABEL_STYLE = { fontSize: 42, ... }`) are fine at the top level.

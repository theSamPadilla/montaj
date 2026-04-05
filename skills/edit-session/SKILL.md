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
python3 steps/transcribe.py \
  --input "/abs/path/to/clip.mp4" \
  --model base.en
```

Output: `clip.json` (word-level timings) and `clip.srt`. Always read the fresh `clip.json` before deriving overlay or cut timings.

---

## Cutting

### Cut tool spec

```
steps/cut.py --input <video> [options]
```

| Param | Type | Description |
|-------|------|-------------|
| `--start` | float | Start of section to remove (seconds). Single-cut mode with `--end`. |
| `--end`   | float | End of section to remove (seconds). Single-cut mode with `--start`. |
| `--cuts`  | string | JSON array of `[start, end]` pairs — multiple cuts in one ffmpeg pass. |
| `--spec`  | flag | Write a trim spec JSON instead of re-encoding. Prints `{"path": "..."}` to stdout. |

**Single cut:**
```bash
python3 steps/cut.py --input clip.mp4 --start 4.2 --end 7.8
```

**Multiple cuts in one pass:**
```bash
python3 steps/cut.py --input clip.mp4 --cuts '[[1.0,3.5],[12.4,14.0]]'
```

**Spec mode (no encode, fast):**
```bash
python3 steps/cut.py --input clip.mp4 --cuts '[[1.0,3.5]]' --spec
# → {"path": "/tmp/clip_spec.json"}
```

### Cut list (UI workflow)

When using the UI, cuts are **non-destructive until applied**:

1. **"Add to cut list"** — queues a `[start, end]` physical range on the clip instantly (no encode).
2. Pending cuts appear as red zones on the scrubber. PreviewPlayer skips over them.
3. **"Apply cuts (N)"** — encodes all queued cuts in one ffmpeg pass and updates the clip.

**Overlap merging:** if a new pending cut overlaps an existing one, they are merged to the outer bounds. Example:

```
Existing cut: [1.0, 3.0]
New cut:      [2.0, 5.0]
Result:       [1.0, 5.0]   ← outer bounds win
```

```
Existing: [1.0, 2.0]
New:      [0.0, 3.0]
Result:   [0.0, 3.0]       ← new fully contains old
```

**After applying cuts, the clip file changes.** Re-transcribe if you need to update overlay timings.

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
    [
      // Track 0 — primary footage track
      { "id": "clip-0", "type": "video", "src": "/abs/path/clip.mp4", "start": 0.0, "end": 0.0 }
    ],
    [
      // Track 1 — background layer (opaque sections, backgrounds)
      { "id": "...", "type": "overlay", "src": "/abs/path.jsx", "start": 0.0, "end": 5.0, "opaque": true }
    ],
    [
      // Track 2+ — renders on top of track 1
      { "id": "...", "type": "overlay", "src": "/abs/path.jsx", "start": 2.0, "end": 4.0 }
    ]
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

# Project JSON

> The single format that flows through the entire montaj pipeline. Describes a video edit completely — source clips, trim points, captions, overlays, audio. No media bytes, just data.

---

## States

| State | Who writes it | What's in it |
|-------|--------------|-------------|
| `pending` | `montaj run` or `montaj serve` (on `POST /run`) | Clip paths, editing prompt, workflow name. No agent work yet. |
| `draft` | agent | Trim points, ordering, captions, overlays. Agent's complete edit. |
| `final` | human (via UI) | Reviewed and tweaked. Ready to render. |

The agent writes project.json as it works — every write pushes to the browser via SSE.

---

## Top-level shape

```json
{
  "version": "0.1",
  "id": "a1b2c3d4-e5f6-...",
  "status": "pending | draft | final",
  "name": "Wedding BTS",
  "workflow": "tight-reel",
  "editingPrompt": "tight cuts, remove filler, 9:16 for Reels",
  "settings": { ... },
  "tracks": [ ... ],
  "overlay_tracks": [ ... ],
  "audio": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Schema version |
| `id` | string | UUID v4. Stable unique identifier for this project. Never changes. |
| `status` | string | Pipeline state: `pending`, `draft`, `final` |
| `name` | string \| null | Human-readable label set at init time. Optional. Does not need to be unique. |
| `workflow` | string | Workflow used to produce this edit |
| `editingPrompt` | string | The free-form prompt passed in |
| `settings` | object | Output resolution, fps, brand kit |
| `tracks` | array | Video, caption, and overlay tracks |
| `overlay_tracks` | array | Array of overlay track arrays. Each inner array is one z-level. Overlays belong here, not in `tracks[]`. |
| `audio` | object | Music and ducking config |

---

## Settings

```json
{
  "settings": {
    "resolution": [1080, 1920],
    "fps": 30,
    "brandKit": "default"
  }
}
```

---

## Tracks

Three track types. Rendered in order — later tracks composite over earlier ones.

### `video` — source footage

```json
{
  "id": "main",
  "type": "video",
  "clips": [
    {
      "id": "clip-1",
      "src": "/tmp/clips/take1.mp4",
      "inPoint": 2.5,
      "outPoint": 8.3,
      "order": 0,
      "transition": { "type": "crossfade", "duration": 0.3 }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `src` | string | Local file path — always local, never a URL |
| `inPoint` | number | Start time in the source file (seconds) |
| `outPoint` | number | End time in the source file (seconds) |
| `order` | number | Position in the sequence (0-indexed) |
| `transition` | object | Transition into the next clip. Omit for hard cut |

**Transition types:** `cut` (default), `crossfade`, `flash-white`, `flash-black`

---

### `caption` — captions and subtitles

```json
{
  "id": "captions",
  "type": "caption",
  "style": "word-by-word",
  "segments": [
    {
      "text": "This is how it works",
      "start": 0.0,
      "end": 2.1,
      "words": [
        { "word": "This",  "start": 0.0, "end": 0.3 },
        { "word": "is",    "start": 0.3, "end": 0.5 },
        { "word": "how",   "start": 0.5, "end": 0.8 },
        { "word": "it",    "start": 0.8, "end": 1.0 },
        { "word": "works", "start": 1.0, "end": 2.1 }
      ]
    }
  ]
}
```

`start` and `end` are timestamps in the **output video** — after trim and concat. The `words` array comes from Whisper and is required for animated styles.

**Caption styles:** `word-by-word`, `pop`, `karaoke`, `subtitle`

---

> Overlays are not in `tracks`. They live in `overlay_tracks` — see below.

---

## Overlay Tracks

All timed graphical elements (except captions) live in `overlay_tracks` — a top-level array of arrays. Each inner array is one z-level track. Items in the same track cannot overlap in time. Items in higher-index tracks render on top.

```json
{
  "overlay_tracks": [
    [
      {
        "id": "hook",
        "type": "custom",
        "src": "./overlays/hook.jsx",
        "start": 0.0,
        "end": 3.0,
        "props": { "text": "Hook line" }
      }
    ],
    [
      {
        "id": "logo",
        "type": "custom",
        "src": "./overlays/logo.jsx",
        "start": 0.0,
        "end": 30.0
      }
    ]
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `type` | string | Always `"custom"` |
| `src` | string | Path to JSX file, relative to project.json |
| `start` / `end` | number | Timestamps in output video (seconds) |
| `props` | object | Arbitrary props passed to the component |
| `opaque` | boolean | When `true`, render engine skips alpha — JSX root CSS controls the full frame background |
| `offsetX` | number | Horizontal offset as % of frame width (set by UI drag) |
| `offsetY` | number | Vertical offset as % of frame height (set by UI drag) |
| `scale` | number | Size multiplier from center (set by UI resize) |

**Canvas projects (no video track):** When the project has no video track, the render engine generates a synthetic black base video. Duration is inferred from the maximum `end` timestamp across all overlay items.

---

## Audio

```json
{
  "audio": {
    "music": {
      "src": "/tmp/audio/track.mp3",
      "volume": 0.15,
      "ducking": {
        "enabled": true,
        "depth": -12,
        "attack": 0.3,
        "release": 0.5
      }
    }
  }
}
```

**Ducking** auto-lowers music under speech and raises it in pauses. `depth` is in dB (negative). `attack` and `release` are in seconds.

---

## Assets

Image files (logos, watermarks, b-roll stills) passed in at project creation and copied into the workspace.

```json
{
  "assets": [
    { "id": "asset-0", "src": "/abs/path/to/workspace/logo.png", "type": "image", "name": "logo.png" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier — reference this when passing the asset to an overlay |
| `src` | string | Absolute path to the asset file in the workspace |
| `type` | string | `"image"` |
| `name` | string | Original filename. Human-readable label only. |

Assets are passed at project creation:

```bash
# CLI
montaj run clip.mp4 --prompt "add logo watermark" --assets logo.png

# HTTP
POST /api/run
{ "clips": ["/path/clip.mp4"], "assets": ["/path/logo.png"], "prompt": "add logo watermark" }
```

To use an asset in an overlay, pass its `src` path via `props`:

```json
{ "id": "ov-logo", "type": "custom", "src": "./overlays/logo.jsx", "start": 0.0, "end": 30.0,
  "props": { "src": "/abs/path/to/workspace/logo.png" } }
```

---

## Versioning

Project JSON versioning uses two layers:

**1. Git — milestone checkpoints (durable)**

`montaj run` initializes the workspace as a git repo if one doesn't exist. Commits are created automatically at state transitions:

| Event | Commit message |
|-------|---------------|
| `pending` created | `init: new project` |
| Agent marks `draft` | `draft: agent pass complete` |
| Human saves in UI | `review: human edits` |
| Manual checkpoint | `checkpoint: <name>` |

```bash
montaj checkpoint "before re-run"   # named commit before a risky operation
montaj undo                          # git checkout previous commit
```

The agent can also create checkpoints before major operations — e.g. before a caption pass, before resize. Full diff history via `git log` and `git diff`.

**2. In-memory undo stack — fine-grained UI undo**

The browser UI maintains an undo stack for the current review session. Every edit to a caption, overlay, or trim point pushes the previous state onto the stack. Undo/redo operates on this stack without touching disk or git.

The stack is cleared when the human saves (triggering a git commit) or when the page is reloaded.

---

## Conventions

- All timestamps in seconds (float)
- `src` fields are always local file paths — Montaj never reads or writes URLs
- Filename: `project.json`
- Encoding: UTF-8

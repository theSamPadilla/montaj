# Project JSON

> The single format that flows through the entire montaj pipeline. Describes a video edit completely — source clips, trim points, captions, overlays, audio. No media bytes, just data.

---

## States

| State | Who writes it | What's in it |
|-------|--------------|-------------|
| `pending` | `montaj run` or `montaj serve` (on `POST /run`) | Clip paths, editing prompt, workflow name. For `ai_video`, also the pre-seeded `storyboard` stub (raw intake references copied from the upload form). No agent work yet. |
| `storyboard_ready` | agent (for `projectType: "ai_video"` only) | Agent has populated `storyboard.imageRefs[]` with anchors + reference images, written `storyboard.styleAnchor`, and populated `storyboard.scenes[]` with the editorial plan (each with a prompt, duration, and refImages). `tracks[0]` is still empty — real clips only appear after approval + generation. Awaiting user approval before scene videos are generated. |
| `draft` | agent (for `editing`/`music_video`) or agent (for `ai_video` after all scene videos complete) | Trim points, ordering, captions, overlays. Complete edit — for `ai_video`, all `tracks[0]` items have non-empty `src`. |
| `final` | human (via UI) | Reviewed and tweaked. Ready to render. |

The status transition for `ai_video` is: `pending → storyboard_ready → draft → final`. For all other project types it remains `pending → draft → final`.

The agent writes project.json as it works — every write pushes to the browser via SSE.

---

## Top-level shape

```json
{
  "version": "0.2",
  "id": "a1b2c3d4-e5f6-...",
  "status": "pending | draft | final",
  "name": "Wedding BTS",
  "workflow": "tight-reel",
  "editingPrompt": "tight cuts, remove filler, 9:16 for Reels",
  "settings": { ... },
  "tracks": [ ... ],
  "captions": { ... },
  "audio": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Schema version — `"0.2"` |
| `id` | string | UUID v4. Stable unique identifier for this project. Never changes. |
| `status` | string | Pipeline state: `pending`, `storyboard_ready`, `draft`, `final` |
| `projectType` | string | Inherited from the workflow's `project_type` at init time. One of `"editing"`, `"music_video"`, `"ai_video"`. Default: `"editing"`. Never changes after creation. |
| `name` | string \| null | Human-readable label set at init time. Optional. Does not need to be unique. |
| `workflow` | string | Workflow used to produce this edit |
| `editingPrompt` | string | The free-form prompt passed in |
| `settings` | object | Output resolution, fps, brand kit |
| `tracks` | array | Array of track arrays. `tracks[0]` is the primary footage track. `tracks[1+]` are overlay tracks. Higher-index tracks render on top. May contain one empty track `[[]]` for animation-only projects. |
| `captions` | object | Caption configuration. Always rendered topmost, above all tracks. |
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

## tracks

All timeline items live in `tracks` — a top-level array of track arrays. `tracks[0]` is the primary track (source footage). `tracks[1+]` are overlay tracks. Each inner array is one z-level; items in higher-index tracks render on top.

### Track conventions

| Property | Rule |
|----------|------|
| **Primary track** | `tracks[0]` — always. Contains the main footage clips (`type: "video"`). |
| **Z-order** | Track index = z-order. `tracks[0]` renders furthest back; higher indices on top. |
| **Primary audio** | Non-muted items in `tracks[0]` provide the primary audio mix. |
| **Transcript source** | Whisper runs against `tracks[0]` audio. |
| **Canvas projects** | `tracks: [[]]` — one empty primary track. Duration is inferred from max `end` across all overlay tracks. |

### Primary track (`tracks[0]`)

Items in `tracks[0]` are always `type: "video"`. They have explicit `start`/`end` positions on the output timeline. Gaps between items render as black + silence.

```json
"tracks": [
  [
    {
      "id": "clip-1",
      "type": "video",
      "src": "./footage/take1.mp4",
      "start": 0.0,
      "end": 5.8,
      "inPoint": 2.5,
      "outPoint": 8.3,
      "transition": { "type": "crossfade", "duration": 0.3 }
    },
    {
      "id": "clip-2",
      "type": "video",
      "src": "./footage/take2.mp4",
      "start": 5.8,
      "end": 17.9,
      "inPoint": 0.0,
      "outPoint": 12.1
    }
  ]
]
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `type` | string | Always `"video"` for primary track items |
| `src` | string | Local file path — always local, never a URL |
| `start` | number | Output timeline position — when this clip starts (seconds) |
| `end` | number | Output timeline position — when this clip ends (seconds). `end - start` must equal `outPoint - inPoint`. |
| `inPoint` | number | Start time in the source file (seconds). Set by clean/trim steps. |
| `outPoint` | number | End time in the source file (seconds). Set by clean/trim steps. |
| `transition` | object | Transition into this clip. Omit for hard cut. |

**Transition types:** `cut` (default), `crossfade`, `flash-white`, `flash-black`

**Duration formula:**
```
totalDuration = max(item.end) across all items in all tracks
```

### Overlay tracks (`tracks[1+]`)

Overlay tracks contain the same item types as before: `overlay`, `image`, and `video`. See the field reference below.

---

## Overlay track items

All timed graphical elements in `tracks[1+]` are overlay track items. Each inner track array is one spatial z-level. Items in higher-index tracks render on top. Three item types are supported: `overlay`, `image`, and `video`.

### `type: "overlay"` — JSX component layer

```json
{
  "id": "hook",
  "type": "overlay",
  "src": "./overlays/hook.jsx",
  "start": 0.0,
  "end": 3.5,
  "props": { "text": "Watch this" },
  "offsetX": 0,
  "offsetY": 0,
  "scale": 1,
  "opacity": 1.0,
  "opaque": false
}
```

### `type: "image"` — static image layer (no JSX required)

```json
{
  "id": "logo",
  "type": "image",
  "src": "./assets/logo.png",
  "start": 0.0,
  "end": 120.0,
  "offsetX": 0.82,
  "offsetY": 0.04,
  "scale": 0.12,
  "opacity": 1.0
}
```

### `type: "video"` — video layer (with optional background removal)

```json
{
  "id": "presenter",
  "type": "video",
  "src": "./assets/presenter.mp4",
  "remove_bg": true,
  "nobg_src": "./assets/presenter_nobg.mov",
  "nobg_preview_src": "./assets/presenter_nobg_preview.webm",
  "muted": false,
  "start": 0.0,
  "end": 120.0,
  "inPoint": 5.0,
  "outPoint": 25.0,
  "offsetX": 0.6,
  "offsetY": 0.65,
  "scale": 0.35,
  "opacity": 1.0
}
```

### Field reference

| Field | Type | Types | Description |
|-------|------|-------|-------------|
| `id` | string | all | Unique identifier |
| `type` | string | all | `"overlay"`, `"image"`, or `"video"` |
| `src` | string | all | Path to JSX file, image, or video — relative to project.json |
| `start` / `end` | number | all | Timestamps in output video (seconds) |
| `offsetX` | number | all | Horizontal offset as % of frame width |
| `offsetY` | number | all | Vertical offset as % of frame height |
| `scale` | number | all | Size multiplier from center |
| `opacity` | number | all | Opacity 0.0–1.0 (default 1.0). Applied at compose time. |
| `props` | object | overlay | Arbitrary props passed to the JSX component |
| `opaque` | boolean | overlay | When `true`, render engine skips alpha — JSX controls full frame |
| `googleFonts` | array | overlay | Google Font names to load before rendering |
| `remove_bg` | boolean | video | Marks this item as background-removed. `src` stays as the original (used for browser preview). Render uses `nobg_src` when present. |
| `nobg_src` | string | video | Path to the ProRes 4444 `.mov` with alpha channel produced by the `remove_bg` step. Used at final render time. |
| `nobg_preview_src` | string | video | Path to the VP9 WebM with alpha produced by the `remove_bg` step. Used in the browser preview player (Chrome supports VP9 alpha; ProRes does not play in browsers). |
| `muted` | boolean | video | When `true`, audio from this video item is suppressed in both preview and final render. Default: `false`. |
| `inPoint` | number | video | Trim start in the source video file (seconds) |
| `outPoint` | number | video | Trim end in the source video file (seconds) |

---

## captions

The `captions` field is a top-level object (not a track). It always renders above all tracks — topmost in the compositing stack.

```json
{
  "captions": {
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
}
```

`start` and `end` are timestamps in the **output video** — after trim and concat. The `words` array comes from Whisper and is required for animated styles.

**Caption styles:** `word-by-word`, `pop`, `karaoke`, `subtitle`

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

To use an asset in a `tracks[1+]` item, pass its `src` path via `props` (for overlays) or directly as `src` (for image/video types):

```json
{ "id": "logo", "type": "image", "src": "/abs/path/to/workspace/logo.png", "start": 0.0, "end": 30.0,
  "offsetX": 0.82, "offsetY": 0.04, "scale": 0.12 }
```

---

## Storyboard

All `ai_video`-specific state lives under a single top-level `storyboard` object. Absent for `editing` and `music_video` projects. Distinct from the flat `assets` array (which is unrelated and used by all project types for user-uploaded logos/watermarks).

The `storyboard` holds four logical groups:

1. **Intake settings** — `aspectRatio`, `targetDurationSeconds`. Structured parameters the user chose at intake.
2. **Reference library** — `imageRefs[]` (things that appear in the video), `styleRefs[]` (things that influence style without appearing), `styleAnchor` (the agent-written style string prepended to every Kling prompt at call time).
3. **The editorial plan** — `scenes[]`. One entry per planned scene, reviewable in the StoryboardView before approval. Populated by the agent during `pending`; empty at intake.
4. **Approval marker** — `approval`. Written by the UI when the user clicks "Approve & Generate."

```json
{
  "storyboard": {
    "aspectRatio": "16:9",
    "targetDurationSeconds": 30,
    "imageRefs": [
      {
        "id": "ref1",
        "label": "Max",
        "anchor": "A golden retriever with one floppy ear, wearing a red collar.",
        "refImages": ["/abs/path/to/workspace/max.png"],
        "source": "upload",
        "status": "ready"
      },
      {
        "id": "ref2",
        "label": "Lena",
        "anchor": "A woman in her 30s with curly red hair, freckles, wearing denim.",
        "refImages": ["/abs/path/to/workspace/lena_generated.png"],
        "source": "text",
        "status": "ready"
      }
    ],
    "styleRefs": [
      {
        "id": "style1",
        "kind": "video",
        "path": "/abs/path/to/workspace/mood_clip.mp4",
        "label": "mood reference"
      }
    ],
    "styleAnchor": "warm golden-hour lighting, shallow depth of field, cinematic framing",
    "scenes": [
      {
        "id": "scene1",
        "prompt": "Max runs into the sunlit kitchen, ball in mouth, sliding on tiles.",
        "duration": 6,
        "refImages": ["ref1"]
      },
      {
        "id": "scene2",
        "prompt": "Close-up of Max dropping the ball by the fridge, panting.",
        "duration": 5,
        "refImages": ["ref1"]
      }
    ],
    "approval": {
      "approvedAt": "2026-04-18T14:32:00Z"
    }
  }
}
```

### Top-level storyboard fields

| Field | Type | Written by | When | Description |
|-------|------|-----------|------|-------------|
| `aspectRatio` | string | `init.py` | Intake | Kling body parameter. Enum: `"16:9" \| "9:16" \| "1:1"`. Constant across the project — every scene generates at this aspect. Mutable later via agent chat (rewrites the field; regeneration reads the current value). |
| `targetDurationSeconds` | number | `init.py` | Intake | Editorial aggregate goal — informs the agent's scene count and per-scene durations. NOT passed to Kling directly. The agent divides this across scenes when populating `scenes[]`. |
| `styleAnchor` | string | agent | `pending` | Style string prepended to every scene's prompt at call time. Informed by `styleRefs` analysis. Not persisted into per-scene prompts — applied at the `kling_generate` call site. |
| `scenes` | object[] | agent | `pending` | The editorial plan. Empty at intake. See "`scenes[]` fields" below. |
| `approval` | object | **UI** | On Approve click | `{approvedAt: ISO-8601}`. The agent watches for field presence (not value) to start scene generation. |

### `imageRefs[]` fields

Anything that *appears in* the video: characters, locations, specific objects. Populated by `init.py` from the user's intake form; anchors written by the agent during `pending`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable within the project. Referenced by `scenes[i].refImages` as well as `tracks[0][i].generation.refImages`. |
| `label` | string | Short human-friendly name. The user provides this at intake (e.g. "Max"). Agents use labels to match natural-language prompt mentions to refs. |
| `anchor` | string | Agent-written longer description. If the user provided an image at intake, the agent writes the anchor from the image + label. If the user provided a text description, the anchor starts as that text and the agent enriches it. |
| `refImages` | string[] | Absolute paths to reference images. For `source: "upload"`, populated at intake with the user's file. For `source: "text"`, starts empty; agent calls `generate_image` with the anchor as prompt and appends the result. Fed into Kling's `image_list` (up to 3 per scene — Kling's hard limit). |
| `source` | string | What the user gave us at intake. `"upload"` = user uploaded a file (that file is `refImages[0]`). `"text"` = user provided a text description (`anchor` holds it; `refImages` starts empty and the agent populates it). Immutable after intake — describes the user's input, not the ref's current state. The UI shows a "your upload" chip when `source === "upload"`. |
| `status` | string | `"pending"` \| `"generating"` \| `"ready"` \| `"failed"`. Written by the agent / UI as generation/regeneration runs. |

### `styleRefs[]` fields

Audio/video/image files that influence *style* without appearing in the final video. Consumed once by the agent during `pending` (via `analyze_media`), folded into `storyboard.styleAnchor`. Display-only in the StoryboardView afterwards.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable within the project. |
| `kind` | string | `"video"` \| `"audio"` \| `"image"`. Determined from the file extension at intake. |
| `path` | string | Absolute path to the file in the workspace. |
| `label` | string | User-given label (optional). |

Style refs do not reach Kling directly — their influence is mediated entirely through `styleAnchor`.

### `scenes[]` fields

The editorial plan — one entry per scene the agent intends to generate. Empty at intake; agent populates during `pending` informed by `editingPrompt`, `imageRefs`, `styleAnchor`, and `targetDurationSeconds`. Editable pre-approval via the StoryboardView's scene-prompt editor.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable within the project. Provenance pointer on every resulting `tracks[0]` clip via `generation.sceneId`. |
| `prompt` | string | Scene-specific prompt. Does NOT include `styleAnchor` — that's prepended at call time in the connector layer. Max 2500 chars (Kling's limit). |
| `duration` | number | Per-scene duration in seconds, picked by the agent. Sum across scenes should approximate `targetDurationSeconds` but is not enforced. Constrained to what Kling accepts (currently enum: `5`, `7`, `10` — verify against current Kling docs). |
| `refImages` | string[] | IDs into `storyboard.imageRefs[]`. Max 3 per scene (Kling hard limit). The agent picks refs that match labels mentioned in the prompt. |

At approval time, the agent iterates `scenes[]` and calls `kling_generate` for each entry. A successful call appends a new `tracks[0]` clip with a frozen `generation` block. See next section.

---

### `generation` (optional, on video items in `tracks[0]`)

Post-generation provenance record. Present on clips produced by an AI-generation step. Absent for items sourced from user-uploaded clips.

This block is a **frozen snapshot** of what was sent to the provider when the clip was created. It is the authoritative record for that clip — regeneration reads from here, not from `storyboard.scenes[]` (which may have drifted since the clip was produced). When a clip is cut into pieces, all pieces inherit the same `generation` block at cut time and can diverge independently on future regeneration.

```json
{
  "id": "clip-scene1",
  "type": "video",
  "src": "/path/to/scene1.mp4",
  "start": 0,
  "end": 6,
  "inPoint": 0,
  "outPoint": 6,
  "generation": {
    "sceneId": "scene1",
    "provider": "kling",
    "model": "kling-v3-omni",
    "prompt": "warm golden-hour lighting... Max runs into the sunlit kitchen...",
    "refImages": ["ref1"],
    "duration": 6,
    "attempts": [
      { "ts": "2026-04-18T14:40:00Z", "prompt": "...", "src": "/path/to/scene1_v1.mp4" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `generation.sceneId` | string | Optional pointer back to the `storyboard.scenes[i].id` this clip was generated from. Convenience for UI grouping when one scene is cut into multiple pieces. |
| `generation.provider` | string | Currently `"kling"`. Could grow to include other video-gen providers. |
| `generation.model` | string | Model used (e.g. `"kling-v3-omni"`). Recorded for reproducibility. |
| `generation.prompt` | string | The exact combined prompt that was sent to the provider (includes `styleAnchor` and `<<<image_N>>>` tokens for reference images). Useful for "why did this clip look weird" debugging — one field, one answer. |
| `generation.refImages` | string[] | IDs into `storyboard.imageRefs[]`. Regeneration resolves these to current paths (`imageRefs[i].refImages[0]`), so if the user regenerates a reference image, subsequent regens of this clip pick up the new visual. |
| `generation.duration` | number | Duration in seconds that was requested for this specific clip. Regeneration pre-fills the modal with this value. |
| `generation.attempts` | object[] | Chronological (oldest first). On every regeneration, the previous `{ts, prompt, src}` is appended. Does NOT include the current state — that's the top-level `prompt`/`src`. |

**`aspectRatio` is NOT on the generation block.** Aspect ratio lives at `storyboard.aspectRatio` (project-wide). Regeneration reads the current project-wide value. If the user switches aspect mid-draft, regenerated clips pick up the new value — intentionally.

#### Batched clips (multi-shot mode)

When the agent uses Kling's multi-shot mode, a SINGLE `tracks[0]` clip can contain up to 6 scenes concatenated into one video. The `generation` block shifts shape: `sceneId` / `prompt` / `refImages` / `duration` are replaced by `batchShots[]`, which carries the per-scene mapping.

```json
{
  "id": "batch-scene1-scene3",
  "type": "video",
  "src": "/path/to/batch.mp4",
  "start": 0,
  "end": 10,
  "inPoint": 0,
  "outPoint": 10,
  "generation": {
    "provider": "kling",
    "model": "kling-v3-omni",
    "multiShot": true,
    "shotType": "customize",
    "refImages": ["ref1", "ref2"],
    "attempts": [],
    "batchShots": [
      { "sceneId": "scene1", "index": 1, "prompt": "...", "start": 0.0, "end": 3.0, "duration": 3 },
      { "sceneId": "scene2", "index": 2, "prompt": "...", "start": 3.0, "end": 7.0, "duration": 4 },
      { "sceneId": "scene3", "index": 3, "prompt": "...", "start": 7.0, "end": 10.0, "duration": 3 }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `generation.multiShot` | boolean | `true` when this clip came from a multi-shot call. Omitted otherwise. |
| `generation.shotType` | string | `"customize"` or `"intelligence"`. Mirrors Kling's `shot_type` request param. |
| `generation.batchShots` | object[] | Per-scene mapping inside the batch. One entry per shot. |
| `generation.batchShots[i].sceneId` | string | The `storyboard.scenes[i].id` this shot was generated from. |
| `generation.batchShots[i].index` | number | 1-based, matches Kling's `multi_prompt[].index`. |
| `generation.batchShots[i].prompt` | string | Combined prompt for this shot (styleAnchor + scene prose + any `<<<image_N>>>` tokens). 512-char cap per Kling's docs. |
| `generation.batchShots[i].start` | number | Shot start in seconds, **relative to the batch clip** (not the project timeline). UI derives per-scene progress windows from these values. |
| `generation.batchShots[i].end` | number | Shot end in seconds, relative to the batch clip. |
| `generation.batchShots[i].duration` | number | Requested duration in seconds (same as `end - start` barring Kling rounding). |

**UI progress check.** A scene is "done" if `tracks[0].some(c => c.generation?.sceneId === s.id || c.generation?.batchShots?.some(x => x.sceneId === s.id))`. Both cases must be checked — the agent chooses between single-shot and batched dispatch per its judgment.

**Regenerating one scene from a batch.** Run that scene as a single-shot call; append the resulting clip to `tracks[0]` as a new entry. Leave the original batched clip in place; its window for the replaced scene becomes unused time between other shots. The timeline readers place clips by `start`/`end`; unused windows are acceptable for v1.

### Lifecycle: when `tracks[0]` is populated

`tracks[0]` holds **real clips only** — items whose `src` is a file that exists on disk. There are no stubs, no placeholder items, no `src: ""` entries. This invariant is consistent across all project types:

- `editing` projects populate `tracks[0]` at intake with user-uploaded clips.
- `music_video` projects start with `tracks[0] = []` and get populated by the lyrics pipeline.
- `ai_video` projects start with `tracks[0] = []` and grow by append as each `kling_generate` call returns.

For `ai_video`:
- At `pending` and `storyboard_ready` (including during active generation), `tracks[0]` is empty or partial. The StoryboardView stays mounted; per-scene progress is derived by checking whether `tracks[0].some(c => c.generation?.sceneId === scene.id)`.
- Status transitions `storyboard_ready → draft` only when every `storyboard.scenes[i]` has a corresponding clip in `tracks[0]`. At that point `EditorPage` routes to `ReviewView` and the user sees a coherent timeline for the first time.
- On partial failure, status stays `storyboard_ready`. The failed scene has no corresponding clip; the agent can retry later (idempotent — scenes with existing clips are skipped).

---

## Full example

Talking-head presenter over a screen recording, with a logo watermark, hook overlay, and captions.

```json
{
  "version": "0.2",
  "id": "abc123",
  "status": "final",
  "settings": { "resolution": [1080, 1920], "fps": 30 },
  "tracks": [
    [
      { "id": "clip-1", "type": "video", "src": "./screen_recording.mp4", "start": 0.0, "end": 120.0, "inPoint": 0, "outPoint": 120 }
    ],
    [
      {
        "id": "presenter",
        "type": "video",
        "src": "./presenter.mp4",
        "remove_bg": true,
        "start": 0.0,
        "end": 120.0,
        "inPoint": 0.0,
        "outPoint": 120.0,
        "offsetX": 0.6,
        "offsetY": 0.65,
        "scale": 0.35
      }
    ],
    [
      {
        "id": "logo",
        "type": "image",
        "src": "./assets/logo.png",
        "start": 0.0,
        "end": 120.0,
        "offsetX": 0.82,
        "offsetY": 0.04,
        "scale": 0.12
      }
    ],
    [
      {
        "id": "hook",
        "type": "overlay",
        "src": "./overlays/hook.jsx",
        "start": 0.0,
        "end": 3.5,
        "props": { "text": "Watch this" }
      }
    ]
  ],
  "captions": { "style": "word-by-word", "segments": [] }
}
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

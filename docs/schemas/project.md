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
| `projectType` | string | Inherited from the workflow's `project_type` at init time. One of `"editing"`, `"music_video"`, `"ai_video"`, `"carousel"`, `"broll"`. Default: `"editing"`. Never changes after creation. |
| `name` | string \| null | Human-readable label set at init time. Optional. Does not need to be unique. |
| `workflow` | string | Workflow used to produce this edit |
| `editingPrompt` | string | The free-form prompt passed in |
| `settings` | object | Output resolution, fps, brand kit |
| `tracks` | array | Array of track objects (`{id, items, volume?, muted?, enabled?}`); a legacy array-of-arrays shape is also still read everywhere. `tracks[0]` is the primary footage track. `tracks[1+]` are overlay tracks. Higher-index tracks render on top. `tracks[0]` may have an empty `items` array for animation-only projects. See [tracks](#tracks) below. |
| `captions` | object | Caption configuration. Always rendered topmost, above all tracks. |
| `audio` | object | Music and ducking config |
| `derivedFrom` | string | Optional. Set on clip projects fanned out from a source by the `clips` workflow; the source project's id. |

---

## Settings

```json
{
  "settings": {
    "resolution": [1080, 1920],
    "fps": 30,
    "brandKit": "default",
    "normalize": "eager"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `resolution` | number[2] | Output resolution `[width, height]` in pixels. |
| `fps` | number | Output frame rate. |
| `brandKit` | string | Brand kit name. |
| `normalize` | string | Source normalization strategy. `"eager"` (default) — re-encodes the full source to a dense-keyframe, conformant file at import time. `"lazy"` — skips full-source normalization; instead each clip's `[inPoint, outPoint]` window is normalized on demand and cached as `normalizedSrc` on the track item. The `clips` workflow imports with `lazy` so large sources are not re-encoded up front. |
| `imageTone` | string | Optional. Color mapping for overlay images in HDR renders — one of `"vivid"` (default: true colors at full graphics brightness), `"broadcast"` (BT.2408 203-nit graphics white; accurate but dimmer than the raster graphics), `"punchy"` (legacy contrast with corrected color), `"raw"` (no conversion — the legacy oversaturated look). Ignored for SDR projects. The `montaj render --image-tone` flag overrides it per run. Cached conversions live next to each asset as `<stem>_<colorSpace>_<tone>.png`. |

---

## tracks

Each entry in `tracks` is a track object:

```json
"tracks": [
  { "id": "trk-0", "items": [ /* video items */ ] },
  { "id": "trk-1", "items": [ /* overlay items */ ], "volume": 0.8, "muted": false, "enabled": true }
]
```

`tracks[0]` is the primary track (source footage). `tracks[1+]` are overlay tracks. Track order is meaningful: index is z-order, and items on a higher-index track's `items` array render on top of items on a lower one.

### Track object fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable track identifier. Assigned when a legacy project is migrated (rule below) or when a drag creates a new track in the editor; never reused within a project. |
| `items` | array | The track's timeline items — same item shapes as before: `type: "video"` on `tracks[0]`, `overlay`/`image`/`video` on `tracks[1+]`. See [Overlay track items](#overlay-track-items) below. |
| `volume` | number | Optional. Gain for the track's audio. Absent = unity (1.0). |
| `muted` | boolean | Optional. Absent or `false` = audible. |
| `enabled` | boolean | Optional. Absent or `true` = the track renders. |

`volume`/`muted`/`enabled` carry a setting that belongs to the TRACK rather than to one clip on it, and the track rail (the mute button, skip toggle, and volume gear on a track's sidebar) reads and writes them. `volume` scales every item's audio on that track — it multiplies against each item's own `volume` rather than replacing it, so balancing two clips against each other survives turning the whole track down. `muted` silences the track's audio without touching the clip volumes underneath; un-muting restores them. `enabled: false` skips the track entirely — it renders in neither preview nor final render, and its items are excluded when the render pipeline computes the project's total duration. They are unrelated to the per-clip `item.muted`/`item.volume` fields on individual `tracks[1+]` video items (below) and to `audio.tracks[].muted`/`.volume`, both of which render and preview already honor independently. A track carrying none of the three optional fields behaves exactly as it always has.

### Legacy shape and the both-shapes contract

Before this, `tracks` was a bare array of arrays — `[[item, item], [item]]` — with no place to hang a track-level setting. Both shapes are read everywhere in the codebase today. A project converts to the object shape the first time it's opened in the editor, riding the existing lazy on-open pass — there is no separate migration command or button. A project that's never opened keeps rendering and editing correctly as-is: the CLI and the render pipeline read both shapes directly, without requiring a migration.

When a legacy track is converted, its `id` is generated as `trk-<index>`; a collision with an id already present elsewhere in the project is resolved by appending `-2`, `-3`, … A project already in object form is returned unchanged by the conversion (same object, same ids) — converting is idempotent, and a converged project triggers no extra write.

**Read or write tracks through the shared accessors, never `project.tracks` directly** — they absorb the shape difference so callers don't have to:

- Python: `normalize_tracks`, `track_items`, `replace_track_items` in `lib/project_tracks.py`
- Render pipeline (Node): `normalizeTracks`, `trackItems` in `montaj_assets/render/project-tracks.js`
- Editor (TypeScript): `normalizeTracks`, `trackItems`, `mapTrackItems` in `montaj_assets/editor/src/video/timeline/timeline-model.ts`

The three are kept in lock-step by convention: the same input produces the same ids and the same structure from any of them. `engine/validate.py` accepts both shapes on read.

### Track conventions

| Property | Rule |
|----------|------|
| **Primary track** | `tracks[0]` — always. Its `items` contain the main footage clips (`type: "video"`). |
| **Z-order** | Track index = z-order. `tracks[0]` renders furthest back; higher indices on top. |
| **Primary audio** | Non-muted items in `tracks[0]`'s `items` provide the primary audio mix. |
| **Transcript source** | Whisper runs against `tracks[0]` audio. |
| **Canvas projects** | `tracks[0].items` is `[]` for animation-only projects. Duration is inferred from max `end` across all overlay tracks. |

### Primary track (`tracks[0]`)

Items in `tracks[0].items` are always `type: "video"`. They have explicit `start`/`end` positions on the output timeline. Gaps between items render as black + silence.

```json
"tracks": [
  {
    "id": "trk-0",
    "items": [
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
  }
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
| `sourceCrop` | object | Optional. `{x, y, w, h}` as fractions of the source's natural dimensions (`[0, 1]`). Defines the visible region for vertical reframing (e.g. auto-reframe from landscape to portrait). All four keys required when present. |
| `sourceWidth` | number | Optional. Source pixel width. Written by the agent from a probe; required for `sourceCrop` to render correctly. |
| `sourceHeight` | number | Optional. Source pixel height. Written by the agent from a probe; required for `sourceCrop` to render correctly. |
| `normalizedSrc` | string | Optional. Path to a per-window normalized cache produced by `montaj step normalize_window`. Covers exactly `[inPoint, outPoint]` of the original source — dense-keyframe, conformant. Render and preview prefer `normalizedSrc` over `src` when present; `src` always stays the original file. `inPoint`/`outPoint` remain original-source timestamps; the render engine rebases them automatically when reading from the cache (cache always starts at 0). Written by the `clips` workflow under `settings.normalize: "lazy"`. |
| `proxySrc` | string | Optional. Path to a full-source, all-intra 720p AV1+Opus editing proxy for instant-scrub preview. Always covers the whole original file — never a window, no `proxyInPoint` — so one proxy can serve every clip that shares a lazy source. **Preview-only: render never reads this field.** Preview's src precedence is `nobg_preview_src ?? proxySrc ?? normalizedSrc ?? src` — the proxy sits after `nobg_preview_src` deliberately, since an opaque proxy ahead of it would resurrect a removed background in preview while render still composites alpha. The filename carries a look-version tag (`<stem>_proxy_<LOOK>.mp4`); `LOOK` is the current master look from `montaj_assets/luts/looks.json` (`lib/look.py`'s `MASTER_LOOK`, currently `"vivid1"`) — bumping the manifest's `masterLook` invalidates every existing proxy by construction, since the freshness check (`mtime(proxy) >= mtime(src)`) sees a different filename and treats it as absent. Written by `project/init.py` at import, best-effort (a failed encode just leaves the item without `proxySrc`; the editor falls back to playing `src`/`normalizedSrc`), or via `POST /api/proxy` for backfill. |
| `muted` | boolean | Optional. When `true`, this clip's audio is suppressed in both preview and final render. Default: `false`. ORed with the track's own `muted` (above) — either one silences the clip. |
| `volume` | number | Optional. Gain for this clip's audio, `0.0`–`2.0`. Default `1.0`. Multiplies with the track's own `volume` (above) rather than replacing it. |
| `speed` | number | Optional. Playback speed, `0.25`–`4`. Default `1.0`. Pitch-corrected in both preview and final render — audio plays at the new speed without a pitch shift. Speeding a clip up shortens its `end - start` on the timeline; slowing it down lengthens it. |

**Transition types:** `cut` (default), `crossfade`, `flash-white`, `flash-black`

**Duration formula:**
```
totalDuration = max(item.end) across all items in all tracks
```

### Overlay tracks (`tracks[1+]`)

An overlay track's `items` array holds the same item types as before: `overlay`, `image`, and `video`. See the field reference below.

---

## Overlay track items

All timed graphical elements live in `tracks[1+]`'s `items` arrays. Each track is one spatial z-level; items on higher-index tracks render on top. Three item types are supported: `overlay`, `image`, and `video`.

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
| `proxySrc` | string | video | Full-source, all-intra 720p AV1+Opus editing proxy — same field and same rules as `tracks[0]`'s `proxySrc` above. `OverlayItemsLayer` adopts it at `nobg_preview_src ?? proxySrc ?? src` (this track type has no `normalizedSrc` tier); render never reads it. |
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

**Segment end is explicit.** Each segment carries its own `end`; the next segment's `start` does NOT imply the previous segment's `end`. The editor's active-segment test is `currentTime >= start && currentTime < end`.

**Caption styles:** `word-by-word`, `pop`, `karaoke`, `subtitle`

Each style maps to a built-in JSX template served at `GET /api/caption-template/:style`. An unknown style value renders no captions. `words` is optional in the schema but required for animated styles (`word-by-word`, `karaoke`).

**Per-segment positioning.** Each entry in `segments[]` may carry its own `offsetX`, `offsetY`, and `scale`, letting one segment be moved or resized independently of the rest — e.g. to clear a beat that puts something else (a whiteboard card, a lower-third) at the bottom of the frame. These are consumed only by the JSX browser preview and the Puppeteer render path; the ffmpeg `drawtext` render branch does not read them and continues to honour only the track-level `position` field below.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Stable identifier for the segment, used for selection in the editor (drag in preview, click in timeline). Optional in hand-authored captions — the editor backfills a `cap-<n>` id for any segment missing one, both on load and after caption regeneration. Ids are minted against those already in use, so a track mixing identified and unidentified segments never gets a duplicate. |
| `offsetX` | number | 0 | Horizontal offset as % of frame width. `0` or absent = the style's default anchor (e.g. `bottom: 18%`, which varies per style). |
| `offsetY` | number | 0 | Vertical offset as % of frame height. `0` or absent = the style's default anchor. |
| `scale` | number | 1 | Visual scale of the whole caption block, about its own centre. This is a CSS transform, not a font-size change: it scales the background box (`subtitle`) and text stroke (`outline`) along with the text, and it does **not** re-wrap the text — a scaled-up caption keeps its original line breaks and can overflow the frame. |
| `color` | string | — | Per-segment override of the base text color, overriding the track-level `color` below for this segment only (per-style accent colors — e.g. `highlightColor`, `accentColor` — are not overridable per segment). Absent = inherit the track-level `color` → the style's own default. Like `offsetX`/`offsetY`/`scale`, this is consumed only by the JSX browser preview and the Puppeteer render path; the ffmpeg `drawtext` render branch has no per-segment concept and continues to honour only the track-level `color` field below. |

**ffmpeg-only fields.** The following optional fields may appear on the top-level `captions` object. They are consumed only by the ffmpeg `drawtext` render branch and are ignored by the JSX browser preview. The caption generation route preserves them across regeneration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `position` | string | — | `center`, `top-left`, or `bottom-left` |
| `color` | string | — | CSS-style hex or named color for caption text |
| `fontsize` | number | — | Font size in pixels for drawtext render |
| `bgColor` | string | — | Background box color for drawtext render |

**Hand-authorable.** `project.captions` is a first-class field: an agent that holds word-level transcripts can write captions directly via `PUT /api/projects/:id` without going through the generation pipeline. The Hub proxy validates the shape on PUT (when captions are written through Hub) and rejects malformed captions before forwarding (style must be a known enum value; each segment must have `text`, `start`, and `end`; `words`, if present, must be well-formed); Montaj itself stores whatever it receives. Agents writing captions by hand should include `words` whenever using an animated style.

### HTTP endpoints

```
POST /api/projects/:id/captions
```

SSE stream (default). Runs the materialize → transcribe → caption pipeline and streams `log` / `done` / `error` events. Writes `project.captions` on success.

Optional body fields: `model` (Whisper model, default `"large"`), `language` (default `"auto"`), `style` (default: existing `captions.style`, or `"pop"`).

Returns `409` if a caption job for the project is already in flight.

```
POST /api/projects/:id/captions?async=1
```

Async kick. Launches the same pipeline detached and returns immediately:

```json
HTTP 202
{ "projectId": "<id>", "status": "running" }
```

```
GET /api/projects/:id/captions/status
```

Poll the state of the current or last detached caption job. Returns `idle` when no job has run since the server started.

```json
{ "status": "idle | running | done | error", "captions": { ... }, "error": "..." }
```

`captions` is present only when `status` is `done`. `error` is present only when `status` is `error`.

---

## Audio

Independent audio tracks, mixed into the video in a final pass. Every audio source — music bed, voiceover spine, sound effect — is a track in this array. There is no separate `music` block.

```json
{
  "audio": {
    "tracks": [
      {
        "src": "/tmp/audio/track.mp3",
        "volume": 0.15,
        "ducking": { "enabled": true, "depth": -12, "attack": 0.3, "release": 0.5 }
      }
    ]
  }
}
```

| field | type | meaning |
|---|---|---|
| `src` | string | Absolute path to the audio (or video — only its audio is read) file. Required. |
| `muted` | bool | When true the track is skipped entirely. |
| `volume` | number | Linear gain. Defaults to `1.0`. |
| `start` | number | Where the track begins on the output timeline, in seconds. Implemented as a delay; defaults to `0`. |
| `end` | number | Where the track stops on the output timeline, in seconds. |
| `inPoint` / `outPoint` | number | Slice of the **source** file to use. Optional. |
| `fadeIn` / `fadeOut` | number | Fade durations in seconds. |
| `ducking` | object | `{ enabled, depth, attack, release }` — see below. |

**One track is one contiguous slice of one file.** There is no multi-segment cut list for audio; a track carries a single `inPoint`/`outPoint` pair. A voiceover that has been cut down (silence, non-speech, and fillers removed) is therefore materialized to a single file first — see `materialize_cut --audio` — rather than emitted as one track per surviving segment.

**Ducking** auto-lowers a track under speech and raises it in pauses. `depth` is in dB (negative). `attack` and `release` are in seconds.

---

## Voiceover

Present only on `broll` projects — `engine/validate.py` requires this block (with a non-empty `src`) whenever `projectType` is `"broll"`.

```json
{
  "voiceover": {
    "src": "/abs/path/to/workspace/narration.mp4",
    "cleanedSrc": "/abs/path/to/workspace/narration_cut.wav"
  }
}
```

| Field | Type | Description |
|-------|------|--------------|
| `src` | string | Required. Absolute path to the voiceover source file in the workspace — audio or video. Only its audio is used; a video file's picture is never placed on a visual track unless the editing prompt explicitly asks for it. Written by `project/init.py` from `--voiceover-asset` (CLI, accepting one or more paths) or `voiceoverAsset` / `voiceoverAssets` (HTTP `POST /api/run`). When several takes are supplied, `src` points at the concatenated `voiceover_full.wav` rather than at any single input (`voiceover_full_<N>.wav` in the rare case a take of the user's own already claims that name). Not rewritten by any step after init. |
| `takes` | string[] | Optional. Absolute paths to the individual voiceover takes in the workspace, in the order they were concatenated to produce `src`. Written by `project/init.py` only when more than one file was supplied via `--voiceover-asset` / `voiceoverAssets`; absent for a single-take project, where `src` **is** the take. Provenance only — no step reads it. |
| `cleanedSrc` | string | Optional. Absolute path to the cleaned voiceover, written by the `broll` skill after running `materialize_cut --audio` on the clean-cut chain. Present once the skill has produced its draft; absent before. |

The footage index the `broll` skill builds while assembling the draft is written to `broll_index.json` in the project workspace — a working artifact for the skill, not part of `project.json`.

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

## Profile

Optional fields that associate a project with a creator style profile. Both are present together when `--profile` is passed at init; both are absent otherwise.

| Field | Type | Description |
|-------|------|-------------|
| `profile` | string | Optional profile name (e.g., `"thesampadilla"`). When set, the project is associated with the profile at `~/.montaj/profiles/{profile}/`. Live link: changes to the profile dir affect what the agent reads (e.g., `style_profile.md`). |
| `profileSnapshot` | object | Optional snapshot of the profile's assets manifest at project init time. Pinned — does NOT update if the profile changes after init. Shape described below. |

### `profileSnapshot` shape

```json
{
  "profileSnapshot": {
    "name": "thesampadilla",
    "summary": "Always end with bumper.mov. Logo bottom-right at 60% opacity.",
    "styleProfilePath": "/Users/sam/.montaj/profiles/thesampadilla/style_profile.md",
    "availableAssets": [
      { "filename": "bumper.mov", "description": "End-card bumper", "tags": ["branding", "end-card"] },
      { "filename": "logo.png",   "description": "Channel logo",   "tags": ["branding"] }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Same as `profile` — kept for self-containment. |
| `summary` | string | Hand-written guidance about how to use this asset library. Frozen at project init. Distinct from `style_profile.md` (which is analysis-derived editorial direction); `summary` is hand-curated rules tied to the asset library. When the two conflict, `summary` wins. |
| `styleProfilePath` | string | Absolute path to the profile's `style_profile.md`. The agent reads this file **live** (not snapshotted) for editorial direction analyzed from the creator's content. **Field is omitted** when `style_profile.md` did not exist at project init time (e.g., a project created before `montaj profile analyze` was run). |
| `availableAssets` | object[] | Alpha-sorted list of files in the profile's assets dir at init time, with their manifest descriptions. Frozen at project init. |
| `availableAssets[i].filename` | string | Filename of the asset (e.g., `"bumper.mov"`). |
| `availableAssets[i].description` | string | User-written description from the assets manifest. |
| `availableAssets[i].tags` | string[] | Optional tags. |

The agent reads `profileSnapshot` as creative context: load `styleProfilePath` for editorial direction (live read), use `summary` for asset-library guidance (frozen), and use `availableAssets` as a directory of reusable files the user has curated. Specific assets are included into the project by the user via the editor side panel — included assets land in the top-level `assets[]` array with the standard asset shape.

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
| `id` | string | Stable within the project. Referenced by `scenes[i].refImages` as well as `tracks[0].items[i].generation.refImages`. |
| `label` | string | Short human-friendly name. The user provides this at intake (e.g. "Max"). Agents use labels to match natural-language prompt mentions to refs. |
| `anchor` | string | Agent-written longer description. If the user provided an image at intake, the agent writes the anchor from the image + label. If the user provided a text description, the anchor starts as that text and the agent enriches it. |
| `refImages` | string[] | Absolute paths to reference images. For `source: "upload"`, populated at intake with the user's file. For `source: "text"`, starts empty; agent calls `generate_image` with the anchor as prompt and appends the result. Fed into Kling's `image_list` (up to 7 per scene — Kling's hard limit). |
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
| `prompt` | string | Scene-specific prompt. Does NOT include `styleAnchor` — that's prepended at call time by the director skill (not the connector). Max 2500 chars single-shot, 512 chars per shot in multi-shot mode. |
| `duration` | number | Per-scene duration in integer seconds (Kling-enforced enum: 3–15). Sum across scenes should approximate `targetDurationSeconds` but is not enforced. |
| `refImages` | string[] | IDs into `storyboard.imageRefs[]`. Max 7 per scene (Kling API limit). The agent picks refs that match labels mentioned in the prompt. |
| `lastError` | object \| undefined | Optional. Written by the agent on a failed `kling_generate` call: `{ts: ISO-8601, message: string}`. Cleared on eventual success. The UI's ApproveAndGenerate progress panel reads this to show "failed" status per scene. |

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

**UI progress check.** A scene is "done" if `tracks[0].items.some(c => c.generation?.sceneId === s.id || c.generation?.batchShots?.some(x => x.sceneId === s.id))`. Both cases must be checked — the agent chooses between single-shot and batched dispatch per its judgment.

**Regenerating one scene from a batch.** Run that scene as a single-shot call; append the resulting clip to `tracks[0].items` as a new entry. Leave the original batched clip in place; its window for the replaced scene becomes unused time between other shots. The timeline readers place clips by `start`/`end`; unused windows are acceptable for v1.

### `regenQueue` (ai_video only)

Per-clip regeneration queue. The UI (inspect modal, subcut tool) and CLI (`montaj regen`) append entries; the agent drains them when triggered by the user in chat.

```json
{
  "regenQueue": [
    {
      "id": "req-1713658092",
      "clipId": "clip-scene-2",
      "mode": "full",
      "subrange": null,
      "prompt": "warm golden-hour lighting... Max running faster through the meadow",
      "refImages": ["imgref_max", "imgref_meadow"],
      "duration": 5,
      "useFirstFrame": false,
      "useLastFrame": false,
      "model": "kling-v3-omni",
      "requestedAt": "2026-04-20T15:28:12Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique within the queue. Convention: `"req-<timestamp>"`. |
| `clipId` | string | Must match a `tracks[0].items[i].id`. |
| `mode` | string | `"full"` (replace entire clip) or `"subcut"` (replace a window within the clip). |
| `subrange` | object \| null | `{start: <int>, end: <int>}` in source-seconds. Null for `mode: "full"`. For subcut, `end - start` must be in [3, 15] integer. |
| `prompt` | string | Natural language. The agent/step composes the ref clause and `<<<image_N>>>` tokens via `compose_prompt()`. |
| `refImages` | string[] | `imageRef` IDs. Resolved against `storyboard.imageRefs[i].refImages[0]` at call time. |
| `duration` | number | Integer seconds in [3, 15]. For `kling-video-o1`: must be 5 or 10. |
| `useFirstFrame` | boolean | Subcut only. When true, the agent extracts the frame at `subrange.start` and passes it as `--first-frame`. |
| `useLastFrame` | boolean | Subcut only. When true, the agent extracts the frame at `subrange.end` and passes it as `--last-frame`. |
| `model` | string | `"kling-v3-omni"` or `"kling-video-o1"`. Inherited from `clip.generation.model`, user-overridable. |
| `requestedAt` | string | ISO-8601 timestamp. |
| `lastError` | object \| undefined | Set by the agent on failure: `{ts: ISO-8601, message: string}`. Entry stays in queue until user re-triggers or removes it. |

**Lifecycle:** UI/CLI appends → agent drains on user trigger → entries removed on success, marked with `lastError` on failure.

**UI progress convention:** A small "N queued" chip appears on any clip whose `id` matches a `regenQueue[i].clipId`.

### Lifecycle: when `tracks[0]` is populated

`tracks[0]` holds **real clips only** — items whose `src` is a file that exists on disk. There are no stubs, no placeholder items, no `src: ""` entries. This invariant is consistent across all project types:

- `editing` projects populate `tracks[0].items` at intake with user-uploaded clips.
- `music_video` projects start with `tracks[0].items = []` and get populated by the lyrics pipeline.
- `ai_video` projects start with `tracks[0].items = []` and grow by append as each `kling_generate` call returns.

For `ai_video`:
- At `pending` and `storyboard_ready` (including during active generation), `tracks[0].items` is empty or partial. The StoryboardView stays mounted; per-scene progress is derived by checking whether `tracks[0].items.some(c => c.generation?.sceneId === scene.id)`.
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
    {
      "id": "trk-0",
      "items": [
        { "id": "clip-1", "type": "video", "src": "./screen_recording.mp4", "start": 0.0, "end": 120.0, "inPoint": 0, "outPoint": 120 }
      ]
    },
    {
      "id": "trk-1",
      "items": [
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
      ]
    },
    {
      "id": "trk-2",
      "items": [
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
      ]
    },
    {
      "id": "trk-3",
      "items": [
        {
          "id": "hook",
          "type": "overlay",
          "src": "./overlays/hook.jsx",
          "start": 0.0,
          "end": 3.5,
          "props": { "text": "Watch this" }
        }
      ]
    }
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

---

## Carousel projects

Carousel projects (`projectType: "carousel"`) share the universal header fields (`version`, `id`, `status`, `projectType`, `name`, `workflow`, `editingPrompt`, `runCount`, `settings.resolution`) but omit `tracks`, `sources`, `audio`, `storyboard`, and `settings.fps`. The render target is a set of PNGs, not a video.

Carousel-specific top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `projectType` | `"carousel"` | Identifies this project as a carousel. Set at init; immutable. |
| `carousel.aspect` | string | One of `square`, `portrait`, `vertical`. Locked at creation. Drives `settings.resolution` — `[1080,1080]`, `[1080,1350]`, `[1080,1920]` respectively. |
| `slides` | `Slide[]` | Ordered slide deck. Element order within a slide is z-order, bottom → top. |

### `Slide` shape

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID v4. Stable identifier. |
| `base_color` | string | CSS hex color for the slide background. Default `#ffffff`. |
| `elements` | `Element[]` | Ordered array of elements. Bottom → top z-order. |

### `Element` variants

**`type: "image"`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID v4. |
| `type` | `"image"` | |
| `src` | string | Path relative to the project directory. |
| `x`, `y` | number | Top-left position in pixels at native resolution. |
| `w`, `h` | number | Width and height in pixels at native resolution. |
| `rotation` | number | Clockwise rotation in degrees. |

**`type: "overlay"`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID v4. |
| `type` | `"overlay"` | |
| `overlay.template` | string | Overlay ID — matches the overlay's id in the global or profile library. |
| `overlay.props` | object | Per-overlay props (text, color, etc.). `offsetX`/`offsetY`/`scale` inside props are ignored at render time; position is owned by `x/y/w/h/rotation`. |
| `frame` | number | Frame index passed to the overlay component at render time. Carousels have no time axis; each element renders at exactly one frame. Default = overlay's `staticFrame` export, or `duration - 1`. |
| `x`, `y` | number | Top-left position in pixels at native resolution. |
| `w`, `h` | number | Width and height in pixels at native resolution. |
| `rotation` | number | Clockwise rotation in degrees. |

### Example

```jsonc
{
  "version": "0.2",
  "id": "abc123",
  "projectType": "carousel",
  "status": "final",
  "carousel": { "aspect": "portrait" },
  "settings": { "resolution": [1080, 1350] },
  "slides": [
    {
      "id": "slide-1",
      "base_color": "#ffffff",
      "elements": [
        {
          "id": "el-1",
          "type": "image",
          "src": "assets/hero.jpg",
          "x": 0, "y": 0, "w": 1080, "h": 1350,
          "rotation": 0
        },
        {
          "id": "el-2",
          "type": "overlay",
          "overlay": {
            "template": "lower-third",
            "props": { "text": "Day one." }
          },
          "frame": 60,
          "x": 0, "y": 1100, "w": 1080, "h": 200,
          "rotation": 0
        }
      ]
    }
  ]
}
```

Source of truth for the exact contract: `engine/validate.py`.

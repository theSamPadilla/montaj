---
name: montaj
description: "You MUST use this whenever the user asks for video editing work. Use it when video-related tasks are brought up. Editing, analyzing video, or transcribing videos"
---

# Montaj Skill

Montaj is a video editing toolkit with agent-first tools. Built-in steps cover common operations. Workflows provide suggested operations. But you (the agent) decide what to run, in what order, and with what parameters based on user input.

## Core Loop

**Detecting which interface to use:**
Try `GET http://localhost:3000/api/projects?status=pending`. If it responds → **HTTP mode**: load `skills/serve/SKILL.md` before making any API calls, then follow the HTTP loop there. If connection is refused → CLI or MCP mode.

**When running as MCP client:** Load `skills/mcp/SKILL.md`.

**When running headless (CLI):**
```
1. The location of the clips, the prompt, and preferred workflow should have been given to you by your human. If not provided, ask. Don't guess.
2. Read the workflow from workflows/{name}.json
3. Apply editorial judgment (select/order/trim clips via probe + transcribe)
4. Execute workflow steps following the dependency graph
5. Write/update project.json in the project directory as you go
6. Probe the final output → set inPoint: 0, outPoint: <duration>
7. Mark project as draft (status: "draft") when complete
8. Notify your human or ask questions if you run into issues.
```

**Check for a style profile:**
- **HTTP mode** — read `profile` field from project JSON. If set, load `~/.montaj/profiles/<profile>/style_profile.md` and let it inform editorial decisions.
- **CLI mode** — run `montaj profile list`. If profiles exist, ask the user if they wish to apply it.

**Never invent a step sequence from scratch.** Follow the assigned workflow; deviate only where the prompt explicitly requires it or the workflow fails (see Deviation Rules).

**Multiple clips or workflow has `foreach` steps:** Load `skills/parallel/SKILL.md`.

## Running Steps

**HTTP API:** Load `skills/serve/SKILL.md` — all step calls go through `POST http://localhost:3000/api/steps/:name`. Fire long-running steps with `run_in_background: true` to stay available for conversation.

**CLI — use when serve is NOT running:**
```bash
montaj probe clip.mp4
montaj snapshot clip.mp4
montaj trim clip.mp4 --start 2.5 --end 8.3
montaj cut clip.mp4 --start 3.0 --end 7.5
montaj cut clip.mp4 --cuts '[[0,1.2],[5.3,7.8]]'   # multiple cuts, one ffmpeg pass
montaj cut clip.mp4 --cuts '[[3.0,7.5]]' --spec     # write trim spec instead of encoding
montaj materialize-cut clip.mp4 --inpoint 2.0 --outpoint 8.0
montaj materialize-cut spec.json
montaj waveform-trim clip.mp4 --threshold -30 --min-silence 0.3
montaj rm-nonspeech clip_spec.json --model base
montaj transcribe clip.mp4 --model base.en
montaj caption clip.mp4 --style word-by-word
montaj crop-spec --input spec.json --keep 8.5:14.8 --keep 40.0:end
montaj virtual-to-original --input spec.json 47.32
montaj normalize clip.mp4 --target youtube
montaj resize clip.mp4 --ratio 9:16
```
To see all available steps including project-local custom steps: `montaj step -h`

## Available Steps

### Inspect
| Step | What it does | Key params |
|------|-------------|------------|
| `probe` | Duration, resolution, fps, codec | — |
| `snapshot` | Contact sheet grid image | `--cols 3 --rows 3` |
| `virtual_to_original` | Map virtual-timeline timestamps → original file timestamps | `--input spec.json`; positional timestamps; `--inverse`; `--verbose` |

### Clean
| Step | What it does | Key params |
|------|-------------|------------|
| `waveform_trim` | Detect silence → trim spec (near-instant, no encode) | `--threshold -30 --min-silence 0.3` |
| `rm_nonspeech` | Remove non-speech → trim spec. **Input: trim spec, not video.** | `--model base --max-word-gap 0.18 --sentence-edge 0.10` |
| `rm_fillers` | Remove um/uh/hmm → trim spec. **Input: trim spec, not video.** | `--model base.en` |
| `crop_spec` | Crop trim spec to virtual-timeline windows → refined trim spec, no encode | `--keep 8.5:14.8` (repeatable; `end` sentinel ok) |

### Edit
| Step | What it does | Key params |
|------|-------------|------------|
| `trim` | Cut by start/end/duration | `--start 2.5 --end 8.3` or `--duration 5` |
| `cut` | Remove one or more sections and rejoin | `--start 3.0 --end 7.5` (single) · `--cuts '[[s,e],...]'` (multi, one pass) · `--spec` (trim spec out, no encode) |
| `materialize_cut` | Encode a trim spec or raw segment to H.264 — required before steps that need an actual video file (e.g. `remove_bg`) | `spec.json` or `clip.mp4 --inpoint 2.0 --outpoint 8.0` |
| `resize` | Reframe to aspect ratio | `--ratio 9:16` or `1:1` or `16:9` |
| `extract_audio` | Extract audio track | `--format wav` |

### Enrich
| Step | What it does | Key params |
|------|-------------|------------|
| `transcribe` | Word-level transcript (whisper.cpp) → SRT + JSON | `--model base.en --language en` |
| `caption` | Transcript → animated caption track (data, not pixels) | `--style word-by-word` (or `karaoke`, `pop`, `subtitle`) |
| `normalize` | Loudness normalization (LUFS) | `--target youtube` (or `podcast`, `broadcast`) |

**`caption` produces a data track, not pixels.** Rendered at review/final render time by the UI and render engine.

### VFX
| Step | What it does | Key params |
|------|-------------|------------|
| `materialize_cut` | Encode trim spec or raw segment to H.264. **Use `--inputs` for multiple clips** — caps at 2 concurrent encodes by default. Never fan out more than 2–3 instances in parallel; each is a full libx264 encode and will exhaust memory at 4K if over-parallelised. | `--inputs clip0.json clip1.json`, `--workers 2` |
| `remove_bg` | Remove video background via RVM → ProRes 4444 `.mov` with alpha channel. Store result in `nobg_src`; keep original in `src` (for preview). Set `remove_bg: true` on the item. **Long-running (minutes per clip) — always run in the background with `--progress` so you can monitor status.** Use `--inputs` for multiple clips. | `--inputs clip0.mp4 clip1.mp4`, `--progress`, `--model rvm_mobilenetv3` (or `rvm_resnet50`), `--downsample 0.5` |

### Select Takes (`montaj/select_takes`)
**REQUIRED SUB-SKILL:** Load `skills/select-takes/SKILL.md` before executing this step.

### Overlays (`montaj/overlay`)
**REQUIRED SUB-SKILL:** Load `skills/overlay/SKILL.md` before executing. Also load `skills/write-overlay/SKILL.md` before writing JSX.

## Trim Spec Architecture

Editing steps do not encode video. They output **trim specs** — JSON describing which ranges of the original file to keep:

```json
{"input": "/path/to/original.MOV", "keeps": [[0.0, 5.3], [6.1, 12.4]]}
```

**Data flow:**
```
waveform_trim → trim spec → transcribe
                           → rm_fillers → refined spec → tracks[0] inPoint/outPoint/start/end
                                                               ↓
                                                       render engine (final assembly)
```

**Rules:**
- Pass original source files to editing steps — never pre-encode them
- `rm_fillers`, `rm_nonspeech`, `crop_spec` take a trim spec as `input` and output a refined spec — never pass a video file to these
- One encode per clip, then one render pass

> **CRITICAL — video clip `src` field:**
> Any video clip item (in any track) MUST have `src` pointing to a **real video file** (`.MOV`, `.mp4`, etc.) — never a spec JSON file.
> For clips derived from trim specs: read `spec["input"]` for `src`, and `spec["keeps"]` to derive `inPoint`/`outPoint`.
> **The UI preview player seeks into the source file using `inPoint`/`outPoint`. It cannot play a JSON spec.**
> Multi-keep specs expand into multiple clip items, each with their own `inPoint`/`outPoint`.
> Use a materialized (encoded) file as `src` ONLY if the workflow explicitly includes a `materialize_cut` step — otherwise always use the original source file.

## Workflows

Read the assigned workflow from `workflows/{name}.json` (filesystem only — not served via API).

**Available workflows:**
- `clean_cut` — silence trim, remove non-speech, transcribe, select takes, remove fillers
- `overlays` — clean_cut + transcribe + overlays
- `short_captions` — clean_cut + transcribe + caption + overlays + resize 9:16
- `animations` — no source footage; build entirely from animated JSX sections
- `explainer` — footage clips + animation sections combined
- `floating_head` — trim + materialize + RVM background removal; presenter in tracks[1], background asset in tracks[0]
- `lyrics_video` — audio + lyrics → word-synced text video (ffmpeg drawtext or JSX overlays)
- `ai_video` — director agent writes a storyboard from your prompt and references, you approve, scenes are generated via Kling

**Deviation Rules**
You should deviate only under one conditions:
When the prompt or user intent deviates from the selected workflow:**
- "no captions" → skip caption
- "keep it raw" → skip rm_fillers, waveform_trim
- "YouTube format" → resize 16:9

If in doubt, **ask your human**.

## Project JSON

**States:** `pending` → `draft` (agent done) → `final` (human approved)

**Structure:**
```json
{
  "version": "0.2", "id": "<uuid>", "status": "pending",
  "workflow": "overlays", "editingPrompt": "...",
  "settings": {"resolution": [1080, 1920], "fps": 30},
  "tracks": [[{"id": "clip-0", "type": "video", "src": "/abs/path/clip.mp4", "start": 0.0, "end": 0.0}]],
  "assets": [], "audio": {}
}
```

**Assets** — image files (logos, watermarks). Each has `id`, absolute `src`, `type: "image"`, optional `name`. Pass at creation: `--assets logo.png` (CLI) or `"assets": ["/path/logo.png"]` (HTTP `/api/run`).

**Update as you work:**
- After trim/clean: update `tracks[0]` clip `src`; set `inPoint`/`outPoint` and `start`/`end` (seconds)
- After transcribe + caption: set top-level `captions: { "style": "word-by-word", "segments": [...] }` — do NOT store a file pointer
- After overlays/images/video: populate `tracks[1+]` — array of arrays; items have `type: "overlay"` (JSX), `type: "image"` (static image), or `type: "video"` (video clip with optional `remove_bg: true`)
- After all steps: set `status: "draft"`
- HTTP: persist via `PUT /api/projects/{id}` | CLI: write to `project.json`

**HEVC clips:** `concat` handles HEVC automatically. Never manually re-encode before editing steps.

**One trim pass only.** Running silence removal twice causes boundary glitches.

## File Conventions

- Project directory: `{workspaceDir}/<date>-<name>/` (`workspaceDir` defaults to `~/Montaj`, override in `~/.montaj/config.json`)
- Step outputs go next to their inputs
- Trim spec outputs: `<original>_spec.json` | concat output: `<original>_concat.mp4`
- Final render: `output.mp4` in project directory
- Transcripts: `<clip>_transcript.json` and `<clip>.srt`

## Sub-skills

| Skill | Path | When to load |
|-------|------|-------------|
| `serve` | `skills/serve/SKILL.md` | HTTP mode detected — **load before first API call** |
| `parallel` | `skills/parallel/SKILL.md` | Multiple clips, or workflow has `foreach` steps |
| `mcp` | `skills/mcp/SKILL.md` | Running as MCP client |
| `select-takes` | `skills/select-takes/SKILL.md` | Executing `montaj/select_takes` in a workflow |
| `overlay` | `skills/overlay/SKILL.md` | Executing `montaj/overlay` in a workflow |
| `write-overlay` | `skills/write-overlay/SKILL.md` | Writing custom JSX overlay components |
| `style-profile` | `skills/style-profile/SKILL.md` | Creating or updating a creator style profile |
| `workflow-builder` | `skills/workflow-builder/SKILL.md` | Creating or editing workflows |
| `lyrics-video` | `skills/lyrics-video/SKILL.md` | Working on a `lyrics_video` workflow project |
| `ai-video` | `skills/ai-video/SKILL.md` | Working on an `ai_video` workflow project (projectType: "ai_video") |

## Dependencies

- `ffmpeg` + `ffprobe`
- `whisper.cpp` (with models in standard location)
- `Python 3.x`
- `Node.js` (render engine only)

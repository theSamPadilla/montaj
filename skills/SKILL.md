---
name: montaj
description: "You MUST use this whenever the user asks for video editing work. Use it when video-related tasks are brought up. Editing, analyzing video, or transcribing videos"
---

# Montaj Skill

Montaj is a video editing toolkit with agent-first tools. Built-in steps cover common operations. Workflows provide suggested operations. But you (the agent) decide what to run, in what order, and with what parameters based on user input.

## Core Loop

This root skill is the **dispatcher**. It detects which interface Montaj is reached through, loads the matching interface skill, then loads the domain skills the workflow needs. It owns orchestration — the project state machine and workflow loading — not transport mechanics. The interface skill (`native` or `mcp`) owns how each `_contract` verb is actually performed.

**Detecting which interface to use** (three-way; if you were already told the context, honor it):

1. **MCP client** (e.g. Claude Desktop) → load skill `mcp`.
2. Else, **local server up** — `GET http://localhost:3000/api/projects?status=pending` responds → **HTTP mode**.
3. Else → **CLI mode**.

For HTTP and CLI, **load skill `native`** — it defines how every `_contract` verb (run step, read/save the project, write/read a file, log) is performed in each mode. Then load the domain skills you need for the workflow (see Sub-skills below). Do not perform transport directly from this skill; `native` owns it.

**The loop, once your interface is loaded:**
```
1. The location of the clips, the prompt, and preferred workflow should have been given to you by your human. If not provided, ask. Don't guess.
   (HTTP: pick the first pending project via `read the project`. MCP: clips/prompt/workflow arrive as tool-call params.)
2. Read the workflow from workflows/{name}.json
3. Apply editorial judgment (select/order/trim clips via probe + transcribe)
4. Execute workflow steps following the dependency graph; log before each step
5. Save the project (delta) as you go — GET fresh, merge your delta, save (see Project JSON)
6. Probe the final output → set inPoint: 0, outPoint: <duration>
7. Mark project as draft (status: "draft") when complete
8. Notify your human or ask questions if you run into issues.
```

**Check for a style profile:**
- **HTTP / CLI / MCP** — read `profile` field from project JSON. If set, the `profileSnapshot` field in the same project.json gives you everything you need (see below).
- **CLI mode, no project yet** — run `montaj profile list`. If profiles exist, ask the user if they wish to apply one.
- **Profile snapshot in project.json** — when `profile` is set, project.json also contains `profileSnapshot` with three fields:
  - `styleProfilePath` — absolute path to the profile's `style_profile.md`. Load it live for editorial direction analyzed from the creator's content (pacing, palette, tone). Field is **omitted** when the file did not exist at project init.
  - `summary` — hand-written guidance about how to use this asset library, frozen at init. Asset-library-specific rules ("always end with bumper.mov", "logo bottom-right at 60% opacity"). Distinct from `style_profile.md`: that's analysis-derived; this is hand-curated.
  - `availableAssets` — list of `{filename, description, tags}` entries the user has curated. Frozen at init.
- **Selection is human-driven.** The user picks specific assets via the editor side panel; included assets land in `project.assets[]` with the same shape as any other asset. **Never call the include-asset endpoint on the user's behalf without explicit instruction.**
- **Conflict rule.** When `style_profile.md` and `summary` disagree, `summary` wins — it's the explicit user-authored rule.

**Never invent a step sequence from scratch.** Follow the assigned workflow; deviate only where the prompt explicitly requires it or the workflow fails (see Deviation Rules).

**Multiple clips or workflow has `foreach` steps:** Load skill `parallel`.

## Running Steps

**Running a step is a `_contract` verb** — "run step `<name>` with `<args>`". The `native` skill (loaded by the dispatcher) defines how that resolves: `POST /api/steps/:name` in HTTP mode, `montaj <step> …` in CLI mode. Fire long-running steps in the background to stay available for conversation. The catalog of steps and their params is below.

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

**Language — non-English footage.** The speech steps (`transcribe`, `rm_nonspeech`, `rm_fillers`) default to the English-only `base.en` model. On non-English audio an English-only model emits sparse/garbage word timestamps — and `rm_nonspeech` then deletes the gaps as "silence", silently cutting most of the speech. **Always pass `--language <code>` to every speech step** (e.g. `--language es`), taken from `project.settings.language`. A non-English code auto-upgrades the `*.en` model to its multilingual sibling (`base.en` → `base`, same speed), so keep `--model base.en` and just set the language. Set the project language at init with `--language es` (stored in `settings.language`); if a project predates this field and the audio clearly isn't English, pass `--language` explicitly anyway. `rm_fillers` also switches to that language's hesitation-filler set.

**Transcribing a long source (e.g. the `clips` workflow source pass)?** whisper can fall into a repetition-loop hallucination — one phrase repeated to EOF after a hard-to-decode stretch (music, a goal replay). Pass `--max-context 0` to `transcribe` to disable cross-window context, which reliably prevents the loop. Recommended for any multi-minute and/or non-English source transcription.

### VFX
| Step | What it does | Key params |
|------|-------------|------------|
| `materialize_cut` | Encode trim spec or raw segment to H.264. **Use `--inputs` for multiple clips** — caps at 2 concurrent encodes by default. Never fan out more than 2–3 instances in parallel; each is a full libx264 encode and will exhaust memory at 4K if over-parallelised. | `--inputs clip0.json clip1.json`, `--workers 2` |
| `remove_bg` | Remove video background via RVM → ProRes 4444 `.mov` with alpha channel **plus** a VP9 WebM preview proxy. Store the ProRes path in `nobg_src` (used by render) and the WebM path in `nobg_preview_src` (used by browser preview — ProRes can't decode in `<video>`); keep the original in `src`. Set `remove_bg: true` on the item. **Long-running (minutes per clip) — always run in the background with `--progress` so you can monitor status.** Use `--inputs` for multiple clips. | `--inputs clip0.mp4 clip1.mp4`, `--progress`, `--model rvm_mobilenetv3` (or `rvm_resnet50`), `--downsample 0.5` |

### Select Takes (`montaj/select_takes`)
**REQUIRED SUB-SKILL:** Load skill `select-takes` before executing this step.

### Overlays (`montaj/overlay`)
**REQUIRED SUB-SKILL:** Load skill `overlay` before executing. Also load skill `write-overlay` before writing JSX.

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
- **Saving is always GET-fresh → merge your delta → save** — the user can edit the project from the UI while the server is running, and a stale save silently overwrites their work (Montaj only auto-commits to git on status transitions, so mid-status edits have no recovery path). The `native` skill defines how the save resolves per mode (PUT in HTTP, file write in CLI) and carries the full discipline.

**HEVC clips:** `concat` handles HEVC automatically. Never manually re-encode before editing steps.

**One trim pass only.** Running silence removal twice causes boundary glitches.

## File Conventions

- Project directory: `{workspaceDir}/<date>-<name>/` (`workspaceDir` defaults to `~/Montaj`, override in `~/.montaj/config.json`)
- Step outputs go next to their inputs
- Trim spec outputs: `<original>_spec.json` | concat output: `<original>_concat.mp4`
- Final render: `output.mp4` in project directory
- Transcripts: `<clip>_transcript.json` and `<clip>.srt`

## Sub-skills

Refer to sub-skills by name; the reader resolves the name to a path.

| Skill | When to load |
|-------|-------------|
| `native` | HTTP or CLI mode — the native interface; **load before any step / project interaction** |
| `mcp` | Running as MCP client |
| `parallel` | Multiple clips, or workflow has `foreach` steps |
| `select-takes` | Executing `montaj/select_takes` in a workflow |
| `overlay` | Executing `montaj/overlay` in a workflow |
| `write-overlay` | Writing custom JSX overlay components |
| `image-search` | Sourcing outside imagery (`search_images` + `fetch_image`) when the prompt asks for photos / logos / B-roll stills |
| `style-profile` | Creating or updating a creator style profile |
| `workflow-builder` | Creating or editing workflows |
| `lyrics-video` | Working on a `lyrics_video` workflow project |
| `ai-video-plan` | Working on an `ai_video` project (Phases 0-2: story clarification, storyboard planning) |
| `ai-video-generate` | Working on an `ai_video` project (Phases 6-7: scene generation, audio assembly, regenQueue) |

## Dependencies

- `ffmpeg` + `ffprobe` — **strongly recommended**: `zscale` filter (requires libzimg) for accurate HDR→SDR tonemap. Without it, a fallback tonemap runs but with degraded colors. Run `montaj doctor` to check (exit 0 = OK, exit 1 = issues). Fix: `montaj install ffmpeg` (automates zimg install + formula patch + rebuild).
- `whisper.cpp` (with models in standard location)
- `Python 3.x`
- `Node.js` (render engine only)

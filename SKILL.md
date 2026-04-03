---
name: montaj
description: "You MUST use this whenever the user asks for video editing work. Use it when video-related tasks are brought up. Editing, analyzing video, or transcribing videos"
---

# Montaj Skill

Montaj is a video editing harness with agent-first tools. Built-in steps cover common operations. The agent decides what to run, in what order, and with what params.

## Core Loop

**Detecting which interface to use:**
Try `GET http://localhost:3000/api/projects?status=pending`. If it responds → **HTTP mode**: load `skills/serve/SKILL.md` before making any API calls, then follow the HTTP loop there. If connection is refused → CLI or MCP mode.

**When running headless (CLI):**
```
1. Clips, prompt, and workflow are given to you directly
2. Read the workflow from workflows/{name}.json
3. Apply editorial judgment (select/order/trim clips via probe + transcribe)
4. Execute workflow steps following the dependency graph
5. Write/update project.json in the project directory as you go
6. Probe the final output → set inPoint: 0, outPoint: <duration>
7. Mark project as draft (status: "draft") when complete
```

**When running as MCP client:** Load `skills/mcp/SKILL.md`.

**Check for a style profile:**
- **HTTP mode** — read `profile` field from project JSON. If set, load `~/.montaj/profiles/<profile>/style_profile.md` and let it inform editorial decisions.
- **CLI mode** — run `montaj profile list`. If profiles exist, ask the user which to apply.

**Never invent a step sequence from scratch.** Always follow the assigned workflow; deviate only where the prompt explicitly requires it (see Deviation Rules).

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
montaj concat clip1.mp4 clip2.mp4 clip3.mp4 --out joined.mp4
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
| `concat` | Join clips — **only encode step** (auto-normalizes HEVC→H.264 CRF 18) | multiple inputs or trim spec array |
| `resize` | Reframe to aspect ratio | `--ratio 9:16` or `1:1` or `16:9` |
| `ffmpeg_captions` | Burn static text overlay | `--text "Hello" --fontsize 48 --position center` |
| `extract_audio` | Extract audio track | `--format wav` |

### Enrich
| Step | What it does | Key params |
|------|-------------|------------|
| `transcribe` | Word-level transcript (whisper.cpp) → SRT + JSON | `--model base.en --language en` |
| `caption` | Transcript → animated caption track (data, not pixels) | `--style word-by-word` (or `karaoke`, `pop`, `subtitle`) |
| `normalize` | Loudness normalization (LUFS) | `--target youtube` (or `podcast`, `broadcast`) |

**`caption` produces a data track, not pixels.** Rendered at review/final render time by the UI and render engine.

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
                           → rm_fillers → refined spec → concat (ONLY encode)
```

**Rules:**
- Pass original source files to editing steps — never pre-encode them
- `rm_fillers`, `rm_nonspeech`, `crop_spec` take a trim spec as `input` and output a refined spec — never pass a video file to these
- `concat` is the encode boundary — the only step that produces a video file
- One encode total, regardless of how many steps or clips

## Workflows

Read the assigned workflow from `workflows/{name}.json` (filesystem only — not served via API).

**Available workflows:**
- `default` — probe, snapshot, transcribe, rm_fillers, waveform_trim, caption (word-by-word), overlays (auto), resize 9:16

**Deviation Rules — only when the prompt explicitly requires it:**
- "no captions" → skip caption
- "keep it raw" → skip rm_fillers, waveform_trim
- "YouTube format" → resize 16:9
- "music" → add normalize, consider audio ducking
- Multiple takes of same content → add select-takes before the workflow

## Project JSON

**States:** `pending` → `draft` (agent done) → `final` (human approved)

**Structure:**
```json
{
  "version": "0.1", "id": "<uuid>", "status": "pending",
  "workflow": "trim_and_overlay", "editingPrompt": "...",
  "settings": {"resolution": [1080, 1920], "fps": 30},
  "tracks": [{"id": "main", "type": "video", "clips": [
    {"id": "clip-0", "src": "/abs/path/clip.mp4", "order": 0}
  ]}],
  "assets": [], "audio": {}
}
```

**Assets** — image files (logos, watermarks). Each has `id`, absolute `src`, `type: "image"`, optional `name`. Pass at creation: `--assets logo.png` (CLI) or `"assets": ["/path/logo.png"]` (HTTP `/api/run`).

**Update as you work:**
- After trim/clean: update clip `src`; set `inPoint`/`outPoint` (seconds)
- After transcribe + caption: inline `_captions.json` as a `type: "caption"` track with `style` and `segments` — do NOT store a file pointer
- After all steps: set `status: "draft"`
- HTTP: persist via `PUT /api/projects/{id}` | CLI: write to `project.json`

## Decision Rules

**Choosing clean steps:**
- Talking head, one speaker → `rm_fillers` then `waveform_trim`
- Interview, multiple speakers → `rm_nonspeech`
- Music/ambient → `waveform_trim` only
- "tight cuts" → `rm_fillers` + `waveform_trim --threshold -25 --min-silence 0.2`
- "natural pacing" → `waveform_trim --threshold -35 --min-silence 0.5`

**Choosing caption style:**
- TikTok/Reels → `pop` or `word-by-word`
- YouTube → `subtitle`
- Emphasis/energy → `karaoke`

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

## Dependencies

- `ffmpeg` + `ffprobe`
- `whisper.cpp` (with models in standard location)
- `Python 3.x`
- `Node.js` (render engine only)

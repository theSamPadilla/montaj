# Montaj

> Open source video editing toolkit. AI-native, CLI-first, agent-friendly. Do whatever you want.

Montaj is a video editing harness that mounts on top of your existing AI agent. You bring Claude, OpenClaw, or any agent — Montaj gives it the tools to edit video. Built-in steps cover the common operations. The agent decides what to run, in what order, and with what params.

**The fundamental dependency is an agent.** Montaj doesn't edit on its own. It provides the tools; the agent makes the creative decisions.

## Why Montaj Exists

Other programmatic video tools (Remotion, etc.) give an agent a framework to **write code** — the agent authors JSX compositions that describe a video. Montaj takes the opposite approach: the agent **orchestrates tools**. We put a set of discrete, well-defined operations in front of the agent and teach it how to use them. No code authoring. The agent reasons about which steps to call, in what order, with what params.

The gaps this fills:

- **Agent-native interface** — CLI, HTTP, and MCP; steps are callable from any agent without writing code
- **Editing existing footage** — trim, cut, transcribe, composite against source clips
- **Animation generation** — agent can generate React overlay components (captions, titles, effects) rendered frame-by-frame via headless Chrome and composited in
- **Local-first** — ffmpeg + whisper.cpp, no external APIs required
- **Open source** — MIT, self-hosted, no vendor

## Quick Start

```bash
brew install montaj

# Headless — agent edits, renders, done
montaj run ./clips --prompt "tight cuts, remove filler, 9:16"

# With UI — watch the agent work live, tweak the result
montaj serve
```

## What's Inside

```
steps/              Step executables + JSON schemas (probe, trim, transcribe, etc.)
workflows/          Suggested editing plans (trim_and_overlay.json, tight-reel.json, etc.)
adaptors/           External AI API harnesses (Stitch, Veo, ElevenLabs, etc.)
render/             React + Puppeteer + ffmpeg render engine
serve/              Local HTTP + SSE server (montaj serve)
ui/                 Browser UI (Vite + React + Tailwind)
docs/               Architecture, CLI reference, UI design, schemas
```

## How It Works

```
1. Upload clips + write an editing prompt
2. montaj creates project.json [pending]
3. Agent picks it up, reads the workflow, calls steps as tools
4. Agent writes project.json as it works → UI updates live via SSE
5. Agent marks project [draft]
6. Human reviews in browser (optional) → tweaks → marks [final]
7. Render engine → final MP4
```

## CLI

Every operation the UI performs is available from the terminal. `montaj` is the full command, `mtj` is the short alias.

```bash
# Run a full edit
montaj run ./clips --prompt "tight cuts, upbeat pacing"

# Start the UI
montaj serve

# Render project.json → final.mp4
montaj render

# Fetch a clip from a URL
montaj fetch https://youtube.com/watch?v=...
```

Steps are the individual editing operations. Run any step directly:

```bash
montaj step probe --input clip.mp4          # Metadata: duration, resolution, fps, codec
montaj step snapshot --input clip.mp4       # Frame grid contact sheet
montaj step waveform_trim --input clip.mp4  # Remove silent gaps
montaj step rm_fillers --input clip.mp4     # Remove filler words (um, uh, like)
montaj step transcribe --input clip.mp4     # Word-level transcript via Whisper
montaj step caption --input clip.mp4 --style pop
montaj step trim --input clip.mp4 --start 2.5 --end 8.3
montaj step concat --input clip1.mp4 --input clip2.mp4
montaj step resize --input clip.mp4 --ratio 9:16
montaj step normalize --input clip.mp4 --target youtube
```

Steps are composable — stdout of one is input to the next:

```bash
FILE=$(montaj step rm_fillers --input clip.mp4)
FILE=$(montaj step trim --input "$FILE" --start 5 --end 90)
FILE=$(montaj step resize --input "$FILE" --ratio 9:16)
```

List all available steps (including custom):

```bash
montaj step -h
```

See [docs/CLI.md](docs/CLI.md) for the full reference.

## Steps

Every editing operation is a step — a Python executable with a JSON schema. Native steps ship with Montaj. Custom steps are any executable that follows the output convention.

| Category | Steps |
|----------|-------|
| **Inspect** | `probe`, `snapshot` |
| **Clean** | `waveform_trim`, `rm_fillers`, `rm_nonspeech` |
| **Edit** | `trim`, `concat`, `resize`, `extract_audio` |
| **Enrich** | `transcribe`, `caption`, `normalize` |
| **Acquire** | `fetch` — download from any URL via yt-dlp |

**Custom steps:** Run `montaj create-step <name>` to scaffold a new step. Drop the generated `.py` + `.json` anywhere in `steps/` — no registration needed, discovered automatically. Works in workflows and the UI node graph.

## Workflows

A workflow is a suggested editing plan — which steps to use and with what default params. The agent reads the plan, reads the prompt, and decides the actual execution.

```json
{
  "name": "tight-reel",
  "steps": [
    { "id": "probe",      "uses": "montaj/probe" },
    { "id": "transcribe", "uses": "montaj/transcribe" },
    { "id": "clean",      "uses": "montaj/rm_fillers", "params": { "sensitivity": 0.8 } },
    { "id": "caption",    "uses": "montaj/caption",    "params": { "style": "word-by-word" } },
    { "id": "resize",     "uses": "montaj/resize",     "params": { "ratio": "9:16" } }
  ]
}
```

## Render Engine

React + Puppeteer + ffmpeg. Reads project.json, renders captions and overlays as React components frame-by-frame via headless Chrome, composites with source footage via ffmpeg.

**Built-in templates:** `word-by-word`, `pop`, `karaoke`, `subtitle`, `title-card`, `lower-third`, `callout`, `flash`, `transition`

**Custom overlays:** Agent writes JSX directly. Full creative control. Rendered the same way.

**Parallel rendering:** Segment-level (all overlays render simultaneously) + frame chunking (long segments split across workers). Configurable via `~/.montaj/config.json`.

## UI

Optional browser interface. Upload → watch the agent work live → review → render.

```bash
montaj serve   # http://localhost:3000
```

- **Editor** — timeline, preview player, caption editor, overlay editor
- **Workflows** — n8n-style node graph for building editing plans
- **Overlays** — live animated preview of custom JSX overlays
- **Profiles** — view creator style profiles (pacing, color palette, editorial direction)

The UI is a layer on top of the CLI, not a separate system. Every action maps to a CLI command.

## Project JSON

The single format that flows through the entire pipeline. One file, three states:

| State | Who writes | Contents |
|-------|-----------|----------|
| `pending` | `montaj serve` / `montaj run` | Clip paths, prompt, workflow name |
| `draft` | Agent | Trim points, ordering, captions, overlays — complete edit |
| `final` | Human (via UI) | Reviewed and tweaked, ready to render |

See [docs/schemas/project.md](docs/schemas/project.md) for the full schema.

## Adaptors

Optional harnesses for external AI APIs. Credentials in `~/.montaj/credentials.json`.

| Adaptor | API | Returns |
|---------|-----|---------|
| `stitch` | Google Stitch | React overlay component (JSX) |
| `veo` | Google Veo | AI-generated video clip |
| `elevenlabs` | ElevenLabs | Voiceover audio |
| `suno` | Suno | AI background music |
| `openai-whisper` | OpenAI Whisper | Transcript (alt to local whisper.cpp) |

## Dependencies

`pip install montaj` handles Python dependencies automatically. Two system tools require separate installation — they are compiled binaries that can't be bundled in a Python package.

**Included via pip:**

| Package | Purpose |
|---------|---------|
| `Pillow` | Image processing (color analysis, frame sampling) |
| `yt-dlp` | Video download from TikTok, Instagram, YouTube, etc. |

**Required system dependencies:**

| Tool | macOS | Linux | Windows |
|------|-------|-------|---------|
| `ffmpeg` + `ffprobe` | `brew install ffmpeg` | `apt install ffmpeg` | [ffmpeg.org](https://ffmpeg.org/download.html) |
| `whisper-cpp` | `brew install whisper-cpp` | build from source | build from source |

**Required for the render engine and UI:**

| Tool | Install |
|------|---------|
| `Node.js >=18` | `brew install node` / [nodejs.org](https://nodejs.org) |

`brew install montaj` handles all of the above on macOS in one command.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how everything fits together
- [CLI Reference](docs/CLI.md) — full command list
- [UI Design](docs/UI.md) — browser interface
- [Project JSON Schema](docs/schemas/project.md) — the core format
- [Overlay Contract](docs/schemas/overlay.md) — render component spec
- [Adaptor Interface](docs/schemas/adaptor.md) — external API harness

## License

MIT — do whatever you want. See [LICENSE](LICENSE).

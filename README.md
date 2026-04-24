<p align="center">
  <img src="https://raw.githubusercontent.com/theSamPadilla/montaj/main/Montaj.jpeg" alt="Montaj" width="200" />
</p>

# Montaj

> A video editing CLIP for AI agents. CLI-first, agent-native, open source.

Montaj is a **CLIP** — a CLI Program for agents. It clips onto your existing AI agent (Claude Code, OpenClaw, Cursor, or any harness) and gives it the specialized tools to edit video. Built-in steps cover the full editing pipeline. The agent decides what to run, in what order, and with what parameters.

**The fundamental dependency is an agent.** Montaj doesn't edit on its own. It provides the tools; the agent makes the creative decisions.

## Quick install
Send this to your agent:
```
Install Montaj from https://github.com/theSamPadilla/montaj, then read skills/onboarding/SKILL.md to get us started.
```

## Install

**PyPI:**
```bash
pip install montaj
# install Node.js >=18 separately: https://nodejs.org
montaj install whisper   # whisper-cpp binary + model weights
montaj install ui        # npm deps + UI build
```

**Homebrew (macOS)** — installs Node.js and all Python deps including bundled ffmpeg:
```bash
brew install theSamPadilla/montaj/montaj
```

**From source:**
```bash
git clone https://github.com/theSamPadilla/montaj
cd montaj
pip install -e ".[connectors]"
montaj install whisper
montaj install ui
```

Optional extras:
```bash
pip install "montaj[connectors]"  # Kling, Gemini, OpenAI API connectors
pip install "montaj[rvm]"         # background removal (torch + RVM)
pip install "montaj[demucs]"      # audio stem separation
montaj install all                # whisper + ui + rvm
```

## Quick Start

```bash
# Headless — agent edits, renders, done
montaj run ./clips --prompt "tight cuts, remove filler, 9:16"

# With UI — watch the agent work live, tweak the result
montaj serve

# AI video generation — agent creates from a text prompt via Kling
montaj serve   # then create an ai_video project in the UI
```

## What's Inside

```
steps/              Step executables + JSON schemas (probe, trim, transcribe, generate, etc.)
workflows/          Editing plans (clean_cut, overlays, ai_video, lyrics_video, etc.)
skills/             Agent skill contracts (onboarding, edit-session, ai-video-plan, ai-video-generate, etc.)
connectors/         API connectors (Kling, Gemini, OpenAI)

render/             React + Puppeteer + ffmpeg render engine
serve/              Local HTTP + SSE server (montaj serve)
ui/                 Browser UI (Vite + React + Tailwind)
docs/               Architecture, CLI reference, UI design, schemas
```

## How It Works

```
1. Upload clips + write an editing prompt (or describe an AI video)
2. montaj creates project.json [pending]
3. Agent picks it up, reads the workflow, calls steps as tools
4. Agent writes project.json as it works → UI updates live via SSE
5. Agent marks project [draft]
6. Human reviews in browser (optional) → tweaks → marks [final]
7. Render engine → final MP4
```

## CLI

Every operation is available from the terminal. `montaj` is the full command, `mtj` is the short alias.

```bash
montaj run ./clips --prompt "tight cuts, upbeat pacing"
montaj serve
montaj render
montaj fetch https://youtube.com/watch?v=...
```

See the [CLI Reference](https://docs.montaj.ag/cli) for the full documentation.

## Steps & Workflows

**Steps** are individual editing operations — Python executables with JSON schemas, callable as agent tools, CLI commands, or API calls. Native steps ship with Montaj; custom steps are any executable that follows the output convention.

| Category | Steps |
|----------|-------|
| **Inspect** | `probe`, `snapshot`, `analyze_media` |
| **Clean** | `waveform_trim`, `rm_fillers`, `rm_nonspeech` |
| **Edit** | `materialize_cut`, `resize`, `extract_audio`, `crop_spec` |
| **Enrich** | `transcribe`, `caption`, `normalize`, `lyrics_sync`, `lyrics_render` |
| **Generate** | `kling_generate`, `generate_image`, `eval_scene` |
| **VFX** | `remove_bg`, `stem_separation` |
| **Acquire** | `fetch` — download from any URL via yt-dlp |

**Workflows** are suggested editing plans — which steps to use and with what default params. The agent reads the plan, reads the prompt, and decides the actual execution.

| Workflow | Description |
|----------|-------------|
| `clean_cut` | Trim, remove filler, clean audio |
| `overlays` | Add animated overlays and titles |
| `ai_video` | Generate video from text via Kling + storyboard |
| `lyrics_video` | Sync lyrics to audio with animated captions |
| `animations` | Custom JSX animation compositions |
| `explainer` | Educational/explainer video style |
| `floating_head` | Speaker overlay on background footage |

Custom steps and workflows are discovered automatically — no registration needed. See the [Steps Reference](https://docs.montaj.ag/steps) and [Core Concepts](https://docs.montaj.ag/concepts) for details.

## Skills

Skills are agent-readable contracts that teach the agent how to approach a specific editing task. Each skill describes the goal, the steps to use, the parameter choices, and the quality criteria.

Available skills: `onboarding`, `edit-session`, `ai-video-plan`, `ai-video-generate`, `eval-scenes`, `overlay`, `write-overlay`, `animation-sections`, `lyrics-video`, `style-profile`, `serve`, `parallel`, `select-takes`, `waveform-silence`, `camera-vocabulary`, `workflow-builder`, `mcp`.

## Connectors

API connectors for external services. Installed via `pip install "montaj[connectors]"`.

| Connector | Used for |
|-----------|----------|
| **Kling** | AI video generation (v3-omni, video-o1) |
| **Gemini** | Media analysis, scene evaluation, image generation |
| **OpenAI** | Image generation, analysis |

## Render Engine

React + Puppeteer + ffmpeg. Reads `project.json [final]`, renders captions and overlays frame-by-frame via headless Chrome, composites with source footage via ffmpeg → final MP4.

See the [Render Engine](https://docs.montaj.ag/render) docs for the full breakdown.

## UI

Optional browser interface. Upload → watch the agent work live → review → render.

```bash
montaj serve   # http://localhost:3000
```

- **Editor** — timeline, preview player, caption editor, overlay editor
- **Storyboard** — AI video scene planning with image/style references
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

For AI video projects, the storyboard (scenes, image refs, style refs) lives inside the same `project.json`.

See the [Core Concepts](https://docs.montaj.ag/concepts) page and [docs/schemas/project.md](docs/schemas/project.md) for the full schema.

## Docs

Full documentation at **[docs.montaj.ag](https://docs.montaj.ag)**:

- [Installation](https://docs.montaj.ag/installation) — Homebrew, PyPI, source
- [Quick Start](https://docs.montaj.ag/quickstart) — first project in 2 minutes
- [CLI Reference](https://docs.montaj.ag/cli) — full command list
- [Steps Reference](https://docs.montaj.ag/steps) — all 27+ built-in steps
- [Core Concepts](https://docs.montaj.ag/concepts) — architecture, project.json, trim specs, workflows
- [Render Engine](https://docs.montaj.ag/render) — the compositing pipeline
- [Agent Integration](https://docs.montaj.ag/agents) — MCP, HTTP API, skills
- [Connectors](https://docs.montaj.ag/connectors) — Kling, Gemini, OpenAI setup
- [Extending](https://docs.montaj.ag/extending) — custom steps, workflows, connectors

Internal references (for contributors):
- [Architecture](docs/ARCHITECTURE.md) — deep implementation details
- [Project JSON Schema](docs/schemas/project.md) — field-level schema reference
- [Overlay Contract](docs/schemas/overlay.md) — render component spec

## License

MIT — do whatever you want. See [LICENSE](LICENSE).

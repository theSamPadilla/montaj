# Montaj — Architecture

> Open source video editing toolkit. Local-first, CLI-driven, agent-friendly. Extensible workflow engine — native steps, custom steps, visual workflow builder.

---

## What Montaj is

A video editing tool harness that mounts on top of your existing agent framework. Montaj is not an agent — it is the toolkit the agent uses. You bring Claude, OpenClaw, or any agent; Montaj gives it the tools to edit video.

Built-in steps cover the common operations (trim, transcribe, remove fillers, resize). Custom steps extend the toolkit. The agent reads the workflow and the editing prompt, then calls steps as tools at its own discretion — deciding what to run, in what order, and with what params.

**The fundamental dependency is an agent.** Montaj headlessly produces nothing on its own. `montaj run` creates a pending project and waits. An agent picks it up, calls steps, and writes the edit.

**Montaj is agent-agnostic.** It exposes two interfaces for agents to call steps — CLI and MCP. Neither is mandatory. The agent uses whichever it has access to. Both wrap the same underlying executables.

---

## How it fits together

```
┌──────────────────────────────────────────────────────────────────────┐
│                          LOCAL UI  (ui/)                             │
│                       browser → montaj serve                         │
│                                                                      │
│  ┌───────────────────┐                       ┌──────────────────┐    │
│  │    1. UPLOAD      │                       │   3. REVIEW      │    │                
│  │  drop clips       │                       │  timeline        │    │
│  │  write prompt     │                       │  preview player  │    │
│  │  select workflow ◄├── workflows/ dir      │  caption editor  │    │
│  │  POST /run        │                       │  overlay editor  │    │
│  └────────┬──────────┘                       └────────┬─────────┘    │
│           │                                           │              │
│           │           ┌──────────────────┐            │              │
│           │           │   2. LIVE VIEW   │            │              │
│           │           │  SSE stream of   │────────────┘              │
│           │           │  project.json as │  rerenders timeline +     │
│           │           │  agent works     │  preview in real time     │
│           │           └────────┬─────────┘                           │
└───────────┼────────────────────┼────────────────────────────────────-┘
            │ POST /api/run          │ GET /api/projects/:id/stream (SSE)
            │ clips + prompt         │
            │ + workflow name        │
            ▼                        │
┌───────────────────────────────-────┴────────────────────────────────┐
│                          montaj serve                               │
│                      local HTTP + SSE server                        │
│                                                                     │
│  POST /api/run      → creates project.json [pending], stores to disk│
│  GET  /api/projects → list projects; ?status=pending for agent poll│
│  file watcher       → detects project.json writes, pushes SSE       │
└───────────┬─────────────────────────────────────────────────────────┘
            │ agent polls GET /api/projects?status=pending
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AGENT (external)                             │
│                     Claude, OpenClaw, etc.                          │
│                                                                     │
│  reads project.json [pending]                                       │
│  reads workflows/<name>.json   ← suggested steps + default params   │
│  reads editing prompt                                               │
│                                                                     │
│  calls steps as tools at its own discretion:                        │
│                                                                     │
│  Native steps              Custom steps (steps/)                    │
│  ─────────────             ─────────────────────                    │
│  probe                     viral-hook-detector.py                   │
│  snapshot                  sentiment-analysis.py                    │
│  transcribe                b-roll-inserter.py                       │
│  rm_fillers                ...any executable + schema               │
│  trim, concat, resize                                               │
│  caption                                                            │
│  ...                                                                │
│                                                                     │
│  writes project.json as work progresses ────────────────────────────┼──► file watcher
│  marks [draft] when done                                            │         │
└─────────────────────────────────────────────────────────────────────┘         │
                                               SSE → UI (live timeline update)
                             │ project.json [draft]
                             ▼
                ┌────────────────────────┐
                │   human review (UI)    │
                │   optional tweaks      │
                └────────────┬───────────┘
                             │ project.json [final]
                             ▼
            ┌────────────────────────────────────┐
            │            RENDER PASS             │
            │                                    │
            │  Render Engine                     │
            │  React + Puppeteer + ffmpeg         │
            │  captions, overlays, animations    │
            └────────────────┬───────────────────┘
                             │
                             ▼
                        final MP4
```

Montaj also supports managed-orchestrator deployments where the caller's compute never touches the bytes. Input clips and assets can be fetched from remote URLs at init time — via `montaj init --remote-clip`/`--remote-asset` flags (repeatable JSON strings) or the `remoteClips`/`remoteAssets` fields on `POST /api/run` — and written directly into the project's workspace directory. Output files can be pushed back to caller-supplied URLs after render via `montaj upload` or `POST /api/projects/{id}/upload`. Both directions use the caller's URLs, methods, and headers verbatim, so S3 pre-signed URLs, R2, GCS, Azure SAS URLs, and custom webhooks all work without provider-specific code.

The entire mechanism is fail-closed: it is dormant unless `MONTAJ_HTTP_ALLOWED_HOSTS` (comma-separated, lowercase) is set in the server or CLI environment. All fetches verify content-type and streamed byte count against declared values and use atomic temp-then-replace writes; all caller-supplied paths are validated against the project directory to prevent traversal. The OS desktop UI is unaffected — it continues using `POST /api/upload` and the existing file-serving routes.

---

## Agent Interfaces

Montaj exposes two interfaces for agents to call steps. Both are optional. Both wrap the same CLI executables.

### CLI

The agent runs montaj commands directly via shell access.

```bash
montaj trim clip.mp4 --start 2.5 --end 8.3
montaj transcribe clip.mp4 --model base.en
montaj resize clip.mp4 --ratio 9:16
```

Works with any agent that has shell access — Claude Code, OpenClaw, or any framework that can execute shell commands. Steps are also independently runnable by humans for debugging.

### MCP

Montaj runs as a local MCP server (`montaj mcp`), started automatically by the MCP client (Claude Desktop, Claude Code). The agent calls steps as native tools — no shell access required.

```
Claude Desktop opens
  → spawns: montaj mcp
  → montaj mcp reads steps/*.json, registers each as an MCP tool
  → agent calls: trim({input: "clip.mp4", start: 2.5, end: 8.3})
  → montaj mcp invokes the CLI executable, returns result
Session ends → process dies
```

Configure once in `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "montaj": { "command": "montaj", "args": ["mcp"] }
  }
}
```

New steps are picked up automatically — adding `steps/my-step.py` + `.json` makes it available as an MCP tool with no extra configuration.

### HTTP API (via montaj serve)

`montaj serve` exposes a step execution API alongside the browser UI. Any HTTP-capable agent can call steps via POST — no shell access or MCP required. The UI uses the same API to trigger individual steps during the review phase (e.g. re-transcribe with a different model, re-run normalize).

```bash
POST /api/steps/trim        body: { input: "clip.mp4", start: 2.5, end: 8.3 }
POST /api/steps/transcribe  body: { input: "clip.mp4", model: "medium.en" }
GET  /api/steps             returns: list of available steps with schemas
```

All API routes are namespaced under `/api/` so they never collide with React Router paths. The SPA catch-all at `/{path}` serves `index.html` for everything else — no Accept-header heuristics needed.

The server invokes the CLI executable and returns stdout as the response body. Same output convention as CLI — result path or JSON on success, JSON error on failure.

Two additional routes support managed-orchestrator file sync (see "How it fits together" for the full security model):

- `POST /api/run` (extended) accepts `remoteClips` and `remoteAssets` body fields — arrays of `{url, destPath, contentType, sizeBytes, method?, headers?}` objects — to fetch inputs from remote URLs at project-init time.
- `POST /api/projects/{id}/upload` (new) pushes workspace files to caller-supplied URLs. Body: `{uploads: [{srcPath, url, method?, headers?}]}`. Returns 200 on full success or 207 Multi-Status on partial failure, with per-op results in the response body (per-op failures never surface as request-level 4xx).

### Summary

```
CLI           →  step execution — agents with shell access, humans
HTTP API      →  step execution — agents with HTTP access, the browser UI
MCP           →  step execution — Claude Desktop / Claude Code (native tools)

montaj serve  →  browser UI, SSE, project lifecycle, HTTP API
```

All three execution paths wrap the same underlying CLI executables.

### CLI flag conventions

Two flags look similar and must not be conflated:

| Flag | Layer | Purpose |
|------|-------|---------|
| `--json`        | CLI (`add_global_flags`) | Wrap the command's stdout in a JSON envelope for machine-readable output. Available on every `montaj <command>`. |
| `--json-output` | Step / CLI mirror | Ask the underlying model or API to return structured JSON data. Only present on steps that call out to a model/API with a JSON mode (currently `analyze-media`). |

Per-command parsers must never redefine `--json` — it's reserved globally. When a step needs a model-JSON toggle, use `--json-output` at both the CLI and step layers, with matching names.

---

## Workflow Engine

The core of Montaj. Every operation is a step. Steps are callable tools. Workflows define a suggested plan — the steps to use and their default params. The agent reads the plan, reads the prompt, and decides the actual execution.

### Directory structure

Three scopes. Same format at every level — native steps and custom steps are identical from the agent's perspective.

```
~/Montaj/                       # workspace — all projects live here (default)
  2024-11-01-my-ad/             # one directory per project
    project.json
    clip1_trimmed.mp4
    clip1_transcript.json
    ...
  2024-11-02-product-demo/
    project.json
    ...

~/.montaj/                      # user-global config + extensions
  steps/
    my-watermark.py
    my-watermark.json
  workflows/
    my-brand.json
  config.json                   # global defaults (workspaceDir, model, etc.)
  credentials.json              # API credentials for external connectors (0600)

montaj/                         # built-in (ships with montaj)
  steps/
    probe.py + probe.json
    snapshot.py + snapshot.json
    rm_fillers.py + rm_fillers.json
    transcribe.py + transcribe.json
    ...
  connectors/
    kling.py
    gemini.py
    openai.py
    ...
  workflows/
    overlays.json
    tight-reel.json
    tutorial-style.json

my-project/                     # project-local steps/workflows
  steps/
    viral-hook-detector.py
    viral-hook-detector.json
  workflows/
    my-workflow.json
```

The workspace location defaults to `~/Montaj`. Override via `~/.montaj/config.json`:

```json
{ "workspaceDir": "/Volumes/FastSSD/Montaj" }
```

### Credentials — `~/.montaj/credentials.json`

API credentials for external connectors (Kling, Gemini, etc.) live in `~/.montaj/credentials.json` with `0600` permissions.

Install via:

    montaj credentials                                          # interactive
    montaj credentials --provider kling --key access_key --value ...
    montaj credentials --list                                   # check what's set

Each connector reads credentials via `lib/credentials.get_credential(provider, key)`. Precedence: env var (`KLING_ACCESS_KEY` etc.) > credentials file > fail with install instructions.

Supported providers:

| Provider | Keys |
|----------|------|
| `kling` | `access_key`, `secret_key` |
| `gemini` | `api_key` |
| `openai` | `api_key` |

**Step resolution order:** project-local → user-global → montaj built-in.

**Prefix in workflow files makes scope explicit:**

| Prefix | Resolves to |
|--------|------------|
| `montaj/<name>` | montaj built-in steps |
| `user/<name>` | `~/.montaj/steps/<name>` |
| `./steps/<name>` | project-local steps |

`montaj step install <path>` copies a step into `~/.montaj/steps/` and confirms the prefix to use.

---

### Workflow file

A JSON file that describes a suggested editing plan — which steps to use, their default params, and their dependencies. Not a deterministic execution pipeline. The agent reads the workflow as context, then decides the actual execution based on the editing prompt and what it finds in the clips.

```json
{
  "name": "overlays",
  "description": "Multi-clip edit — silence trim, transcribe, select best takes, remove fillers, concat, caption, overlays, resize to 9:16.",
  "steps": [
    { "id": "probe",             "uses": "montaj/probe" },
    { "id": "snapshot",          "uses": "montaj/snapshot" },
    { "id": "silence",           "uses": "montaj/waveform_trim",  "foreach": "clips", "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "transcribe",        "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["silence"],           "params": { "model": "base.en" } },
    { "id": "select_takes",      "uses": "montaj/select_takes",                       "needs": ["transcribe"] },
    { "id": "fillers",           "uses": "montaj/rm_fillers",     "foreach": "clips", "needs": ["select_takes"],      "params": { "model": "base.en" } },
    { "id": "concat",            "uses": "montaj/concat",                             "needs": ["fillers"] },
    { "id": "transcribe_concat", "uses": "montaj/transcribe",                         "needs": ["concat"],            "params": { "model": "base.en" } },
    { "id": "caption",           "uses": "montaj/caption",                            "needs": ["transcribe_concat"], "params": { "style": "word-by-word" } },
    { "id": "overlays",          "uses": "montaj/overlay",                            "needs": ["caption"],           "params": { "style": "auto" } },
    { "id": "resize",            "uses": "montaj/resize",                             "needs": ["overlays"],          "params": { "ratio": "9:16" } }
  ]
}
```

The agent may call these steps in this order, reorder them, adjust params, skip steps that don't apply, or add steps not in the list — whatever the prompt and content call for. A prompt saying "keep it raw" means the agent skips rm_fillers. A single long incoming clip may prompt the agent to trim before transcribing to reduce cost.

**Step fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier within the workflow — used in `needs` references |
| `uses` | yes | Step to run: `montaj/<name>`, `user/<name>`, or `./steps/<name>.py` |
| `params` | no | Default param overrides — only include values that differ from step defaults |
| `needs` | no | Step IDs that must complete before this step starts. Omit (don't use `[]`) when there are no deps. |
| `foreach` | no | `"clips"` — run this step once per clip in the project, in parallel. Produces one output per clip. |

---

### Parallel execution model

`needs` is the dependency graph. The agent fires all steps with no unmet needs simultaneously, then re-evaluates after each completes. Steps in the same "wave" run in parallel.

Example execution waves for the `overlays` workflow:

```
Wave 1 (parallel): probe, snapshot, silence×N (foreach clips)
Wave 2 (parallel): transcribe×N (foreach clips — needs silence)
Wave 3:            select_takes (needs transcribe)
Wave 4 (parallel): fillers×N (foreach clips — needs select_takes)
Wave 5:            concat (needs fillers)
Wave 6:            transcribe_concat (needs concat)
Wave 7:            caption (needs transcribe_concat)
Wave 8:            overlays (needs caption)
Wave 9:            resize (needs overlays)
```

`foreach: <path>` fans out a step across all entries in a dotted-path collection on the project. Common values: `"clips"` (all project clips), `"storyboard.scenes"`, `"storyboard.imageRefs"`, `"storyboard.styleRefs"` (used by the `ai_video` workflow). The agent runs them as parallel tool calls (not subagents) and collects the outputs before proceeding to steps that need them. Any dotted identifier path is accepted; the agent decides what iteration means for that collection (e.g. the ai-video-plan skill skips imageRefs with `source: "upload"` since they already have their image).

---

### Agent-authored steps

Two step names in workflows are **not CLI executables** — they are tasks the agent performs itself using its own reasoning, then records the results in project.json.

**`montaj/select_takes`**

When the agent encounters this step, it reads the transcripts from all clips, groups segments by content similarity (repeated takes of the same script section), selects the best take of each section, and trims each clip accordingly using `montaj/trim`. Output: an ordered list of trimmed clip paths passed to the next step.

**`montaj/overlay`**

When the agent encounters this step, it writes custom JSX overlay files and adds them to `tracks` in project.json. There are no built-in overlay templates — every overlay is a `type: "overlay"` item pointing to a JSX file the agent writes. See the Overlays & Captions section below, and `skills/write-overlay/SKILL.md` for the full authoring reference.

---

### Custom steps

Any executable that follows the output convention (stdout = result, stderr = JSON error, exit 0/1). Language agnostic — Python, bash, Node, binary.

**Adding a custom step:**
1. `steps/my-step.py` — the executable
2. `steps/my-step.json` — the schema (params, inputs, outputs)
3. Done. Available to the agent as a callable tool, appears in the UI node graph, accessible via CLI.

No registration, no config changes. Discovered automatically.

---

### Connectors — `connectors/`

Wrappers around external AI/video APIs (Kling, Gemini, OpenAI, ElevenLabs, …). Each file in `connectors/` is a framework-agnostic Python module that owns everything about talking to **one vendor**: auth, request shape, polling, response normalization.

**The layering rule — memorize this:**

| Layer | Organized by | Example |
|-------|--------------|---------|
| `connectors/<vendor>.py` | **Vendor** (one file per API key) | `connectors/gemini.py` handles video analysis + image gen — all Gemini endpoints share one client and one credential |
| `steps/<verb>_<noun>.py` | **Use case** (one file per agent-callable action) | `steps/generate_image.py` dispatches to `gemini.generate_image` or `openai.generate_image` based on `--provider` |

A vendor like Gemini can unlock multiple use cases (multimodal analysis today, text/image tomorrow) through the same API key and SDK. Duplicating the client+auth plumbing per endpoint is waste. Specificity lives in the step layer, where the file name (`analyze_media`, `generate_image`, `transcribe_audio`) tells the agent what it does.

Connectors:
- Read credentials via `lib.credentials.get_credential(provider, key)`.
- Raise `ConnectorError` on user-facing failures. Step scripts catch and translate to `common.fail()`.
- Have no argparse, no FastAPI, no CLI concerns, no `sys.exit` — those live in `steps/` and `cli/commands/`.
- Are **never referenced directly from workflows, the CLI, HTTP API, or MCP**. Every connector function needs a step wrapping it to be agent-callable. See [docs/CONNECTORS.md](./CONNECTORS.md) for the full contract and current connector list.

Install the optional deps with `montaj install connectors`.

---

### Bundled workflows

| Workflow | Description |
|----------|-------------|
| `overlays` | Multi-clip edit — silence trim, transcribe, select best takes, remove fillers, overlays. No captions. |
| `short_captions` | Multi-clip edit — same as `overlays` plus caption and resize 9:16. |
| `clean_cut` | Trim and clean only — silence, transcribe, select best takes, remove fillers. No captions, overlays, or resize. |
| `animations` | Animation-only — no source footage required. Agent builds entirely from overlays and animation sections. |
| `explainer` | Multi-clip edit with animation sections — same as `overlays` plus animation sections. No captions. |
| `floating_head` | Talking-head presenter over a custom background — trim, materialize, RVM background removal. Background in `tracks[0]`, presenter in `tracks[1]`. |

`workflows/overlays.json` is used by `montaj run` when no `--workflow` is specified. All workflow files are equal — fork any of them, save under a new name, and it becomes available immediately.

---

## Skills

Skills are agent-authored task instructions. They live in `skills/<name>/SKILL.md`.

### Step skills

When a workflow step has `"uses": "montaj/<name>"` and no matching Python step exists, the agent looks for `skills/<name>/SKILL.md` with `step: true` in the frontmatter. If found, it is loaded automatically as the task context for that step — no explicit invocation needed.

Name matching is the mechanism: a workflow step `uses: "montaj/overlay"` automatically loads `skills/overlay/SKILL.md` when that file has `step: true`.

### Manual skills

Skills without `step: true` (e.g. `skills/write-overlay/SKILL.md`) are loaded manually by the agent using `/write-overlay` syntax when sub-task guidance is needed.

### Skill directory

| Skill | Type | Purpose |
|-------|------|---------|
| `skills/overlay/` | step | Decide + author overlays; loaded on `montaj/overlay` step |
| `skills/animation-sections/` | step | Build animation sections from scratch; loaded on `montaj/animation-sections` step |
| `skills/write-overlay/` | manual | JSX authoring reference; loaded by overlay and animation-sections skills |
| `skills/ai-video-plan/` | step | Director skill for `ai_video` projects — story clarification, storyboard writes, approval gate (Phases 0-2). Loaded on `montaj/ai-video-plan` step or when `projectType` is `"ai_video"`. |
| `skills/ai-video-generate/` | step | Generation skill for `ai_video` projects — scene generation, audio assembly, regenQueue (Phases 6-7). Loaded after storyboard approval when generation begins. |

---

## Project JSON

The single format that flows through the entire pipeline. One file, three states.

| State | Who writes it | What's in it |
|-------|--------------|-------------|
| `pending` | `project/init.py` (via `montaj run`) | Project ID, name, clip paths, editing prompt, workflow name. No agent work yet. |
| `draft` | agent | Trim points, ordering, captions, overlays. Agent's complete edit. |
| `final` | human (via UI) | Reviewed and tweaked. Ready to render. |

The agent writes project.json as it works — every write is picked up by the file watcher and pushed to the browser via SSE. The timeline builds live as the agent makes decisions.

Each project gets a UUID (`id`) at init time — this is the stable identifier. The workspace directory name (`~/Montaj/<date>-<name>/` or `~/Montaj/<date>-<HHMMSS>/`) is human-readable but not the identity. The optional `name` field is a label; it does not need to be unique.

**Versioning — two layers:**

- **Git (milestone)** — `montaj run` initializes the workspace as a git repo. Commits are created automatically at state transitions (`pending`, `draft`, human save). `montaj checkpoint "<name>"` creates a named commit before risky operations. Full diff history, full revert.
- **In-memory undo stack (fine-grained)** — the UI maintains an undo stack for the current review session. Every caption, overlay, or trim edit is undoable without touching disk. Cleared on save or page reload.

Schema: `docs/schemas/project.md`

---

## Native Steps

All steps are agent-callable tools. The agent decides which to run, when, and with what params — guided by the workflow plan and the editing prompt.

> **Where to look:**
> - **Authoring a step** (schema format, output convention, scopes, adding a custom step) → [docs/schemas/step.md](./schemas/step.md)
> - **Using a step from the CLI** (flags, usage examples per step) → [docs/CLI.md](./CLI.md) → Tier 3 — Steps
> - **Wrapping an external API as a step** (the connector → step layering) → [docs/CONNECTORS.md](./CONNECTORS.md)
> - **Quick catalog of built-in steps** (what each one does, by category) → below

### Inspect

| Step | What it does |
|------|-------------|
| `montaj/probe` | Metadata: duration, resolution, fps, codec, audio |
| `montaj/snapshot` | Frame grid — agent's visual understanding of the clip |

---

### Smart Cuts

| Step | What it does |
|------|-------------|
| `montaj/rm_fillers` | Remove filler words (um, uh, hmm) — outputs trim spec JSON |
| `montaj/rm_nonspeech` | Remove all non-speech (noisy ambient audio) — outputs trim spec JSON |
| `montaj/waveform_trim` | Waveform silence analysis — outputs trim spec JSON (near-instant, no encode) |
| `montaj/crop_spec` | Crop a trim spec to virtual-timeline windows — outputs refined trim spec, no encode |
| `montaj/virtual_to_original` | Map virtual-timeline timestamps to original-file timestamps (inspect/debug utility) |


---

### Whisper

| Step | What it does |
|------|-------------|
| `montaj/transcribe` | Generate SRT + JSON with word-level timestamps |

---

### ffmpeg

| Step | What it does |
|------|-------------|
| `montaj/trim` | Cut by in/out point |
| `montaj/concat` | Join clips and apply all trim specs in a single encode pass (the only step that writes video) |
| `montaj/materialize_cut` | Encode a trim spec or raw video to H.264 — used when a subsequent step (e.g. `remove_bg`) requires an actual video file rather than a trim spec. Uses input-level seeking (`-ss`/`-t` before `-i`) so only the requested segment is decoded; for multi-keep specs the same source is opened once per keep. |
| `montaj/resize` | Reframe: 9:16, 1:1, 16:9 |
| `montaj/extract_audio` | Extract as WAV or MP3 |

---

### Background Removal

| Step | What it does |
|------|-------------|
| `montaj/remove_bg` | Remove video background using RVM (Robust Video Matting). Outputs ProRes 4444 `.mov` with alpha channel (`nobg_src`) for final render and a VP9 WebM (`nobg_preview_src`) for browser preview. Requires `montaj install rvm`. |

Used in the `floating_head` workflow. `remove_bg` requires an actual video file — pass the output of `materialize_cut`, not a trim spec. The step updates the project item with `remove_bg: true`, `nobg_src`, and `nobg_preview_src`. At render time the engine composites the alpha-channel `.mov` over the layers beneath it via ffmpeg.

---

### Generation (external APIs)

| Step | What it does |
|------|-------------|
| `montaj/kling_generate` | Generate video via Kling v3 Omni (text, image, or reference-guided) |
| `montaj/analyze_media` | Analyze a media file (video, audio, or image) with Gemini Flash (description, timestamps, structured output) |
| `montaj/generate_image` | Generate image via Gemini or OpenAI (text-to-image or reference-conditioned) |

These steps require `montaj install connectors` (SDK deps) and `montaj credentials` (per-provider keys). See [docs/CONNECTORS.md](./CONNECTORS.md).

---

## Trim Spec Architecture

Editing steps output **trim specs** — not video files. A trim spec describes which ranges of the **original source file** to keep:

```json
{"input": "/abs/path/original.MOV", "keeps": [[0.0, 5.3], [6.1, 12.4]]}
```

### Why this matters

Before this architecture, every editing step re-encoded the full video. A five-clip workflow running silence removal + filler removal produced fifteen video encodes before the final concat. For 4K HEVC footage this caused multi-minute timeouts per step.

With trim specs, **no video is decoded or encoded until `concat`**. Editing steps work on audio only (for analysis) and pass timestamps forward. The entire set of cuts — silence boundaries, filler removals, take selections — is accumulated as trim spec refinements and applied in a single ffmpeg filter_complex pass at concat time.

### Data flow

```
waveform_trim(clip.MOV)
  → {input: "clip.MOV", keeps: [[2.1, 8.4], [9.0, 15.2]]}

transcribe({input: "clip.MOV", keeps: [...]})
  → extracts audio only at keep ranges
  → runs whisper on the joined audio
  → remaps word timestamps back to original timeline

rm_fillers({input: "clip.MOV", keeps: [...]})
  → extracts audio at keeps, detects fillers
  → subtracts filler timestamps from keeps
  → {input: "clip.MOV", keeps: [[2.1, 7.8], [9.2, 15.2]]}  ← refined

concat({inputs: [spec1.json, spec2.json, ...]})
  → ONE filter_complex per clip, applying all accumulated cuts
  → ONE encode pass total
  → final.mp4
```

### Rules

- Editing steps (`waveform_trim`, `rm_fillers`, `rm_nonspeech`) always receive the **original source file path**, never a re-encoded intermediate
- Trim specs chain: each step refines the keeps list, preserving the original `input` path throughout
- `concat` and `materialize_cut` are the only steps that encode video. `concat` is used for the normal pipeline; `materialize_cut` is used only when a subsequent step (e.g. `remove_bg`) requires a physical video file before the final render
- Both encoders use input-level seeking (`-ss`/`-t` placed before `-i`) — ffmpeg seeks at the container level so only the requested segment is decoded. Neither uses the `trim` filter, which would force a full file decode regardless of the requested range
- HEVC source files are handled automatically at concat — no pre-conversion needed

---

### Timeline resolver (`montaj_assets/timeline-core/`)

`@bycrux/timeline-core` is the single implementation of "what is on screen at
time T" — plain JS ESM with JSDoc types (`// @ts-check`, strict `tsc --noEmit`,
a committed hand-written `index.d.ts`), zero runtime dependencies, no build
step. It answers the questions every consumer of `project.json` timing was
independently re-deriving: which items are active at a timestamp, where their
source window seeks to, where they sit in frame, which caption segment is
speaking, and how long the project runs.

**Four implementations, one of them out of band.** Three JS runtimes import
the package directly:

- **Editor preview** — `useVideoPlayback`'s `effectiveInPoint`/`effectiveOutPoint`/
  `playbackSrcFor` are thin wrappers over the resolver; `PreviewPlayer.activeClip`
  and `OverlayItemsLayer` call its activation predicates and `geometryFor`.
- **Render engine** — `segment-plan.js` and `render.js`'s `collectAllItems`
  delegate their boundary/activation math to it.
- **`sample-frame.js`** — the diagnostic frame-sampling tool adopts it too, so
  what an engineer inspects offline matches what actually renders.

Python's `serve/caption_job.py` is a **fourth, independent implementation** —
TypeScript-shaped code can't run inside the Python server process, so its
timeline arithmetic is hand-ported rather than imported. It's kept honest
against the other three by a pytest pinned to the same fixture corpus (see
below), not by sharing code.

**The variant model.** The resolver is variant-aware, not silently unified:
every function whose answer legitimately differs between preview and render
takes an explicit `Variant = 'preview' | 'render'` argument (an unrecognized
value throws rather than defaulting). Preview and render really do disagree
in places — src precedence when a normalized cache or a background-removal
artifact is present, which items are "active" at a boundary, whether `opaque`
hides underlying video, whether `rotation` is honored — and the resolver's job
is to reproduce each side's actual behavior under its own variant, not to
invent a single "correct" answer and quietly change what ships. Where the two
variants are supposed to agree, they call the same variant-agnostic primitive.

**The shared fixture corpus.** `fixtures/*.json` (project-shaped test inputs)
and `expected/*.json` (committed golden output) live in the package and are
read by all three JS suites plus the Python pytest — one corpus, four readers,
so "does runtime X agree with runtime Y" is a fixture-by-fixture diff instead
of a claim. `fixtures/README.md` documents the corpus's own ground rules
(never depend on real files, never author a genuinely malformed or
unreachable-in-production fixture).

**The divergence registry.** Porting three independently-evolved codebases
into one resolver surfaced places where they already disagreed with each
other in production, before the resolver existed. `KNOWN-DIVERGENCES.md`
documents each one it found: what diverges, the exact `file:line` on both
sides, the user-visible consequence, an **owning SP** for the eventual fix,
and a fixture pointer where one exists. The resolver **reproduces** whichever
behavior each consumer currently gets — it does not fix any of these; fixing
is out of scope for the package that just extracted the shared math. New
divergences discovered after the initial port are appended to a "Discovered
during SP2" section rather than folded into the original numbered list.

**Permanent gates.** Two tests exist specifically to keep future edits to the
resolver (or to render's delegation to it) from silently changing what ships:

- `render/test/resolver-parity.test.mjs` — compares a frozen, verbatim,
  pre-adoption copy of `segment-plan.js`'s algorithm against both the
  resolver's composed primitives and the shipped `planSegments`. All three
  must agree; a change to the resolver that alters segment planning fails
  here.
- `render/test/encode-args-golden.test.mjs` — runs the real, fully-swapped
  `collectAllItems` → `planSegments` → `encodeSegment(..., {_dryRun:true})`
  pipeline over the fixture corpus and compares the resulting ffmpeg
  arguments against goldens captured from the pre-resolver pipeline. This is
  the end-to-end "the bytes ffmpeg is asked to produce did not change" proof.

---

### Playback engine (`montaj_assets/editor/src/engine/`) — experimental, flag-gated

**Status: off by default, opt-in, zero behavior change unless a host asks for
it.** SP4 replaces the editor preview's double-buffered `<video>` machinery
(`useVideoPlayback.ts`, three independent rAF clocks) with a WebCodecs
demux→decode→paint pipeline, but ships it entirely behind a `VideoEditor`
`engine?: {enabled, debugHud?}` prop (plan decision 3: feature-flagged
parallel rollout — the old path stays until a parity pass clears it, and
removal is a later, separate change). See `docs/UI.md` for the operator-facing
surface (the flag, eligibility, fallback, Preparing placeholder, debug HUD)
and `docs/plans/SP4-PARITY-CHECKLIST.md` for the manual verification pass that
gates ever flipping the default.

**Module map:**

| Module | What it does |
|---|---|
| `eligibility.ts` | Pure project-shape check (every track-0 video item proxied, none needing WebM alpha) + an async, session-cached WebCodecs capability probe (`VideoDecoder`/`AudioDecoder.isConfigSupported`). `evaluateEngineEligibility` composes both. |
| `media-loader.ts` | `loadBytes` — a host-injected `FileUrlResolver` (`EditorAdapter.fileUrl`, unchanged) mapped to a whole-file `fetch`. |
| `demux.ts` | mp4box.js MP4 parse → a flat, codec-agnostic sample table. Samples stay in **decode order** (a `presIndex` answers presentation-time questions separately) — WebCodecs requires decode order, and the source footage's B-frames make the two orders differ. `demuxBytes` is synchronous (mp4box's callback API isn't actually async when handed a whole file at once). |
| `batch-planner.ts` | Pure decode-ahead planning: pipelined batches (≥1 request queued on the worker so it never idles waiting for main), batches floored at a quarter of the decode-ahead budget so a `decoder.flush()` amortizes over many frames, batch pre-roll targets computed from the batch's minimum presentation time (not its first decode-order sample), and a 1µs pre-roll epsilon reconciling integer-µs `EncodedVideoChunk` timestamps against the demuxer's float sample times. |
| `frame-server.ts` + `decode-worker-source.ts` | Main-side decode-ahead orchestration, plus the actual decoder: a classic `Worker` loaded from an inlined source **string** via a Blob URL, running one `VideoDecoder` behind a supersession-by-request-id queue (never `decoder.reset()`). |
| `audio-clock.ts` + `audio-worklet-source.ts` | The master clock. An `AudioWorkletProcessor`, also an inlined Blob-URL source string, renders PCM from a ring buffer and reports its actual output-frame count (`samplesConsumed`) back at ~10Hz; that count — not decode progress, not wall time — is the clock. Includes PCM resampling (the page's shared `AudioContext` rate need not match Opus's 48kHz decode rate), per-clip volume scaling at ring-enqueue time, and a wall-clock fallback for everything with nothing to sync to. |
| `scheduler.ts` | The single synchronous tick / state machine. Two orthogonal axes — `transport` (idle/paused/playing/ended) and `picture` (video/black/opaque/preparing) — reproduce every legacy behavior (gaps, loop wrap/stop, end-of-project, `sourceCrop` framing) from one master clock instead of three. |
| `index.ts` | The `createEngine` facade: resource lifecycle (`EngineSourceHost` — one `FrameServer` per `src`, refcounted by clip; one `MasterClock` per clip; a small demux LRU), the rAF loop (runs only while playing), the canvas painter, and `EngineStats` for the debug HUD. |
| `debug-hud.tsx` | The fps/dropped/buffered/clock readout, rendered only when `engine.debugHud` is true. |

**Data flow.** Video: proxy fetch (via the host's `fileUrl`, whole file) →
mp4box demux (main thread, decode order preserved) → batch planning (main
thread, pure functions) → decode (a Blob-URL classic `Worker` running one
`VideoDecoder`, fed by structured-cloned sample bytes, `VideoFrame`s returned
by transfer) → paint (canvas 2D `drawImage` of one `VideoFrame` per tick).
Audio: Opus packets → `AudioDecoder` (main thread) → volume-scaled,
resampled PCM → an `AudioWorklet` ring buffer (postMessage chunks, deliberately
**not** `SharedArrayBuffer` — cross-origin isolation is unavailable in Hub's
serving context) → `samplesConsumed` reported back ~10Hz, which **is** the
master clock (wall-clock-extrapolated between reports, bounded so a suspended
`AudioContext` presents as a stalled clock rather than a runaway one). Frames
paint according to that clock; video drops rather than blocking decode when it
falls behind — the inverse of the legacy path's audio nudging toward video.
Wherever there's nothing to derive a clock from — gaps, canvas (image/
overlay-only) projects, muted clips, undecodable/absent audio, or any failure
building the real clock — `createMasterClock` resolves (never throws or
rejects) to a wall-clock fallback with a human-readable reason, surfaced by the
HUD's `clock: 'fallback'`.

**Flag + eligibility + fallback + Preparing-state design.** `engine` absent or
`{enabled: false}` (the default): the legacy `<video>`-slot player renders
exactly as before, and the eligibility probe never even runs — this is SP4's
non-regression guarantee, checked by keeping the full editor test suite green
with the prop untouched. `{enabled: true}` only asks the editor to *try*:
per-project eligibility (every track-0 video item already `proxySrc`'d, none
needing `nobg_preview_src`, plus the WebCodecs capability probe) is evaluated
once per project **load** (`PreviewPlayer.tsx`'s `useEngineMode`) and never
re-run on an edit — a project that fails stays on the legacy player, with a
one-line console reason, for its whole session even if it becomes eligible a
minute later; a project that passes stays on the engine for its whole session
even if a clip added afterward isn't proxied yet. That one clip alone shows
the **Preparing** picture state instead — `scheduler.ts`'s `picture` state
machine has a value distinct from `video`/`black`/`opaque` that covers a proxy
not yet encoded, a proxy that failed to load, and a proxy that failed to
*decode* mid-session, all through the same path
(`EngineSourceHost.onDecodeError`) — while the rest of the project (other
clips, audio) keeps playing. The UI shows a spinner + "Preparing preview…"
only after 200ms of sustained Preparing, so an ordinary prewarm-covered clip
boundary never flashes it.

**One deliberate preview/render unification, engine-path only.** An overlay's
`opaque: true` now hides the underlying video on the engine path (audio keeps
running) — matching what render has always done — where the legacy `<video>`
path still shows the video underneath, a pre-existing preview/render
divergence. See `montaj_assets/timeline-core/KNOWN-DIVERGENCES.md`'s
`opaque-in-preview` entry for the full disposition; it is closed for the
engine path and stays open for legacy until that player is retired.

**The inline-string worker/worklet portability decision.** Both the decode
worker and the `AudioWorkletProcessor` ship as plain-JS **source strings**,
loaded via `URL.createObjectURL(new Blob([source], {type:
'text/javascript'}))` and `new Worker(url)` / `audioWorklet.addModule(url)` —
not as separate asset files. `@bycrux/editor` is a published package consumed
by hosts with different bundlers (montaj's own `ui/`, Hub); a Vite-only `?raw`
import or a `new Worker(new URL(...))` asset reference can only be verified
against the bundlers actually present in this repo and would silently break
for a host on a different one. The Blob-URL form needs nothing from the
consumer's build tooling. Consequence: both strings are plain ES5-ish JS with
no `import`, so they are kept deliberately thin — the worker does queueing,
request-id supersession, and the pre-roll drop; the worklet does the ring
buffer, underrun-as-silence, and the report cadence. Every actual *decision*
(batch sizing, the pre-roll epsilon, the resample ratio, PCM volume scaling,
the project↔media time mapping) lives in `batch-planner.ts` / `audio-clock.ts`
— real, type-checked, unit-tested modules — and is injected into the string at
construction time (`init` / `processorOptions`) rather than duplicated inside
it.

**One `FrameServer` per source, not per clip.** A silence-trimmed timeline
that is fifty clips cut from one proxy shares a single decoder session,
refcounted by clip; a small (3-entry) LRU keeps recently-demuxed sample tables
around across a scrub back-and-forth even after the last clip referencing them
drops its live session. Decode *workers* still terminate on every source
boundary (the SP1 spike's rule: "terminate and respawn, never
`decoder.reset()` a live worker") — only the parsed bytes linger.

**Testing.** The whole engine down through the scheduler is unit-tested with
injected seams (a fake `Painter`, a fake `SourceHost`, a fake rAF pair, a fake
decode-worker port) in jsdom, which has none of `WebCodecs`, `Worker`, or a
real canvas — see `montaj_assets/editor/src/engine/__tests__/`.

---

### Canvas timeline (`montaj_assets/editor/src/video/timeline/canvas/`) — experimental, flag-gated

**Status: off by default, opt-in, zero behavior change unless a host asks for
it.** SP5 replaces the timeline's DOM track-row area — every visual clip and
audio bar its own positioned `<div>`, recalculated on every scroll/zoom, with
zero virtualization — with a `<canvas>`-rendered surface, behind a
`VideoEditor` `timeline?: {canvas: boolean}` prop (the same host-knob pattern
SP4's `engine` flag established: the old DOM rows stay fully intact until a
parity pass clears the flip, and removal is a later, separate change). See
`docs/UI.md` for the operator-facing surface (the flag, what changes for the
user) and `docs/plans/SP5-PARITY-CHECKLIST.md` for the manual verification
pass that gates ever flipping the default.

**Two-mode architecture, one chrome.** `Timeline.tsx` owns the surface either
way — zoom controls, marker state, the scrubber, the transcript panel/modal,
and the `TimelineContext` provider are unchanged by the flag. Only the
track-row area (visual tracks + audio lanes) swaps: `{canvas: false}` (or the
prop absent) renders the existing `VisualTrackRow`/`AudioTrackRow` DOM rows;
`{canvas: true}` renders one `TimelineCanvas` surface in their place. The
caption row (`CaptionTrackRow`) is an explicit carve-out from "DOM rows
retired" — inline `contentEditable` editing (caret, IME, selection, a11y)
does not survive a canvas — and mounts as a real DOM component in **both**
modes; only its position in the vertical stack changes (below the canvas in
canvas mode, above the visual tracks in DOM mode — see the parity
checklist's §C for why that's an accepted difference, not a bug).

**The shared `timeline-model.ts` contract.** Anything both surfaces must
reproduce identically lives in `timeline/timeline-model.ts`, imported by
both the DOM branch and the canvas branch — behavior can't fork between them
because there is exactly one implementation, not two kept in sync by hand:

| Export | What it is |
|---|---|
| `computeDerivedTiming` | Snap boundaries, content duration, and the padded total duration — the render-time memo both branches key their `useMemo` on. |
| `computeAutoCrossfade` | The auto-crossfade rule (overlapping unmuted audio tracks get complementary fade-out/fade-in). Lifted out of what used to be an untested, DOM-only render-time effect in `Timeline.tsx`; now unit-tested and invoked from ONE `useEffect` in `Timeline.tsx` that sits above the DOM/canvas branch, so it fires identically regardless of the flag. |
| `groupAudioLanes` | Groups audio tracks into lanes (explicit `lane` field, or auto-assigned) — used by the DOM branch's lane rendering and by the canvas layout (`computeTimelineLayout` in `draw.ts`), so a track can never land in a different lane depending on the flag. |
| `moveItemAcrossTracks` | The cross-track drag placement search (collision-avoidance, track pruning) extracted verbatim from `VisualTrackRow`'s drag handler; reused by the canvas pointer machine for the identical gesture. |
| Row-geometry constants | `VISUAL_ROW_HEIGHT_PX`, `AUDIO_LANE_HEIGHT_PX`, `VISUAL_ROW_RENDER_HEIGHT_PX`, `BASE_VISUAL_ROW_RENDER_HEIGHT_PX`, `ROW_GAP_PX` — the DOM rows' Tailwind heights, named once so the canvas painter draws rows at the same size the DOM rows render. |

**The canvas module layout.** Everything under `timeline/canvas/` is pure,
DOM-free logic plus one thin React shell:

| Module | What it does |
|---|---|
| `viewport.ts` | The scroll/zoom model: `pxPerSecond` (px per second) + `scrollSeconds` (time at the left edge), replacing the DOM path's "multiple of container width against a content-dependent duration" zoom — a model that couldn't zoom out past fit and silently changed px/second whenever a clip moved. Time↔pixel conversion is a pure affine map. Also owns the DPR-crisp rendering plumbing (backing-store sizing, `ResizeObserver` + a `devicePixelRatio`-change watcher, `ctx.setTransform` scaling) — no precedent existed elsewhere in the repo for a resolution-independent 2D canvas. The viewport lives in an external store (`createViewportStore`, `useSyncExternalStore`), not React state, so a wheel-zoom gesture never re-renders `Timeline` (and in particular never re-renders the caption row's hundreds of DOM nodes). |
| `draw.ts` | Pure paint functions (`drawClipRect`, `drawAudioItem`, `drawTimelineContent`, `drawTimelineOverlay`, …) taking a structural `DrawContext` subset of `CanvasRenderingContext2D`, so a recording stub can assert on the exact call list in tests. `drawTimelineContent` culls to the visible time range before any draw call — draw cost is bounded by the viewport, not the project (the acceptance probe the parity checklist's §B cites). The playhead is a SEPARATE draw function/layer (see `TimelineCanvas.tsx` below) so a 60Hz-during-playback repaint never touches the content layer. |
| `hit-test.ts` | Pure point → target resolution (`{kind, itemId, edge\|body, trackIdx\|laneIdx, t}`) over the SAME layout `draw.ts` computes (`computeTimelineLayout`) — the canvas has no DOM elements to let the browser hit-test for it, so this exists where the DOM path never needed an equivalent. |
| `snap.ts` | ONE magnetic-snapping model (18px attract / 28px release hysteresis, generalized from the Scrubber's playhead-drag implementation) used by every gesture — playhead drag, clip drag, and edge trims alike — retiring the DOM path's other two implementations (a flat 8px "nearest wins" test with no memory, which flickers right at the threshold). |
| `pointer-machine.ts` | The full gesture state machine — a pure reducer (`pointerReducer`) over `{state, event} → {state, effects}`, with no DOM access, so every transition is a unit test rather than a browser session. Implements click-seek, press-scrub, additive selection, cross-track move, edge trims, and the four new trim gestures (edge-drag = trim, Alt+edge-drag = roll, Alt+body-drag = slip, Cmd/Ctrl+body-drag = slide) with the DOM rows' exact callback contracts (`onProjectChange` per-move, `onOverlayEdit` at commit). |
| `waveforms.ts` | Turns fetched `PeaksData` into pixel columns and paints them as a content layer inside `drawClipRect`/`drawAudioItem`. Two render targets: audio lanes (replacing the DOM path's fixed-resolution PNG chunks, canvas mode only) and NET-NEW per-clip waveforms on visual tracks (clips never had waveforms before this SP). `WaveformPeaksStore` is a small per-mounted-surface fetch-state cache keyed by `(ownerId, src, window, bucket)`, resolution-bucketed at 50/200/800 samples/second based on current zoom (`resolveBucket`) so zoom-in fetches the next bucket up exactly once and zoom-out never re-fetches (a cached higher-resolution bucket downsamples for free). |
| `filmstrips.ts` | Lazy tile-sheet fetch (gated on BOTH a zoom threshold — `tileWidth / minInterval` from the step's own defaults, 160px/s — and the clip actually intersecting the visible range) plus tile-draw and the hover-scrub preview thumb. `FilmstripStore` caches the index (JSON) and decoded sheet images independently, so a ready index with an undecoded sheet degrades to "no tiles yet" rather than an error. |
| `TimelineCanvas.tsx` | The React shell: two stacked `<canvas>` elements (content below, playhead-only overlay above — so a ~60Hz-during-playback playhead move repaints two `fillRect`s, not the whole scene), rAF-coalesced redraw scheduling (`requestRedraw('content' \| 'overlay' \| 'all')`), the playhead subscribing directly to the shared `PlaybackClock` (mirroring the DOM path's isolated `PlayheadLine`, but driving an imperative repaint instead of a React render), and the DOM event listeners that translate mouse events into `pointer-machine.ts` calls. |

**Derivative steps + caching conventions.** Two new steps back the
canvas-only content layers, both proxy-input by design (never the original
source):

- **`montaj/waveform_peaks`** — windowed min/max peak pairs at a requested
  samples-per-second (50/200/800, clamped to ≤500k total pairs per call,
  stepping the resolution down and reporting the actual value used rather
  than silently truncating). Returns its JSON **inline** — nothing written
  to disk. The montaj adapter (`montaj_assets/ui/src/app/editor/montajAdapter.ts`)
  caches in-memory per `(projectId, src, start, duration, samplesPerSecond)`
  with evict-on-reject, so a bucket transition mid-zoom is fetched at most
  once. Clip waveforms fetch `item.proxySrc` only (never `item.src` — a
  clip with no proxy yet simply has no waveform, never an error or a
  fallback decode of the original); audio-lane waveforms fetch `track.src`
  (audio tracks have no proxies).
- **`montaj/filmstrip`** — uniform time-grid JPEG tile sheets (`interval =
  max(duration / maxTiles, minInterval)`) plus an index JSON mapping every
  tile to its source timestamp. Ports `shot_sheet.py`'s tiling (including
  its `nb_frames` partial-final-sheet guard) minus the shot-detection
  dependency — uniform-grid instead of per-shot sampling. **Writes to disk**,
  project-scoped: `.cache/filmstrips/<projectId>/<hash of src>/`, distinct
  from the waveform PNG cache's older workspace-global-by-trackId shape
  (a collision hazard the SP5 plan called out explicitly). Proxy-only input,
  same as waveforms — no proxy, no filmstrip, no fallback.

**Testing.** Every module above is unit-tested with no real browser: `draw.ts`
against a recording `DrawContext` stub, `pointer-machine.ts`'s reducer
directly (every gesture transition is a table test), `viewport.ts`/`snap.ts`/
`hit-test.ts` as pure math, and `TimelineCanvas.tsx` itself with a fake
canvas 2D context in jsdom. See
`montaj_assets/editor/src/video/timeline/canvas/__tests__/`.

**Keyboard editing is a separate, NOT flag-gated change landing in the same
SP.** `video/keymap.ts` is one `document`-level keydown registry (mounted
twice — once in `Timeline.tsx` for arrows/delete/enter/escape, once in
`VideoEditor.tsx`'s `ReviewSurface` for split/undo/redo/ripple-delete/
palette/shuttle) replacing four independently-racing listeners that used to
live spread across `VideoEditor` and `Timeline`. It absorbs every existing
binding verbatim (including each one's typing-surface guard) and adds J/K/L
seek-loop shuttle (`video/shuttle.ts` — fixed-step, not real variable-rate
playback; the engine has no rate API), Shift+Delete ripple-delete (the new
`rippleDelete` op below), timecode go-to (`video/timecode.ts`), and a Cmd/
Ctrl+K command palette (`video/CommandPalette.tsx`). Space is deliberately
excluded from the registry — it stays owned by the playback hooks (legacy
and engine both) so the keymap can never race them. The shuttle and the
palette's Play/Pause command reach playback through one new seam,
`PreviewPlayer`'s optional `transportRef` (`{togglePlay, isPlaying}`),
filled by whichever playback hook is active — a host-level keymap never
needs to know which player is running.

**`cuts.ts` gains four new pure trim ops**, exported from the package
(`src/index.ts` — an `@bycrux/editor` npm API addition): `rippleDelete`
(shifts only items after the deletion point, unlike the existing global
`collapseGaps`), `rollEdit` (moves a shared clip boundary, both clips'
durations change, nothing else moves), `slipItem` (shifts the source
window, timeline position unchanged), `slideItem` (moves the item, its
immediate neighbors absorb the movement). All follow `cuts.ts`'s existing
conventions — original-source-coordinate in/outPoints, a `MIN_DURATION`
clamp, same-reference-return on a no-op. The canvas pointer machine binds
them to edge-drag/Alt+edge-drag/Alt+body-drag/Cmd-or-Ctrl+body-drag
respectively (see `pointer-machine.ts` above); the DOM timeline has no UI
for roll/slip/slide in this SP.

---

### Render Engine (`render/`)

Turns project.json into a final MP4. Reads the `captions` and `overlays` tracks, renders each item as a transparent video segment via React + Puppeteer, then composites everything with the source footage via ffmpeg.

Built on React + Puppeteer + ffmpeg. No third-party licensing.

**Rendering pipeline:**

```
For each item in captions + overlays tracks:
  1. Load the React component (template or agent-generated JSX)
  2. Puppeteer: render frame-by-frame in headless Chrome (transparent background)
     - window.__frame increments each tick
     - screenshot each frame → PNG with alpha
  3. ffmpeg: encode PNG sequence → transparent video segment

Then:
  Normalize pre-pass:
    - All video sources → project's working color space (settings.colorSpace):
        sdr_bt709 → H.264 yuv420p bt709
        hdr_hlg   → HEVC 10-bit yuv420p10le bt2020/HLG
        hdr_pq    → HEVC 10-bit yuv420p10le bt2020/PQ + HDR10 metadata
    - Sources already conformant pass through with no transcode
    - Creates _normalized_<colorSpace>.mp4 alongside originals (originals preserved)

  Segment-based composition:
    - Plan segments at clip/overlay boundaries (segment-plan.js)
    - Encode each segment independently: N layers by trackIdx + overlays + captions (encode-segment.js)
    - Concat via ffmpeg concat demuxer (-c:v copy, -c:a aac re-encode)
    - Mix independent audio tracks in final pass (mix-audio.js)
    → final MP4 (codec/colorimetry follow settings.colorSpace)
```

**Overlays are always custom JSX** — the agent writes a React component per overlay, styled to the editing prompt and brand context. There are no built-in overlay templates.

```json
{ "type": "overlay", "src": "./overlays/hook.jsx", "props": { "text": "Hook line" }, "start": 0.0, "end": 3.0 }
```

**Caption templates** are pre-built and referenced by style name: `word-by-word`, `karaoke`, `pop`, `subtitle`.

All components produce the same output: rendered frame-by-frame by Puppeteer, composited into the video by ffmpeg.

**Core utilities** (available to all components):
- `interpolate(frame, inputRange, outputRange)` — map frame number to any value
- `spring({ frame, fps, config })` — physics-based easing (mass, stiffness, damping)

**Parallelism:**

Puppeteer frame rendering is CPU-bound. Two levels of parallelism are applied:

- **Segment-level** — all overlay and caption segments are independent. A worker pool of N Puppeteer instances renders all segments simultaneously. Default workers = CPU core count.
- **Frame chunking** — segments above a threshold (default: 1,000 frames / ~33s at 30fps) are split into chunks, each rendered by a separate worker, then reassembled by ffmpeg. This keeps a 10-minute caption track from blocking a single worker.

```
caption track — 18,000 frames → 18 chunks × 1,000 frames → 18 workers in parallel
lower-third   — 135 frames    → 1 chunk                  → 1 worker
flash         — 9 frames      → 1 chunk                  → 1 worker
                                                          ↓
                                              ffmpeg compose (all done)
```

Configurable via `~/.montaj/config.json`:
```json
{ "render": { "workers": 8, "chunkSize": 1000 } }
```

**GPU acceleration:**

The pipeline is mostly CPU-bound. GPU applies at one step:

| Step | Bound | GPU |
|------|-------|-----|
| Puppeteer frame rendering | CPU | — parallelism is the lever |
| ffmpeg compositing (filter graph) | CPU | — limited GPU filter support |
| ffmpeg intermediate encode (PNG → WebM/ProRes) | CPU | — alpha formats lack hwaccel support |
| **Final encode** | **GPU** | VideoToolbox (macOS), NVENC (NVIDIA), VAAPI (Intel/Linux). Codec follows the project's color space — H.264 for SDR projects, HEVC 10-bit for HDR projects. |

**Background-removed video items (`nobg_src`):**

When a `tracks[1+]` item has `remove_bg: true` and `nobg_src` is set, the render engine uses the ProRes 4444 `.mov` (with alpha) in place of the original `src` at compose time. The alpha channel is preserved through the ffmpeg filter graph and composited over the layers beneath. Browser preview uses `nobg_preview_src` (VP9 WebM) instead — Chrome supports VP9 alpha; ProRes does not play in browsers.

ffmpeg detects and uses available hardware encoders automatically. 5–10x speedup on final encode.

---

### Overlays & Captions

Both are React components rendered frame-by-frame by Puppeteer and composited into the video by ffmpeg. They differ in how they're stored and who authors them.

**Overlays** are custom JSX files written by the agent. They live in `tracks` — a top-level array of arrays (`tracks[0]` is the primary video track; overlay tracks start at index 1). Each item points to a JSX file and a time window:

```json
{
  "tracks": [
    [],
    [
      {
        "id": "ov-hook",
        "type": "overlay",
        "src": "/abs/path/to/project/overlays/hook.jsx",
        "props": { "text": "She built an AI employee" },
        "start": 0.0,
        "end": 3.0
      }
    ]
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"overlay"` for custom JSX, `"image"` for static images, `"video"` for video clips |
| `src` | yes | Absolute path to the JSX file |
| `start` / `end` | yes | Time window in output video (seconds) |
| `props` | no | Arbitrary data injected as the `props` global inside the component |
| `offsetX` / `offsetY` | no | Position offset as % of frame size — written by the UI when user repositions |
| `scale` | no | Uniform scale multiplier — written by the UI when user resizes |

`offsetX`, `offsetY`, and `scale` are applied by the render engine as a CSS transform on the component container: `translate(offsetX%, offsetY%) scale(scale)`. The JSX component itself is unaware of them.

**Captions** live in a separate track (`type: "caption"`). The agent does not write JSX for captions — it chooses a style name, and the render engine loads the matching built-in template:

```json
{
  "id": "captions",
  "type": "caption",
  "style": "word-by-word",
  "segments": [
    { "text": "Hello world", "start": 0.0, "end": 1.2,
      "words": [{ "word": "Hello", "start": 0.0, "end": 0.5 }, { "word": "world", "start": 0.5, "end": 1.2 }] }
  ]
}
```

Built-in caption styles:

| Style | Description |
|-------|-------------|
| `word-by-word` | One word at a time, spring pop-in |
| `pop` | Segment-at-a-time with scale entry |
| `karaoke` | Words highlight as they're spoken |
| `subtitle` | Static line at bottom, segments replace sequentially |
| `highlight-box` | Whole phrase visible; the spoken word sits in a colored rounded box |
| `outline` | All-caps, heavy black stroke; only the spoken word fills with the accent color |
| `clean` | Plain sentence-case line, no background box, Figtree 700 |

Caption data (segments + word timestamps) is always inlined in the track — never a `src` pointer. Theme keys carried on the caption track/props include `fontsize`/`fontSize`, `color`, and `accentColor` (used by `highlight-box`/`outline` for the active-word fill); `fontsize` now applies to both the ffmpeg and the Puppeteer/JSX render paths, not just ffmpeg.

**Preview pipeline** — when `montaj serve` is running, the UI previews overlays and captions live in the browser via `ui/src/lib/overlay-eval.ts`. The JSX file is fetched, transpiled in-browser by `@babel/standalone`, and called directly on every animation frame. It is an approximation — font rendering and CSS compositing differ slightly from the Puppeteer environment. The render output is what matters.

**For JSX authoring details** (globals, `interpolate`, `spring`, rules, examples) — see `skills/write-overlay/SKILL.md`.

#### HDR image handling in overlay JSX

For HDR projects (`hdr_hlg`, `hdr_pq`), images embedded inside overlay JSX — any `<img src="file://...">`, CSS `background-image: url(...)`, etc. — are intercepted at the Puppeteer layer before the page loads. `renderChunk()` in `montaj_assets/render/renderer.js` enables `page.setRequestInterception(true)` when the project color space is HDR; local `file://` image fetches are caught, the source PNG is converted to an HDR-encoded 8-bit RGBA PNG by `lib/normalize_image.py` (applying a `zscale`-based transfer-curve conversion + 2x linear brightness boost to match overlay text brightness), and the converted bytes are returned in the intercepted response. Converted files are cached alongside the source as `<stem>_<colorspace>.png` and invalidated by mtime, so each unique image only pays the conversion cost on first render.

This split is intentional:

- **Images inside overlay JSX** — converted via the interceptor (this path goes through Puppeteer's screenshot framebuffer, so the converted HDR pixel values reach encode-segment correctly).
- **Overlay text, shapes, captions, and SVG** — not converted; they stay on the sRGB-reinterpreted-as-HDR path that was deliberately kept in v2.5.7 for its bright, punchy output.
- **Tracks-level `{type: 'image'}` items** — not converted in v1; they flow through encode-segment's existing image branch. The converter (`lib/normalize_image.py`) is fully reusable for this path if it becomes a real complaint.
- **SDR projects** — the interceptor is never enabled; no Python subprocess is spawned; render output is byte-identical to v2.5.7.

SVG image references and remote (`https://`) URLs are passed through unchanged (remote URLs emit a one-time per-host stderr warning). On any conversion failure the interceptor degrades gracefully to `request.continue()` rather than aborting the render.

---

## Output Convention

All steps follow a strict contract:

- **stdout** — the result: file path or JSON. Nothing else.
- **stderr** — errors only: `{"error":"code","message":"detail"}`
- **exit 0** on success, **exit 1** on failure

This makes steps composable at the shell level and predictable for the agent as callable tools.

Full details: `docs/output-convention.md`

---

## The Pipeline

### Agent pass

`montaj run` creates `project.json [pending]` and hands off to the agent. The agent:

1. Reads `project.json [pending]` — clip paths, prompt, workflow name
2. Reads `workflows/<name>.json` — suggested steps and default params
3. Calls steps as tools at its own discretion, guided by the workflow plan and the prompt
4. Writes `project.json` as it works (every write → SSE → live UI update)
5. Marks the project `draft` when the edit is complete

The agent is the editor. It decides the execution order, param values, and whether to deviate from the workflow plan based on what it finds.

### Normalize

After clip copy/ingest and before compose, all video sources are **normalized** to the project's working **color space** (`settings.colorSpace`). The color space is detected from clip metadata at init time (see `docs/RENDER.md` → *Project Color Space*) and may be overridden via `--color-space` (CLI) or `colorSpace` (HTTP intake).

Per color space:

- `sdr_bt709` → `libx264 -pix_fmt yuv420p` with `bt709` color metadata.
- `hdr_hlg` → `libx265 -pix_fmt yuv420p10le` with `bt2020nc`/`arib-std-b67`.
- `hdr_pq` → `libx265 -pix_fmt yuv420p10le` with `bt2020nc`/`smpte2084` + static HDR10 mastering metadata.

Sources whose color transfer and bit depth already match the project's working format pass through with no transcode (iPhone HDR HLG in an HLG project, for instance). Sources that conflict are converted at intake (per the color-space spec) or, lazily, in the segment encoder's per-item filter graph.

This runs at three enforcement points:

1. **Ingest** (`project/init.py`) — when clips are added to a project
2. **AI video** (`steps/ai_video.py`) — when generated clips are downloaded
3. **Render** (`render/render.js`) — pre-pass before compose (safety net)

The shared implementation lives in `lib/normalize.py` — a single module used by all three call sites. The taxonomy itself lives in `montaj_assets/schemas/color_space.json` and is loaded by both Python (`lib/types/colorspace.py`) and JS (`montaj_assets/render/color-space.js`). Normalize creates `_normalized_<colorSpace>.mp4` alongside the original file (e.g. `clip_normalized_hdr_hlg.mp4`); originals are never modified.

### Editing proxies

Every imported video also gets a lightweight editing copy for instant scrubbing in the editor preview: a full-source, all-intra, 720p AV1+Opus proxy (`av1-crf35-fast`), recorded as `proxySrc` on the track item. It sits alongside the other per-clip derivative artifacts:

| Derivative | Naming | Produced by | Consumed by |
|---|---|---|---|
| `_normalized_<colorSpace>.mp4` | sibling of the original | `lib/normalize.py`, at the three enforcement points above | Render (always, safety net); preview when present (`normalizedSrc`) |
| `_nobg.mov` / `_nobg_preview.webm` | sibling of the source | `remove_bg` step | Render uses `nobg_src` (ProRes 4444, alpha); preview uses `nobg_preview_src` (VP9 WebM, alpha) |
| `_proxy_<PROXY_LOOK>.mp4` | sibling of the file it's encoded **from** | `lib/proxy.py`, at import (`project/init.py`) or via `POST /api/proxy` backfill | Preview only (`proxySrc`) — **render never reads it** |

**Naming and freshness.** `proxy_path_for(src)` names the proxy `<stem>_proxy_<PROXY_LOOK>.mp4`, a sibling of whatever file it was encoded from — not necessarily the item's original `src`. `is_proxy_fresh(proxy, src)` is the same mtime-invalidation precedent normalize/image-tone caching already use: exists and `mtime(proxy) >= mtime(src)`.

**Two encode paths.** Which file a proxy is encoded from, and whether it needs a tone-map, depends on the project's normalize mode:
- **Eager projects** (`settings.normalize` absent or `"eager"`) — the proxy encodes from the already-normalized master (the post-`normalize()` `src`), with `tonemap = is_hdr(master colorspace)`. For an SDR project the master already made the one HDR→SDR color decision, so the proxy is a plain hardware-decode + scale + SVT-AV1 encode, no second tone-map. For an HDR project the master is HDR — the proxy tone-maps it through the vivid1 LUT so the editor preview always shows montaj's SDR curve (policy v3), never the browser's own improvised HDR tone-mapping.
- **Lazy projects** (`settings.normalize: "lazy"`, used by the `clips` workflow) — there is no normalized master to start from, so the proxy encodes from the original file, with the scale-first HDR→SDR tone-map chain composed ahead of the encode when the source is HDR (`tonemap=True`).

In both cases the proxy encode is scheduled inside `project/init.py`'s `_normalize_one`, under a separate `PROXY_ENCODE_LIMIT = 2` semaphore so proxy encodes never queue behind the heavier libx264/libx265 normalize pool. A proxy failure is never fatal to import — it's logged (`"proxy FAILED — editor will play the master"`) and the item simply keeps no `proxySrc`.

**Shared proxies for shared sources.** The `clips` workflow fans one long source out into N per-clip child projects via `--symlink-clips`, all pointing at the same underlying file (`~/Montaj/.sources/<id>/`). Because a lazy proxy is named after `os.path.realpath()` of the file it's encoded from, every child converges on the same proxy path — the first child to reach it encodes, later children find it already fresh and skip straight to writing `proxySrc`. One caveat worth stating plainly: this sibling-of-the-encoded-from-file naming means an ad-hoc `montaj init --clips <path outside the workspace> --symlink-clips` places the proxy next to the user's original footage, outside `~/Montaj/.sources/` and outside the current project directory — outside every root `montaj clean --proxies` scans by default (see below). The real clips workflow doesn't hit this, since its shared sources always live under `~/Montaj/.sources/`.

**The alpha-ordering rule.** Preview's source precedence (in `@bycrux/timeline-core`) is `nobg_preview_src ?? proxySrc ?? normalizedSrc ?? src`. `proxySrc` is deliberately inserted *after* `nobg_preview_src`, not at the head of the chain: `nobg_preview_src` is VP9-with-alpha, and an opaque MP4 proxy ahead of it would resurrect a removed background in preview while render still composites the alpha channel — exactly the preview/render divergence the resolver exists to prevent.

**Preview-only, provably.** Render's own precedence (`nobg_src ?? normalizedSrc ?? src` when `remove_bg`, else `normalizedSrc ?? src`) never mentions `proxySrc` — the field doesn't exist as a concept on the render side. This is enforced by a permanent guard test (`playbackSrcFor({proxySrc, src}, 'render') === src`) plus the render engine's own encode-args goldens, which stay byte-identical with `proxySrc` present on fixtures.

**Look-version regeneration.** The proxy's encode parameters (scale, codec, tone-map) are frozen behind a look tag, `PROXY_LOOK`, baked into the filename. The tag is the master look from `montaj_assets/luts/looks.json` (currently `"vivid1"`, the Montaj Vivid LUT shipped in SP6b; `"hable1"` is the historical pre-Vivid value). Tone-mapped normalize masters carry the same tag (`_normalized_sdr_bt709_vivid1.mp4`). When a future look ships and the manifest value changes, every existing artifact's filename no longer matches what `proxy_path_for()`/`normalized_output_path()` compute — the freshness check sees a file that doesn't exist under the new name and regenerates lazily.

Filename-based freshness alone can't fix a project whose `project.json` fields (`proxySrc`, and `normalizedSrc` for full-source masters) still point at old-look files that exist on disk — so `GET /projects/{project_id}` runs a **look-migration pass** on open (`serve/routes/projects.py`): stale fields are cleared and committed (this makes project-open a write under some conditions), background re-encode jobs are queued through the serve job registry (one worker, artifact-keyed dedupe, so a stampede of stale items or simultaneously-opened projects encodes serially and never competes with a user render), and each completion writes the fresh path back into `project.json`. The project opens immediately; artifacts arrive as jobs finish, the same UX as import backfill. The pass is idempotent (a second open schedules nothing, even mid-flight), probe-free once migrated, skips items whose source file is missing, and never touches per-window `normalizedSrc` caches (it matches the item's own full-source master name exactly). `montaj clean` reclaims the old look's now-orphaned proxies — and lists superseded untagged masters that have a look-tagged sibling — on request (see below).

**Cleanup.** `montaj clean --proxies` (`cli/commands/clean.py`) scans the current project directory (or `--project <dir>` / `--all-projects` for the whole workspace) plus `~/Montaj/.sources/` — which it always includes, since shared lazy-workflow proxies live there — for `*_proxy_*.mp4`, prints each with its size, and deletes them unless `--dry-run`. Proxies are disposable by design: deleting one just means the editor falls back to playing the master until the proxy is regenerated (at next import, or via `POST /api/proxy`).

**Cost.** Proxies are optional insurance for scrub speed, not free: import takes roughly +30s per minute of source footage on the reference machine (a macOS/videotoolbox number — the encode uses `-hwaccel auto`, which silently falls back to software decode on machines without a hardware decoder, so budget more there), and proxies use about 2GB of disk per hour of footage. Both are reclaimable at any time via `montaj clean --proxies --yes`.

**Bounded import time (SP3 fix B1).** The inline proxy encode is duration-gated: sources longer than ~8 minutes (`--proxy-inline-max` to override) log `proxy deferred` and leave `proxySrc` absent instead of blocking project creation — critical for the lazy/clips path, whose sources are long-form by definition and whose import must stay a no-re-encode operation. Deferred proxies are backfilled via `POST /api/proxy` (async job) or `montaj step proxy`, then written onto the item with a normal project save. Proxies can be disabled outright with `montaj init --no-proxy` or a workflow's `"proxy": false` (persisted as `settings.proxy: false`).

**Unsupported browsers (SP3 fix B2).** AV1+Opus-in-MP4 isn't universally decodable (notably Safari on pre-M3 Macs). The editor probes decode support once per session and, when unsupported — or when a specific proxy fails to decode mid-session (e.g. a dangling `proxySrc` after an out-of-band delete) — strips the proxy tier for the affected clips and falls back to the master, logging a console warning instead of showing a silent black preview.

### Render pass

```
project.json [final] → Normalize pre-pass → Segment-based compose → Audio mix → final MP4
```

### Hard dependencies

```
agent pass → render   (can't render without a draft)
```

---

## Shared-type codegen

Shared enums between Python and TypeScript (`project_type`, `project_status`, `aspect_ratio`, etc.) have a **single source of truth** at `schema/enums.yaml`. A codegen script (`scripts/gen_types.py`) emits per-language modules under `lib/types/` (Python) and `ui/src/lib/types/` (TypeScript). This replaces the earlier manual-mirror convention between `lib/project_types.py` and `ui/src/lib/project.ts`, which relied on developer discipline to stay in sync.

**What's generated** — closed enums with small value sets. Each pair of files (Python module + TS module) is entirely machine-produced, deterministic, and carries a `GENERATED FROM schema/enums.yaml` header.

**What's hand-written** — compound interfaces that describe the full `project.json` shape (`Project`, `VisualItem`, `Asset`, `CaptionSegment`, etc.) live in `ui/src/lib/types/schema.ts`. They're not part of the codegen pipeline; Python consumes `project.json` as dicts and validates via `engine/validate.py`, so there's no equivalent Python module to mirror against.

**Runtime surface: zero.** The generator is a dev-time tool — the server, `pip install`, and `npm install` paths never invoke it. Generated files are committed artifacts, so a fresh clone works without running codegen. `pyyaml` lives in `requirements-dev.txt` only.

**CI enforcement.** A CI step runs `python3 scripts/gen_types.py && git diff --exit-code`. If the YAML was edited but the generator wasn't re-run, CI fails with a diff pointing at the mismatch.

See `CONTRIBUTING.md` → "Adding a shared enum" for the developer workflow (edit YAML → run `gen` → commit both).

---

## Dependencies

| Tool | Purpose |
|------|---------|
| `ffmpeg` + `ffprobe` | Core video processing. **Strongly recommended:** build with `zscale` (requires libzimg) and `lut3d` — the Montaj Vivid HDR-to-SDR chain needs both (`montaj doctor` checks). Without them, a fallback tonemap runs with degraded colors. |
| `whisper.cpp` | Local speech-to-text (word-level timestamps) |
| `yt-dlp` | YouTube downloads |
| `Python 3.x` | Script + step runtime |
| `Node.js` | Render engine (React + Puppeteer) + UI server (Vite + React) |

### Shared infrastructure

| Module | Purpose |
|--------|---------|
| `lib/normalize.py` | Video normalization to the project's working color space (`sdr_bt709` / `hdr_hlg` / `hdr_pq`). Looks up the codec, pixel format, and color args from `montaj_assets/schemas/color_space.json` via `lib/types/colorspace.py`. Used by `project/init.py`, `steps/ai_video.py`, and `render/render.js`. |

### Dependency management

- `montaj doctor` — check all system dependencies (ffmpeg + required filters, ffprobe, node, python3, whisper). Exit 0 = OK, exit 1 = issues. Run after install to verify setup.
- `montaj install ffmpeg` — rebuild ffmpeg with `zscale` (libzimg) for HDR normalization. macOS/Homebrew only. Automates zimg install, formula patch, and source rebuild.

Install: `brew install montaj` (or `pip install montaj`) then `montaj doctor` to verify, and run whatever `doctor` instructs — almost always `montaj install ui` on first launch.

### Asset packaging & build cache

Bundled Node.js assets — the render engine, the Vite UI source, and the MCP server — live under a single private Python namespace package, `montaj_assets/`. The wheel ships these as source only; `node_modules/` and `montaj_assets/ui/dist/` are excluded by `MANIFEST.in` so the installed package stays small and immutable.

On first run, `montaj install ui` copies that source out of site-packages into `~/.cache/montaj/` (XDG cache convention) and runs `npm install` plus `npm run build` there. Site-packages is never written to at runtime, which keeps `pip install montaj` working under read-only install locations (`/usr/local`, `--user`, brew's `Cellar/`).

The cache is keyed by package version: a `.version` stamp at `~/.cache/montaj/.version` is written at the end of a successful `install ui`. The next run compares the stamp against `importlib.metadata.version("montaj")` and wipes the cache on mismatch, so an upgrade automatically forces a clean rebuild. Failed installs leave the stamp absent so the next run starts from scratch.

Dev checkouts skip the cache entirely. `cli/deps.is_dev_checkout()` keys on the presence of `.git` at `MONTAJ_ROOT`; when true, `npm install` and `npm run build` happen in the source tree so Vite HMR works against the same files the developer is editing. Three runtime helpers in `cli/deps.py` — `ui_runtime_dir()`, `render_runtime_dir()`, and `mcp_runtime_dir()` — return the source path in dev and the cache path in prod, and every call site (`serve/server.py`, `cli/commands/mcp.py`) routes through them rather than joining `MONTAJ_ROOT` directly.

Same first-run UX for brew and pip: `montaj doctor` first (it diagnoses what's missing and prints the exact command to fix each piece), then act on its output — almost always `montaj install ui`.

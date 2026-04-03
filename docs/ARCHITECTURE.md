# Montaj — Architecture

> Open source video editing toolkit. Local-first, CLI-driven, agent-friendly. Extensible workflow engine — native steps, custom steps, visual workflow builder.

---

## What Montaj is

A video editing tool harness that mounts on top of your existing agent framework. Montaj is not an agent — it is the toolkit the agent uses. You bring Claude, OpenClaw, or any agent; Montaj gives it the tools to edit video.

Built-in steps cover the common operations (trim, transcribe, remove fillers, resize). Custom steps and adaptors extend the toolkit. The agent reads the workflow and the editing prompt, then calls steps as tools at its own discretion — deciding what to run, in what order, and with what params.

**The fundamental dependency is an agent.** Montaj headlessly produces nothing on its own. `montaj run` creates a pending project and waits. An agent picks it up, calls steps, and writes the edit.

Adaptors connect Montaj to external AI APIs (Veo, Stitch, ElevenLabs, etc.) when the agent decides to use them. They are optional — the core pipeline runs entirely on local tools (ffmpeg, whisper.cpp) with no external API keys required. API keys are only needed if the agent chooses to call an adaptor.

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

### Summary

```
CLI           →  step execution — agents with shell access, humans
HTTP API      →  step execution — agents with HTTP access, the browser UI
MCP           →  step execution — Claude Desktop / Claude Code (native tools)

montaj serve  →  browser UI, SSE, project lifecycle, HTTP API
```

All three execution paths wrap the same underlying CLI executables.

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
  credentials.json              # API keys for adaptors — never committed
  config.json                   # global defaults (workspaceDir, model, etc.)

montaj/                         # built-in (ships with montaj)
  steps/
    probe.py + probe.json
    snapshot.py + snapshot.json
    rm_fillers.py + rm_fillers.json
    transcribe.py + transcribe.json
    ...
  workflows/
    trim_and_overlay.json
    tight-reel.json
    tutorial-style.json
  adaptors/
    stitch/                     # Google Stitch — UI + overlay generation
    veo/                        # Google Veo — AI B-roll generation
    elevenlabs/                 # ElevenLabs — voiceover generation
    runway/                     # Runway — AI video generation
    suno/                       # Suno — AI music generation
    openai-whisper/             # OpenAI Whisper API (alt to local whisper.cpp)

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
  "name": "trim_and_overlay",
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

Example execution waves for the `trim_and_overlay` workflow:

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

`foreach: "clips"` fans out a step across all project clips. The agent runs them as parallel tool calls (not subagents) and collects the outputs before proceeding to steps that need them.

---

### Agent-authored steps

Two step names in workflows are **not CLI executables** — they are tasks the agent performs itself using its own reasoning, then records the results in project.json.

**`montaj/select_takes`**

When the agent encounters this step, it reads the transcripts from all clips, groups segments by content similarity (repeated takes of the same script section), selects the best take of each section, and trims each clip accordingly using `montaj/trim`. Output: an ordered list of trimmed clip paths passed to the next step.

**`montaj/overlay`**

When the agent encounters this step, it writes custom JSX overlay files and adds them to the project's overlay track in project.json. There are no built-in overlay templates — every overlay is a `type: "custom"` item pointing to a JSX file the agent writes. See the Overlays & Captions section below, and `skills/write-overlay/SKILL.md` for the full authoring reference.

---

### Custom steps

Any executable that follows the output convention (stdout = result, stderr = JSON error, exit 0/1). Language agnostic — Python, bash, Node, binary.

**Adding a custom step:**
1. `steps/my-step.py` — the executable
2. `steps/my-step.json` — the schema (params, inputs, outputs)
3. Done. Available to the agent as a callable tool, appears in the UI node graph, accessible via CLI.

No registration, no config changes. Discovered automatically.

---

### Bundled workflows

| Workflow | Description |
|----------|-------------|
| `trim_and_overlay` | Multi-clip edit — silence trim, transcribe, select best takes, remove fillers, concat, caption, overlays, resize 9:16 |
| `basic_trim` | Trim and clean only — silence, transcribe, select best takes, remove fillers, concat. No captions, overlays, or resize. |

`workflows/trim_and_overlay.json` is used by `montaj run` when no `--workflow` is specified. All workflow files are equal — fork any of them, save under a new name, and it becomes available immediately.

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
| `skills/canvas-sections/` | step | Build animation sections from scratch; loaded on `montaj/canvas-sections` step |
| `skills/write-overlay/` | manual | JSX authoring reference; loaded by overlay and canvas-sections skills |

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
| `montaj/jump_cut_detect` | Find pauses, stutters, and false starts — advisory JSON output |
| `montaj/best_take` | Score takes by speech confidence and WPM — ranked JSON output |
| `montaj/pacing` | WPM per window, slow sections, editing suggestions — JSON output |

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
| `montaj/resize` | Reframe: 9:16, 1:1, 16:9 |
| `montaj/ffmpeg_captions` | Burn static text overlay |
| `montaj/extract_audio` | Extract as WAV or MP3 |

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
- `concat` is the only step that decodes or encodes video
- HEVC source files are handled automatically at concat — no pre-conversion needed

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
  ffmpeg filter graph:
    - trim + concat source clips (per project.json video track)
    - overlay each transparent segment at its start timestamp
    - mix audio track
    → final MP4 (H.264, CRF 18)
```

**Overlays are always custom JSX** — the agent writes a React component per overlay, styled to the editing prompt and brand context. There are no built-in overlay templates.

```json
{ "type": "custom", "src": "./overlays/hook.jsx", "props": { "text": "Hook line" }, "start": 0.0, "end": 3.0 }
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
| **Final H.264 encode** | **GPU** | VideoToolbox (macOS), NVENC (NVIDIA), VAAPI (Intel/Linux) |

ffmpeg detects and uses available hardware encoders automatically. 5–10x speedup on final encode.

---

### Overlays & Captions

Both are React components rendered frame-by-frame by Puppeteer and composited into the video by ffmpeg. They differ in how they're stored and who authors them.

**Overlays** are custom JSX files written by the agent. Each item points to a JSX file and a time window:

```json
{
  "id": "overlays",
  "type": "overlay",
  "items": [
    {
      "id": "ov-hook",
      "type": "custom",
      "src": "/abs/path/to/project/overlays/hook.jsx",
      "props": { "text": "She built an AI employee" },
      "start": 0.0,
      "end": 3.0
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | Always `"custom"` — no built-in overlay templates |
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

Caption data (segments + word timestamps) is always inlined in the track — never a `src` pointer.

**Preview pipeline** — when `montaj serve` is running, the UI previews overlays and captions live in the browser via `ui/src/lib/overlay-eval.ts`. The JSX file is fetched, transpiled in-browser by `@babel/standalone`, and called directly on every animation frame. It is an approximation — font rendering and CSS compositing differ slightly from the Puppeteer environment. The render output is what matters.

**For JSX authoring details** (globals, `interpolate`, `spring`, rules, examples) — see `skills/write-overlay/SKILL.md`.

---

### Adaptors

Adaptors are Montaj's harness for external AI APIs. The agent can call any adaptor as a tool — credentials are resolved automatically from `~/.montaj/credentials.json` or env vars. Each adaptor ships with an optimized prompt template for the specific use case Montaj needs.

All adaptors follow the same output convention as steps: stdout = file path, stderr = JSON error, exit 0/1.

```bash
montaj adaptor stitch "dark glass lower third, @handle, slide in from left"
# → ./workspace/overlays/stitch-abc123.jsx

montaj adaptor veo "drone shot over city at sunset, 5 seconds"
# → ./workspace/clips/veo-abc123.mp4

montaj adaptor elevenlabs "intro voiceover" --voice "calm-male"
# → ./workspace/audio/elevenlabs-abc123.mp3
```

**Bundled adaptors:**

| Adaptor | API | Returns |
|---------|-----|---------|
| `stitch` | Google Stitch SDK | React overlay component (JSX) |
| `veo` | Google Veo | AI-generated video clip |
| `elevenlabs` | ElevenLabs | Voiceover audio file |
| `runway` | Runway | AI-generated video clip |
| `suno` | Suno | AI background music |
| `openai-whisper` | OpenAI Whisper API | Transcript (alternative to local whisper.cpp) |

**Each adaptor contains:**

```
adaptors/<name>/
  adaptor.js      # API call + credential resolution
  prompt.md       # optimized prompt template for montaj's use cases
  schema.json     # inputs, outputs, required credentials
```

The `prompt.md` encodes domain knowledge for that API — how to ask it for what Montaj needs. The agent passes a plain description; the adaptor handles the rest.

**Three paths for any capability:**

```
Need an overlay?
  1. Write JSX directly
  2. Delegate to a sub-agent
  3. montaj adaptor stitch "description" → file path

Need B-roll?
  1. Use an existing clip
  2. montaj adaptor veo "description" → clip path

Need music?
  1. Use a local file
  2. montaj adaptor suno "upbeat, energetic, no vocals" → audio path
```

Full spec: `docs/schemas/adaptor.md`

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

### Render pass

```
project.json [final] → Render Engine → final MP4
```

### Hard dependencies

```
agent pass → render   (can't render without a draft)
```

---

## Dependencies

| Tool | Purpose |
|------|---------|
| `ffmpeg` + `ffprobe` | Core video processing |
| `whisper.cpp` | Local speech-to-text (word-level timestamps) |
| `yt-dlp` | YouTube downloads |
| `Python 3.x` | Script + step runtime |
| `Node.js` | Render engine (React + Puppeteer) + UI server (Vite + React) |

Install: `brew install montaj`

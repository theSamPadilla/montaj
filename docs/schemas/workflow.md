# Workflow Schema

> Defines the format for workflow files — the suggested execution plans the agent reads before making editorial decisions.

---

## What a workflow is

A workflow is a JSON file that describes a suggested editing plan: which steps to use, their default params, and their dependencies. It is not a deterministic pipeline. The agent reads the workflow as context, then decides the actual execution — what to run, in what order, with what params — based on the editing prompt and what it finds in the clips.

```json
{
  "name": "overlays",
  "description": "Trim and clean, then apply overlays — silence trim, remove non-speech, transcribe, select best takes, remove fillers, overlays.",
  "project_type": "editing",
  "steps": [
    { "id": "probe",            "uses": "montaj/probe",          "foreach": "clips" },
    { "id": "snapshot",         "uses": "montaj/snapshot",       "foreach": "clips" },
    { "id": "silence",          "uses": "montaj/waveform_trim",  "foreach": "clips",                           "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "nonspeech",        "uses": "montaj/rm_nonspeech",   "foreach": "clips", "needs": ["silence"],     "params": { "model": "base.en", "max-word-gap": 0.10, "sentence-edge": 0.05 } },
    { "id": "transcribe",       "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["nonspeech"],   "params": { "model": "base.en" } },
    { "id": "select-takes",     "uses": "montaj/select-takes",                       "needs": ["transcribe"] },
    { "id": "fillers",          "uses": "montaj/rm_fillers",     "foreach": "clips", "needs": ["select-takes"], "params": { "model": "base.en" } },
    { "id": "transcribe_final", "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["fillers"],     "params": { "model": "base.en" } },
    { "id": "overlays",         "uses": "montaj/overlay",                            "needs": ["transcribe_final"], "params": { "style": "auto" } }
  ]
}
```

---

## The agent's relationship to a workflow

The workflow is a suggestion, not a mandate. The agent may:

- Follow the plan as written
- Reorder steps based on what the prompt and clips call for
- Adjust param values beyond the defaults
- Skip steps that don't apply (e.g. skip `rm_fillers` if the prompt says "keep it raw")
- Add steps not in the plan (e.g. add `normalize` if audio levels are inconsistent)


The workflow gives the agent a sensible starting point and encodes domain knowledge (e.g. "for a tight reel, use sensitivity 0.8 not 0.5"). It does not constrain execution.

---

## Schema format

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Must match the filename (e.g. `overlays` for `overlays.json`) |
| `description` | string | yes | One or two sentences. Agent reads this to understand when to use this workflow. |
| `steps` | array | yes | Ordered list of step entries |
| `requires_clips` | boolean | no | When `false`, no source footage is needed. Default: `true`. The UI warns if clips are missing for a workflow that requires them. |
| `project_type` | string | no | One of `"editing"`, `"music_video"`, `"ai_video"`, `"carousel"`, `"broll"`. Drives UI branching (upload flow, player actions). Default: `"editing"`. Canonical list: `schema/enums.yaml`. |
| `notes` | string | no | Extra guidance for the agent — conventions, track ordering rules, or input semantics specific to this workflow. Read alongside the description before the agent begins execution. |

### Project types

`project_type` is a coarse UI hint. It does not affect workflow execution. Five values are defined — `schema/enums.yaml` is the single source of truth, and this table must be kept in step with it:

| Value | Upload UI | Review phase before timeline | Player actions added |
|-------|-----------|------------------------------|----------------------|
| `editing` (default) | Video clip drop zone + prompt + workflow picker | None | None (universal actions only) |
| `music_video` | Song file + optional bg video + optional lyrics file + prompt | None | Music-specific actions (swap lyrics timing, etc.) — future |
| `ai_video` | Prompt + image references (image or text per slot) + style references (up to 2) + settings | **StoryboardView** — review + approve the storyboard before videos are generated | "Regenerate section" (per-clip) and future generation actions |
| `carousel` | Aspect picker (square / portrait / vertical) + image assets + prompt + workflow picker | N/A — carousel projects have no timeline; review happens in the slide editor | None (no video player) |
| `broll` | Footage drop zone + image assets + voiceover file (audio or video; audio only is used) + prompt | None | None |

Workflows without `project_type` are treated as `"editing"`. Third-party workflows (user-global in `~/.montaj/workflows/` or project-local in `./workflows/`) can declare any of these values to invoke the corresponding UI without shipping UI code.

The flag propagates into `project.json` at init time (see `docs/schemas/project.md`). Once written, it never changes — a project's type is decided by the workflow that created it.

### Step entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier within this workflow. Used in `needs` references and logs. |
| `uses` | string | yes | Step reference. See prefix system below. |
| `params` | object | no | Default param overrides. Keys are param names from the step schema. |
| `needs` | array | no | IDs of steps that must complete before this one starts. Omit entirely (don't use `[]`) when there are no deps. Drives parallel execution. |
| `input` | string | no | Dotted identifier path into the project object naming the field this step reads — e.g. `"clips"`, `"voiceover.src"`. Declarative only: like `notes` and `foreach`, the engine doesn't act on it; it tells the agent which source a step applies to. Use it when a workflow has more than one input and the target isn't already implied by `foreach` — `broll` is the case that motivated it, where the `vo_*` chain must run over the voiceover and never over the footage. Same shape rule as `foreach`; validated by `engine/validate.py`. Redundant alongside `foreach` (which already names its collection), so the graph badges it only on non-iterated steps. |
| `foreach` | string | no | Dotted identifier path into the project object, indicating the step is iterated per entry in that collection. Common values: `"clips"`, `"storyboard.scenes"`, `"storyboard.imageRefs"`, `"storyboard.styleRefs"`. Any value matching `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$` is accepted — the agent decides what it means to iterate; the engine doesn't auto-execute. For `foreach: "clips"` specifically, steps that output trim specs (e.g. `waveform_trim`, `rm_fillers`) have downstream steps receive the trim spec as their `--input`; steps that accept trim specs (e.g. `transcribe`, `rm_fillers`) detect this automatically by checking for `.json` extension + `input`/`keeps` keys. For `ai_video` storyboard-path foreaches, see `skills/ai-video-plan/SKILL.md` and `skills/ai-video-generate/SKILL.md` for per-item skip rules. |

### Step reference prefixes

| Prefix | Resolves to |
|--------|-------------|
| `montaj/<name>` | Built-in step: `steps/<name>.py` |
| `user/<name>` | User-global step: `~/.montaj/steps/<name>.py` |
| `./steps/<name>` | Project-local step: `./steps/<name>.py` |

**Prefixes are explicit scope selectors, not fallback hints.** `montaj/trim` always resolves to the built-in, regardless of whether a project-local or user-global `trim` exists. To use a custom version, change the prefix in the workflow. This keeps workflow files portable — the same `uses` reference produces the same behavior on any machine.

The "project-local → user-global → built-in" resolution order applies to *bare step names* (no prefix) resolved by the CLI — e.g. `montaj run trim`. It does not apply to prefixed `uses` references.

---

## Three scopes

Workflows are discovered the same way steps are. Resolution order: project-local → user-global → built-in.

| Scope | Location |
|-------|----------|
| Project-local | `./workflows/<name>.json` |
| User-global | `~/.montaj/workflows/<name>.json` |
| Built-in | `workflows/<name>.json` |

`montaj run` without `--workflow` uses `overlays`. If a project-local `overlays.json` exists, it takes precedence over the built-in.

---

## Built-in workflows

The `clean_cut`, `broll`, `clips`, `animations`, `explainer`, `floating_head` and `lyrics_video` workflows moved to the Montaj app. Their skills (`broll`, `find_clips`, `lyrics-video`, `animation-sections`) moved with them and are served by the app; their project types stay in montaj.

### `overlays`

Multi-clip edit. Silence trim per clip, transcribe, select best takes, remove fillers, caption, overlays, resize to 9:16. Used by `montaj run` when no `--workflow` is specified.

```json
{
  "name": "overlays",
  "description": "Trim and clean, then apply overlays — silence trim, remove non-speech, transcribe, select best takes, remove fillers, overlays.",
  "project_type": "editing",
  "steps": [
    { "id": "probe",            "uses": "montaj/probe",          "foreach": "clips" },
    { "id": "snapshot",         "uses": "montaj/snapshot",       "foreach": "clips" },
    { "id": "silence",          "uses": "montaj/waveform_trim",  "foreach": "clips",                           "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "nonspeech",        "uses": "montaj/rm_nonspeech",   "foreach": "clips", "needs": ["silence"],     "params": { "model": "base.en", "max-word-gap": 0.10, "sentence-edge": 0.05 } },
    { "id": "transcribe",       "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["nonspeech"],   "params": { "model": "base.en" } },
    { "id": "select-takes",     "uses": "montaj/select-takes",                       "needs": ["transcribe"] },
    { "id": "fillers",          "uses": "montaj/rm_fillers",     "foreach": "clips", "needs": ["select-takes"], "params": { "model": "base.en" } },
    { "id": "transcribe_final", "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["fillers"],     "params": { "model": "base.en" } },
    { "id": "overlays",         "uses": "montaj/overlay",                            "needs": ["transcribe_final"], "params": { "style": "auto" } }
  ]
}
```

### `ai_video`

AI-generated video. No source clips required. A director agent (the `ai-video-plan` and `ai-video-generate` skills) writes a storyboard from the user's prompt and image/style references, the user reviews and approves, then scenes are generated via Kling. The workflow's `steps[]` array is a **strong suggestion** of pipeline shape — the engine never auto-executes it; the director skill orchestrates the tools.

```json
{
  "name": "ai_video",
  "description": "AI-generated video — director agent writes a storyboard from your prompt and references, you review and approve, then scenes are generated via Kling.",
  "project_type": "ai_video",
  "requires_clips": false,
  "steps": [
    {
      "id": "plan",
      "uses": "montaj/ai-video-plan",
      "description": "Director skill. Story clarification, storyboard writes (scenes, imageRefs, styleAnchor), approval gate."
    },
    {
      "id": "analyze_style",
      "uses": "montaj/analyze_media",
      "foreach": "storyboard.styleRefs",
      "needs": ["plan"],
      "description": "Per styleRef: Gemini extracts mood/style text. Director folds outputs into storyboard.styleAnchor."
    },
    {
      "id": "generate_ref",
      "uses": "montaj/generate_image",
      "foreach": "storyboard.imageRefs",
      "needs": ["plan"],
      "description": "Per imageRef: generate a reference image from the user's anchor text. Director skips entries where source != 'text' or refImages is already populated."
    },
    {
      "id": "generate",
      "uses": "montaj/ai-video-generate",
      "needs": ["plan", "analyze_style", "generate_ref"],
      "description": "Generation orchestration. Dispatch mode selection, scene generation via kling_generate, audio assembly. Runs after storyboard approval."
    },
    {
      "id": "generate_scene",
      "uses": "montaj/kling_generate",
      "foreach": "storyboard.scenes",
      "needs": ["generate"],
      "description": "Per scene (post-approval only): Kling generates the clip. Appends result to tracks[0]. May be batched (multi-shot) — up to 6 scenes per call."
    },
    {
      "id": "eval-scenes",
      "uses": "montaj/eval-scenes",
      "foreach": "storyboard.scenes",
      "needs": ["generate_scene"],
      "description": "Per scene (post-generation, optional): evaluates clips via analyze_media (Gemini rubric). Failures are regenerated via kling_generate."
    }
  ],
  "agent_notes": [
    "PIPELINE: Director-driven. Two skills: ai-video-plan (Phases 0-2) and ai-video-generate (Phases 6-7). analyze_media, generate_image, kling_generate are the agent's tools, invoked from within these flows.",
    "INTAKE: project.storyboard is pre-seeded by init.py. project.tracks[0] is empty at intake and stays empty until post-approval generation.",
    "APPROVAL GATE: Do not load ai-video-generate or call kling_generate until storyboard.approval is set.",
    "TRACKS[0]: Append-only; real clips only, no stubs. Flip status to 'draft' only when every storyboard.scenes[i] has a matching clip (or batchShots entry)."
  ]
}
```

`foreach` and `needs` are advisory — they document the pipeline shape for readers and UI introspection. The director skill handles iteration, skipping (e.g., `imageRefs` where `source !== "text"`), and the approval gate (no `kling_generate` before `storyboard.approval` is set).

### `blank`

Empty editing project — no source footage and no steps. Hosts use it to open an editor with nothing in it; the user (or an agent following the user's direct instructions) builds the edit by hand. `project_type: "editing"`, `requires_clips: false`, `steps: []`.

### `carousel`

Image carousel for Instagram/TikTok. Slide-based design with image and overlay elements; renders to N PNGs rather than a video. Build is delegated to the `montaj/carousel` skill. `project_type: "carousel"`, `requires_clips: false`.

> **Keeping this list honest.** These entries must match the files in `workflows/`. Verify with:
> ```bash
> ls workflows/*.json && grep -c '^### `' docs/schemas/workflow.md
> ```
> Full step arrays live in the JSON files and are not duplicated here for every workflow — only `overlays` and `ai_video` inline theirs. Prefer reading the file over trusting an inlined copy.

---

## Step output types

Steps produce one of three output types:

| Output type | Format | Examples |
|-------------|--------|---------|
| Video file | Absolute path printed to stdout | `resize`, `trim` |
| Trim spec | JSON `{"input": "...", "keeps": [[s,e],...]}` | `waveform_trim`, `rm_fillers`, `rm_nonspeech` |
| Data | JSON object | `probe`, `transcribe`, `snapshot` |

**Trim specs are the primary data type flowing between editing steps.** A workflow like `silence → transcribe → fillers` passes trim specs from step to step. The trim specs from the final editing step translate directly into `inPoint`/`outPoint`/`start`/`end` on `tracks[0]` items — no encode step in the interactive pipeline.

Steps that accept trim spec input detect it automatically — you do not need to change param names or add special flags. Pass the `.json` output path from one step as the `--input` to the next.

**The engine does not wire this up for you.** `engine/resolve_workflow.py` only resolves each `uses` reference to its executable and schema and merges params — it never runs a step or threads one step's output into the next step's input; `needs` is metadata the agent reads, not something the resolver or any other runtime enforces. A trim-spec step's output is inline JSON on stdout by default, not a file, so there is no `.json` output path to pass along until you make one: write the JSON to a file yourself, or, for `waveform_trim`, pass `--out <path>` and read back `{"path": "<abs path>"}` instead of the spec. Either way, that path becomes the next step's `--input` (e.g. `waveform_trim --out spec.json` → `rm_nonspeech --input spec.json`, the `silence`/`nonspeech` hop in `overlays`).

---

## Using custom steps in a workflow

Mix built-in and custom steps freely. The agent sees them all the same way.

```json
{
  "name": "brand-reel",
  "description": "Reel with brand watermark and viral hook detection",
  "steps": [
    { "id": "probe",      "uses": "montaj/probe" },
    { "id": "snapshot",   "uses": "montaj/snapshot" },
    { "id": "transcribe", "uses": "montaj/transcribe" },
    { "id": "fillers",    "uses": "montaj/rm_fillers",  "needs": ["transcribe"] },
    { "id": "hook",       "uses": "./steps/viral-hook-detector", "needs": ["transcribe"] },
    { "id": "watermark",  "uses": "user/my-watermark",  "needs": ["fillers"], "params": { "opacity": 0.8 } },
    { "id": "caption",    "uses": "montaj/caption",     "needs": ["transcribe", "fillers"] },
    { "id": "resize",     "uses": "montaj/resize",      "needs": ["caption", "watermark"], "params": { "ratio": "9:16" } }
  ]
}
```

---

## Creating a workflow

```bash
montaj workflow new my-workflow   # creates workflows/my-workflow.json from template
montaj workflow list              # list all available workflows (all three scopes)
montaj workflow edit my-workflow  # open in $EDITOR
```

Or create the JSON file directly — no registration needed. Discovered automatically.

# Workflow Schema

> Defines the format for workflow files — the suggested execution plans the agent reads before making editorial decisions.

---

## What a workflow is

A workflow is a JSON file that describes a suggested editing plan: which steps to use, their default params, and their dependencies. It is not a deterministic pipeline. The agent reads the workflow as context, then decides the actual execution — what to run, in what order, with what params — based on the editing prompt and what it finds in the clips.

```json
{
  "name": "trim_and_overlay",
  "description": "Multi-clip edit — silence trim, transcribe, select best takes, remove fillers, caption, overlays, resize to 9:16.",
  "steps": [
    { "id": "probe",             "uses": "montaj/probe" },
    { "id": "snapshot",          "uses": "montaj/snapshot" },
    { "id": "silence",           "uses": "montaj/waveform_trim",  "foreach": "clips", "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "transcribe",        "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["silence"],           "params": { "model": "base.en" } },
    { "id": "select_takes",      "uses": "montaj/select_takes",                       "needs": ["transcribe"] },
    { "id": "fillers",           "uses": "montaj/rm_fillers",     "foreach": "clips", "needs": ["select_takes"],      "params": { "model": "base.en" } },
    { "id": "transcribe_final", "uses": "montaj/transcribe",                         "needs": ["fillers"],            "params": { "model": "base.en" } },
    { "id": "caption",           "uses": "montaj/caption",                            "needs": ["transcribe_final"], "params": { "style": "word-by-word" } },
    { "id": "overlays",          "uses": "montaj/overlay",                            "needs": ["caption"],           "params": { "style": "auto" } },
    { "id": "resize",            "uses": "montaj/resize",                             "needs": ["overlays"],          "params": { "ratio": "9:16" } }
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
- Call adaptors alongside or instead of native steps

The workflow gives the agent a sensible starting point and encodes domain knowledge (e.g. "for a tight reel, use sensitivity 0.8 not 0.5"). It does not constrain execution.

---

## Schema format

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Must match the filename (e.g. `trim_and_overlay` for `trim_and_overlay.json`) |
| `description` | string | yes | One or two sentences. Agent reads this to understand when to use this workflow. |
| `steps` | array | yes | Ordered list of step entries |
| `requires_clips` | boolean | no | When `false`, no source footage is needed. Default: `true`. The UI warns if clips are missing for a workflow that requires them. |

### Step entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier within this workflow. Used in `needs` references and logs. |
| `uses` | string | yes | Step reference. See prefix system below. |
| `params` | object | no | Default param overrides. Keys are param names from the step schema. |
| `needs` | array | no | IDs of steps that must complete before this one starts. Omit entirely (don't use `[]`) when there are no deps. Drives parallel execution. |
| `foreach` | string | no | `"clips"` — fan out this step across all project clips in parallel. Each clip gets its own invocation; outputs are collected before dependent steps run. When `foreach: "clips"` steps output trim specs (e.g. `waveform_trim`, `rm_fillers`), downstream steps receive the trim spec as their `--input`, not a video file. Steps that accept trim specs (e.g. `transcribe`, `rm_fillers`) detect this automatically by checking for `.json` extension + `input`/`keeps` keys. |

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

`montaj run` without `--workflow` uses `trim_and_overlay`. If a project-local `trim_and_overlay.json` exists, it takes precedence over the built-in.

---

## Built-in workflows

### `trim_and_overlay`

Multi-clip edit. Silence trim per clip, transcribe, select best takes, remove fillers, caption, overlays, resize to 9:16. Used by `montaj run` when no `--workflow` is specified.

```json
{
  "name": "trim_and_overlay",
  "description": "Multi-clip edit — silence trim, transcribe, select best takes, remove fillers, caption, overlays, resize to 9:16.",
  "steps": [
    { "id": "probe",             "uses": "montaj/probe" },
    { "id": "snapshot",          "uses": "montaj/snapshot" },
    { "id": "silence",           "uses": "montaj/waveform_trim",  "foreach": "clips", "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "transcribe",        "uses": "montaj/transcribe",     "foreach": "clips", "needs": ["silence"],           "params": { "model": "base.en" } },
    { "id": "select_takes",      "uses": "montaj/select_takes",                       "needs": ["transcribe"] },
    { "id": "fillers",           "uses": "montaj/rm_fillers",     "foreach": "clips", "needs": ["select_takes"],      "params": { "model": "base.en" } },
    { "id": "transcribe_final", "uses": "montaj/transcribe",                         "needs": ["fillers"],            "params": { "model": "base.en" } },
    { "id": "caption",           "uses": "montaj/caption",                            "needs": ["transcribe_final"], "params": { "style": "word-by-word" } },
    { "id": "overlays",          "uses": "montaj/overlay",                            "needs": ["caption"],           "params": { "style": "auto" } },
    { "id": "resize",            "uses": "montaj/resize",                             "needs": ["overlays"],          "params": { "ratio": "9:16" } }
  ]
}
```

### `basic_trim`

Trim and clean only. No captions, overlays, or resize. Useful when the output feeds another pipeline or when a clean cut is all that's needed.

```json
{
  "name": "basic_trim",
  "description": "Trim and clean only — silence trim, transcribe, select best takes, remove fillers. No captions, overlays, or resize.",
  "steps": [
    { "id": "probe",        "uses": "montaj/probe" },
    { "id": "snapshot",     "uses": "montaj/snapshot" },
    { "id": "silence",      "uses": "montaj/waveform_trim", "foreach": "clips", "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "transcribe",   "uses": "montaj/transcribe",    "foreach": "clips", "needs": ["silence"],       "params": { "model": "base.en" } },
    { "id": "select_takes", "uses": "montaj/select_takes",                      "needs": ["transcribe"] },
    { "id": "fillers",      "uses": "montaj/rm_fillers",    "foreach": "clips", "needs": ["select_takes"],  "params": { "model": "base.en" } }
  ]
}
```

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

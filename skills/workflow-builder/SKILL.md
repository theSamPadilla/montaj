---
name: workflow-builder
description: "Create or edit Montaj workflows. Reasons about step dependencies to produce a workflow JSON with correct `needs` fields for parallel execution."
---

# Workflow Builder

A Montaj workflow is a JSON file in `workflows/` that defines which steps to run and their dependencies. Workflows with correct `needs` fields enable the agent to parallelise independent steps automatically — significantly reducing total execution time.

This skill guides you through creating or editing a workflow that is both correct and maximally parallel.

---

## When to invoke this skill

- User asks to create a new workflow
- User asks to edit or update an existing workflow
- User wants to add a step to an existing workflow
- User asks "what's the fastest way to run X" — the answer is often a well-structured workflow

---

## Step reference

Before reasoning about dependencies, know what each step reads and produces:

| Step | Reads | Produces |
|------|-------|---------|
| `probe` | original clip | metadata JSON |
| `snapshot` | original clip | contact sheet image |
| `transcribe` | original clip | transcript JSON + SRT |
| `rm_fillers` | original clip + transcript | cleaned video |
| `waveform_trim` | any video | trimmed video |
| `rm_nonspeech` | any video | trimmed video |
| `trim` | any video | trimmed video |
| `cut` | any video | trimmed video (or trim spec with `--spec`) — supports `--cuts '[[s,e],...]'` for multiple sections in one pass |
| `caption` | transcript + cleaned video | caption track data |
| `normalize` | any video | normalized video |
| `resize` | any video | resized video |
| `ffmpeg_captions` | any video | composited video |
| `extract_audio` | any video | audio file |
| `concat` | multiple videos | joined video |
| `fetch` | — | downloaded video file |
| `pacing` | any video | pacing analysis JSON |
| `jump_cut_detect` | any video | issues JSON |
| `best_take` | any video + transcript | best take selection |

---

## Execution flow

Work through this conversationally. The output is a workflow JSON file saved to `workflows/<name>.json`.

### Step 1 — Understand the goal

Ask: **"What is this workflow for? Walk me through the kind of edit it should produce."**

Listen for:
- Content type (talking head, interview, multi-clip reel, etc.)
- Target format (9:16 TikTok, 16:9 YouTube, etc.)
- Quality level (quick cut vs. full clean + captions + overlays)
- Steps the user wants to include or exclude

### Step 2 — List the steps

Based on the goal, propose which steps should be included. Confirm with the user before proceeding.

Example for a standard social reel:
```
probe, snapshot, transcribe, rm_fillers, waveform_trim, caption, overlays, resize
```

### Step 3 — Reason about dependencies

For each step, ask: **"What does this step need as input?"**

Apply these rules:

**Steps that read the original clip directly (no deps):**
- `probe`, `snapshot`, `transcribe`, `fetch`
- These can always run in parallel with each other

**Steps that depend on transcript:**
- `rm_fillers` needs `transcribe` (uses transcript to locate fillers)
- `caption` needs `transcribe` (uses word timings)
- `best_take` needs `transcribe`

**Steps that depend on a prior cleaned video:**
- `waveform_trim`, `rm_nonspeech` — if the user wants them to run on an already-cleaned clip (e.g. after `rm_fillers`), add that step as a need
- `caption` — if it should caption the cleaned video (not the original), add the last cleaning step as a need
- `normalize`, `resize`, `ffmpeg_captions` — chain after whatever the last video-producing step is

**Steps that depend on both transcript AND a cleaned video:**
- `caption` commonly needs both `transcribe` AND the last cleaning step (e.g. `waveform_trim`)

**Steps that have no downstream deps:**
- `probe`, `snapshot`, `pacing`, `jump_cut_detect` — analysis-only, no other step needs their output

### Step 4 — Identify parallel waves

Group the steps by execution wave — steps in the same wave have all their needs met at the same time:

```
Wave 1: [all steps with no needs]
Wave 2: [all steps whose needs are only in wave 1]
Wave 3: [all steps whose needs are in waves 1-2]
...
```

Show the waves to the user: **"Here's how the execution will look:"**

```
Wave 1 (parallel): probe, snapshot, transcribe
Wave 2:            rm_fillers  (needs transcribe)
Wave 3:            waveform_trim  (needs rm_fillers)
Wave 4:            caption  (needs transcribe + waveform_trim)
Wave 5:            overlays  (needs caption)
Wave 6:            resize  (needs overlays)
```

Ask: **"Does this look right? Any steps you'd reorder or change?"**

### Step 5 — Write the workflow JSON

```json
{
  "name": "<workflow-name>",
  "description": "<one-line description>",
  "steps": [
    { "id": "probe",        "uses": "montaj/probe" },
    { "id": "snapshot",     "uses": "montaj/snapshot" },
    { "id": "transcribe",   "uses": "montaj/transcribe",   "params": { "model": "base.en" } },
    { "id": "fillers",      "uses": "montaj/rm_fillers",   "needs": ["transcribe"], "params": { "model": "base.en" } },
    { "id": "silence",      "uses": "montaj/waveform_trim","needs": ["fillers"],    "params": { "threshold": "-30", "min-silence": 0.3 } },
    { "id": "caption",      "uses": "montaj/caption",      "needs": ["transcribe", "silence"], "params": { "style": "word-by-word" } },
    { "id": "overlays",     "uses": "montaj/overlay",      "needs": ["caption"],   "params": { "style": "auto" } },
    { "id": "resize",       "uses": "montaj/resize",       "needs": ["overlays"],  "params": { "ratio": "9:16" } }
  ]
}
```

Rules for the JSON:
- Steps with no dependencies: **omit the `needs` field entirely** (not `"needs": []`)
- Step `id` must be unique within the workflow — use the step name, or `<name>-<n>` if the same step appears twice
- `uses` format: `montaj/<step-name>`
- Only include params that differ from the step's defaults

Save to `workflows/<name>.json`.

### Step 6 — Confirm

Read the file back and confirm the wave structure one more time. Then: **"Workflow saved to `workflows/<name>.json`. To use it, set `"workflow": "<name>"` in your project config or pass `--workflow <name>` to `montaj run`."**

---

## Editing an existing workflow

When the user wants to add a step:

1. Read the existing workflow
2. Identify where the new step fits in the dependency graph
3. Add its `needs` based on what it reads
4. Check if any existing step's `needs` should now include the new step (i.e. does any downstream step need the new step's output?)
5. Re-derive the execution waves
6. Confirm the updated wave structure before saving

---

## Common patterns

**Fastest possible clean + caption (max parallelism):**
```
Wave 1: probe, snapshot, transcribe
Wave 2: rm_fillers  (needs transcribe)
Wave 3: waveform_trim  (needs rm_fillers)
Wave 4: caption  (needs transcribe + waveform_trim), normalize  (needs waveform_trim)
Wave 5: resize  (needs caption + normalize)
```

**Multi-clip reel (clip-level swarm):**
```
Per-clip steps (fan-out — run as parallel subagents per clip):
  probe, transcribe, rm_fillers, waveform_trim, resize

Fan-in step:
  concat  (needs all per-clip resize outputs)

Post-concat:
  caption, overlays, normalize
```
For multi-clip projects, indicate the fan-in boundary in the workflow description so the agent knows where to swarm.

**Analysis-only workflow (no editing):**
```
Wave 1 (all parallel): probe, snapshot, transcribe, pacing, jump_cut_detect
```
No deps — everything reads the original clip and produces analysis data.

---
name: parallel
description: "Parallel execution patterns for montaj — load when workflow has multiple clips or foreach steps"
step: false
---

# Parallel Execution

**Important:** Claude Code's Bash tool executes sequentially — multiple Bash calls in the same turn queue one after another. They do NOT run in parallel. Use the patterns below for true parallelism.

## Step-level — same step, multiple clips

For `foreach` steps on independent clips, use a **single Bash call with background jobs**:

```bash
out0=$(curl -s -X POST http://localhost:3000/api/steps/transcribe \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/clip0.MOV", "model": "base.en"}') &
out1=$(curl -s -X POST http://localhost:3000/api/steps/transcribe \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/clip1.MOV", "model": "base.en"}') &
# ... repeat for each clip
wait
echo "$out0"; echo "$out1"  # parse results after all complete
```

Use for any independent `foreach` step: `waveform_trim`, `transcribe`, `rm_fillers`, `probe`, `snapshot`.

## `waveform_trim` native batch

Preferred over background jobs — pass all clips in a single call:

```bash
# HTTP
curl -s -X POST http://localhost:3000/api/steps/waveform_trim \
  -H "Content-Type: application/json" \
  -d '{"inputs": ["/path/clip0.mp4", "/path/clip1.mp4", "/path/clip2.mp4"]}'
# → returns JSON array of trim specs: [{"input": "...", "keeps": [...]}, ...]

# CLI
montaj waveform-trim clip0.mp4 clip1.mp4 clip2.mp4
# → JSON array of trim specs printed to stdout
```

## Clip-level — multiple steps per clip (swarm)

When each clip needs 3+ sequential steps before concat, background jobs get unwieldy. Use **one subagent per clip**:

1. Identify fan-out point: all per-clip steps (before concat)
2. Identify fan-in point: `concat` and everything after
3. Spawn one subagent per clip — each receives: clip path, steps to run, project id, editing prompt
4. Cap at **4 concurrent clip agents** to avoid resource contention
5. Wait for all subagents to complete, collect output paths
6. Fan in: run `concat` with all paths, then continue

Use when a clip needs 3+ sequential steps — subagent coordination overhead is worth it beyond that threshold.

## Dependency waves

Workflow steps declare `needs: [step_ids]`. Identify waves of ready steps (all `needs` met) and execute each wave with the appropriate parallel pattern before moving to the next.

**Example — default workflow:**

| Wave | Steps | Pattern |
|------|-------|---------|
| 1 | `probe`, `snapshot`, `waveform_trim` (per clip) | Bash `&` or waveform_trim batch |
| 2 | `transcribe` (per clip) | Bash `&` |
| 3 | `rm_fillers` (per clip) | Bash `&` |
| 4 | `select-takes` | Sequential |
| 5 | `caption`, `overlays` | Sequential |
| 6 | `concat` | Sequential (encode boundary) |

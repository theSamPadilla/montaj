---
name: ai-video-generate
description: "Generation orchestration for approved ai_video storyboards: dispatch mode selection, scene generation via kling_generate, audio assembly, regenQueue processing. Load after storyboard approval."
step: true
subskills: "eval-scenes"
---

# AI Video Generation

You are executing generation for an approved `ai_video` storyboard. The workflow file `workflows/ai_video.json` lists this as the `generate` step, following `ai-video-plan`. The storyboard — `scenes[]`, `imageRefs[]`, `styleAnchor` — was written by the planning skill; your job is to generate clips and audio from it.

This skill covers **Phase 6** (scene generation dispatch) and **Phase 7** (draft-phase regenQueue processing). For Phases 0-2 (story clarification, storyboard writes, review), see `skills/ai-video-plan/SKILL.md`.

## Sub-skills

| Name | Path | When to load |
|------|------|--------------|
| `eval-scenes` | `skills/eval-scenes/SKILL.md` | After generating scenes in Phase 6 — quality evaluation + retry loop |

---

## Status machine

```
pending → storyboard_ready → draft → final
```

| Transition | Writer | Precondition |
|------------|--------|--------------|
| `pending → storyboard_ready` | **ai-video-plan** (agent) | Phase 1 writes complete: imageRefs anchors+images filled, styleAnchor written, scenes[] populated. `tracks[0]` still `[]`. |
| `storyboard_ready → storyboard_ready` | **ai-video-plan** (agent) in review-phase | User asks for storyboard changes via chat. Mutate `project.json`; status stays `storyboard_ready`. |
| `(implicit, UI-driven)` | **UI** | User clicks Approve. UI writes `storyboard.approval = {approvedAt: <ISO8601>}`. Status stays `storyboard_ready` — you observe the field and start Phase 6. |
| `storyboard_ready → draft` | **you** (this skill) | Every `storyboard.scenes[i]` has a matching clip in `tracks[0]` (either `generation.sceneId === scene.id` OR a `batchShots[]` entry for it). |
| `draft → final` | **human** (via UI) | Manual review. Out of scope for this skill. |

---

## Phase 6 — Scene generation (status: `storyboard_ready`, `storyboard.approval` is set)

### Entry point — how you get here

You are not file-watching. You enter Phase 6 because **the user tells you to** in chat. The typical message looks like:

> *"I approved the storyboard for project "X". Please proceed with scene generation per the ai-video-generate skill Phase 6 contract."*

That message is produced by either:
- The UI's post-approval "Tell your agent" panel (a one-click "Copy" button on `ApproveAndGenerate`), or
- The `montaj approve` CLI command (which prints the same message for the user to paste), or
- The user typing it manually (e.g. they edited `project.json` directly and now want you to go).

### Verification guard — **always run before generating**

Before calling `kling_generate`, re-read `project.json` and verify:

1. `project.projectType === "ai_video"`.
2. `project.status === "storyboard_ready"`.
3. `project.storyboard.approval` exists AND has an `approvedAt` field.
4. `project.storyboard.scenes` is non-empty.

If ANY of those is false, **do not proceed.** Tell the user what's missing and ask them to click the Approve button in the UI (or run `montaj approve`). Common failure modes:

- User said "I approved, go" but `storyboard.approval` is absent → the UI save failed, or the user saw a stale view. Ask them to click Approve again.
- Status is `pending` → storyboard hasn't been written yet. Return to Phase 1.
- Status is already `draft` → nothing to do. Tell them.
- `scenes` is empty → Phase 1 never populated the plan. Return to Phase 1 instead of generating from thin air.

Never trust the user's chat message alone as the authorization signal. The file field is the source of truth — the message is just the trigger to check.

### Once the guard passes, start generating.

### Step A — determine the scene set to generate

Iterate `storyboard.scenes[]`. For each scene, check for a matching clip on `tracks[0]`:

- **Single-shot origin**: `tracks[0].some(c => c.generation?.sceneId === scene.id)`.
- **Batched origin**: `tracks[0].some(c => c.generation?.batchShots?.some(shot => shot.sceneId === scene.id))`.

A scene is "already done" if EITHER check passes. Then:

- Clip exists → **skip** (user is re-approving after editing only a subset).
- `scene.lastError` set AND no clip → **retry**.
- Else → **new generation**.

This makes generation idempotent and incremental:

- **Full approval (first run):** all scenes generate.
- **Re-approval after editing specific scenes:** only the changed scenes regenerate. Unchanged scenes keep their existing clips.
- **Selective regeneration (user asks to redo specific scenes):** remove the clip for that scene from `tracks[0]`, then call `kling_generate --project-id X --scene-id Y`. The step's dedup guard replaces any existing clip for the same sceneId, so you can also just re-run the step — it overwrites.

**Never regenerate all scenes when only some changed.** Each Kling call costs credits and takes ~60s. If the user edited scenes 1 and 3, generate only those two. The agent should diff the user's changes against the current storyboard to determine which scenes need regeneration.

### Step B — pick a dispatch mode

Three modes; infer from the prompt + scene count (ask in Phase 0 if unclear):

#### Independent (default — parallel)

Each scene is a separate `kling_generate` call, self-contained. **You MUST fire these in parallel** — call all scenes' `kling_generate` tool calls in a single response so they execute concurrently. Cap at 4 concurrent calls; if there are more than 4 scenes, fire 4 at a time, wait for any to complete, then fire the next. Do NOT generate scenes one at a time in a sequential loop — that wastes minutes of wall-clock time that parallel dispatch avoids.

When parallel results land out of narrative order, compute each clip's `start`/`end` from the scene's position in `storyboard.scenes[]`, not from generation order. Fault-isolated and easy to regenerate.

**How to fire in parallel:** Include multiple tool calls in one assistant message. For example, if you have 5 scenes and are capping at 4 concurrent:

1. First message: call `kling_generate` for scenes 1, 2, 3, 4 simultaneously (4 tool calls in one response).
2. When results arrive, write all 4 clips to `tracks[0]`.
3. Second message: call `kling_generate` for scene 5.
4. Write the final clip and check if all scenes are done → set status to `draft`.

#### Chained continuity

Scene N visually continues N-1. Generate sequentially: after N-1 succeeds, call `snapshot --input <clip.src> --at <clip.outPoint> --out <frame.jpg>` to extract its last frame, then call `kling_generate --first-frame <frame.jpg> ...` for scene N. Slower (no parallelism), but preserves visual continuity at scene boundaries.

#### Batched (multi-shot)

Group up to 6 scenes into ONE `kling_generate` call using `--multi-shot --shot-type customize --multi-prompt '<json>'`. Kling returns a single concatenated video. Cheaper (1 billing unit per batch vs N), stronger visual consistency across shots (shared stylistic context), one poll instead of N.

Trade-offs:
- **Per-shot prompt cap is 512 chars**, not 2500. Write tighter per-scene prose.
- **No `--first-frame` / `--last-frame`** — frame control isn't supported. Incompatible with chained.
- **All-or-nothing failure.** If the batch fails on one scene, the whole batch is lost. Regenerating a single scene from a completed batch runs as a single-shot call spliced into `tracks[0]`.
- **One clip per batch, not per scene.** Store per-scene mapping in `generation.batchShots[]` (see Step D).
- **Storyboard > 6 scenes** → split into multiple batches.

#### Picking a mode

- **Default for nearly everything → independent (parallel).** Fastest wall-clock time, fault-isolated, no prompt-length restrictions. Use this unless one of the below specifically applies.
- "Flowing" / "seamless" transitions requiring frame continuity (e.g. a continuous camera move across scenes) → **chained**. Only use when the creative brief specifically demands visual continuity at scene boundaries.
- Strong scene-to-scene continuity **AND** scenes fit in 512 chars each **AND** you want cheapest billing → **batched**. Best cost-to-quality when applicable.

State your chosen mode in chat once at the start — the user can redirect if wrong.

#### Picking a model

Two Kling models are available. Pass `--model <name>` to `kling_generate`.

- **`kling-video-o1`** (preferred for visual quality) — newest model. **Only 5s or 10s durations.** No multi-shot. End frame (`--last-frame`) requires `--mode pro`. **Does NOT generate audio** — clips are silent.
- **`kling-v3-omni`** (required for audio) — flexible 3–15s durations, multi-shot support, start+end frame in both std/pro. **Generates audio** when `sound: "on"`. Use when scenes have dialogue or need sound.

**How to decide:** The model is **per-scene, not per-project** — you can mix and match. The step auto-upgrades to o1 when safe:
- Duration is 5 or 10 AND `sound: "off"` → auto-upgrades to `kling-video-o1`.
- Duration is 5 or 10 AND `sound: "on"` → stays on `kling-v3-omni` (needs audio).
- Duration is anything else → `kling-v3-omni`.

This lets you get the best quality where possible while keeping flexible pacing elsewhere. The connector snaps invalid durations to the nearest allowed value, but snapping changes your editorial pacing — better to pick the right model per scene than rely on snapping.

State your model choices in chat alongside the dispatch mode. Record the actual model used on `generation.model` for each clip.

#### Transition style — hard cuts by default

Each scene is generated from scratch via text-to-video. Shot-to-shot transitions are **hard cuts**. Do NOT use `--first-frame` to chain scene N's last frame into scene N+1's generation — this produces a morphy, dissolve-y feel that reads as AI-generated.

**The only exception is a deliberate match-cut** — where the end of scene A and the start of scene B form an intentional visual rhyme (e.g. a ball rolling → a globe spinning). This is rare: 0-1 times per video, only when the user explicitly requests it. If you're unsure whether something qualifies as a match-cut, it doesn't — use a hard cut.

Identity consistency across hard cuts comes from **the same character specs and ref images being passed to every scene** — not from pixel handoff between frames. The `kling_generate` step appends character descriptions and `<<<image_N>>>` tokens to every prompt, so identity holds via the spec.

**Note:** Chained dispatch mode (documented above) remains available for the rare match-cut case. It is no longer the recommended default — use independent dispatch with hard cuts unless the user specifically requests visual continuity at a scene boundary.

### Step C — prompt composition (handled by the step)

In project-aware mode (`--project-id` + `--scene-id`), the `kling_generate` step handles all prompt composition automatically. The agent does NOT compose the wire prompt manually. The step:

1. Reads the scene's `## Section` prompt and flattens it (Subject → Action → Dialogue → Setting order, period-terminated).
2. Prepends `storyboard.styleAnchor` as a short prefix.
3. Places `<<<image_N>>>` tokens inline at character/object label mentions (matches on first word of label for flexibility — "Rosie" matches even if label is "Rosie the Dog").
4. Appends `[SHOT SCALE]` and `[CAMERA MOVE]` tags from the scene's structured fields.
5. Auto-sets a default negative prompt targeting common Kling failure modes.
6. Generates a random seed for reproducibility.
7. Auto-upgrades to `kling-video-o1` when duration is 5/10 and sound is off.

**The agent's only job is writing good `## Section` prompts in Phase 1.** Everything else is mechanical.

**What gets stored on `generation.prompt`:** the composed wire-ready string (with tokens, style anchor, camera tags). This is the exact prompt sent to Kling.

- **Length caps (enforced by connector):**
  - **Single-shot: silently truncates at 2500 chars.** Keep scene prompts under ~100 words to stay safe.
  - **Multi-shot customize: hard-rejects any `multi_prompt[i].prompt` > 512 chars.**

- Resolve `scene.refImages` IDs against `storyboard.imageRefs` (use `imageRefs[i].refImages[0]` as the primary path). Enforce the API cap of 7 refs per scene.

- Respect Kling's length cap: 2500 chars in single-shot, **512 chars per shot in multi-shot**.

### Step D — call and write

#### Single-shot (independent or chained)

```
kling_generate \
  --prompt <combined> \
  --duration <scene.duration> \
  --aspect-ratio <storyboard.aspectRatio> \
  --model <chosen model> \
  --ref-image <path> [--ref-image <path> ...] \
  --out <path> \
  --external-task-id <scene.id>
```

Add `--first-frame <path>` for chained mode (N-1's last frame).

**On success:** append a new clip to `tracks[0]`:

```json
{
  "id": "clip-<scene.id>",
  "type": "video",
  "src": "<returned path>",
  "start": <cumulative sum of prior durations>,
  "end": <start + scene.duration>,
  "inPoint": 0,
  "outPoint": <scene.duration>,
  "generation": {
    "sceneId": "<scene.id>",
    "provider": "kling",
    "model": "<chosen model>",
    "prompt": "<combined>",
    "refImages": ["<ref_id>", ...],
    "duration": <scene.duration>,
    "attempts": []
  }
}
```

The prompt stored on `generation.prompt` is the **caller's composed string** (styleAnchor + scene prose in natural language) — NOT the wire string the connector produced after prepending its ref clause. The connector derives the ref clause deterministically from `refImages`, so regen can re-run the same caller prompt and reproduce the same wire string. Phase 7's regenerate flows (full-scene and subcut) pre-fill the prompt field from this.

**Write `project.json` back IMMEDIATELY after each scene completes** — do not batch writes. The UI watches for changes via SSE and flips scene chips from "pending" → "done" in real time. If you wait until all scenes finish to write, the user sees no progress for minutes. Each `kling_generate` call returns → append the clip to `tracks[0]` → save `project.json` → move to the next result. When running scenes in parallel, save after EACH result lands (not after all parallel calls complete).

**On failure:** record `storyboard.scenes[i].lastError = {ts: <ISO8601>, message: <error>}` and write `project.json` back immediately. Do NOT append to `tracks[0]`. Continue to the next scene. The UI updates in real-time via SSE.

**On retry after failures:** Before retrying failed scenes, clear `lastError` on each scene you're about to retry — set `storyboard.scenes[i].lastError = undefined` and write `project.json`. This resets the UI's red "failed" chips back to "pending" so the user sees live progress. Then proceed with generation as normal. On success, the clip write naturally clears the failed state in the UI.

#### Batched (multi-shot customize)

Build `multi_prompt` JSON from the batch:

```json
[
  {"index": 1, "prompt": "<combined for scene_A>", "duration": "3"},
  {"index": 2, "prompt": "<combined for scene_B>", "duration": "4"},
  ...
]
```

Each `prompt` is the combined styleAnchor + scene prose + inline `<<<image_N>>>` tokens (SAME composition as single-shot, but respect the 512-char per-shot cap). Call:

```
kling_generate \
  --multi-shot \
  --shot-type customize \
  --multi-prompt '<json>' \
  --aspect-ratio <storyboard.aspectRatio> \
  --ref-image <path> [--ref-image <path> ...] \
  --out <path> \
  --external-task-id batch-<first_id>-<last_id>
```

Refs passed apply to any shot in the batch. Cap still 7 total.

**On success:** append ONE clip to `tracks[0]` representing the whole batch:

```json
{
  "id": "batch-<first_scene_id>-<last_scene_id>",
  "type": "video",
  "src": "<returned path>",
  "start": <cumulative>,
  "end": <start + total_batch_duration>,
  "inPoint": 0,
  "outPoint": <total_batch_duration>,
  "generation": {
    "provider": "kling",
    "model": "<chosen model>",
    "multiShot": true,
    "shotType": "customize",
    "refImages": ["<ref_id>", ...],
    "attempts": [],
    "batchShots": [
      {"sceneId": "scene_A", "index": 1, "prompt": "<combined_A>", "start": 0.0, "end": 3.0, "duration": 3},
      {"sceneId": "scene_B", "index": 2, "prompt": "<combined_B>", "start": 3.0, "end": 7.0, "duration": 4}
    ]
  }
}
```

`batchShots[i].start` / `end` are **relative to the batch clip**, not the project timeline. The UI uses these for per-scene progress.

**On failure (batch-level):** the whole batch is lost. Record `storyboard.scenes[i].lastError = {ts, message, batchId}` on EVERY scene in the batch. Do NOT append to `tracks[0]`. The user can re-click Approve (Step A skips scenes with existing clips — retry is automatic for batches with no clip) or edit individual prompts and retry.

### Step E — Audio generation, then wrap up

**Important: generate audio BEFORE setting status to `draft`.** Setting `draft` routes the user to ReviewView — audio tracks must already be on the project by then.

After all scenes have clips on `tracks[0]`, process the audio intake fields first (Step E.1), then set status (Step E.2).

#### Step E.1 — Audio generation and assembly

Process the audio intake fields. Compute total video duration:

```python
total_duration = sum(scene['duration'] for scene in storyboard['scenes'])
```

**Re-run cleanup.** Phase 6 may run multiple times. Before appending any generated tracks, remove prior Phase-6-generated audio:

```python
project['audio']['tracks'] = [
    t for t in project['audio'].get('tracks', [])
    if not (t['id'] == 'voiceover' or t['id'].startswith('music-') or t['id'] == 'music')
]
```

#### Music

If `storyboard.music` is set:

**Upload mode** (`storyboard.music.mode === 'upload'`):
- Probe the file: `run_step('probe', { 'input': storyboard.music.path })` → get `duration`.
- Append one `AudioTrack`:
  ```json
  {
    "id": "music",
    "src": "<storyboard.music.path>",
    "start": 0,
    "end": min(duration, total_duration),
    "sourceDuration": duration,
    "volume": 0.3,
    "label": "music (uploaded)",
    "ducking": { "enabled": true }
  }
  ```

**Describe mode** (`storyboard.music.mode === 'describe'`):
- Call `run_step('generate_music', { prompt: storyboard.music.prompt, out: '<project_dir>/assets/music.wav' })`.
- Lyria Clip produces ~30s. If `total_duration > duration`, tile the track by creating multiple `AudioTrack` entries pointing to the same file at sequential start offsets:
  ```python
  start = 0
  while start < total_duration:
      seg_end = min(start + dur, total_duration)
      append AudioTrack with id=f"music-{start}", src=result.path,
        start=start, end=seg_end, inPoint=0, outPoint=seg_end-start,
        sourceDuration=dur, volume=0.3, label=f"music (generated, loop at {start}s)",
        ducking={ enabled: true }
      start += dur
  ```

**Ducking config:** `{ enabled: true }` is sufficient. The render pipeline's `mix-audio.js` applies defaults for depth (−12 dB), attack (0.3s), and release (0.5s) when those fields are absent.

#### Voiceover

If `storyboard.voiceover` is set:

**Step 1 — decide script vs. brief.** Inspect `storyboard.voiceover.prompt`:
- If the text reads like literal spoken lines (first-person narrative, quoted dialogue) → use verbatim as TTS input.
- If the text reads like a direction ("narrate like a documentary") → expand into a full script via LLM call, sized to ~`total_duration * 150 / 60` words (~150 wpm narration pace).
- Ambiguous cases: prefer verbatim (trust the user's text).

**Concrete examples:**

| User prompt | Interpretation | Action |
|---|---|---|
| `"Welcome to our farm, where every morning begins with..."` | First-person narrative, reads as spoken lines | **verbatim** — feed directly to TTS |
| `"narrate like David Attenborough describing a quiet morning"` | Clear direction, no content | **expand** — LLM generates a script in that voice |
| `"the dog looks up at the sky"` | Third-person description, could go either way | **verbatim** (prefer trusting the user) |
| `"make it sound urgent and dramatic, mention the storm"` | Direction + content hint | **expand** — LLM writes an urgent script about a storm |

**Step 2 — call the step (with Kling→Gemini fallback):**

**Voice selection.** `TTS_VOICES` in `connectors/kling.py` is currently empty (placeholder IDs). Pass the raw voice string directly — the connector falls back to using it as-is via `TTS_VOICES.get(voice, voice)`. For Gemini, use documented voice names.

| Inferred tone | Kling `--voice` | Gemini `--voice` |
|---|---|---|
| Neutral / documentary / instructional | `"female_warm"` (raw string; Kling resolves or uses default) | `"Kore"` |
| Energetic / commercial / dramatic | `"female_warm"` | `"Puck"` |
| Dark / serious | `"male_calm"` | `"Charon"` |

Always record the chosen voice on the resulting track's label (e.g. `"voiceover (kling:female_warm)"` or `"voiceover (gemini:Kore)"`).

```python
out = f"{project_dir}/assets/voiceover.wav"

# Primary: Kling TTS. Fall back to Gemini if Kling errors.
try:
    result = run_step('generate_voiceover', {
        'text':   script,
        'voice':  'female_warm',       # raw string — Kling connector passes through
        'out':    out,
        'vendor': 'kling',
    })
    voice_label = 'kling:female_warm'
except Exception as e:
    # Kling TTS failed (likely due to placeholder voice IDs) — retry with Gemini.
    agent_log(f"Kling TTS failed ({e}); retrying with Gemini TTS")
    result = run_step('generate_voiceover', {
        'text':   script,
        'voice':  'Kore',              # Gemini documented voice name
        'out':    out,
        'vendor': 'gemini',
    })
    voice_label = 'gemini:Kore'
```

**Step 3 — append as track:**
```json
{
  "id": "voiceover",
  "src": "<result.path>",
  "start": 0,
  "end": min(result.duration_seconds, total_duration),
  "sourceDuration": result.duration_seconds,
  "volume": 1.0,
  "label": "voiceover (<voice_label>)",
  "ducking": { "enabled": false }
}
```

**Duration mismatch handling:**
- VO duration > total_duration: clamp `end` to `total_duration` (truncates tail). Warn the user.
- VO duration < total_duration: VO plays and stops; silence fills the remainder (with music still playing if present). No warning needed.

**Error handling:** If `generate_music` or `generate_voiceover` fails, skip the failed track — do not abort the whole project. Surface the error to the user. Continue with the other track if available.

Write `project.json` after appending the audio tracks.

#### Step E.2 — Set status

- **When every `storyboard.scenes[i]` has a matching clip** (by sceneId OR batchShots sceneId) AND audio generation is complete (or skipped if no intake fields): set `project.status = "draft"`. The UI's EditorPage routing carries the user to ReviewView.
- **If some scenes failed:** leave status at `storyboard_ready`. The user sees partial progress (some cards "done," some showing error). They may re-click Approve (idempotency handles retry) or ask in chat for tweaks.

### Step F — evaluate generated clips (optional but recommended)

After all scenes have clips, run the eval loop:

    for each scene:
      eval_scene --project-id {id} --scene-id {scene.id} --max-retries 2

The step evaluates each clip against a 5-dimension quality rubric (character match, physics, anatomy, action, standalone) using Gemini. If a clip fails, the step regenerates it via Kling (non-deterministic re-roll with the same composed prompt) and re-evaluates, up to `max-retries` times. Previous attempts are preserved as versioned files (`scene-1-v2.mp4`, etc.) and recorded in `generation.attempts[]` with their eval verdicts.

Results are stored on `tracks[0][i].generation.eval` — `{pass, scores, attempt}`.

**When to skip:** If the user says they're happy with the clips, want to iterate manually, or are cost-sensitive (each eval = 1 Gemini call + potentially N Kling calls per scene).

**Note:** The eval loop does NOT revise prompts — it re-rolls generation with the same prompt, relying on Kling's non-determinism to produce a better draw. Prompt revision based on Gemini feedback is a future enhancement.

---

## Phase 7 — Draft phase (status: `draft`)

Treat the project like any other. Respond to timeline-editing requests.

Don't touch the `generation` block on `tracks[0]` clips unless explicitly asked ("regenerate scene 3 with a different prompt"). That block is a frozen snapshot of what produced the clip.

### Processing the regenQueue

`project.regenQueue[]` is the authoritative queue for per-clip regeneration requests. The UI (inspect modal for full-scene, subcut range-picker tool for windowed regens) and the `montaj regen` / `montaj regen subcut` CLI commands all write entries to this queue. When the user triggers you — typically with *"Please process project.regenQueue[] per the ai-video-generate skill Phase 7 contract."* — drain it.

**Verification guard (same spirit as Phase 6's approval guard):**
1. `project.projectType === "ai_video"`.
2. `project.regenQueue` is a non-empty array.
3. Each entry's `clipId` matches a real item in `tracks[0]`.

Bad entries → tell the user, do NOT drop silently.

**For each entry, in order:**

1. **Locate the clip.** `clip = tracks[0].find(c => c.id === entry.clipId)`. If missing → set `entry.lastError = {ts, message: "clip not found"}`, continue to next entry.

2. **Extract continuity frames if needed (subcut + toggle on):**
   - `entry.useFirstFrame === true` → `snapshot --input <clip.src> --at <entry.subrange.start> --out <frame_first.jpg>`.
   - `entry.useLastFrame === true` → `snapshot --input <clip.src> --at <entry.subrange.end> --out <frame_last.jpg>`.

3. **Compose the full prompt** from `entry.prompt` + `entry.refImages`, then **call `kling_generate`**.

   The connector is a pure pass-through — you must place `<<<image_N>>>` tokens and the ref clause yourself, same as Phase 6 Step C. Compose the prompt:
   - Start with `storyboard.styleAnchor` (if present) as prefix.
   - Append `entry.prompt`. At each character/object label that matches a ref's `imageRefs[i].label`, insert the positional `<<<image_N>>>` token (N = 1-indexed, matching `--ref-image` order).
   - Prepend the ref clause: `"Use the character/style from <<<image_1>>>, <<<image_2>>>. "`.

   Store the **pre-composition** natural-language prompt (without tokens/clause) on `generation.prompt` when patching the clip.

   Call `kling_generate` with the composed prompt:
   - `--prompt "<composed prompt with tokens and ref clause>"`
   - `--duration <entry.duration>`
   - `--aspect-ratio <project.storyboard.aspectRatio>`
   - `--model <entry.model>` (falls back to `kling-v3-omni` if unset)
   - `--ref-image <resolved_path>` per ID in `entry.refImages` (resolve via `project.storyboard.imageRefs[i].refImages[0]`)
   - `--first-frame <frame_first.jpg>` / `--last-frame <frame_last.jpg>` if step 2 produced them
   - `--out <workspace_path>`
   - `--external-task-id <entry.id>`

4. **Patch `tracks[0]` based on mode:**

   **`mode: "full"`** — replace in place:
   - Push `{ts, prompt: <clip.generation.prompt>, src: <clip.src>}` onto `clip.generation.attempts[]`.
   - `clip.src = <new path>`, `clip.inPoint = 0`, `clip.outPoint = entry.duration`.
   - `clip.end = clip.start + entry.duration` → ripple subsequent items.
   - Update `clip.generation.prompt = entry.prompt`, `.duration = entry.duration`, `.refImages = entry.refImages`, `.model = entry.model`.

   **`mode: "subcut"`** — split and insert:
   - **Left piece** (if non-zero duration): `inPoint = clip.inPoint`, `outPoint = entry.subrange.start`; timeline span `start = clip.start`, `end = clip.start + (subrange.start - clip.inPoint)`. Inherits `clip.generation` unchanged.
   - **Middle piece** (new): `src = <new path>`, `inPoint = 0`, `outPoint = entry.duration`; timeline span starts where left ends. Fresh `generation`: `{sceneId: clip.generation.sceneId, provider: "kling", model: entry.model, prompt: entry.prompt, refImages: entry.refImages, duration: entry.duration, attempts: []}`.
   - **Right piece** (if non-zero duration): `inPoint = entry.subrange.end`, `outPoint = clip.outPoint`; timeline span starts where middle ends. Inherits `clip.generation` unchanged.
   - Replace the single `tracks[0]` entry with the non-degenerate pieces in order. Ripple subsequent clips.
   - Degenerate case: subrange covers the whole clip → no left/right → equivalent to full-scene regen. No special-case logic needed.

5. **Remove the processed entry** from `regenQueue`. Write `project.json`.

6. Loop to the next entry.

**On failure (any entry):** do NOT remove it. Set `entry.lastError = {ts: <ISO8601>, message: <kling error>}` and continue to the next entry. User can re-trigger after investigating.

**Regen contract — what NOT to do:**
- Don't process `regenQueue` entries before the user triggers you. The queue being non-empty doesn't mean "go" — wait for the chat message, same pattern as `storyboard.approval` in Phase 6.
- Don't process entries in parallel if they target overlapping clips. Sequential avoids races.
- Don't mutate `storyboard.scenes[]` during regen. Editorial plan stays stable; regen operates on `tracks[0]` only.
- Don't drop bad entries silently. Record `lastError` so the user can fix and retry.
- Don't pass `entry.prompt` raw as `--prompt` — compose it first (tokens + ref clause + styleAnchor). The connector does NOT add tokens; you must.
- Don't skip the snapshot step when `useFirstFrame` / `useLastFrame` is set. Those toggles are the user's explicit continuity request; honor them.

---

## Field path reference

One table of every field you write, grouped by phase.

| Field | When | What |
|-------|------|------|
| `project.storyboard.scenes[i].lastError` | phase 6 | Optional per-scene error record. Clear on eventual success. For batched failures, stamp on every scene in the failed batch. |
| `project.tracks[0]` | phase 6 | **Append** real clips only. Never stubs, never empty-src items. |
| `project.tracks[0][i].generation.*` (single-shot) | phase 6 | Frozen snapshot: `{sceneId, provider, model, prompt, refImages, duration, attempts}`. |
| `project.tracks[0][i].generation.multiShot / shotType / batchShots` | phase 6, batched only | Batched clip metadata; `batchShots[]` carries per-scene mapping inside the concatenated output. |
| `project.tracks[0][i].generation.attempts` | post-draft regen (Phase 7 regenQueue drain) | Append previous `{ts, prompt, src}` before overwriting on a `mode: "full"` regen. For `mode: "subcut"`, the middle piece is a fresh clip with empty `attempts[]`; the left/right pieces inherit the original clip's attempts unchanged. |
| `project.regenQueue` | Phase 7 | UI and CLI append entries. Agent drains on trigger — remove on success, set `lastError` on failure. |
| `project.storyboard.music` | intake | `{ mode: 'upload', path }` or `{ mode: 'describe', prompt }`. Project-wide music brief. |
| `project.storyboard.voiceover` | intake | `{ prompt }`. Project-wide voiceover script or brief. |
| `project.audio.tracks` (music/voiceover entries) | phase 6 | Appended after all scene clips are on `tracks[0]`. Music at volume 0.3 with ducking enabled; voiceover at volume 1.0. Stripped and re-created on Phase 6 re-runs. |
| `project.status` → `draft` | end of Phase 6 | Only when every `storyboard.scenes[i]` has a matching clip (single-shot sceneId OR batchShots sceneId). |

---

## What NOT to do

- **Don't generate scenes sequentially in independent mode.** Fire all `kling_generate` calls in parallel (up to 4 concurrent). Sequential one-at-a-time dispatch wastes minutes of wall-clock time — Kling handles concurrent requests fine.
- **Don't use multi-shot mode with `--first-frame` / `--last-frame`.** Kling doesn't support frame control in multi-shot. If you need frame continuity, use chained mode.
- **Don't exceed 512 chars per shot in multi-shot mode.** Single-shot's 2500-char budget does NOT apply per-shot. Fall back to independent mode for any scene that needs more prose.
- **Don't use `sceneId` on the outer `generation` block of a batched clip.** Use `batchShots[].sceneId`. The idempotency check in Step A branches on whether `batchShots` exists.
- **Don't set non-integer `scenes[i].duration`.** Kling's per-scene enum is integers (3–15 single-shot, 1–N multi-shot). Floats get silently clamped; apparent length drifts from your plan.
- **Don't call `kling_generate` before `storyboard.approval` is set.** Premature generation wastes credits.
- **Don't overwrite `storyboard.approval`.** The UI owns that field.
- **Don't mutate `tracks[0][i].generation` to "edit the scene".** That block is a frozen snapshot. To change editorial intent, edit `storyboard.scenes[i]`. To actually regenerate with new settings, queue a `regenQueue` entry (via UI, CLI, or by writing one yourself in chat) and drain per Phase 7.
- **Don't regenerate scenes that already have a clip** when the user re-approves. The skip-if-clip-exists check in Phase 6 Step A is mandatory — partial-approval retries depend on it.
- **Don't put scenes on `tracks[0]` before they've been generated.** `tracks[0]` holds real clips only — no stubs, no empty-src items.
- **Don't set `project.status` to `"draft"` until every `storyboard.scenes[i]` has a matching clip in `tracks[0]`.**
- **Don't chain scenes via `--first-frame` by default.** Hard cuts are the standard. Frame bridging produces morphy AI-slop transitions. Reserve `--first-frame` for deliberate match-cuts (rare, user-requested only).
- **Don't include `## Dialogue` in scene prompts when `storyboard.voiceover` is set.** Kling-generated dialogue competes with TTS voiceover — omit it so scenes only produce ambient SFX.
- **Don't skip the Phase 6 re-run cleanup for audio tracks.** Always strip prior `music`, `music-*`, and `voiceover` tracks before appending new ones — prevents stale accumulation on re-approval.
- **Don't invent fields outside the schema.** If you need to store something, ask the user.
- **Don't touch `project.json` outside ai_video's documented paths** (e.g., don't add fields to `settings`).

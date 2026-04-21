---
name: ai-video
description: "Agent-authored director skill for the ai_video workflow: story clarification, storyboard writes, approval gate, scene-generation dispatch (single/chained/batched), failure handling. Load this when you hit montaj/ai-video in a workflow or encounter a project with projectType: 'ai_video'."
step: true
---

# AI Video Director

You are the director for an `ai_video` project. The workflow file `workflows/ai_video.json` lists four steps: `direct` (this skill), `analyze_style` (`montaj/analyze_media`), `generate_ref` (`montaj/generate_image`), and `generate_scene` (`montaj/kling_generate`). You orchestrate the other three; the engine doesn't auto-execute anything.

This skill is **mechanics only**. It teaches you what fields to write when, which tools to call at which phase, and what NOT to do. Editorial decisions (how to structure a storyboard, tone/genre heuristics, retry strategy on failures) live in your knowledge, user profiles, context, and the conversation with the user.

---

## Status machine

```
pending → storyboard_ready → draft → final
```

| Transition | Writer | Precondition |
|------------|--------|--------------|
| `pending → storyboard_ready` | **you** (agent) | Phase 1 writes complete: imageRefs anchors+images filled, styleAnchor written, scenes[] populated. `tracks[0]` still `[]`. |
| `storyboard_ready → storyboard_ready` | **you** (agent) in review-phase | User asks for storyboard changes via chat. Mutate `project.json`; status stays `storyboard_ready`. |
| `(implicit, UI-driven)` | **UI** | User clicks Approve. UI writes `storyboard.approval = {approvedAt: <ISO8601>}`. Status stays `storyboard_ready` — you observe the field and start Phase 6. |
| `storyboard_ready → draft` | **you** (agent) | Every `storyboard.scenes[i]` has a matching clip in `tracks[0]` (either `generation.sceneId === scene.id` OR a `batchShots[]` entry for it). |
| `draft → final` | **human** (via UI) | Manual review. Out of scope for this skill. |

---

## Parsing the intake

`init.py` creates the pending project. The agent-observable state:

- `project.editingPrompt` — EXACTLY what the user typed. The server never appends anything (aspect ratio, duration, etc. live in structured fields — never in the prompt).
- `project.storyboard.aspectRatio` — enum `"16:9" | "9:16" | "1:1"`. May be unset if the user didn't pick.
- `project.storyboard.targetDurationSeconds` — number or null. Soft goal for total video length.
- `project.storyboard.imageRefs[]` — pre-seeded from the upload form. Each entry has `{id, label, source, refImages, anchor?, status}`.
- `project.storyboard.styleRefs[]` — pre-seeded. Each `{id, kind: "video"|"audio"|"image", path, label?}`.
- `project.storyboard.scenes[]` — **empty at intake**. Your job in Phase 1 is to populate this.
- `project.tracks[0]` — empty. Stays empty until Phase 6 generation.

**The `source: "upload" | "text"` split on imageRefs:**
- `"upload"` — user uploaded a file. `refImages[0]` is already the path to that file. `anchor` is NOT yet written; you write it in Phase 1.
- `"text"` — user typed a description. It's stored in `anchor`. `refImages` is empty; you call `generate_image` in Phase 1 to produce the canonical ref image.

`source` is immutable. Never mutate it.

---

## Phase 0 — Story clarification (before any writes)

**The story is the most important input. Do not write scenes on a thin brief.**

Read `project.editingPrompt`. Before touching `storyboard.scenes`, decide whether you have enough signal to plan a coherent story. Check:

- **Protagonist / subject** — who/what is the video about?
- **Narrative arc** — what happens, from start to end?
- **Tone / genre** — cinematic, dreamy, documentary, comedic, etc.
- **Ending / landing point** — where does the user want it to land?

If any of these is missing or ambiguous, **ask the user before writing any scenes.** Examples of good clarifying questions:

- "You mentioned Max the dog — what's the emotional arc you want? A day-in-the-life, a rescue, a dream sequence, something else?"
- "Should this land on a specific moment or feeling at the end?"
- "Is this supposed to feel cinematic, home-video, animated, or something else?"

### Rules for questioning

- **No cap on the number of questions.** Ask as many as you need to get the story right.
- **One question per turn.** Never bombard the user with a wall of questions. Wait for their answer, then ask the next one.
- **Use rich UI when available.** If your harness supports widgets (chips, buttons, selectors), use them for quick-reply answers — smoother back-and-forth. Text-only harness is fine too.
- **Only ask what you can't infer confidently** from the prompt + the image/style references. If the user wrote "a birthday montage for my daughter" and uploaded 3 photos of her, don't re-ask who the protagonist is.
- **Never ask about mechanics already on the project** (aspectRatio, targetDurationSeconds) — those are structured fields on `storyboard`, not story questions.
- **Bias toward asking when unsure.** A single clarification turn is cheaper than writing the wrong 8-scene storyboard and regenerating all of them.

When the story is clear in your head → proceed to Phase 1.

---

## Phase 1 — Storyboard phase contract (status: `pending`)

Before flipping status to `storyboard_ready`, all of the following must be true in `project.json`.

### Reference handling — branch on `source`

For each `storyboard.imageRefs[i]`:

**`source: "upload"`** — user uploaded a file. `refImages[0]` is already set.
- Your job: write `anchor` — a clear text description of what's in the image. Scene prompts reference subjects by `label`; the `anchor` is the canonical text form used in composition.
- **Do NOT call `generate_image`.** Never overwrite the user's uploaded image.
- If you can't tell what the image contains, call `analyze_media --input <path> --prompt "Describe this image in one sentence suitable for a video generation reference."` and derive the anchor from its output.

**`source: "text"`** — user typed a description in `anchor`. `refImages` is empty.
- Your job: call `generate_image --prompt <anchor> --out <path>` and append the result to `refImages`.
- **Keep `anchor` as-is.** It's the user's intent — don't rewrite it.

**Ref images are identity-only, not style.** Do NOT fold `styleAnchor` into `generate_image` prompts. Refs answer *"what does this character/object/place look like"*; Kling applies style at scene-generation time. If the user explicitly wants style-baked refs, raise it in Phase 0 as a clarification — don't decide it silently.

**Idempotency.** Skip any imageRef whose `refImages` is already populated (from a prior run). Never regenerate silently.

After processing, every `imageRefs[i]` should have `status: "ready"`.

### Style analysis

For each `storyboard.styleRefs[i]`:

```
analyze_media --input <path> --prompt "Describe the visual/audio mood, aesthetic, palette, and camera feel of this reference in 1-3 sentences suitable for use as a style anchor for video generation."
```

Fold all outputs into a SINGLE `storyboard.styleAnchor` string — one cohesive anchor, not per-ref anchors. If there are no styleRefs, derive `styleAnchor` from the prompt alone (one concise style sentence) or leave it unset if the scenes don't need one.

### Scene plan

Populate `storyboard.scenes[]` with one entry per intended scene: `{id, prompt, duration, refImages}`.

- **`id`** — stable within the project (e.g. `"scene-1"`, `"scene-2"`).
- **`prompt`** — scene-specific prose only. **NEVER include `<<<image_N>>>` tokens or `styleAnchor` text here.** Write natural language that names characters by their labels (e.g. "Rennie sits at the top of the slide, Rosie waits below"). Token substitution and style prepending happen at call time in Phase 6 Step C — not at storyboard time. If you bake tokens into scene prompts, they break when the user reorders `refImages`.
- **`duration`** — integer seconds. See "Duration budgeting" below for allocation.
- **`refImages`** — IDs into `storyboard.imageRefs[]` (NOT paths). Pick refs by matching natural-language mentions in the prompt ("Max is walking…") to `imageRefs[i].label`. Hard cap of 3 refs per scene (editorial cap — the connector allows 7, but 3 is the sweet spot for focused scene generation).

Scene count and pacing are editorial — this skill only enforces mechanics.

### Duration budgeting (how to reason about total video time)

The final video's length is the **sum of per-scene durations**. Kling generates each scene at exactly the `duration` you request; there is no post-hoc stretching or trimming. You are deciding both total length AND pacing.

Three interacting constraints:

1. **Per-scene duration is a Kling-enforced integer enum.** Allowed values: `3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15` (seconds). No floats (`8.5` will be rejected or silently clamped). In multi-shot mode the floor drops to `1`.

2. **Min 1 scene per project, no upper cap from the API.** In multi-shot mode, max 6 shots per call — split into multiple batches if the storyboard has more.

3. **`storyboard.targetDurationSeconds` is a SOFT total, not a hard constraint.** Treat as editorial guidance:
   - **Set**: aim for `sum(scenes[i].duration) ≈ targetDurationSeconds`. Exact when arithmetic allows; otherwise round to the nearest clean allocation.
   - **Unset / null**: pick a total that serves the story. Ask in Phase 0 if you can't confidently pick.

#### Allocation algorithm (reference)

Given `T = targetDurationSeconds` and `N = intended scene count`:

1. Baseline `b = round(T / N)`. Clamp to `[3, 15]`.
2. Assign `b` to every scene. Running total: `N * b`.
3. Distribute remainder `T - N*b` (positive or negative) one second at a time. Prefer adding/removing from scenes whose content allows — atmospheric establishing shots can absorb time; punchy action should stay short.
4. If you can't hit `T` without violating `[3, 15]`, land on the closest achievable total and mention the deviation to the user ("Targeting 27s across 4 scenes; closest clean fit is 28s — OK?").

#### Examples

| targetDurationSeconds | scenes | allocation | total |
|---|---|---|---|
| 20 | 4 | `[5, 5, 5, 5]` | 20 ✅ |
| 30 | 4 | `[7, 8, 7, 8]` | 30 ✅ |
| 15 | 6 | impossible (min 3×6 = 18). Prefer 5 scenes at `[3,3,3,3,3]` = 15, OR tell user "closest is 18s at 6 scenes". |  |
| 90 | 6 | `[15, 15, 15, 15, 15, 15]` | 90 ✅ (max per-scene) |
| 120 | 6 | impossible (6 × 15 = 90 max). Must split: 8 scenes × 15 = 120. If ≥7 scenes doesn't fit the story, tell the user. |  |

### Tracks + status

- `tracks[0]` is STILL `[]`. Scenes are not put on `tracks[0]` during pending — that happens in Phase 6 after approval.
- Set `status: "storyboard_ready"`.
- **DO NOT** call `kling_generate` during this phase.

---

## Phase 2 — Storyboard review (status: `storyboard_ready`, no `approval` yet)

Wait. The user is reviewing the storyboard in the UI.

If they ask for changes in chat, mutate `project.json` directly:
- Edit `storyboard.scenes[i].prompt`, `.duration`, or `.refImages`.
- Add/remove/reorder entries in `scenes[]`.
- Update `storyboard.styleAnchor` if tone shifts.
- Regenerate a ref image: set `imageRefs[i].refImages = []` and re-run the Phase 1 generation for that entry.

Keep status at `storyboard_ready` throughout. The UI also lets the user:
- Regenerate ref images in place (writes to `imageRefs[i].refImages`).
- Edit scene prompts directly via the SceneEditor side panel (writes to `scenes[i].prompt`).

Neither of those requires agent involvement. You only transition out when the UI writes `storyboard.approval` (Phase 6).

---

## Phase 6 — Scene generation (status: `storyboard_ready`, `storyboard.approval` is set)

### Entry point — how you get here

You are not file-watching. You enter Phase 6 because **the user tells you to** in chat. The typical message looks like:

> *"I approved the storyboard for project "X". Please proceed with scene generation per the ai-video skill Phase 6 contract."*

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

This makes approval idempotent. If the user tweaked scene 3 and hit Approve again, scenes 1/2/4/5 skip and only scene 3 regenerates — regardless of whether the original was single, chained, or batched. A scene re-generated out of a batched origin runs as a **single-shot call** and gets its own clip on `tracks[0]`; the original batched clip stays in place.

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

### Step C — compose the combined prompt at call time

For each scene (or shot, in batched mode):

- **Substitute `storyboard.styleAnchor` literally** at the start of the prompt, followed by the scene-specific prose. Write natural language — reference characters by their labels (e.g. "Rennie sits at the top", "Rosie waits below"). Do NOT manually insert `<<<image_N>>>` tokens.

- **The connector handles ref-image binding automatically.** When you pass `--ref-image` paths, the connector prepends a ref clause to the prompt:
  ```
  Use the character/style from <<<image_1>>>, <<<image_2>>>. <your prompt here>
  ```
  This tells Kling to faithfully reproduce the reference characters/styles. You do not need to (and should not) place `<<<image_N>>>` tokens yourself — the connector owns token generation and prompt prepending.

  **Concrete example.** Say `storyboard.styleAnchor` is `"Warm golden-hour lighting, soft film grain, handheld camera."` and `scene.refImages = [max_id, meadow_id]` resolves to paths `/refs/max.jpg` and `/refs/meadow.jpg`. The prompt you pass to `kling_generate --prompt` is:

  ```
  Warm golden-hour lighting, soft film grain, handheld camera. The dog runs across the meadow.
  ```

  And the CLI call is:

  ```
  kling_generate --prompt "<that string>" --ref-image /refs/max.jpg --ref-image /refs/meadow.jpg ...
  ```

  The connector will produce the final wire prompt:
  ```
  Use the character/style from <<<image_1>>>, <<<image_2>>>. Warm golden-hour lighting, soft film grain, handheld camera. The dog runs across the meadow.
  ```

- **Length caps (enforced by connector):**
  - **Single-shot: silently truncates at 2500 chars** (after ref clause prepend). The step prints a `prompt_truncated` warning on stderr — watch for it. Respect the cap when composing; don't rely on the truncation to land gracefully.
  - **Multi-shot customize: hard-rejects any `multi_prompt[i].prompt` > 512 chars.** Raises `ConnectorError`, step fails. Compose tighter per-shot prose.
  - **Multi-shot customize: omits the top-level `prompt` body field entirely** (per Kling's spec — `prompt` is invalid in that mode). Your per-shot strings in `multi_prompt[]` are what ship.

- Resolve `scene.refImages` IDs against `storyboard.imageRefs` (use `imageRefs[i].refImages[0]` as the primary path). Enforce the editorial cap of 3 refs per scene.

- Respect Kling's length cap: 2500 chars in single-shot, **512 chars per shot in multi-shot** (both after ref clause).

### Step D — call and write

#### Single-shot (independent or chained)

```
kling_generate \
  --prompt <combined> \
  --duration <scene.duration> \
  --aspect-ratio <storyboard.aspectRatio> \
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
    "model": "kling-v3-omni",
    "prompt": "<combined>",
    "refImages": ["<ref_id>", ...],
    "duration": <scene.duration>,
    "attempts": []
  }
}
```

The combined prompt stored on `generation.prompt` is the final wire-ready string — Plan 5's regenerate modal pre-fills from this.

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
    "model": "kling-v3-omni",
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

### Step E — wrap up

- **When every `storyboard.scenes[i]` has a matching clip** (by sceneId OR batchShots sceneId): set `project.status = "draft"`. The UI's EditorPage routing carries the user to ReviewView.
- **If some scenes failed:** leave status at `storyboard_ready`. The user sees partial progress (some cards "done," some showing error). They may re-click Approve (idempotency handles retry) or ask in chat for tweaks.

---

## Phase 7 — Draft phase (status: `draft`)

Treat the project like any other. Respond to timeline-editing requests.

Don't touch the `generation` block on `tracks[0]` clips unless explicitly asked ("regenerate scene 3 with a different prompt"). That block is a frozen snapshot of what produced the clip.

The UI's post-draft "Regenerate section" action (Plan 5) handles one-shot per-clip regens directly via `/api/steps/kling_generate` + boundary-frame extraction via `/api/steps/snapshot --at`. You don't need to serve that unless the user asks you specifically. When asked, mirror the UI's flow:

1. Extract boundary frames from the selected clip's `src` at its `inPoint` / `outPoint` via `snapshot --at <sec>`.
2. Call `kling_generate` with those frames as `--first-frame` / `--last-frame`.
3. Replace `src` on the clip, update `inPoint: 0`, `outPoint: <newDuration>`, `end = start + newDuration`.
4. Push the old `{ts, prompt, src}` to `generation.attempts[]`.

---

## Field path reference

One table of every field you write, grouped by phase.

| Field | When | What |
|-------|------|------|
| `project.storyboard.imageRefs[i].anchor` | pending | Clear text description the image generator / Kling can use. Written for both "upload" and "text" sources. |
| `project.storyboard.imageRefs[i].refImages` | pending | Append paths from `generate_image` calls. Leave untouched for `source: "upload"` entries. |
| `project.storyboard.imageRefs[i].status` | pending | Flip to `"ready"` when anchor + refImages are both set. |
| `project.storyboard.styleAnchor` | pending | One cohesive style-anchor string informed by styleRefs + prompt. |
| `project.storyboard.scenes[i].*` | pending | Per-scene editorial plan `{id, prompt, duration, refImages}`. User may edit `.prompt` directly via the UI. |
| `project.storyboard.scenes[i].lastError` | phase 6 | Optional per-scene error record. Clear on eventual success. For batched failures, stamp on every scene in the failed batch. |
| `project.tracks[0]` | phase 6 | **Append** real clips only. Never stubs, never empty-src items. |
| `project.tracks[0][i].generation.*` (single-shot) | phase 6 | Frozen snapshot: `{sceneId, provider, model, prompt, refImages, duration, attempts}`. |
| `project.tracks[0][i].generation.multiShot / shotType / batchShots` | phase 6, batched only | Batched clip metadata; `batchShots[]` carries per-scene mapping inside the concatenated output. |
| `project.tracks[0][i].generation.attempts` | post-draft regen (Plan 5) | Append previous `{ts, prompt, src}` before overwriting on regeneration. |
| `project.status` → `storyboard_ready` | end of Phase 1 | scenes[] populated, refs ready, styleAnchor written, `tracks[0]` still `[]`. |
| `project.status` → `draft` | end of Phase 6 | Only when every `storyboard.scenes[i]` has a matching clip (single-shot sceneId OR batchShots sceneId). |

---

## What NOT to do

- **Don't put `<<<image_N>>>` tokens in scene prompts OR in the composed prompt you pass to `kling_generate`.** Scene prompts are natural language with character labels. The connector auto-prepends a ref clause with the correct tokens when you pass `--ref-image` paths. Manually placing tokens leads to duplicate/conflicting bindings.
- **Don't generate scenes sequentially in independent mode.** Fire all `kling_generate` calls in parallel (up to 4 concurrent). Sequential one-at-a-time dispatch wastes minutes of wall-clock time — Kling handles concurrent requests fine.
- **Don't skip Phase 0.** If intake is thin or ambiguous, ASK before writing scenes. A wrong 8-scene storyboard costs more than one clarification turn.
- **Don't bombard the user with multiple questions at once.** One question per turn, wait for the answer.
- **Don't call `generate_image` on `imageRefs[i]` with `source: "upload"`.** You'd overwrite the user's file. Only text-sourced refs get image generation.
- **Don't fold `styleAnchor` into `generate_image` prompts.** Refs are identity-only; style is applied by Kling at scene generation.
- **Don't manually place `<<<image_N>>>` tokens in prompts.** The connector handles ref clause prepending automatically. Adding your own tokens creates duplicate bindings that confuse Kling.
- **Don't use multi-shot mode with `--first-frame` / `--last-frame`.** Kling doesn't support frame control in multi-shot. If you need frame continuity, use chained mode.
- **Don't exceed 512 chars per shot in multi-shot mode.** Single-shot's 2500-char budget does NOT apply per-shot. Fall back to independent mode for any scene that needs more prose.
- **Don't use `sceneId` on the outer `generation` block of a batched clip.** Use `batchShots[].sceneId`. The idempotency check in Step A branches on whether `batchShots` exists.
- **Don't set non-integer `scenes[i].duration`.** Kling's per-scene enum is integers (3–15 single-shot, 1–N multi-shot). Floats get silently clamped; apparent length drifts from your plan.
- **Don't silently overshoot/undershoot `targetDurationSeconds`.** If your allocation lands >10% or ≥3s off, mention it in chat so the user can confirm or redirect.
- **Don't treat `targetDurationSeconds` as per-scene.** It's a TOTAL budget. Target 30s with 6 scenes → 5s each, not 30s each.
- **Don't write `project.assets`.** That's the unrelated user-logo array.
- **Don't set `project.status` to `"draft"` until every `storyboard.scenes[i]` has a matching clip in `tracks[0]`.**
- **Don't put scenes on `tracks[0]` before they've been generated.** `tracks[0]` holds real clips only — no stubs, no empty-src items.
- **Don't append `aspectRatio` or `targetDurationSeconds` (or anything else) to `editingPrompt`.** Those fields live at `project.storyboard.*` as structured values. Pass `aspectRatio` directly to `kling_generate`; use `targetDurationSeconds` as input to your scene-count/duration decisions.
- **Don't call `kling_generate` before `storyboard.approval` is set.** Premature generation wastes credits.
- **Don't overwrite `storyboard.approval`.** The UI owns that field.
- **Don't mutate `tracks[0][i].generation` to "edit the scene".** That block is a frozen snapshot. To change editorial intent, edit `storyboard.scenes[i]`. To actually regenerate with new settings, use the Plan 5 regenerate-section flow.
- **Don't regenerate scenes that already have a clip** when the user re-approves. The skip-if-clip-exists check in Phase 6 Step A is mandatory — partial-approval retries depend on it.
- **Don't invent fields outside the schema.** If you need to store something, ask the user.
- **Don't touch `project.json` outside ai_video's documented paths** (e.g., don't add fields to `settings`).

---

## Mechanics vs editorial — one closing reminder

Everything here is **mechanics** — the contract Montaj and the UI are built against. Editorial choices (storyboard structure, scene count, character design, style-anchor voice, retry strategy, prompt craft for specific genres) come from whatever editorial sources you have: your general knowledge, the conversation with the user, user profiles, personal skills if any. If those sources conflict with this skill's field writes, status transitions, or tool-call shapes, the mechanics here win — the downstream UI and persisted project files depend on the invariants in this document.

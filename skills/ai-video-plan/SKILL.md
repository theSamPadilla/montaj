---
name: ai-video-plan
description: "Agent-authored director skill for the ai_video workflow: story clarification, storyboard writes, approval gate. Load this when you hit montaj/ai-video-plan in a workflow or encounter a project with projectType: 'ai_video'."
step: true
subskills: "camera-vocabulary"
---

# AI Video Director

You are the director for an `ai_video` project. The workflow file `workflows/ai_video.json` lists two skill steps: `plan` (this skill) and `generate` (`montaj/ai-video-generate`). You also orchestrate `analyze_style` (`montaj/analyze_media`) and `generate_ref` (`montaj/generate_image`); the engine doesn't auto-execute anything.

This skill covers **what to create** (story clarification, storyboard writes, approval gate) and **how to do it well** (prompt structure, camera vocabulary, character consistency). For **generation execution** (Phases 6-7: dispatch, clip writing, audio assembly, regenQueue), see `skills/ai-video-generate/SKILL.md`.

## Sub-skills

| Name | Path | When to load |
|------|------|--------------|
| `camera-vocabulary` | `skills/camera-vocabulary/SKILL.md` | Planning scenes in Phase 1 — shot scale + camera move selection |

---

## Status machine

```
pending → storyboard_ready → draft → final
```

| Transition | Writer | Precondition |
|------------|--------|--------------|
| `pending → storyboard_ready` | **you** (agent) | Phase 1 writes complete: imageRefs anchors+images filled, styleAnchor written, scenes[] populated. `tracks[0]` still `[]`. |
| `storyboard_ready → storyboard_ready` | **you** (agent) in review-phase | User asks for storyboard changes via chat. Mutate `project.json`; status stays `storyboard_ready`. |
| `(implicit, UI-driven)` | **UI** | User clicks Approve. UI writes `storyboard.approval = {approvedAt: <ISO8601>}`. Status stays `storyboard_ready` — the `ai-video-generate` skill observes the field and starts Phase 6. |
| `storyboard_ready → draft` | **ai-video-generate** | Every `storyboard.scenes[i]` has a matching clip in `tracks[0]` (either `generation.sceneId === scene.id` OR a `batchShots[]` entry for it). |
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

### Audio intake fields

Two optional fields in `storyboard` control audio generation:

- `storyboard.music` — `{ mode: 'upload', path }` or `{ mode: 'describe', prompt }`. Project-wide background music. Processed at Phase 6.
- `storyboard.voiceover` — `{ prompt }`. Project-wide narration track (TTS-generated from the prompt). Processed at Phase 6.

Both are project-wide, not per-scene. They never appear in `scenes[]`. If set, they modify how you write scene prompts at Phase 1 — see the "Dialogue rule" below.

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
- Your job: write `anchor` — a **detailed character/object spec** (60-120 words). This is appended verbatim to every Kling prompt that references this character as a `[LABEL] spec` block in the CHARACTER/OBJECT SPECS section, so specificity matters. Cover:
  - **(a) Overall:** age range, gender, species/type, build, size
  - **(b) Distinguishing features:** face shape, eye color, fur/skin color, markings, expression style
  - **(c) Clothing/surface:** every visible garment or surface detail — color, fabric, fit, condition
  - **(d) Accessories:** any props, gear, distinctive marks
  - **(e) Art style cues:** outline weight, color fill style, proportions

  Example for a corgi character: "A small playful corgi with short legs, a long body, tan and golden fur with a white chest and belly, a fluffy white-tipped tail that curls upward, small pointed ears with tan fronts and white backs, round dark eyes with a friendly alert expression, a small black nose, bold black outlines with flat solid color fills, slightly exaggerated cartoon proportions with an oversized head relative to body."

- If you can't discern enough detail from the image, call `analyze_media --input <path> --prompt "Describe this character in 60-120 words covering: overall appearance, distinguishing features, colors, clothing/surface details, accessories, and art style. Be specific enough that a video generator could reproduce this character consistently across multiple scenes."` and use the output as the anchor.
- **Do NOT call `generate_image`.** Never overwrite the user's uploaded image.

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

Populate `storyboard.scenes[]` with one entry per intended scene.

- **`id`** — stable within the project (e.g. `"scene-1"`, `"scene-2"`).
- **`prompt`** — structured using `## Section` headers. **NEVER include `<<<image_N>>>` tokens or `styleAnchor` text here.** Write natural language that names characters by their labels. Token substitution, style prepending, and section reordering happen at generation time — not at storyboard time.

  **Sections** (use these `##` headers):

  ```
  ## Camera
  Shot size + camera motion. One sentence. Kling needs framing context first.
  Example: "Wide shot, camera slowly pushes in."

  ## Subject
  Who/what is in the scene. Anchor identity here — name the character,
  describe their pose/position. This is the first thing Kling renders.
  Example: "Rennie sits at the top of the yellow slide, gripping the railings."

  ## Action
  What happens. EVERY sentence must have a motion verb — describe how
  things MOVE, not how they look. Sequential phrasing ("First... then...").
  BAD: "Rosie waits at the bottom." (static)
  GOOD: "Rosie wags her tail and tilts her head up." (motion)

  ## Dialogue
  Voice-tagged speech lines. Prefix each line with a voice tag:
  (gender, ~age, tone) Character says: "line"

  Example:
  (female, ~8yo, gentle nervous voice) Rennie says: "It looks high."
  (female, warm friendly dog voice) Rosie says: "I am right here."

  OMIT this section entirely if the scene has no dialogue. Do NOT include
  an empty ## Dialogue section — it wastes prompt budget and may cause
  Kling to generate gibberish audio trying to fill it.
  ```

  ### Dialogue rule (voiceover override)

  **If `storyboard.voiceover` is set, OMIT the `## Dialogue` section from EVERY scene prompt.** Kling-generated speech would compete with the TTS voiceover track. Ambient SFX (generated via `sound: "on"`) is fine and complements the narration.

  When `storyboard.voiceover` is NOT set, you MAY include `## Dialogue` in scene prompts as before.

  **Setting** is NOT a section — put environment details in `storyboard.styleAnchor` once. If a scene needs specific lighting, include it in `## Camera` (e.g. "Golden hour lighting, wide shot").

  **No two adjacent scenes should use the same shot-size + camera-move pair.** Vary the camera across scenes for visual variety (wide → medium → close-up → medium-wide → wide).

  The step parses `##` sections, reorders to optimal Kling sequence (Camera → Subject → Action → Dialogue), adds periods between sections, and flattens into flowing prose. The agent can write sections in any order — the step normalizes.

  **Keep each scene's prompt under ~80 words** (excluding headers). Kling's sweet spot is 60-100 words for the scene-specific content. The step adds ~10 words of style prefix on top.

  **Max 4-5 distinct nouns per scene.** Count every character, object, and named prop. If over 5, simplify or split into two scenes.

- **`duration`** — integer seconds. See "Duration budgeting" below for allocation.
- **`refImages`** — IDs into `storyboard.imageRefs[]` (NOT paths). Pick refs by matching natural-language mentions in the prompt. Hard cap of 7 refs per scene (Kling API limit).
- **`shotScale`** — one of the values from the camera-vocabulary sub-skill. Stored as structured data for planning and UI display.
- **`cameraMove`** — one of the values from the camera-vocabulary sub-skill. Stored as structured data for planning and UI display.

Scene count and pacing are your call — guided by the prompt structure and camera vocabulary sub-skills.

### Duration budgeting (how to reason about total video time)

The final video's length is the **sum of per-scene durations**. Kling generates each scene at exactly the `duration` you request; there is no post-hoc stretching or trimming. You are deciding both total length AND pacing.

Three interacting constraints:

1. **Per-scene duration depends on the model.** Two models are available:
   - **`kling-v3-omni`** (default) — `3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15` seconds. Supports multi-shot. Start+end frames in both std and pro modes.
   - **`kling-video-o1`** (newer, potentially higher quality) — **`5` or `10` only**. No multi-shot. End frame requires `--mode pro`.

   No floats (`8.5` will be rejected or silently clamped). In multi-shot mode (v3-omni only) the floor drops to `1`.

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
| 20 | 4 | `[5, 5, 5, 5]` | 20 |
| 30 | 4 | `[7, 8, 7, 8]` | 30 |
| 15 | 6 | impossible (min 3x6 = 18). Prefer 5 scenes at `[3,3,3,3,3]` = 15, OR tell user "closest is 18s at 6 scenes". |  |
| 90 | 6 | `[15, 15, 15, 15, 15, 15]` | 90 (max per-scene) |
| 120 | 6 | impossible (6 x 15 = 90 max). Must split: 8 scenes x 15 = 120. If >=7 scenes doesn't fit the story, tell the user. |  |

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

## Handoff to generation

After the user approves the storyboard (`storyboard.approval` is set), the workflow advances to the `ai-video-generate` step. Load `skills/ai-video-generate/SKILL.md` for Phase 6+ execution.

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
| `project.status` → `storyboard_ready` | end of Phase 1 | scenes[] populated, refs ready, styleAnchor written, `tracks[0]` still `[]`. |

---

## What NOT to do

- **Don't put `<<<image_N>>>` tokens in `storyboard.scenes[i].prompt`.** Scene prompts are natural language with character labels. Token placement happens at composition time in Phase 6 Step C, where you map `refImages` IDs to positional `--ref-image` args and insert tokens inline at the matching nouns.
- **Don't skip Phase 0.** If intake is thin or ambiguous, ASK before writing scenes. A wrong 8-scene storyboard costs more than one clarification turn.
- **Don't bombard the user with multiple questions at once.** One question per turn, wait for the answer.
- **Don't call `generate_image` on `imageRefs[i]` with `source: "upload"`.** You'd overwrite the user's file. Only text-sourced refs get image generation.
- **Don't fold `styleAnchor` into `generate_image` prompts.** Refs are identity-only; style is applied by Kling at scene generation.
- **Don't write `<<<image_N>>>` tokens into `storyboard.scenes[i].prompt` or `generation.prompt` (the stored prompt).** These fields hold natural language only. Tokens and the ref clause are composed at call time (Phase 6 Step C / Phase 7 step 3) and passed directly to `kling_generate --prompt` — they are NOT persisted. The connector is a pure pass-through; it does not add tokens.
- **Don't silently overshoot/undershoot `targetDurationSeconds`.** If your allocation lands >10% or >=3s off, mention it in chat so the user can confirm or redirect.
- **Don't treat `targetDurationSeconds` as per-scene.** It's a TOTAL budget. Target 30s with 6 scenes → 5s each, not 30s each.
- **Don't write `project.assets`.** That's the unrelated user-logo array.
- **Don't append `aspectRatio` or `targetDurationSeconds` (or anything else) to `editingPrompt`.** Those fields live at `project.storyboard.*` as structured values. Pass `aspectRatio` directly to `kling_generate`; use `targetDurationSeconds` as input to your scene-count/duration decisions.
- **Don't call `kling_generate` before `storyboard.approval` is set.** Premature generation wastes credits.
- **Don't invent fields outside the schema.** If you need to store something, ask the user.
- **Don't touch `project.json` outside ai_video's documented paths** (e.g., don't add fields to `settings`).

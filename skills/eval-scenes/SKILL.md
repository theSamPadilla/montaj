---
name: eval-scenes
description: "Quality evaluation rubric + retry loop for ai_video generated clips. Load after generating scenes in Phase 6 to evaluate and optionally regenerate clips that fail quality checks."
step: true
---

# Eval Scenes

Evaluate generated scene clips against a 5-dimension quality rubric using Gemini. If a clip fails, regenerate it via `kling_generate` (non-deterministic re-roll with the same composed prompt) and re-evaluate. Repeat up to a retry budget.

This is **Step F** of the ai-video Phase 6 contract — optional but recommended.

## When to load

After all scenes have clips on `tracks[0]` (Phase 6 Step E complete). The agent runs this loop before setting `status: "draft"`, or after draft if the user requests quality review.

## The rubric

Evaluate each clip on 9 dimensions, scored 1-5. **Pass/fail thresholds vary by dimension** — some are strict (must be >= 4), others are advisory (noted but not gates).

**Gate dimensions (must ALL be >= 4 to pass):**

| Dimension | What to check | Automatic FAIL (score 1-2) |
|-----------|--------------|---------------------------|
| **CHARACTER_MATCH** | Characters match ref images: correct species, colors, proportions, clothing. Specs describe IDENTITY not pose — do not penalize expression/pose differences from the spec. | Wrong species, wrong colors, character morphs into something else |
| **SCALE** | Characters and objects are proportionally correct relative to each other and the environment. A dog should be small relative to a human. A slide should be taller than characters. | Dog is bigger than the slide. Character is tiny next to a normal-sized object. |
| **PHYSICS** | Gravity, shadows, reflections, momentum are plausible. Characters stand ON surfaces, not inside them. | Character walking inside a slide. Floating objects. Clipping through surfaces. |
| **ANATOMY** | Correct limbs, stable faces, no morphing. No duplicate characters unless the prompt asks for multiples. | Extra fingers, melting faces, **two copies of the same character** |
| **ACTION_INTENT** | Is the character doing the *right kind of thing*? Sitting when should be sitting, celebrating when should be celebrating, sliding when should be sliding. Focus on narrative intent, not exact choreography. | Character doing the opposite of what was described. Sliding when should be still. Happy when should be scared. |
| **COHERENCE** | The scene makes narrative sense given the prompt. | Scene contradicts the prompt's narrative intent. |
| **AUDIO** | If the prompt has dialogue, the clip must have audible speech. Silent clips with dialogue = fail. | No audio track. Completely silent when dialogue was prompted. Unintelligible gibberish. |
| **STANDALONE** | Readable in isolation — subject clear, action clear, composition legible. | Can't tell what's happening. Cluttered mess. |

**Advisory dimensions (scored but NOT gates — low scores are feedback for prompt improvement):**

| Dimension | What to check | Notes |
|-----------|--------------|-------|
| **ACTION_PRECISION** | Does the exact choreography match the prompt? Jumping vs running, spinning vs shifting weight, trembling vs smiling. | Kling doesn't execute precise choreography from text. Score 1-2 if completely wrong motion, 3 if approximate, 4-5 if exact. Low score = suggest prompt simplification, NOT a fail. |

## The evaluation prompt

Call `analyze_media` with the clip and this prompt template. Substitute `{prompt}` and `{specs}` before sending.

```
analyze_media \
  --input <clip_path> \
  --json-output \
  --prompt '<the rubric prompt below>'
```

**Rubric prompt:**

```
You are a strict quality inspector for AI-generated video clips. Be harsh but fair.

Score each dimension 1-5. There are GATE dimensions (must be >= 4 to pass) and ADVISORY dimensions (scored but do not cause failure).

## Gate Dimensions (ALL must be >= 4 to pass)

1. CHARACTER_MATCH — Do characters match their reference images? Correct species, colors, proportions, clothing. Character specs describe IDENTITY (species, colors, features) not POSE or EXPRESSION — do NOT penalize if pose or expression differs from the spec. A corgi described as "friendly" can look worried if the scene calls for it. Score 1-2 if wrong species or wrong colors. Score 4-5 if identity is faithful.

2. SCALE — Proportionally correct? Dog small relative to person. Slide taller than characters. Score 1-2 if giant dog or tiny person.

3. PHYSICS — Characters on surfaces, not inside them. No clipping. Score 1-2 if clipping or floating.

4. ANATOMY — Correct body parts, no morphing, NO DUPLICATE CHARACTERS. Two copies = automatic 1.

5. ACTION_INTENT — Is the character doing the RIGHT KIND of thing? Sitting when should sit, celebrating when should celebrate, sliding when should slide. Focus on narrative intent, NOT exact choreography. "Running excitedly" and "jumping excitedly" are both valid for "excited dog." Score 1-2 only if the character does the OPPOSITE of what was described.

6. COHERENCE — Scene makes narrative sense? Score 1-2 if contradicts prompt.

7. AUDIO — If dialogue in prompt, audible speech present? Silent = 1. Gibberish = 2. No dialogue in prompt = 5.

8. STANDALONE — Readable? Clear subject, action. Score 1-2 if visual mess.

## Advisory Dimension (scored but does NOT gate pass/fail)

9. ACTION_PRECISION — Does the EXACT choreography match? Jumping vs running, spinning vs shifting, trembling vs smiling. Score independently. Low score = feedback for prompt simplification, NOT a failure.

## Response format

Return ONLY valid JSON:
{"pass": true, "scores": {"character_match": 4, "scale": 4, "physics": 4, "anatomy": 4, "action_intent": 4, "coherence": 4, "audio": 4, "standalone": 4, "action_precision": 3}, "suggestions": ["specific issue"]}

A clip FAILS if ANY gate dimension (1-8) is below 4. action_precision (9) does NOT affect pass/fail.

## Context

Prompt used: {prompt}

**Character specs:**
{specs}

Now evaluate the video clip.
```

**Building `{specs}`:** For each ref in `scene.refImages`, look up `imageRefs[i].anchor` and format as `[Label] anchor text`. If no anchors exist, use `(no character specs)`.

**Building `{prompt}`:** Re-compose from `scene.prompt` via `compose_prompt(project, scene)` — NOT from `generation.prompt` (which stores the pre-composition natural language version).

## The eval loop

```
for each scene that has a clip on tracks[0]:
  1. Read clip.src from tracks[0]
  2. Build eval prompt (rubric + composed prompt + character specs)
  3. Call: analyze_media --input <clip.src> --json-output --prompt <eval_prompt>
  4. Parse the JSON verdict

  IF pass:
    → Record on clip: generation.eval = {pass: true, scores: {...}, attempt: 1}
    → Save project. Move to next scene.

  IF fail AND retries left:
    → Push current clip to generation.attempts[]:
      {ts, prompt, src: <current_path>, eval: <verdict>}
    → Generate versioned output path: scene-1-v2.mp4, scene-1-v3.mp4, etc.
    → Call: kling_generate --project-id <id> --scene-id <scene.id> --out <versioned_path>
      (The step re-composes the prompt and handles the project write.)
    → Re-evaluate the new clip. Loop.

  IF fail AND no retries left:
    → Record on clip: generation.eval = {pass: false, scores: {...}, attempt: N}
    → Save project. Move to next scene. Tell the user which scenes failed.
```

## Retry budget

Default: **2 retries** (3 total attempts per scene: 1 initial + 2 re-rolls).

Each retry is a non-deterministic re-roll — same prompt, same refs, Kling just generates a different result. The eval loop does NOT revise prompts. If the same prompt consistently fails, the issue is editorial (bad prompt) not luck — tell the user and suggest prompt changes.

**Cost per scene:** 1-3 Gemini calls (eval) + 0-2 Kling calls (regen). Budget accordingly.

## Recording results

On the clip's `generation` block:

```json
{
  "eval": {
    "pass": true,
    "scores": {"character_match": 4, "physics": 3, "anatomy": 4, "action": 5, "standalone": 4},
    "attempt": 1
  },
  "attempts": [
    {
      "ts": "2026-04-21T...",
      "prompt": "...",
      "src": "/path/scene-1.mp4",
      "eval": {"pass": false, "scores": {...}, "suggestions": [...]}
    }
  ]
}
```

Previous attempts preserve the old `src` path (versioned files are never overwritten) and their eval verdicts. The current clip's `src` points to the latest (passing or best-effort) version.

## What NOT to do

- **Don't revise prompts in the eval loop.** Re-roll only. Prompt revision is an agent editorial decision, not a mechanical retry. If repeated re-rolls fail, tell the user.
- **Don't overwrite clip files.** Use versioned paths (`-v2.mp4`, `-v3.mp4`). Previous versions must be recoverable from `generation.attempts[].src`.
- **Don't eval before generation.** The clip must exist on `tracks[0]` first.
- **Don't eval every project.** This is optional. Skip if the user is happy, iterating manually, or cost-sensitive.
- **Don't run evals in parallel for the same project.** Sequential avoids project.json write races.
- **Don't use `generation.prompt` for the eval context.** Re-compose from `scene.prompt` via `compose_prompt()` — that's the wire-ready version with tokens and specs.

## Latency notes

Each `analyze_media` call on a video file uses Gemini's Files API upload path: 5-15s upload + generation time. Budget ~20-30s per eval call. With 2 retries, worst case is ~3 evals + 2 Kling generations per scene (~6-7 minutes). For a 9-scene project, full eval with retries could take 30-60 minutes.

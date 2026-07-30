---
name: broll
description: "Agent-authored workflow task: segment the cleaned voiceover into script beats, index the footage library from contact sheets, assign shots to beats, and write the draft. Load this when you hit montaj/broll in a workflow."
step: true
---

# B-Roll

`montaj/broll` is an agent-authored task — no CLI step drives the editorial decisions. The pipeline before you has cleaned the voiceover and indexed the footage mechanically; what remains is judgement, and it only shows up when a human watches the output.

**The cadence, cut-placement, and pacing numbers in this skill are measured, not intuited.** See `REFERENCE.md` (alongside this file) for the measurements they come from — shot tables, cadence statistics, cut-placement deviations, and the pacing-inversion finding, derived from four reference videos. Do not substitute your own estimates.

The handful of rules that are *not* measured are labelled inline as design rules. Anything not so labelled traces to REFERENCE.md; if you extend this skill, keep that distinction — an invented anecdote presented as evidence is worse than no anecdote.

## Core Purpose

**The narration is the spine. Footage illustrates what is being said.**

By the time you load this skill, `vo_materialize` has produced a cleaned voiceover audio file and `vo_transcribe` has word-level timings for it. `detect_shots` and `shot_sheet` have broken every clip in the library into shots and tiled sample frames into contact sheets. Your job is to read the script, read the footage, marry them, and write `project.json`.

The voiceover contributes **audio only**. Do not place `project.voiceover.src` on any visual track unless the editing prompt explicitly asks for the speaker's picture.

## Process

### 1. Build the footage index

Read every `shot_sheet` output. For each sheet, **look at the image** and write one index entry per shot, using the sheet's `tiles` map to know which tile belongs to which shot. Never guess a tile's shot from its position alone — `frames-per-shot` is 3 by default, so tiles and shots are not 1:1.

If `shot_sheet` was run outside the workflow, note that its `shots` and `out-dir` params are required and per-clip: `shots` is that clip's `detect_shots` JSON, `out-dir` is where the sheet images go. The workflow cannot declare them statically.

One entry per shot:

```json
{ "clip": "<abs path>", "shot_index": 5, "start": 7.38, "end": 8.75, "duration": 1.37,
  "subject": "trailhead sign", "tags": ["sign","text","landmark"],
  "framing": "medium", "camera": "static", "action": "none",
  "motion_mean": 0.0053, "motion_peak": 0.1288,
  "quality": "good", "notes": "readable trail name" }
```

Rules:

- `motion_mean` and `motion_peak` come from `detect_shots`. **Copy them, do not re-estimate.**
- A low mean with a high peak means a locked frame in which something happens — the camera is still but the subject is not. **Never label such a shot "static and empty."** (Design rule, not a reference-set measurement: `motion_mean` / `motion_peak` postdate REFERENCE.md and have no counterpart in it. Treat it as a heuristic to sanity-check, not as evidence.)
- Every image in `project.assets` is also an index entry, with `duration: null` (free-floating, stretchable to any length) and `camera: "still"`. Assets are first-class B-roll: in the reference set a map screenshot is the longest non-hero shot in the video.
- Write the finished index to `broll_index.json` in the project workspace. It does **not** go in `project.json`.
- If the library is large enough that reading every sheet is impractical, `montaj analyze-media` may fill `subject` / `tags` / `action` in bulk — but it is an accelerator, never a requirement. State in the coverage report when it was used.

### 2. Segment the script into beats

Read the `vo_transcribe` word timings for the **cleaned** voiceover — not the original. The workflow runs `transcribe` twice: `vo_script` is the pre-cut pass that `select-takes` reads, and its timings do not survive the cut. Use `vo_transcribe`. A beat is a contiguous span of narration with one visual subject. The boundary is where the subject changes, which is usually but not always a sentence boundary.

```json
{ "index": 4, "start": 4.28, "end": 7.38, "text": "a little under four miles round trip",
  "subject": "trail length", "need": "LITERAL", "protected": false }
```

`need` is one of:

- **`LITERAL`** — the narration names a concrete thing that exists in the footage. Strongly prefer an exact match; a sign that reads the named words beats a pretty shot of the same place. In the reference set the mapping is almost embarrassingly literal: "the trailhead starts along the San Gabriel River Trail" gets the actual trailhead sign.
- **`ILLUSTRATIVE`** — shows the concept rather than the named noun.
- **`ATMOSPHERIC`** — establishes mood or place; the specific words don't constrain the choice.

### 3. Mark protected beats

Before assigning anything, decide whether any beat is the **emotional peak** — a proposal, a reveal, a reaction, a punchline landing. Mark **at most two** `protected: true`.

A protected beat gets **one unbroken shot** for its whole span, and **every shot-length limit in step 4 is suspended for it.**

This is not a corner case. In the reference set, the longest video holds a single locked-off tripod shot for **12.90 seconds** inside an edit whose median shot is 1.0 second — a 13× pacing inversion at the emotional peak. Cutting that moment into length-compliant pieces would have destroyed the video.

**When in doubt, protect nothing.** A wrongly protected beat is a slow patch; a wrongly cut peak is a ruined video.

### 4. Assign shots to beats

Target numbers. Measured rows come from the four references; the two derived rows are marked.

| quantity | value | |
|---|---|---|
| target shot length | 1.2–1.5s | derived — brackets the measured 1.4s mean |
| median across references | 1.1s | measured |
| hard minimum | 0.5s | measured |
| soft maximum during narration | 3.1s | measured |
| protected beats | no maximum | derived — follows from step 3 |

The median holds across VO-driven and music-driven references and across 9s and 67s runtimes. It is the single most reproducible number in the reference set.

Rules:

- **Shot length is a consequence, not a parameter.** It falls out of how long the narration spends on the subject.
- A beat longer than the soft maximum is filled with **multiple shots of the same subject**, not one long hold. The references show a waterfall across three angles for one 2.5s clause. Only fall back to a longer single hold when the index has no second angle.
- A beat that needs the viewer to **read** something — a map, a sign, a screen — gets the long end of the range. The longest non-hero shot in the reference set is 3.10s on a map.
- **No shot may repeat within 12 seconds of its previous use.** Recurring connective footage (driving, walking) is fine spaced out; back-to-back reuse reads as running out of material. (Design rule — the 12s figure is not measured. REFERENCE.md records only that driving shots recur 4× as connective tissue, with no interval given.)
- **Assign globally, not beat-by-beat greedily.** The only shot that fits beat 7 may also be the best for beat 3. Resolve the whole assignment before committing.
- **Open on texture or action, not exposition.** The reference hook is 1.6s of an extreme close-up of moving creek water, with no informational content at all.
- Faces bookend. In the reference set the creator's face appears at the second shot and the last shot, and nowhere else.

### 5. Place cuts on word onsets

Candidate cut points are word start times from the cleaned transcript. Snap each cut to the nearest word **onset** — not to the silence between words.

Measured across the two voiceover references, cuts sit within ~50ms of a word boundary (median deviation 0.030s and 0.057s), and the majority land slightly **inside** the word. The visual arrives with the emphasis. **Never cut in the middle of a silence.**

Every cut is a hard cut. No crossfades, no speed ramps, no whip pans — none appear anywhere in the reference set.

### 6. Reframe horizontal sources

For any clip whose `sourceWidth / sourceHeight` exceeds 9:16, set `sourceCrop` on its `tracks[0]` item using the deterministic centred math from `skills/find_clips/SKILL.md` step 4:

```
source_ar = source_width / source_height
w = (9/16) / source_ar
h = 1.0
x = (1 - w) / 2
y = 0.0
```

`sourceCrop` is `{x, y, w, h}` — normalized fractions in `[0, 1]`, all four keys required when present. This math is deterministic; do not estimate or eyeball it.

Also write `sourceWidth` and `sourceHeight` on the same item, from `probe`. **Without them the crop silently no-ops at render time.** Never letterbox.

### 7. Emit the project

- **`tracks[0]`** — every assigned shot, in timeline order. Each item carries `start` / `end` on the output timeline, `inPoint` / `outPoint` into its source, `muted: true`, and `sourceCrop` (+ `sourceWidth` / `sourceHeight`) where reframed. **Gaps are not permitted** — the timeline must be continuous from 0 to the voiceover's duration.
- **`audio.tracks[0]`** — the cleaned voiceover from `vo_materialize`, `volume: 1.0`.
- **`project.voiceover.cleanedSrc`** — the cleaned file's path. Leave `project.voiceover.src` pointing at the original.
- Do **not** put `project.voiceover.src` on any visual track unless the editing prompt explicitly asks for the speaker's picture.
- Set `status: "draft"`.

Source-clip audio is muted throughout. The bed is the voiceover, plus music if the prompt asks for it.

**Leave `tracks[1+]` alone.** `montaj/overlay` runs after you and owns the overlay tracks.

### 8. Write the coverage report

Write `broll_coverage.md` in the workspace and summarise it in your final message. One row per beat:

| beat | span | subject | shot chosen | confidence |
|---|---|---|---|---|
| 4 | 4.28–7.38 | trail length | `hike.mov` shot 12 (map) | good |

Confidence is `good` / `weak` / `filler`. Every beat that got an atmospheric fill instead of a real match is `filler` and must be listed explicitly.

**Never leave a gap in the timeline to signal a bad match.** Fill it and report it.

## What to Log

- Number of clips indexed, shots indexed, and assets folded into the index.
- Whether `montaj analyze-media` was used to bulk-fill the index.
- Beat count, and which beats (if any) were marked `protected` and why.
- Median and mean assigned shot length, so drift from the 1.1s / 1.4s reference is visible.
- Every `filler` beat.

## Common Mistakes

- **Putting the voiceover on a visual track.** It is audio only. This is the single most common way to get a talking-head video when the user asked for B-roll.
- **Forgetting `muted: true`** on `tracks[0]` items — source audio then fights the narration.
- **Setting `sourceCrop` without `sourceWidth` / `sourceHeight`** — the crop silently no-ops and the render letterboxes.
- **Enforcing the 3.1s soft maximum on a protected beat.** This is the failure the reference set exists to prevent.
- **Re-estimating `motion_mean` / `motion_peak`** instead of copying them from `detect_shots`.
- **Cutting in the silence between words** instead of on the word onset.
- **Writing overlays.** `montaj/overlay` runs after you and owns `tracks[1+]`. Emit footage and audio only.
- **Leaving a gap in the timeline** to signal a weak match. Fill it, mark it `filler` in the coverage report.
- **Guessing a tile's shot from its position** on the contact sheet instead of reading the `tiles` map.

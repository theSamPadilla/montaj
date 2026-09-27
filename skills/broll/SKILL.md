---
name: broll
description: "Agent-authored workflow task: segment the cleaned voiceover into script beats, index the footage library from contact sheets, assign shots to beats, and write the draft. Load this when you hit montaj/broll in a workflow."
step: true
---

# B-Roll

`montaj/broll` is an agent-authored task — no CLI step drives the editorial decisions. The pipeline before you has cleaned the voiceover and indexed the footage mechanically; what remains is judgement, and it only shows up when a human watches the output.

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
- A low mean with a high peak means a locked frame in which something happens — the camera is still but the subject is not. **Never label such a shot "static and empty."**
- Every image in `project.assets` is also an index entry, with `duration: null` (free-floating, stretchable to any length) and `camera: "still"`.
- Write the finished index to `broll_index.json` in the project workspace. It does **not** go in `project.json`.
- If the library is large enough that reading every sheet is impractical, `montaj analyze-media` may fill `subject` / `tags` / `action` in bulk — but it is an accelerator, never a requirement. State in the coverage report when it was used.

### 2. Segment the script into beats

Read the `vo_transcribe` word timings for the **cleaned** voiceover — not the original. The workflow runs `transcribe` twice: `vo_script` is the pre-cut pass that `select-takes` reads, and its timings do not survive the cut. Use `vo_transcribe`. A beat is a contiguous span of narration with one visual subject. The boundary is where the subject changes, which is usually but not always a sentence boundary.

```json
{ "index": 4, "start": 4.28, "end": 7.38, "text": "a little under four miles round trip",
  "subject": "trail length", "need": "LITERAL", "protected": false }
```

`need` is one of:

- **`LITERAL`** — the narration names a concrete thing that exists in the footage.
- **`ILLUSTRATIVE`** — shows the concept rather than the named noun.
- **`ATMOSPHERIC`** — establishes mood or place; the specific words don't constrain the choice.

### 3. Mark protected beats

Before assigning anything, decide whether any beat is the **emotional peak** — a proposal, a reveal, a reaction, a punchline landing. Mark **at most two** `protected: true`.

A protected beat gets **one unbroken shot** for its whole span, and **no shot-length limit applies to it.**

### 4. Assign shots to beats

Assign a shot from the index, or several shots of the same subject, to every beat. A protected beat gets one unbroken shot (step 3).

### 5. Place cuts on word onsets

Candidate cut points are word start times from the cleaned transcript. Snap each cut to the nearest word **onset** — not to the silence between words.

### 6. Reframe to the project canvas

For each distinct source video behind `tracks[0].items`, call the `reframe` step once and write the returned fields verbatim onto every item cut from that source:

```bash
montaj step reframe --input <source_video> --target 9:16
```

`--target` should match the project canvas (`settings.resolution`) — 9:16 for a vertical edit. The step returns `{sourceCrop, sourceWidth, sourceHeight, source}`. Write `sourceCrop`, `sourceWidth`, and `sourceHeight` onto the item exactly as returned — a `null` `sourceCrop` means write no `sourceCrop` at all, but still write `sourceWidth`/`sourceHeight`. The `source` field is diagnostics only; never write it onto the item. Call it once per source file, not once per shot — every shot cut from the same source gets the same crop.

**Rotated iPhone footage codes as landscape (e.g. 1920x1080) but displays portrait.** Never decide orientation from the probe's coded `width`/`height` — a clip whose DISPLAY aspect is already at or narrower than the target gets no crop at all. The `reframe` step reads the rotation tag for you; that is the entire reason to call it instead of doing the arithmetic.

`sourceCrop` is `{x, y, w, h}` — normalized fractions in `[0, 1]`, all four keys required when present. **Without `sourceWidth`/`sourceHeight` the crop silently no-ops at render time.** Never letterbox.

### 7. Emit the project

- **`tracks[0]` itself carries `muted: true`.** The narration is the point of a b-roll edit; source audio underneath it is noise. Silence the **track**, not each clip: set `"muted": true` on the `tracks[0]` track object, and do **not** write `muted` on the individual items.

  Both work — render and preview both compute `muted = track.muted === true || item.muted === true` (`montaj_assets/render/project-tracks.js:260`, mirrored in `timeline-model.ts:612`) — but the track flag is the one to use, for three reasons. It is a single field instead of one per clip. It is what the track rail's mute button reads and writes, so the operator can audition the source audio with one click instead of editing every item. And it applies to clips added later, whereas per-item flags leave any newly dropped clip audible by default. Setting both is the worst option: un-muting the track then does nothing, because the item flags still force silence, and the rail button appears broken.

- **`tracks[0].items`** — every assigned shot, in timeline order. Each item carries `start` / `end` on the output timeline, `inPoint` / `outPoint` into its source, `proxySrc` **carried over from the source entry it came from** (see below), and `sourceCrop` (+ `sourceWidth` / `sourceHeight`) where reframed. **Gaps are not permitted** — the timeline must be continuous from 0 to the voiceover's duration.

  **Carrying `proxySrc` is mandatory, not cosmetic.** You are building these items from scratch out of `project.sources`, and every field you do not copy is silently lost. `project/init.py` already encoded one editing proxy per source and recorded it on the matching `sources` entry — look up each item's `src` in `project.sources` and copy that entry's `proxySrc` onto the item verbatim. One proxy covers the whole source file and is never windowed, so the SAME `proxySrc` is correct for every shot you cut from that source, whatever its `inPoint`/`outPoint`. Do not recompute the path, do not encode anything, and do not omit it when a source happens to have no `proxySrc` (leave the field off only in that case).

  Dropping it does three things, none of them obvious from the editor: the preview falls back to decoding the full-resolution master (on 4K HDR footage that is roughly 700ms per seek instead of ~50ms, so scrubbing feels broken), the WebCodecs engine refuses the project outright because `engine/eligibility.ts` requires `proxySrc` on every track-0 item, and the header shows a "Generate previews" chip telling the operator their clips have no editing previews. Nothing repairs this on its own — the project-open look migration only re-points a `proxySrc` that is present and stale, and skips an item that has none.
- **`audio.tracks`** — the cleaned voiceover, emitted as **one track per recorded take, never a single consolidated track.**

  **This is a standing directive, not a preference.** The operator edits the narration section by section: re-timing one sentence, nudging a pause, muting a beat, replacing a take. A single 36-second track makes every one of those a destructive waveform edit. Seven tracks make them a drag. Consolidating is the easier thing to write and the wrong thing to ship — do not do it.

  Write every take as its own track, in script order, laid **contiguously on `lane: 0`** so the narration plays as one unbroken read: each track's `start` equals the previous track's `end`, the first starts at `0`, and the last ends exactly where `tracks[0]`'s final item ends. Order is script order — `project.voiceover.takes` records it, and that array is the source of truth for both order and count.

  Per track write **six** fields: `id` (e.g. `"vo-01"`), `src`, `label` (a short human name for the section, e.g. `"Hook"`, `"The command"`, `"CTA"` — this is what the operator reads on the timeline), `volume: 1.0`, `start`, and `end`.

  **Deriving the per-take files.** `vo_materialize` produces one cleaned file for the whole narration. Do not re-materialize each take from its original — that re-runs the trim decisions per file and the pieces will not sum back to the whole. Instead **split the already-cleaned file** at take boundaries: map each keep in the `vo_fillers` spec onto the take whose span in the concatenated source contains it (cumulative raw take durations give those spans), sum each take's kept durations to get its cleaned length, and cut the cleaned file at the running totals. Splitting PCM is lossless and exact, so the pieces sum to the original to the millisecond and the narration cannot drift against the visual cuts. Verify that sum before writing the tracks; if it does not match, stop and say so rather than shipping drift. Confirm too that no keep straddles a take boundary — one that does means the takes were joined without a pause between them and the split point needs a human decision.

  **`start` and `end` are required in practice even though the schema calls `start` optional.** The timeline draws an audio lane from `timeToX(track.start)` to `timeToX(track.end)` (`montaj_assets/editor/src/video/timeline/canvas/draw.ts`, `drawAudioItem`). Omit them and both compute to `NaN`, so the bar is invisible: the lane row still appears (lane assignment tolerates the gap), but it renders permanently empty and the voiceover looks like it never landed. The audio still *plays*, because preview filters only on `!muted && src` — so this fails in the one direction that is hardest to notice, looking broken while sounding fine. `id` matters too: the timeline keys tracks by it for selection and crossfade.

  **Single-take projects** get exactly one track, same six fields. The rule is "one track per take", not "always split" — do not carve a single continuous read into invented sections.
- **`project.voiceover.cleanedSrc`** — the cleaned file's path. Leave `project.voiceover.src` pointing at the original.
- Do **not** put `project.voiceover.src` on any visual track unless the editing prompt explicitly asks for the speaker's picture.
- Set `status: "draft"`.

Source-clip audio is muted throughout, via the track flag above. The bed is the voiceover, plus music if the prompt asks for it. If a specific moment genuinely wants its source audio through — a bark on a punchline, a real reaction — do not un-mute the track for it; say so in the coverage report and let the operator make that call on the one clip.

**Leave `tracks[1+]` alone.** `montaj/overlay` runs after you and owns the overlay tracks.

**Validate before you finish.** Run `montaj validate project <workspace>/project.json` and fix anything it reports. This is the only check that catches a reframe computed against the wrong dimensions: a `sourceCrop` whose `sourceWidth`/`sourceHeight` disagree with what the source actually displays fails here, with the exact correction to make. Nothing downstream will tell you. The crop is in range, the render succeeds, and the defect only surfaces as a stretched clip in the finished video.

### 8. Write the coverage report

Write `broll_coverage.md` in the workspace and summarise it in your final message. One row per beat:

| beat | span | subject | shot chosen | confidence |
|---|---|---|---|---|
| 4 | 4.28–7.38 | trail length | `hike.mov` shot 12 (map) | good |

Confidence is `good` / `weak` / `filler`. Every beat that got an atmospheric fill instead of a real match is `filler` and must be listed explicitly.

**Never leave a gap in the timeline to signal a bad match.** Fill it and report it.

**List the footage you did not use, without apologising for it.** A short "unused" section naming each skipped clip and the one-line reason — wrong subject, weaker angle on a beat that was already covered, redundant with a stronger take, technically poor — is useful to the operator, who may disagree about a particular clip and can then say so. It is a record of decisions, not a list of failures, and an edit that leaves most of the library on the floor is normal. Do not pad the edit to shrink this section.

## What to Log

- Number of clips indexed, shots indexed, and assets folded into the index.
- Whether `montaj analyze-media` was used to bulk-fill the index.
- Beat count, and which beats (if any) were marked `protected` and why.
- Median and mean assigned shot length, plus the **min and max**, so both the overall pace and the amount of variation are visible. A spread that is nearly flat is a finding worth reporting even when the median looks right.
- Every `filler` beat.
- How many clips the edit used out of how many were available, plainly (e.g. "9 of 31 clips used"). A low ratio is information, not an alarm.

## Common Mistakes

- **Putting the voiceover on a visual track.** It is audio only. This is the single most common way to get a talking-head video when the user asked for B-roll.
- **Leaving `tracks[0]` unmuted**, so source audio fights the narration. Mute the **track** (`tracks[0].muted = true`), not the items — and never both, which makes the rail's mute button look broken.
- **Dropping `proxySrc` when building `tracks[0]` items.** The proxies already exist; they are recorded on `project.sources`, not on the items you are creating, so they vanish unless you copy them across. The edit looks correct and validates fine — the damage shows up as sluggish scrubbing, a disabled WebCodecs engine, and a "Generate previews" chip in the header. Copy `proxySrc` from the matching `sources` entry by `src`.
- **Consolidating the voiceover into one audio track.** It is the shorter path and it takes the operator's section-by-section edits away. One track per take, contiguous on lane 0 — see step 7.
- **Setting `sourceCrop` without `sourceWidth` / `sourceHeight`** — the crop silently no-ops and the render letterboxes.
- **Deciding orientation from the probe's coded `width`/`height`, or hand-computing the crop instead of calling `reframe`.** A rotated iPhone clip codes 1920x1080 but displays 1080x1920; cropping off the coded aspect crops footage that was already vertical into a sliver a few hundred pixels wide, which the renderer then stretches to fill the frame.
- **Re-estimating `motion_mean` / `motion_peak`** instead of copying them from `detect_shots`.
- **Cutting in the silence between words** instead of on the word onset.
- **Writing overlays.** `montaj/overlay` runs after you and owns `tracks[1+]`. Emit footage and audio only.
- **Leaving a gap in the timeline** to signal a weak match. Fill it, mark it `filler` in the coverage report.
- **Guessing a tile's shot from its position** on the contact sheet instead of reading the `tiles` map.

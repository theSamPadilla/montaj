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
- **Lean away from reusing a shot.** Repeats read as running out of material, so reach for a fresh shot first and let each one appear once where the library allows it. This is guidance, not a prohibition — reuse is available when it genuinely serves the edit. (Design rule. The reference set actually leans the other way: REFERENCE.md line 110 records driving shots recurring 4× as connective tissue. Treat the preference as a nudge against that pattern, not a ban on it.)

  When you do come back to a source, prefer a **visually distinct passage** of it over a near-identical frame, space it out rather than stacking repeats close together, and note it in the coverage report so the choice is visible.

  **If the library is thinner than the beat count**, fewer and longer shots is usually the better trade than repeating: let shots run toward the soft maximum, merge adjacent beats that share a subject, give a reading beat its long end. Weigh that against holding too long on a weak frame — a well-placed second use can beat a shot that overstays.
- **Assign globally, not beat-by-beat greedily.** The only shot that fits beat 7 may also be the best for beat 3. Resolve the whole assignment before committing.
- **You do not have to use every clip, and usually should not.** The footage library is a library, not a checklist. The narration decides how many shots the edit needs; whatever the library holds beyond that is simply not in this video. A library of thirty clips against a twenty-second script means most of those clips go unused, and that is the correct outcome — not a coverage failure to be corrected. Leaving a clip out costs nothing. Forcing it in costs the beat it displaces.

  **Never reach for a clip because it has not been used yet.** That reasoning always produces a worse edit than the shot you passed over, because "unused" is not a reason a shot fits a beat. The only question is whether this shot is the best available illustration of *this* narration. If two shots tie, prefer the unused one for variety — but only after they have tied on merit.

  Note how this sits with the lean against reuse above: neither preference licenses the other. "Do not pad with unused clips" is not a reason to reuse a favourite instead, and "prefer not to repeat" is not a reason to spend the whole library. Both point the same way — the edit uses the shots the narration actually needs and stops there. Coverage of the *narration* is mandatory and gapless; coverage of the *library* is not a goal at all.
- **Open on texture or action, not exposition.** The reference hook is 1.6s of an extreme close-up of moving creek water, with no informational content at all.
- Faces bookend. In the reference set the creator's face appears at the second shot and the last shot, and nowhere else.

### 5. Place cuts on word onsets

Candidate cut points are word start times from the cleaned transcript. Snap each cut to the nearest word **onset** — not to the silence between words.

Measured across the two voiceover references, cuts sit within ~50ms of a word boundary (median deviation 0.030s and 0.057s), and the majority land slightly **inside** the word. The visual arrives with the emphasis. **Never cut in the middle of a silence.**

Every cut is a hard cut. No crossfades, no speed ramps, no whip pans — none appear anywhere in the reference set.

### 6. Reframe horizontal sources

For any clip whose `sourceWidth / sourceHeight` exceeds 9:16, set `sourceCrop` on its item in `tracks[0].items` using the deterministic centred math from `skills/find_clips/SKILL.md` step 4:

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

  **`start` and `end` are required in practice even though the schema calls `start` optional.** The timeline draws an audio lane as `left = pct(track.start, total)` and `width = pct(track.end - track.start, total)` (`montaj_assets/editor/src/video/timeline/AudioTrackRow.tsx:170-171`). Omit them and both compute to `NaN%`, so the bar is invisible: the lane row still appears (lane assignment tolerates the gap), but it renders permanently empty and the voiceover looks like it never landed. The audio still *plays*, because preview filters only on `!muted && src` — so this fails in the one direction that is hardest to notice, looking broken while sounding fine. `id` matters too: the timeline keys tracks by it for selection and crossfade.

  **Single-take projects** get exactly one track, same six fields. The rule is "one track per take", not "always split" — do not carve a single continuous read into invented sections.
- **`project.voiceover.cleanedSrc`** — the cleaned file's path. Leave `project.voiceover.src` pointing at the original.
- Do **not** put `project.voiceover.src` on any visual track unless the editing prompt explicitly asks for the speaker's picture.
- Set `status: "draft"`.

Source-clip audio is muted throughout, via the track flag above. The bed is the voiceover, plus music if the prompt asks for it. If a specific moment genuinely wants its source audio through — a bark on a punchline, a real reaction — do not un-mute the track for it; say so in the coverage report and let the operator make that call on the one clip.

**Leave `tracks[1+]` alone.** `montaj/overlay` runs after you and owns the overlay tracks.

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
- Median and mean assigned shot length, so drift from the 1.1s / 1.4s reference is visible.
- Every `filler` beat.
- How many clips the edit used out of how many were available, plainly (e.g. "9 of 31 clips used"). A low ratio is information, not an alarm.

## Common Mistakes

- **Putting the voiceover on a visual track.** It is audio only. This is the single most common way to get a talking-head video when the user asked for B-roll.
- **Leaving `tracks[0]` unmuted**, so source audio fights the narration. Mute the **track** (`tracks[0].muted = true`), not the items — and never both, which makes the rail's mute button look broken.
- **Dropping `proxySrc` when building `tracks[0]` items.** The proxies already exist; they are recorded on `project.sources`, not on the items you are creating, so they vanish unless you copy them across. The edit looks correct and validates fine — the damage shows up as sluggish scrubbing, a disabled WebCodecs engine, and a "Generate previews" chip in the header. Copy `proxySrc` from the matching `sources` entry by `src`.
- **Consolidating the voiceover into one audio track.** It is the shorter path and it takes the operator's section-by-section edits away. One track per take, contiguous on lane 0 — see step 7.
- **Setting `sourceCrop` without `sourceWidth` / `sourceHeight`** — the crop silently no-ops and the render letterboxes.
- **Enforcing the 3.1s soft maximum on a protected beat.** This is the failure the reference set exists to prevent.
- **Re-estimating `motion_mean` / `motion_peak`** instead of copying them from `detect_shots`.
- **Cutting in the silence between words** instead of on the word onset.
- **Writing overlays.** `montaj/overlay` runs after you and owns `tracks[1+]`. Emit footage and audio only.
- **Leaving a gap in the timeline** to signal a weak match. Fill it, mark it `filler` in the coverage report.
- **Trying to use every clip in the library.** The narration decides how many shots the edit needs; the library is not a checklist and there is no obligation to spend it. Working a clip in because it is still unused, or stretching the edit to accommodate one, always costs the beat it displaces. Most libraries should finish with clips unused.
- **Reaching for a repeat before checking the library for a fresh shot.** Repeats read as running out of material; prefer a new shot, or fewer and longer ones, where either is available. Reuse is allowed, just not the first move.
- **Guessing a tile's shot from its position** on the contact sheet instead of reading the `tiles` map.

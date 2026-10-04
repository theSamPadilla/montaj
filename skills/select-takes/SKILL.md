---
name: select-takes
description: "Agent-authored workflow task: analyze transcripts across all clips, pick ONE best take per script section, discard all others. Load this when you hit montaj/select_takes in a workflow."
step: true
---

# Select Takes

`montaj/select_takes` is an agent-authored task: no CLI step, no API call. You reason across every clip and make editorial decisions. You do them as text: the speech track is read with `speech_text`, edited, and applied with `speech_edit` (format and rules: skill `speech-edit`).

Order: the mechanical pass (`waveform_trim`, `rm_nonspeech`, `rm_fillers`) has already run, so its keeps are the items on the speech track, in clip order, and the words you read already match that cut.

## Core Purpose

**Pick one. Kill the rest.**

Every repeated take of the same line is wasted runtime. Find every section of the script, find all takes of it across all clips, keep the single best delivery, delete the rest. If a clip is entirely a worse take of content covered better elsewhere, drop the clip.

This is the only step with full cross-clip awareness. Use it.

## Process

### 1. Read the whole track

Run `speech_text` with `unused: lines`. Read all of it before deciding: the best take of a section may be in a different clip than you expect. Source lines outside the cut sit under `## Unused`; they are candidates too.

### 2. Map the script

Lay out every distinct section in narrative order. A section is a unit of content: a sentence, a thought, a beat. Name each one.

```
A. Hook: "this is insane, the source code got leaked"
B. What happened: "at 3am someone posted, 33M views"
C. What was found: "tamagotchi, Kyros mode, dreaming"
D. Fallout: "copyright claims, repos taken down"
E. Resolution: "people rewrote in different languages, Boris said human error"
F. CTA: "go check it out, follow me"
```

Then map each section to the line numbers (`A12`, `B3`, ...) that cover it.

### 3. Find all takes of each section

Any line group covering the section's content: same words, same idea, same intent.

| Kind | Example |
|---|---|
| Complete take | full delivery |
| False start | stops mid-sentence |
| Repeated attempt | full delivery, not the best |

### 4. Pick the best take

One per section. Criteria in order:

| # | Criterion |
|---|---|
| 1 | Complete over truncated: finishes the thought |
| 2 | No mid-sentence restarts: no self-correcting repeats |
| 3 | Clean delivery: fewer fillers, less dead air |
| 4 | Last attempt wins ties |

**Do not hedge.** If two takes are indistinguishable, pick the last.

### 5. Check each selected take for within-take repetition

Look for the same phrase (3+ words) twice inside the selected lines: a restarted clause with no pause long enough to split it into its own take. Keep only the final occurrence and delete the words before it.

Example: `and always on mode, and always on mode called Kyros that basically lets and always on mode called Kyros` keeps only the last `and always on mode called Kyros`.

**Required, not optional.** `rm_fillers` removes only um/uh/hmm; nothing automated catches repeated phrases.

### 6. Edit the file

1. Delete the rows of every losing take.
2. Order the remaining rows into the narrative. Reordering is moving rows.
3. Check every seam (step 7).
4. Apply with `speech_edit`, `preview` first, then for real (see `speech-edit`).

### 7. Check every seam

Read the last line of section N and the first line of section N+1 for every adjacent pair. Flag a pair where:

- the same fact, event or phrase is stated in both ("source code got leaked" then "they had leaked the entire source code");
- the same emotional beat lands twice in a row;
- N already answers a setup that N+1 opens by repeating.

Fix by deleting the redundant words: usually the opening of N+1, or the close of N. Do not accept an overlap because both takes were independently the best.

**Required before applying.** No automated step catches cross-section redundancy.

## Voiceover on an audio track

For flows whose speech is not on a visual track (B-roll's voiceover), `speech_text` does not read it (visual tracks only). There, crop the exact spec that was transcribed with `crop_spec`, and write each result to `<original>_selected.json`.

The `.srt` is in the time of the spec you transcribed, which the words JSON's `montaj.spec` names. Crop that same spec with those times and pass them to `crop_spec` without conversion. The words JSON `offsets` and `timestamps` are source (original-file) time; to use them with `crop_spec`, convert with `virtual_to_original --inverse`. Never crop a different spec with these times.

Run step `crop_spec` with `{"input": "/path/spec.json", "keeps": [[8.5, 34.1]]}`. `input` must be a spec file on disk (save an inline spec with `write_file` first); `keeps` is a native JSON array of `[start, end]` pairs, `null` for open-ended. Never encode an intermediate file: cropping keeps `src` on the original.

When this is the last editorial pass before the render, the project must be `final` before the render will run: see skill `native`, "Project lifecycle".

## What to Log

Before applying, log your decisions by line:

```
select_takes decisions:
  A. Hook -> A1-A4 (only take, clean delivery)
  B. What happened -> B1-B3 (first clean take; B9-B11 is identical but trails off)
  C. What was found -> B20-B27 (THIRD take: first two cut off before "Kyros")
  D. Fallout -> C1-C6 (only take)
  E. Resolution -> D4-D12 (cleaner pivot take + Boris statement; dropping filler at D13-D15)
  F. CTA -> E5-E7 (FOURTH take: first three are false starts)

  Deleted entirely: B4-B19 (repeated takes of B and C), D13-D18 (trailing filler), E1-E4 (false starts)
```

## Common Mistakes

| Mistake | Fix |
|---|---|
| **Too conservative, the most common failure.** Keeping a wide span because it "contains the best take" also keeps the rejected takes | Delete the line groups of the losing takes; keep only the chosen one |
| Not reading all clips before deciding | Read the whole track and `## Unused` first |
| Keeping false starts ("so the, actually let me start over, the tweet got...") | Delete up to the restart |
| Keeping the outro filler ("so yeah", "anyway") | End at the last meaningful sentence |
| Missing within-take repetition | Re-read every selected line group for repeated clauses; no step catches them |
| Skipping the seam check | Read adjacent boundaries as pairs before applying |

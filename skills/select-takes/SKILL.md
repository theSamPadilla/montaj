---
name: select-takes
description: "Agent-authored workflow task: analyze transcripts across all clips, pick ONE best take per script section, discard all others. Load this when you hit montaj/select_takes in a workflow."
step: true
---

# Select Takes

`montaj/select_takes` is an agent-authored task — no CLI step, no API call. You reason across all clip transcripts and make editorial decisions. The output is a set of cropped trim specs ready for `rm_fillers` and `concat`.

## Core Purpose

**Pick one. Kill the rest.**

Every repeated take of the same line is wasted runtime in the final video. Your job is to identify every section of the script, find all takes of that section across all clips, select the single best delivery, and discard everything else. If a section has three takes, two get cut entirely. If a clip is entirely a worse take of content covered better in another clip, that clip is dropped.

This is the only step in the pipeline with full cross-file awareness. Use it.

## Process

### 1. Read all transcripts

Read the SRT file for every clip from the preceding `transcribe` step. Read them all before making any decisions — the best take of a section may be in a different clip than you expect.

### 2. Map the script

Lay out every distinct section of the intended script in narrative order. A "section" is a unit of content — a sentence, a thought, a beat. Name each one.

Example for a 5-clip set:
```
A. Hook — "this is insane, the source code got leaked"
B. What happened — "at 3am someone posted, 33M views"
C. What was found — "tamagotchi, Kyros mode, dreaming"
D. Fallout — "copyright claims, repos taken down"
E. Resolution — "people rewrote in different languages, Boris said human error"
F. CTA — "go check it out, follow me"
```

### 3. Find all takes of each section

For each section, find every occurrence across all clips. A take is any transcript segment that covers that section's content — same words, same idea, same intent. Include:
- Complete takes
- False starts (partial delivery that stops mid-sentence)
- Repeated attempts (full delivery but not the best one)

### 4. Pick the best take

For each section, select **one** take. Apply these criteria in order:

1. **Complete over truncated** — a take that finishes the thought beats one that trails off
2. **No mid-sentence restarts** — a take with no repeated phrases within it beats one that corrects itself
3. **Clean delivery** — fewer filler words, less dead air within the take
4. **Last attempt wins ties** — speakers improve with repetition; when two takes are equally clean, prefer the later one

**Do not hedge.** Pick one. If two takes are genuinely indistinguishable, pick the last one and move on.

### 5. Scan each selected take for within-take repetition

After picking a take, re-read its SRT segments carefully. Look for the **same phrase (3+ words) appearing more than once** within the selected window — this is a mid-take stutter where the speaker restarted a clause without a long enough pause to be split into a separate take by `waveform_trim`.

For each repetition found:
1. **Identify the repeated phrase** and all its occurrences in the SRT
2. **Keep only the final occurrence** — the speaker lands the phrase correctly on the last attempt
3. **Tighten the crop window** to start just before the final occurrence, discarding the earlier stumbles

Example: SRT shows `"and always on mode, and always on mode called Kyros that basically lets and always on mode called Kyros..."` — the speaker repeated "always on mode" three times. Crop the section start to just before the last clean attempt.

**This is a required check, not optional.** `rm_fillers` only removes um/uh/hmm; it will not catch repeated phrases. If you don't catch it here, it encodes into the final video.

### 6. Determine the output order

Arrange the selected takes in narrative order. This may differ from the original clip order. A clip that contains section C might come before a clip that contains section B if that serves the story.

### 7. Check every seam for narrative overlap

After ordering, read the **last sentence of section N** and the **first sentence of section N+1** for every adjacent pair. Flag any pair where:
- The same fact, event, or phrase is stated in both (e.g. hook ends "source code got leaked" → next section opens "they had leaked the entire source code")
- The same emotional beat lands twice in a row
- A setup at the end of N is answered by N itself, making the opening of N+1 redundant

For each flagged seam, fix it by trimming the crop window of whichever section is redundant — usually cutting the opening of N+1 forward to where it adds new information, or cutting the close of N back to where it hands off cleanly. Do not simply accept the overlap because both sections were independently "the best take."

**This check is required before writing any spec files.** Seam problems cannot be caught by any automated step downstream.

### 9. Crop the trim specs — do NOT call `trim`

For each selected take, load the trim spec JSON produced by the preceding `waveform_trim` step for that clip. Crop it to the selected take's virtual-timeline window using the `crop_spec` step.

**Never call the `trim` step.** That encodes an intermediate video file and breaks the single-encode chain. Cropping the spec keeps the original source file all the way through to `concat`.

```bash
# HTTP API — single window
POST /api/steps/crop_spec
{"input": "/path/IMG_4893_spec.json", "keeps": [[8.5, 34.1]]}
→ {"path": "/path/IMG_4893_spec_cropped.json"}

# HTTP API — multiple windows (skip rejected content in between)
POST /api/steps/crop_spec
{"input": "/path/IMG_4893_spec.json", "keeps": [[0, 2.4], [13.84, 18.33]]}
→ {"path": "/path/IMG_4893_spec_cropped.json"}

# Open-ended: keep from virtual 40.28s to end of clip
POST /api/steps/crop_spec
{"input": "/path/IMG_4893_spec.json", "keeps": [[40.28, null]]}
```

The `keeps` field is a **native JSON array** of `[start, end]` pairs — not a string. Use `null` for an open-ended window.

**Important:** the timestamps you pass to `crop_spec` are **virtual-timeline timestamps** — time within the waveform_trim spec's kept audio, not original-file timestamps. If your reference points come from an SRT transcript (which uses original-file timestamps), use `virtual_to_original --inverse` to convert them first (see below).

Write each cropped spec to `<original>_selected.json` by saving the returned path or passing `--out` explicitly.

### 9a. Timestamps — SRT is already virtual; use virtual_to_original for seam debugging only

**SRT timestamps are virtual-timeline timestamps.** The `transcribe` step runs on the extracted audio (the waveform_trim keeps played back-to-back), so its timestamps are relative to that extracted audio — i.e., the virtual timeline. Pass them directly to `crop_spec` without any conversion.

```bash
# SRT shows the best take at 8.5s–34.1s → pass directly
POST /api/steps/crop_spec
{"input": "/path/IMG_4893_spec.json", "keeps": [[8.5, 34.1]]}
```

`virtual_to_original` is a **debugging tool**, not a conversion step in the normal workflow. Use it when you need to verify that a virtual timestamp maps to the right spot in the original file — for example, to check why a cut looks off:

```bash
# "Why does the seam at virtual 47.32 look wrong?"
montaj step virtual_to_original --input spec.json --verbose 47.32
# → 47.32 → 95.483  (keep 10: [93.295, 96.166])
```

The `--inverse` flag goes the other direction (original-file → virtual). Use it when you have an original-file timestamp from somewhere else (e.g., ffprobe output, manual note) and need to know where it falls in the virtual timeline:

```bash
montaj step virtual_to_original --input spec.json --inverse 95.483
# → 47.320
```

### 10. Output

An ordered list of `_selected.json` trim spec paths — one per selected section, in narrative order. These become the inputs to `rm_fillers` and ultimately `concat`.

## What to Log

Before writing specs, log your decisions clearly:

```
select_takes decisions:
  A. Hook → IMG_4891 0–18s (only take, clean delivery)
  B. What happened → IMG_4893 0–7.5s (first clean take; second at 22s is identical but trails off)
  C. What was found → IMG_4893 42.5–66.8s (THIRD take — first two at 26s and 34s cut off before "Kyros")
  D. Fallout → IMG_4894 0–18.4s (only take)
  E. Resolution → IMG_4895 8.5–34.1s (cleaner pivot take + Boris statement; dropping filler at 34–44s)
  F. CTA → IMG_4896 12.9–18.9s (FOURTH take — first three are false starts)

  Dropped entirely: IMG_4893 0–42s (repeated takes of B and C), IMG_4895 44–60s (trailing filler), IMG_4896 0–12.9s (false starts)
```

## Common Mistakes

**Too conservative — the most common failure.** Keeping a wide window like `0–66s` because it "contains the best take" is wrong. It also contains two rejected takes. Crop to the specific take only.

**Not reading all clips before deciding.** The best take of section C might be in clip 4, not clip 2. Read everything first.

**Keeping false starts.** A false start is not content. If a speaker says "so the — actually let me start over — the tweet got..." cut before the restart.

**Keeping the outro filler.** Clips often end with trailing "so yeah", "anyway", "alright" after the real content. Cut at the end of the last meaningful sentence.

**Missing within-take phrase repetition.** Even after picking the best take, the speaker may have stumbled and repeated a clause mid-sentence — no automated step catches this. You must read the SRT for every selected take and crop out earlier occurrences of any repeated phrase. Choosing the "best" take is not enough if that take still contains an internal stutter.

**Skipping the seam check.** Each section is picked independently, but the seams are where edits fall apart. A hook that ends "the source code got leaked" followed by an opener that says "they had leaked the entire source code" is the same beat twice — no automated step catches cross-section redundancy. Always read adjacent section boundaries as a pair before writing specs.

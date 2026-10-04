---
name: speech-edit
description: "Edit a talking head or any speech-led cut by editing its transcript as text: cut words and failed takes, shorten pauses, reorder. Load before cutting speech on a project that already has a timeline."
---

# Speech Edit

Cut speech by editing its words, not by doing timestamp arithmetic. `speech_text` writes the current cut as numbered lines; you edit the file; `speech_edit` rewrites the timeline from it.

## Order of passes

1. Mechanical pass first: `waveform_trim` (or the `waveform-silence` skill when noise defeats its threshold), `rm_nonspeech`, `rm_fillers`.
2. This pass.
3. Captions, overlays and music last. They anchor to the speech, so finish it first.

`waveform_trim` stays the fallback when the transcript is unreliable (noisy or mumbled audio) and for footage without speech.

## The loop

1. Run `speech_text` (params: `project`, `track`, `unused`). Read `speech-text.md` in the project folder.
2. Edit the file: with your edit tool, or in the app by rewriting it with `write_file`.
3. Run `speech_edit` with `text` = the file path and `preview`. Read `cut`, `flagged` and `hardCuts`.
4. Run it again without `preview`. Read the new text it returns and work from that.

After `stale`, read again and redo the edit. Never patch the stamp in the header.

## The text

```
<!-- montaj speech text v1 · track trk-0 · stamp 5fb5552700e7 -->
## Cut
A1 hey this is sam and today i'm going to show you
A2 {0.48} after you log in you'll see down here
-- gap 2.00
-- B 12.40-15.50 no speech
## Unused
A7 um so the next thing is
*A9 creating your first video is really really easy
```

| Piece | Meaning |
|---|---|
| `A12` | A line of source A's transcript. Ids are stable across edits and applies |
| Row in `## Cut` | A line id plus the words of it that play there, in playback order |
| `{0.48}` | A pause in seconds, shown at 0.15 s or longer, at a row start or between words |
| `## Unused` | Every line not fully playing, in full. `*` marks a line partly in the cut |
| `-- gap <s>` | Timeline span with no clip |
| `-- <L> <a>-<b> no speech` | Source L, seconds a to b, nothing spoken |
| `-- <L> <a>-<b> no transcript` | Not transcribed. The step's warnings name the `transcribe` call to run |
| `-- image <name> <s>` | An image on the speech track |

`gap` and `--` rows can be moved or deleted, never edited.

## Edit forms

| To | Do |
|---|---|
| cut words | delete them from the row |
| cut a line | delete the row (or every word, leaving only `A12`) |
| shorten a pause | change the number: `{0.48}` to `{0.25}` |
| cut a pause to the minimum (0.08 s) | delete the marker |
| move | move the row |
| repeat | copy the row |
| use an unused take, or restore cut words | copy the line from `## Unused` into `## Cut`, then delete the words you do not want |

A pause never grows past what the source has; it is clamped and reported in `clamped`.

## Rules

- Never change, add or respell a word. A wrong word is a transcription error, not an edit.
- Cut whole thoughts, not half-sentences.
- Keep the connecting words a kept sentence needs ("so", "but", "then") unless they are pure hesitation.
- Retake: keep the last complete attempt, unless an earlier one is the only complete one. Keep any setup the later attempt does not repeat.
- Never stitch fragments of two attempts into one sentence.
- When unsure, cut less.
- Pauses: cap at 0.3 s for a talking head, 0.5 s for tutorials and explainers, longer before a topic change. Never cut a pause to nothing between sentences. `max-pause` caps every pause the text did not set itself.
- Tell the user what you cut by what was said, never by line ids.

## Refusals

| Code | Fix |
|---|---|
| `stale` | The project or a transcript changed since the read. Read again, redo the edit |
| `changed_words` | A word is not in its line. Restore it |
| `unknown_line` | An id that is not in the text. Copy a real line |
| `bad_row` | A row mixes two lines or is malformed |
| `bad_marker` | A `{x}` that is not a number |
| `bad_header` | The header comment was edited |
| `invalid_result` | The rebuilt project failed validation. Undo the last edit |
| `carry_conflict` | Something anchored to the old cut cannot be placed. Cut less around it |

A refusal writes nothing.

## After an apply

An apply snapshots a version first ("before speech edit"); the Versions panel undoes it.

The result lists what happened to everything else:

| Field | Meaning |
|---|---|
| `cut`, `moved`, `pauses` | What the text changed |
| `clamped` | Pauses held to what the source has |
| `hardCuts` | Cuts with no silence near, placed at the word edge with a small pad |
| `carried` | Overlays, captions, audio, markers that followed their content |
| `flagged` | `overlay_removed`, `overlay_trimmed`, `linked_removed`, `bed_check_timing`, `marker_moved` |

Before saying it is done, check `flagged`. Look at every moved overlay and every hard cut with `sample_frame`. A `bed_check_timing` music or SFX bed was made for the old cut; confirm it still fits.

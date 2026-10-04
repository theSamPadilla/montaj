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

1. Run `speech_text` (params: `project`, `track`, `unused`). Read the file at the result's `path` (`speech-text.md` in the project folder).
2. Edit the file: with your edit tool, or in the app by rewriting it with `write_file`.
3. Run `speech_edit` with `text` = the file path and `preview`. Read `cut`, `flagged` and `hardCuts`.
4. Run it again without `preview`. Read the new text it returns and work from that.

After `stale`, read again and redo the edit. Never patch the stamp in the header.

## The text

```
<!-- montaj speech text v1 · track trk-0 · stamp 5fb5552700e7 -->
# My video

A = take1.mp4
B = take2.mp4

## Cut

A1 so today we're going to look at three ways to start
A2 {0.48} the first one is the simplest
-- gap 2.00
-- B 12.40-15.50 no speech

## Unused

A7 um so the next thing is
*A9 the second one takes a little longer
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

A pause never grows past what the source has; it is clamped and reported in `clamped`. Pause values are source seconds, so a clip at speed 2 plays a `{0.40}` marker as 0.20 s. A pause next to a word the transcript placed inside a pause is kept whole when it cannot be cut safely (the real word lies somewhere in that gap); the result reports it in `clamped` with `unsure`.

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
| `changed_words` | A word is not in its line, or the row mixes two lines. Restore the word, or split the row in two |
| `unknown_line` | An id that is not in the text. Copy a real line |
| `bad_row` | A row is malformed |
| `bad_marker` | A `{x}` that is not a number |
| `bad_header` | The header comment was edited, or the `## Cut` heading is missing |
| `unknown_row` | A `--` row was edited. Move or delete it as it was written |
| `empty_cut` | Every speech row is gone. Keep some speech |
| `transcript_missing` | A source has no transcript. Run the `transcribe` call the error names |
| `mixed_track` | The speech track holds an overlay, text, caption or sourceless item. Pass the `track` that holds the speech |
| `invalid_result` | The rebuilt project failed validation. Undo the last edit |
| `carry_conflict` | Overlays on one track would overlap after the edit. Move or delete one, then apply again |

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
| `flagged` | `overlay_removed`, `overlay_trimmed`, `overlay_moved`, `overlay_clipped`, `linked_removed`, `linked_clipped`, `caption_removed`, `audio_moved`, `audio_clipped`, `audio_removed`, `bed_check_timing`, `marker_moved`, `keyframes_merged`, `state_merged`, `fields_dropped`, `short_piece` |

Before saying it is done, check `flagged`. Look at every moved overlay and every hard cut with `sample_frame`. A `bed_check_timing` music or SFX bed was made for the old cut; confirm it still fits.

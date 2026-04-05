---
name: waveform-silence
description: "Agent-authored workflow task: generate waveform images per clip and reason visually about silence vs. speech to produce trim specs. Use when waveform_trim's fixed threshold fails due to inconsistent background noise."
step: true
---

# Waveform Silence (Visual)

`montaj/waveform_silence` is an agent-authored task — you generate waveform images, read them visually, and produce trim specs. No fixed dB threshold. No automated decision. You are the detector.

## When to Use

Use this instead of (or after) `waveform_trim` when:
- The recording environment changed mid-session (fan kicked on, moved rooms, mic placement shifted)
- Background music or ambient noise makes a fixed silence threshold unreliable
- `waveform_trim` left too much silence in some clips and cut too aggressively in others
- You can see from context that the noise floor is inconsistent across clips

`waveform_trim` compares amplitude against a fixed dB number. This skill compares amplitude *within a clip* — relative contrast between the busy and flat regions. That's what makes it robust to a varying noise floor.

## Output

Same as `select_takes`: an ordered list of cropped trim spec JSON paths, produced by calling `crop_spec`. Feed directly into `rm_fillers` or `concat`.

---

## Process

### 1. Generate waveform images — per clip, in parallel

Run `waveform_image` for each clip. One call per clip; use background jobs for true parallelism:

```bash
# HTTP API
out0=$(curl -s -X POST http://localhost:3000/api/steps/waveform_image \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/clip0.MOV"}') &
out1=$(curl -s -X POST http://localhost:3000/api/steps/waveform_image \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/clip1.MOV"}') &
wait
echo "$out0"; echo "$out1"

# CLI
montaj waveform-image --input /path/clip0.MOV &
montaj waveform-image --input /path/clip1.MOV &
wait
```

Each result is a JSON array of `{path, start, end}` — one object per ≤10s chunk.

### 2. Read all chunks of a clip before deciding anything

For a 45s clip you'll have 5 chunk images covering 0–10s, 10–20s, 20–30s, 30–40s, 40–45s. **Read all five before marking a single boundary.** The noise floor reference is the flattest region across the whole clip — you can't identify it from one chunk alone.

### 3. Establish the per-clip noise floor

Look across all chunk images for this clip. Find the flattest, lowest-amplitude region — typically a long pause or the tail of the clip. That waveform height is your reference baseline for this clip.

**Do not use the same baseline across clips.** Each clip has its own noise floor. A clip recorded in a quiet room has a different baseline than one with a fan running — treat them independently.

### 4. Identify speech and silence regions

Within each chunk:
- **Speech**: amplitude clearly and consistently above the baseline — roughly 2× or more the noise floor height, sustained for at least 0.2–0.3s
- **Silence**: amplitude at or near the baseline — the line is flat or barely moving

Short spikes (single transients, mouth sounds) are not speech. Sustained amplitude that rises and falls with a voice pattern is speech.

### 5. Convert visual positions to timestamps

Each chunk image is 1920px wide and spans exactly `[start, end]` seconds (from the `waveform_image` output).

To timestamp a boundary you see in the image:
1. Estimate its proportional position through the chunk (e.g. "about 35% through")
2. `timestamp = chunk_start + proportion × (chunk_end − chunk_start)`
3. Round to the nearest 0.1s

Precision of ±0.2s is sufficient — that's consistent with what `waveform_trim` achieves.

**Example**: chunk covers 20.0–30.0s. Silence appears to start about 70% through.
`20.0 + 0.70 × 10.0 = 27.0s`

### 6. Build a silence map for the clip

Collect all silence spans: `[(start, end), ...]`. Merge any adjacent silences separated by less than 0.3s — brief amplitude dips within a word are not cuts.

Then invert to get the keeps: the non-silence spans. These are what you'll pass to `crop_spec`.

**Minimum silence to cut**: 0.3s. Don't cut pauses shorter than that — they're part of natural speech rhythm and cutting them makes delivery sound robotic.

### 7. Call crop_spec

For each clip, call `crop_spec` with the keeps array:

```bash
# HTTP API
curl -s -X POST http://localhost:3000/api/steps/crop_spec \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/clip0_spec.json", "keeps": [[0.0, 4.2], [6.8, 14.0], [16.3, 27.0]]}'
# → {"path": "/path/clip0_spec_cropped.json"}

# CLI
montaj crop-spec --input /path/clip0_spec.json --keeps "[[0.0,4.2],[6.8,14.0],[16.3,27.0]]"
```

If there is no existing spec for the clip (this step is running standalone, not after `waveform_trim`), use the full clip as the base spec: `{"input": "/path/clip0.MOV", "keeps": [[0.0, <duration>]]}`.

### 8. Output

An ordered list of cropped spec paths — one per clip, in the order they'll be used downstream.

```
waveform_silence decisions:
  clip0.MOV — cut 3 silences: [4.2–6.8s, 14.0–16.3s, 27.0–29.1s]
    noise floor: flat ~3px in chunk_00; speech peaks ~30px
    → clip0_spec_cropped.json

  clip1.MOV — cut 2 silences: [0.0–1.4s (dead air at start), 22.5–25.0s]
    noise floor: higher than clip0 (~8px, fan noise) but speech still clear at ~40px
    → clip1_spec_cropped.json
```

---

## Common Mistakes

**Using the same noise floor reference across clips.** Each clip is independent. A noisy recording has a higher baseline — that's not silence, don't cut it.

**Cutting too aggressively at chunk boundaries.** If a chunk ends mid-word and the next chunk opens with the tail of that word, the amplitude dip at the boundary is not silence. Always check both sides of a chunk seam.

**Treating every flat region as silence.** A very soft word, a breath, or a held note can look flat compared to loud speech. If you're uncertain whether a region has content, err toward keeping it — `rm_fillers` and `select_takes` can clean further.

**Not merging short gaps.** A 0.1s dip between two words is not a silence cut. Merge adjacent silences < 0.3s apart before computing keeps.

**Forgetting to log decisions.** Write your noise floor reference, speech amplitude range, and cut list for each clip before writing any specs. If a cut looks wrong in review, the log is what lets you diagnose it.

---
name: find_clips
description: "Agent-authored workflow task: transcribe-and-sample one long-form horizontal source, pick N self-contained clip windows, and fan each out into its own vertical (9:16) clip project with the chosen framing. Load this when you hit montaj/find_clips in a workflow."
step: true
---

# Find Clips

`montaj/find_clips` is an agent-authored task — no CLI step, no API call drives the editorial decisions. You reason over the transcript and probe output, select clip windows, then create one child project per clip.

## Core Purpose

**One long source → N focused vertical clips.**

The source project has already been probed and transcribed. Your job is to find the N best self-contained moments, decide a vertical framing mode for each, and create a child vertical (9:16) project for each clip so the downstream editing workflow (`overlays`) can handle per-clip cleaning and captioning.

## Process

### 1. Read the transcript and probe output

Read the SRT file produced by the `transcribe` step. The path is in the transcribe step's output JSON as `srt`. Example output:

```json
{"srt": "/workspace/proj-abc/source.srt", "words": "/workspace/proj-abc/source.json"}
```

Read the probe step's output for `width`, `height`, and `duration`. The source is horizontal (16:9 or similar wide format).

### 2. Determine N and the clip windows

**From the prompt:** if the user specifies a number of clips (e.g. "5 clips", "top 3 moments"), use that as N. If they name specific moments, use those as windows directly.

**By editorial judgment when unspecified:** scan the transcript for self-contained, hook-worthy moments. A good clip window is:
- Narratively complete — it can stand alone without the surrounding context
- Has a clear entry (no mid-sentence start) and a clean exit (sentence ends, thought resolves)
- Between 15 seconds and 90 seconds long (sweet spot for short-form vertical)
- Not a duplicate of another selected window

For each window, record `[inPoint, outPoint]` in seconds (floating-point) relative to the original source file. These are NOT virtual-timeline timestamps — they are positions in the raw source video. Use the SRT timestamps directly (SRT timestamps from the `transcribe` step on a raw video input are original-file timestamps).

### 3. Decide the vertical framing mode per clip

Three modes — pick based on the content in the window and any framing guidance in the prompt:

- **zoom** — single speaker centered in frame, talking-head or walk-and-talk. Use when one subject dominates the frame and a tight crop will contain them throughout.
- **thirds** — source video floated in the top half of the 9:16 canvas with a background fill below. Use when the source needs spatial context (demo, screen share, two-shot, reaction with wide framing).
- **mix** — cropped source occupies roughly the top half as an overlay item (scale ~0.5), leaving the bottom for captions or overlays. Use for content where some cropping + extra overlay space improves the layout.

**When the prompt doesn't specify:** talking-head → zoom; reaction/demo/wide shot needing room → thirds or mix.

### 4. Compute the sourceCrop for zoom mode

For a 16:9 source reframed to 9:16 (zoom mode), compute the centered 9:16 sub-rectangle as fractions of the source dimensions:

```
w = (9/16) / (16/9)  = 81/256  ≈ 0.3164   # width fraction of the source
h = 1.0                                      # full height
x = (1 - w) / 2     ≈ 0.3418               # centered horizontally
y = 0.0                                      # top-aligned
```

Use these exact values. sourceCrop fields (`x`, `y`, `w`, `h`) are normalized fractions in [0, 1]. This math is deterministic — do not estimate or eyeball it.

For a source that is not exactly 16:9, substitute the actual aspect ratio:

```
source_ar = source_width / source_height   # e.g. 1920/1080 = 1.7778
target_ar = 9 / 16                         # 0.5625
w = target_ar / source_ar                  # e.g. 0.5625 / 1.7778 ≈ 0.3164
h = 1.0
x = (1 - w) / 2
y = 0.0
```

### 5. Create one child project per clip

For each clip window, create a child project using `project/init.py` directly via CLI. The HTTP endpoint (`POST /api/run`) does not expose `--symlink-clips` or `--derived-from`, so you must call init.py as a subprocess.

**Creation command:**

```bash
python /path/to/montaj/project/init.py \
  --clips /path/to/source_video.mp4 \
  --workflow overlays \
  --prompt "<per-clip prompt — framing mode + any user instructions>" \
  --symlink-clips \
  --derived-from <source_project_id> \
  --resolution 1080x1920 \
  --normalize lazy
```

- `--clips`: the original source video path (from the source project's `tracks[0][0].src` — always the original .MOV/.mp4, never a derived file)
- `--workflow overlays`: the downstream workflow for the child project
- `--prompt`: carry forward the user's original prompt plus framing mode (`zoom`, `thirds`, or `mix`)
- `--symlink-clips`: stage the source as a symlink, not a copy (source files are large; this is required for clips workflow children)
- `--derived-from <source_project_id>`: the id of the parent source project (read from the source project's `project.json` field `id`)
- `--resolution 1080x1920`: target resolution for the child project
- `--normalize lazy`: suppress the eager full-source normalize that `overlays` would otherwise run at init. The child project only normalizes the per-clip window (done in step 6 below), not the entire symlinked source file.

`project/init.py` prints the path to the created `project.json` on stdout. Read it back to get the child project's `id`.

**Repeat this call once per clip.** There is no batch-create — one invocation per clip window.

Example (three clips from source project `abc-123`):

```bash
# Clip 1: 0:12–1:02
python $MONTAJ_ROOT/project/init.py \
  --clips /workspace/proj-abc/source.mp4 \
  --workflow overlays --prompt "zoom: solo speaker hook" \
  --symlink-clips --derived-from abc-123 --resolution 1080x1920 --normalize lazy

# Clip 2: 2:34–3:18
python $MONTAJ_ROOT/project/init.py \
  --clips /workspace/proj-abc/source.mp4 \
  --workflow overlays --prompt "thirds: demo showing both speaker and screen" \
  --symlink-clips --derived-from abc-123 --resolution 1080x1920 --normalize lazy

# Clip 3: 5:01–5:45
python $MONTAJ_ROOT/project/init.py \
  --clips /workspace/proj-abc/source.mp4 \
  --workflow overlays --prompt "zoom: CTA close-up" \
  --symlink-clips --derived-from abc-123 --resolution 1080x1920 --normalize lazy
```

### 6. Set the clip window and sourceCrop in each child project

After creating each child project, read its `project.json`, update `tracks[0][0]` with the window and framing, then PUT it back.

**For zoom mode:**

```bash
# Read current state
curr=$(curl -s http://localhost:3000/api/projects/<child_id>)

# Apply window + sourceCrop
new=$(echo "$curr" | jq \
  --argjson ip 12.0 --argjson op 62.0 \
  --argjson sc '{"x": 0.3418, "y": 0.0, "w": 0.3164, "h": 1.0}' \
  '.tracks[0][0].inPoint = $ip | .tracks[0][0].outPoint = $op | .tracks[0][0].sourceCrop = $sc')

curl -s -X PUT http://localhost:3000/api/projects/<child_id> \
  -H "Content-Type: application/json" -d "$new"
```

**For thirds mode:** add the source as an overlay-track video item with `offsetY` into the top region (e.g. `y: 0`, `h: 0.5` in canvas-fraction terms) over a solid background. Set `sourceCrop` on the overlay item only if you want to crop within the visible portion. The primary `tracks[0]` item still carries `inPoint`/`outPoint`; the overlay item references the same src.

**For mix mode:** add the source as a scaled overlay item (`scale: ~0.5`) anchored to the top of the canvas, with `sourceCrop` applied to trim the horizontal edges. `inPoint`/`outPoint` stay on `tracks[0][0]`.

Set `sourceWidth` and `sourceHeight` from the probe output on each `tracks[0][0]` item so the renderer has the original dimensions for crop math.

**After setting inPoint/outPoint, run the window-normalize step and record the cache:**

```bash
# Run normalize_window for the clip window
montaj step normalize_window \
  --input <original_source_path> \
  --inpoint <inPoint> \
  --outpoint <outPoint> \
  --color-space <settings.colorSpace>  \
  --out <child_project_dir>/window_normalized.mp4
```

The command prints the cache path to stdout. Capture it, then write it into `tracks[0][0].normalizedSrc` in the child project (either in the same PUT that sets inPoint/outPoint, or as a follow-up PUT):

```bash
# Example: capture the cache path and merge it into the PUT
cache_path=$(montaj step normalize_window \
  --input /workspace/proj-abc/source.mp4 \
  --inpoint 12.0 --outpoint 62.0 \
  --color-space sdr_bt709 \
  --out /workspace/proj-xyz/window_normalized.mp4)

curr=$(curl -s http://localhost:3000/api/projects/<child_id>)
new=$(echo "$curr" | jq \
  --argjson ip 12.0 --argjson op 62.0 \
  --arg ns "$cache_path" \
  '.tracks[0][0].inPoint = $ip | .tracks[0][0].outPoint = $op | .tracks[0][0].normalizedSrc = $ns')
curl -s -X PUT http://localhost:3000/api/projects/<child_id> \
  -H "Content-Type: application/json" -d "$new"
```

Key invariants:
- `tracks[0][0].src` **stays the original source path** (the symlink to the .MOV/.mp4). Never replace it.
- `tracks[0][0].normalizedSrc` is the derived per-window cache that render and preview prefer when available.
- `tracks[0][0].inPoint` and `tracks[0][0].outPoint` remain the **original-source timestamps** in seconds. When the renderer uses `normalizedSrc` (which starts at time 0), it rebases automatically — inPoint/outPoint do not change.

### 7. Finalize — remove the source project

The source project is scaffolding: it exists only so this skill can probe, transcribe, and sample. Once the child clips exist, the user should **not** be left with a project for the raw source. After all child projects and their `normalizedSrc` window caches are created and verified, relocate the source out of the source-project directory and delete the source project.

1. **Relocate the source file to the shared source store** so it survives deletion of the source project (each child symlinks to it):
   ```bash
   SHARED="$HOME/Montaj/.sources/<source_project_id>"
   mkdir -p "$SHARED"
   mv "<source_project_dir>/<source_filename>" "$SHARED/<source_filename>"
   ```
2. **Repoint each child's symlinked `tracks[0][0].src`** to the relocated file:
   ```bash
   for child_dir in <child1_dir> <child2_dir> <child3_dir>; do
     ln -sf "$SHARED/<source_filename>" "$child_dir/<source_filename>"
   done
   ```
   Only the symlink target moves — each child's `src`/`inPoint`/`outPoint` in `project.json` are unchanged, and the per-window `normalizedSrc` caches live inside the child dirs (unaffected). Verify each `src` still resolves before continuing.
3. **Delete the source project:**
   ```bash
   curl -s -X DELETE http://localhost:3000/api/projects/<source_project_id>
   ```
   The children keep `derivedFrom: <source_project_id>` as a provenance tag (grouping), even though the source project no longer exists. Render and preview of the current windows depend only on `normalizedSrc`; the symlinked `src` is needed only for later re-windowing, which is why it must be repointed to the shared store before deletion.

After this, **only the N vertical clip projects remain** — the user never has to manage a project for the raw source.

### 8. Report and hand off — ALWAYS ask before finishing the clips

The child clips are created **pending** in the `overlays` workflow — they are **not finished videos yet**. Each still needs its own editing pass (clean-cut → transcribe → captions → graphic overlays). `find_clips` ends at the fan-out boundary: **do not silently stop, and do not auto-run the `overlays` pass without asking.** End the run by giving the user the choice:

1. **Report** what you created — for each clip: name/ID, its window (`inPoint`–`outPoint`), and framing mode (zoom/thirds/mix) — and that each is **pending the `overlays` pass**.

2. **Ask the user which they want** (this is the required hand-off question):
   - **(a) Finish now** — you continue and run the `overlays` workflow on each clip (clean-cut → transcribe → captions → overlays), advancing each `pending → draft`. Only do this when the user explicitly says yes.
   - **(b) Hand off** — they (or a separate agent) finish later.

3. **For hand-off, give a ready-to-paste prompt per clip**, modeled on the pending-project prompt Montaj surfaces in the UI. For each clip:
   ```
   There is a new project pending: "<clip_name>". Please see @<montaj_root>/skills/SKILL.md and start. Talk to me if you run into questions.
   ```
   `<montaj_root>/skills/SKILL.md` is the root dispatcher; a fresh agent handed this prompt picks up that pending clip and runs its `overlays` workflow. This is the same prompt the Montaj UI shows for any new pending project — reuse it verbatim with the clip's name substituted, so the hand-off matches what the user already sees in the app.

Never run the overlays pass without an explicit yes (option a).

## What to Log

Before creating child projects, log your editorial decisions to the source project:

```
find_clips decisions:
  Clip 1 → 0:12–1:02 (zoom) — solo speaker hook, clean open/close
  Clip 2 → 2:34–3:18 (thirds) — demo needs screen context, two-shot
  Clip 3 → 5:01–5:45 (zoom) — CTA, tight close-up, clean delivery

  Rejected: 1:03–2:33 (repetitive setup, covered by clip 1), 3:19–5:00 (b-roll with no VO)
```

## Common Mistakes

**Selecting overlapping windows.** Each clip must be fully non-overlapping in the source timeline. A viewer who watches all clips should not hear the same content twice.

**Starting mid-sentence.** The SRT will show where sentences begin. If the best moment starts mid-utterance, extend `inPoint` back to the nearest sentence boundary.

**Using a trim spec or derived file as `--clips`.** Always pass the original source video (the `.MOV` or `.mp4` that was the workflow input), never a `_spec.json` or intermediate file. The symlinked source in the child project must point to the original.

**Forgetting `--symlink-clips`.** Source video files are large. Without symlinking, each child project copies the full source video, bloating disk usage N-fold.

**Skipping `--derived-from`.** This field is what links child clip projects back to the parent source project. Always pass the source project's `id`.

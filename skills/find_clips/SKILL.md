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

Read the probe step's output for `duration`, `display_width`, and `display_height` — the rotation-corrected dimensions probe reports, not the coded `width`/`height`. `find_clips` assumes the source is horizontal (16:9 or similar wide format); confirm that assumption against `display_width`/`display_height`, never the coded dims, which can read landscape on a source that actually displays something else once its rotation flag is applied. If the display aspect isn't actually horizontal, stop and flag it rather than continuing — the crop math in step 4 assumes a wide source and produces a wrong crop silently otherwise.

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

Call the `reframe` step against the original source file once — not per clip, the crop is the same for every window cut from this source:

```bash
montaj step reframe --input <source_video> --target 9:16
```

Write the returned `sourceCrop`, `sourceWidth`, and `sourceHeight` verbatim onto each zoom-mode clip item in step 6. A `null` `sourceCrop` means write no `sourceCrop` at all — still write `sourceWidth`/`sourceHeight`. Do not write the response's `source` field onto the item; it is diagnostics only.

**What the step computes for you** (reference only — not a formula to run by hand against the probe's coded dimensions):

```
w = target_ar / display_ar   # e.g. 0.5625 / 1.7778 ≈ 0.3164, for a 1920x1080 DISPLAY source
h = 1.0
x = (1 - w) / 2               # ≈ 0.3418, centered horizontally
y = 0.0                        # top-aligned
```

`display_ar` here is `display_width / display_height` — the rotation-corrected dimensions `reframe` reads internally, never the probe's coded `width`/`height`. That distinction is the whole reason to call the step instead of running this math yourself: a rotated source can code landscape while displaying something else entirely, and computing off the coded aspect crops footage that didn't need cropping.

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

- `--clips`: the original source video path (from the source project's `tracks[0].items[0].src` — always the original .MOV/.mp4, never a derived file)
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

After creating each child project, read its `project.json`, update `tracks[0].items[0]` with the window and framing, then PUT it back.

**For zoom mode:**

```bash
# Read current state
curr=$(curl -s http://localhost:3000/api/projects/<child_id>)

# Apply window + sourceCrop
# sc/sw/sh are reframe's output for this source — replace with the actual values (omit .sourceCrop entirely when reframe returns null)
new=$(echo "$curr" | jq \
  --argjson ip 12.0 --argjson op 62.0 \
  --argjson sc '{"x": 0.3418, "y": 0.0, "w": 0.3164, "h": 1.0}' \
  --argjson sw 1920 --argjson sh 1080 \
  '.tracks[0].items[0].inPoint = $ip | .tracks[0].items[0].outPoint = $op | .tracks[0].items[0].sourceCrop = $sc | .tracks[0].items[0].sourceWidth = $sw | .tracks[0].items[0].sourceHeight = $sh')

curl -s -X PUT http://localhost:3000/api/projects/<child_id> \
  -H "Content-Type: application/json" -d "$new"
```

**For thirds mode:** add the source as an overlay-track video item with `offsetY` into the top region (e.g. `y: 0`, `h: 0.5` in canvas-fraction terms) over a solid background. Set `sourceCrop` on the overlay item only if you want to crop within the visible portion. The primary `tracks[0]` item still carries `inPoint`/`outPoint`; the overlay item references the same src.

**For mix mode:** add the source as a scaled overlay item (`scale: ~0.5`) anchored to the top of the canvas, with `sourceCrop` applied to trim the horizontal edges. `inPoint`/`outPoint` stay on `tracks[0].items[0]`.

Set `sourceWidth` and `sourceHeight` on each `tracks[0].items[0]` item from the `reframe` step's output (step 4), not from a raw probe. These must be the source's DISPLAY dimensions (post-rotation), which is exactly what `reframe` returns — the renderer applies `sourceCrop` against the source as displayed, so recording the probe's coded dimensions here crops the wrong axis on a rotated source.

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

The command prints the cache path to stdout. Capture it, then write it into `tracks[0].items[0].normalizedSrc` in the child project (either in the same PUT that sets inPoint/outPoint, or as a follow-up PUT):

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
  '.tracks[0].items[0].inPoint = $ip | .tracks[0].items[0].outPoint = $op | .tracks[0].items[0].normalizedSrc = $ns | .tracks[0].items[0].normalizedInPoint = $ip')
curl -s -X PUT http://localhost:3000/api/projects/<child_id> \
  -H "Content-Type: application/json" -d "$new"
```

Key invariants:
- **Edit `tracks[0].items[0]` in place. Never rebuild it.** Every example above reads the child project, sets specific keys with `jq`, and PUTs the whole thing back. That is not a stylistic choice: `project/init.py` already wrote `proxySrc` (the editing proxy the WebCodecs preview engine requires — `montaj_assets/editor/src/engine/eligibility.ts:69`) and `sourceDuration` onto that item, and a rebuilt item silently drops whatever you did not think to copy. The symptom never appears here; it appears later, as sluggish scrubbing in the child project and a chip in the header saying its clips have no previews. If you ever do need to construct the item fresh, copy `proxySrc`, `normalizedSrc`, `normalizedInPoint`, and `sourceDuration` across from the item you are replacing.
- `tracks[0].items[0].src` **stays the original source path** (the symlink to the .MOV/.mp4). Never replace it.
- `tracks[0].items[0].normalizedSrc` is the derived per-window cache that render and preview prefer when available.
- `tracks[0].items[0].normalizedInPoint` is the **cache origin** — the source-time (original coordinates) at which the cache starts. Set it to the same value as `inPoint` when the cache is built (because `normalize_window` builds the cache for the current window). Render and preview rebase inPoint/outPoint by this origin so they seek to the correct position inside the cache. If a user later trims the clip's start inward, the cache still covers the new (narrower) window and the rebased seek still lands correctly, because `effectiveInPoint = inPoint - normalizedInPoint`.
- `tracks[0].items[0].inPoint` and `tracks[0].items[0].outPoint` remain the **original-source timestamps** in seconds. When the renderer uses `normalizedSrc`, it rebases by `normalizedInPoint` automatically — inPoint/outPoint do not change.

**Validate each child project before moving on.** Run `montaj validate project <child_workspace>/project.json` and fix anything it reports. It catches a `sourceCrop` whose recorded `sourceWidth`/`sourceHeight` disagree with the source's real display dimensions, which is the rotated-source failure that renders as a stretched sliver and stays invisible until someone watches the export.

### 7. Finalize — remove the source project

The source project is scaffolding: it exists only so this skill can probe, transcribe, and sample. Once the child clips exist, the user should **not** be left with a project for the raw source. After all child projects and their `normalizedSrc` window caches are created and verified, relocate the source out of the source-project directory and delete the source project.

1. **Relocate the source file _and its editing proxy_ to the shared source store** so both survive deletion of the source project (each child symlinks to the source, and every child shares the one proxy):
   ```bash
   SHARED="$HOME/Montaj/.sources/<source_project_id>"
   mkdir -p "$SHARED"
   mv "<source_project_dir>/<source_filename>" "$SHARED/<source_filename>"
   mv "<source_project_dir>/"*_proxy_*.mp4 "$SHARED/" 2>/dev/null || true
   ```

   **Moving the proxy is not optional.** `project/init.py` resolves each child's symlink before naming the proxy (`os.path.realpath`), and `lib/proxy.py:89` puts an in-workspace source's proxy *beside the source* — so all N children share exactly one proxy file, and it is sitting inside the directory step 3 is about to `shutil.rmtree`. Leave it behind and every clip you just created loses its editing preview the moment the source project is deleted: `proxySrc` points at a file that no longer exists, the WebCodecs engine refuses the project, and the operator gets a chip telling them their clips have no previews. The destination path above is exactly the path `proxy_path_for` will compute for the relocated source, and `mv` preserves mtimes, so the moved proxy is still considered fresh.
2. **Repoint each child's symlink, then repoint its `proxySrc`:**
   ```bash
   for child_dir in <child1_dir> <child2_dir> <child3_dir>; do
     ln -sf "$SHARED/<source_filename>" "$child_dir/<source_filename>"
   done

   # Point each child's proxySrc at the relocated proxy. The server recomputes
   # the path itself, finds the moved file already fresh, and rewrites the field.
   for child_id in <child1_id> <child2_id> <child3_id>; do
     curl -s -X POST "http://localhost:3000/api/projects/$child_id/proxies"
   done
   ```
   Each of those should return `{"scheduled": 0, "alreadyFresh": 1}` — `alreadyFresh` means the proxy was found at its new path and the pointer was updated with no re-encode. A `scheduled: 1` means the proxy was not where it was expected and a fresh encode was queued instead; that is not fatal, but check step 1's `mv` actually moved the file. Only the symlink target moves — each child's `src`/`inPoint`/`outPoint` in `project.json` are unchanged, and the per-window `normalizedSrc` caches live inside the child dirs (unaffected). Verify each `src` still resolves before continuing.
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

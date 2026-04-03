# montaj — CLI

> Distributed via Homebrew. Every operation the UI performs is available from the terminal.

```bash
brew install montaj
montaj install       # install system dependencies (ffmpeg, whisper.cpp, base model)
```

---

## Tier 1 — Workflow commands

The primary interface for most users.

```bash
montaj install
# Install system dependencies: ffmpeg, whisper-cpp (via Homebrew), and the base.en
# whisper model. Safe to re-run — skips anything already present.

montaj run ./clips --prompt "tight cuts, remove filler, 9:16"
# Runs workflows/default.json against all clips in the directory
# Pre-pass → project.json [pending] → agent pass → project.json [draft]

montaj run ./clips --workflow tight-reel --prompt "..."
# Runs a named workflow instead of the default

montaj run --canvas --workflow canvas --prompt "60s animated explainer, dark theme"
# Canvas project — no source footage required

montaj serve
# Start local HTTP server + open UI at http://localhost:3000

montaj render
# Render project.json [final] → final.mp4
# Uses project.json in the current directory by default

montaj render --project ./workspace/project.json --out ./output/final.mp4
# Explicit paths

montaj render --clean
# Delete intermediate files (base.mp4, per-segment WebMs) after compositing
```

`montaj run` works headlessly — no UI, no `montaj serve` required. The full pipeline runs in-process.

### Render pipeline internals

`montaj render` runs three stages:

1. **Base video** — trims and concatenates source clips via ffmpeg stream-copy. Canvas projects (no video track) generate a synthetic black base from overlay durations.
2. **Overlay segments** — each JSX overlay is bundled with esbuild, rendered frame-by-frame in headless Chromium (Puppeteer), and encoded to a lossless ffv1/MKV intermediate. Segments are rendered at **design resolution (1080×1920)** regardless of output resolution — the pipeline upscales at compose time.
3. **Compose** — a single `ffmpeg filter_complex` overlays all segments onto the base. For 4K output (2160×3840) segments are upscaled 2× before compositing. HDR source clips (bt2020/HLG) are composed in 10-bit (`yuv420p10le`) and encoded with full bt2020 color metadata so the signal is preserved end-to-end.

Intermediate files (`render/base.mp4`, `render/segments/`) are kept by default and reused on re-runs. Use `--clean` to delete them after compositing.

---

## Tier 2 — Workflow management

```bash
montaj workflow list
# List all available workflows (native + custom in workflows/)

montaj workflow new <name>
# Scaffold a new workflow file at workflows/<name>.json

montaj workflow edit <name>
# Open workflow in the node graph UI (starts montaj serve if not running)

montaj workflow run <name> ./clips --prompt "..."
# Run a specific workflow (alias for: montaj run --workflow <name>)
```

---

## Tier 3 — Steps

`montaj step` is the interface for running any step directly. Steps are discovered automatically across three scopes: built-in, user-global (`~/.montaj/steps/`), and project-local (`./steps/`).

```bash
montaj step --help
# List all available steps with descriptions

montaj step <name> --help
# Show params for a specific step

montaj step <name> --input <file> [params...]
# Run a step

montaj create-step <name>
# Scaffold steps/<name>.py and steps/<name>.json in the current directory

montaj validate step <filename>      # validate a step schema against the step spec
montaj validate project <filename>   # validate a project.json file
montaj validate workflow <filename>  # validate a workflow .json file
```

Steps chain via stdout — the output path of one step becomes the `--input` of the next:

```bash
FILE=$(montaj step rm_fillers --input clip.mp4 --model base.en)
FILE=$(montaj step waveform_trim --input "$FILE")
FILE=$(montaj step resize --input "$FILE" --ratio 9:16)
# $FILE is the final output path
```

### Inspect

```bash
montaj step probe --input clip.mp4
# → JSON: duration, resolution, fps, codec, audio channels

montaj step snapshot --input clip.mp4
# → /path/to/snapshot.png (frame grid contact sheet)

montaj step virtual_to_original --input spec.json 47.32
# → 95.483  (virtual timestamp → original-file timestamp)

montaj step virtual_to_original --input spec.json 47.32 53.23 66.89
# → one result per line

montaj step virtual_to_original --input spec.json --inverse 95.483
# → 47.320  (original-file timestamp → virtual timestamp)
```

### Clean

```bash
montaj step rm_fillers --input clip.mp4
montaj step rm_fillers --input clip.mp4 --model medium.en    # higher accuracy, slower

montaj step waveform_trim --input clip.mp4
montaj step waveform_trim --input clip.mp4 --threshold -30 --min-silence 0.3

montaj step rm_nonspeech --input clip.mp4
montaj step rm_nonspeech --input clip.mp4 --model base --max-word-gap 0.18 --sentence-edge 0.10

montaj step crop_spec --input spec.json --keep 8.5:14.8
# → /path/to/spec_cropped.json  (crops trim spec to a virtual-timeline window, no encode)

montaj step crop_spec --input spec.json --keep 0:2.4 --keep 13.84:18.33
# Multiple windows — keeps are concatenated in order

montaj step crop_spec --input spec.json --keep 40.28:end
# Open-ended — keep from virtual 40.28s to end of clip
```

### Edit

```bash
montaj step trim --input clip.mp4 --start 2.5 --end 8.3
montaj step trim --input clip.mp4 --start 00:00:02 --end 00:01:30   # HH:MM:SS also accepted

montaj step cut --input clip.mp4 --start 3.0 --end 7.5
# Remove a single section and rejoin — opposite of trim

montaj step cut --input clip.mp4 --cuts '[[0,1.2],[5.3,7.8]]'
# Remove multiple sections in one ffmpeg pass — keeps go 1.2→5.3 and 7.8→end

montaj step cut --input clip.mp4 --cuts '[[3.0,7.5]]' --spec
# Write a trim spec JSON instead of encoding — use with concat for deferred encode

montaj step concat --input clip1.mp4 clip2.mp4 clip3.mp4

montaj step resize --input clip.mp4 --ratio 9:16     # TikTok / Reels / Shorts
montaj step resize --input clip.mp4 --ratio 1:1      # Instagram
montaj step resize --input clip.mp4 --ratio 16:9     # YouTube

montaj step normalize --input clip.mp4                           # youtube = -14 LUFS
montaj step normalize --input clip.mp4 --target podcast          # -16 LUFS
montaj step normalize --input clip.mp4 --target broadcast        # -23 LUFS
montaj step normalize --input clip.mp4 --target custom --lufs -18

montaj step extract_audio --input clip.mp4                       # default: wav
montaj step extract_audio --input clip.mp4 --format mp3

montaj step ffmpeg_captions --input clip.mp4 --text "Hello World"
montaj step ffmpeg_captions --input clip.mp4 --text "Lower Third" --position bottom --fontsize 36
```

### Enrich

```bash
montaj step transcribe --input clip.mp4
montaj step transcribe --input clip.mp4 --model medium.en    # higher accuracy, slower
montaj step transcribe --input clip.mp4 --language es        # non-English

montaj step caption --input transcript.json
montaj step caption --input transcript.json --style word-by-word
montaj step caption --input transcript.json --style pop
montaj step caption --input transcript.json --style karaoke
montaj step caption --input transcript.json --style subtitle
```

### Analyze

```bash
montaj step best_take --input clip.mp4
montaj step best_take --input clip.mp4 --model base.en --min-pause 2.0 --min-words 5

montaj step jump_cut_detect --input clip.mp4
montaj step jump_cut_detect --input clip.mp4 --min-pause 0.8 --noise -30

montaj step pacing --input clip.mp4
montaj step pacing --input clip.mp4 --window 5.0 --slow-threshold 0.7
```

---

## Tier 4 — Project commands

```bash
montaj fetch --url "https://www.tiktok.com/@handle/video/123"
# Download a single video via yt-dlp

montaj fetch --url "https://www.tiktok.com/@handle" --limit 15 --out ./clips/
# Download up to N videos from a profile or playlist

montaj init --prompt "tight cuts, remove filler"
# Create empty project.json in current directory

montaj status
# Show current project.json state (pending / draft / final) + step progress
```

---

## Step params reference

All steps accept `--out <path>` to set the output location. Run `montaj step <name> --help` for full details on any step.

| Step | Key params |
|------|-----------|
| `probe` | — |
| `snapshot` | `--cols <n>`, `--rows <n>` |
| `trim` | `--start <t>`, `--end <t>` |
| `cut` | `--start <t>`, `--end <t>` · `--cuts <json>` · `--spec` |
| `concat` | multiple `--input` values |
| `resize` | `--ratio <9:16\|1:1\|16:9>` |
| `normalize` | `--target <youtube\|podcast\|broadcast\|custom>`, `--lufs <n>` |
| `extract_audio` | `--format <wav\|mp3\|aac>` |
| `ffmpeg_captions` | `--text <str>`, `--fontsize <n>`, `--position <center\|top\|bottom>` |
| `rm_fillers` | `--model <tiny.en\|base.en\|medium.en\|large>` |
| `waveform_trim` | `--threshold <dB>`, `--min-silence <s>` |
| `rm_nonspeech` | `--model <base\|small\|medium>`, `--max-word-gap <s>`, `--sentence-edge <s>` |
| `crop_spec` | `--keep <start:end>` (repeatable), `--out <path>` |
| `virtual_to_original` | `--inverse` |
| `transcribe` | `--model <base.en\|medium.en>`, `--language <code>` |
| `caption` | `--style <word-by-word\|pop\|karaoke\|subtitle>` |
| `best_take` | `--model <base.en\|medium.en>`, `--min-pause <s>`, `--min-words <n>` |
| `jump_cut_detect` | `--min-pause <s>`, `--noise <dB>`, `--model <none\|base.en>` |
| `pacing` | `--model <base.en\|medium.en>`, `--window <s>`, `--slow-threshold <0-1>` |

---

## Global output flags

Available on all commands:

```bash
--json        # output result as JSON (for scripting and agent use)
--out <path>  # specify output path (default: workspace/)
--quiet       # suppress progress output, result only on stdout
```

---

## Output convention

All commands follow the same contract:

- **stdout** — the result: file path or JSON. Nothing else.
- **stderr** — errors only: `{"error":"code","message":"detail"}`
- **exit 0** on success, **exit 1** on failure

Steps are composable at the shell level — stdout of one step is the `--input` of the next:

```bash
FILE=$(montaj step rm_fillers --input clip.mp4 --model base.en)
FILE=$(montaj step trim --input "$FILE" --start 5 --end 90)
FILE=$(montaj step resize --input "$FILE" --ratio 9:16)
# $FILE is the final output path
```

Full convention details: `docs/output-convention.md`

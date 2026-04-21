# montaj — CLI

> Distributed via Homebrew. Every operation the UI performs is available from the terminal.

---

## Install & update

ffmpeg is bundled automatically via pip — no manual step required. Node.js is not — pip users must install it separately before running `montaj install ui`.

```bash
brew install theSamPadilla/montaj/montaj   # or: pip install montaj
montaj install whisper      # whisper-cpp binary + base.en model weights
montaj install ui           # npm deps + UI build (pip users only — brew handles this)
montaj install rvm          # torch/torchvision/av (pip) + RVM model weights
montaj install connectors   # pyjwt, requests, google-genai, openai (for API steps)
montaj install credentials  # interactive setup for API keys (~/.montaj/credentials.json)
montaj install all          # everything above
```

`montaj install whisper` is safe to re-run — skips the binary if already at the pinned version, skips weights if already downloaded.

### Optional dependency groups

| Group | What it installs | Required for |
|-------|-----------------|--------------|
| `whisper` | whisper-cpp binary (pinned), base.en model weights | `transcribe`, `rm_fillers`, `rm_nonspeech`, `waveform_trim`, render pipeline |
| `ui` | npm deps for `render/` and `ui/`; production UI build | `montaj serve`, render engine |
| `rvm` | torch, torchvision, av (pip) + rvm_mobilenetv3 (~15 MB) + rvm_resnet50 (~103 MB) | `remove_bg` |
| `connectors` | pyjwt, requests, google-genai, openai | `kling_generate`, `analyze_media`, `generate_image` |

Credentials are stored in `~/.montaj/credentials.json` (0600 permissions). Three modes:

```bash
montaj install credentials                                            # interactive: pick provider, enter keys
montaj install credentials --provider gemini --key api_key --value …  # scripted (CI/automation)
montaj install credentials --list                                     # show set/unset status per provider
```

```bash
montaj install whisper --model medium.en
# Download a specific whisper model instead of the default base.en
```

### Upgrade dependencies

```bash
montaj update            # upgrade everything (whisper binary, pip packages)
montaj update whisper    # re-download whisper binary if pinned version changed
montaj update pip        # pip install --upgrade for all Python packages
```

---

## Tier 1 — Workflow commands

The primary interface for most users.

```bash
montaj run ./clips --prompt "tight cuts, remove filler, 9:16"
# Runs workflows/default.json against all clips in the directory
# Pre-pass → project.json [pending] → agent pass → project.json [draft]

montaj run ./clips --workflow tight-reel --prompt "..."
# Runs a named workflow instead of the default

montaj run --workflow animations --prompt "60s animated explainer, dark theme"
# Animation project — no source footage required

montaj serve
# Start local HTTP server + open UI at http://localhost:3000

montaj serve --network
# Bind to all network interfaces — accessible to other devices on the local network.
# WARNING: only use on trusted networks (e.g. for agents running on other machines).

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


montaj step resize --input clip.mp4 --ratio 9:16     # TikTok / Reels / Shorts
montaj step resize --input clip.mp4 --ratio 1:1      # Instagram
montaj step resize --input clip.mp4 --ratio 16:9     # YouTube

montaj step normalize --input clip.mp4                           # youtube = -14 LUFS
montaj step normalize --input clip.mp4 --target podcast          # -16 LUFS
montaj step normalize --input clip.mp4 --target broadcast        # -23 LUFS
montaj step normalize --input clip.mp4 --target custom --lufs -18

montaj step extract_audio --input clip.mp4                       # default: wav
montaj step extract_audio --input clip.mp4 --format mp3
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

### Generation (external APIs)

Requires `montaj install connectors` + `montaj install credentials`. See [docs/CONNECTORS.md](./CONNECTORS.md).

```bash
montaj kling-generate --prompt "a calico cat walking through a sunlit kitchen, cinematic" --out /tmp/cat.mp4
montaj kling-generate --prompt "slow zoom in" --first-frame frame.png --out /tmp/zoom.mp4
montaj kling-generate --prompt "character walks left" --first-frame start.png --last-frame end.png --out /tmp/walk.mp4
montaj kling-generate --prompt "same style" --ref-image style1.png --ref-image style2.png --out /tmp/styled.mp4
montaj kling-generate --prompt "..." --out /tmp/pro.mp4 --mode pro --duration 10 --aspect-ratio 9:16

montaj analyze-media clip.mp4  --prompt "Describe the scene in 2 sentences."
montaj analyze-media song.mp3  --prompt "Transcribe with timestamps."
montaj analyze-media photo.jpg --prompt "Return JSON: {subject, mood, dominant_colors}" --json-output
montaj analyze-media clip.mp4  --prompt "..." --model gemini-2.5-pro    # override model
montaj analyze-media clip.mp4  --prompt "..." --out analysis.txt        # write to file

montaj generate-image --prompt "portrait, studio lighting" --out /tmp/portrait.png
montaj generate-image --prompt "same character, profile view" --ref-image /tmp/portrait.png --out /tmp/profile.png
montaj generate-image --prompt "red apple on white table" --provider openai --out /tmp/apple.png
montaj generate-image --prompt "..." --provider gemini --aspect-ratio 9:16 --out /tmp/tall.png
```

---

### Lyrics video

```bash
montaj stem-separation --input song.mp3 --stems vocals --out-dir /tmp/stems
# Isolate clean vocals via Demucs before running lyrics-sync.
# Output JSON: { "vocals": "/tmp/stems/htdemucs/song/vocals.wav", ... }

montaj lyrics-sync --input vocals.wav --lyrics lyrics.txt --model medium.en --out captions.json
# Align lyrics.txt to the audio using Whisper. Pass clean vocals, not the full mix.
# Output JSON: { segments: [...], audioInPoint: <seconds> }
# audioInPoint → set as audio.music.inPoint in project.json

montaj lyrics-render \
  --captions captions.json \
  --audio song.mp3 \
  --input background.mov \
  --position center \
  --color white \
  --fontsize 72 \
  --out preview.mp4
# Burn captions directly into video via ffmpeg drawtext (ffmpeg render path only).
# Use --preview-duration <seconds> for a short clip before committing to a full render.
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

montaj approve
# ai_video projects only — mark the storyboard as approved (writes
# storyboard.approval). Prints the message to paste into your agent's
# chat to trigger Phase 6 scene generation. Use --project PATH for an
# explicit location; --force to refresh an existing approval.
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
| `resize` | `--ratio <9:16\|1:1\|16:9>` |
| `normalize` | `--target <youtube\|podcast\|broadcast\|custom>`, `--lufs <n>` |
| `extract_audio` | `--format <wav\|mp3\|aac>` |
| `rm_fillers` | `--model <tiny.en\|base.en\|medium.en\|large>` |
| `waveform_trim` | `--threshold <dB>`, `--min-silence <s>` |
| `rm_nonspeech` | `--model <base\|small\|medium>`, `--max-word-gap <s>`, `--sentence-edge <s>` |
| `crop_spec` | `--keep <start:end>` (repeatable), `--out <path>` |
| `virtual_to_original` | `--inverse` |
| `transcribe` | `--model <base.en\|medium.en>`, `--language <code>` |
| `caption` | `--style <word-by-word\|pop\|karaoke\|subtitle>` |
| `stem-separation` | `--stems <vocals\|drums\|bass\|other>`, `--out-dir <path>` |
| `lyrics-sync` | `--lyrics <txt>`, `--model <base.en\|medium.en>`, `--out <path>`, `--start <s>`, `--end <s>` |
| `lyrics-render` | `--captions <json>`, `--audio <mp3>`, `--input <video>`, `--position <center\|top-left\|bottom-left>`, `--color <str>`, `--fontsize <px>`, `--preview-duration <s>` |
| `kling-generate` | `--prompt <text>`, `--out <path>`, `--first-frame <img>`, `--last-frame <img>`, `--ref-image <img>` (repeatable, max 3), `--duration <3-15>`, `--negative-prompt <text>`, `--sound <on\|off>`, `--aspect-ratio <16:9\|9:16\|1:1>`, `--mode <std\|pro>` |
| `analyze-media` | `<input>` (video/audio/image), `--prompt <text>`, `--model <id>`, `--json-output`, `--out <path>` |
| `generate-image` | `--prompt <text>`, `--out <path>`, `--provider <gemini\|openai>`, `--ref-image <img>` (repeatable), `--size <WxH>`, `--aspect-ratio <ratio>` (Gemini only), `--model <id>` |

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

> **Canonical docs:** https://docs.montaj.ag/cli — this file is a local quick-reference. Update the docs site in `../landing-montaj/docs/content/docs/cli.mdx` for any user-facing changes.

# montaj — CLI

> Distributed via Homebrew. Every operation the UI performs is available from the terminal.

---

## Install & update

Node.js is not installed automatically — install it separately (any install path) before running `montaj install ui`.

```bash
brew install theSamPadilla/montaj/montaj   # or: pip install montaj
montaj doctor                              # diagnose what's missing — prints the exact next steps
montaj install ui                          # build UI bundles into ~/.cache/montaj/ (brew + pip both need this)
montaj install whisper                     # whisper-cpp binary + base.en model weights
montaj install ffmpeg                      # pinned static ffmpeg/ffprobe with zscale (libzimg) for HDR
montaj install rvm                         # torch/torchvision/av (pip) + RVM model weights
montaj install connectors                  # pyjwt, requests, google-genai, openai (for API steps)
montaj credentials                         # interactive setup for API keys (~/.montaj/credentials.json)
montaj install all                         # everything above, including ffmpeg
```

First-run flow is identical for brew and pip: `montaj doctor` first to see what's missing, then act on its output — almost always `montaj install ui`.

`montaj install whisper` is safe to re-run — short-circuits if `whisper-cli` is already on PATH, skips the model download if already cached. On macOS it delegates to `brew install whisper-cpp` (bottled, fast); on Linux it prints build-from-source instructions since upstream stopped publishing pre-built tarballs.

### Optional dependency groups

| Group | What it installs | Required for |
|-------|-----------------|--------------|
| `whisper` | whisper-cli (via `brew install whisper-cpp` on macOS) + base.en model weights | `transcribe`, `rm_fillers`, `rm_nonspeech`, `waveform_trim`, render pipeline |
| `ui` | npm deps for `render/` and `ui/`; production UI build | `montaj serve`, render engine |
| `ffmpeg` | pinned static ffmpeg + ffprobe (8.1.2, with libzimg/zscale) into the managed models dir | HDR normalization (`zscale`), all ffmpeg-backed steps, render engine |
| `rvm` | torch, torchvision, av (pip) + rvm_mobilenetv3 (~15 MB) + rvm_resnet50 (~103 MB) | `remove_bg` |
| `connectors` | pyjwt, requests, google-genai, openai | `kling_generate`, `analyze_media`, `generate_image` |

Credentials are stored in `~/.montaj/credentials.json` (0600 permissions). Three modes:

```bash
montaj credentials                                            # interactive: pick provider, enter keys
montaj credentials --provider gemini --key api_key --value …  # scripted (CI/automation)
montaj credentials --list                                     # show set/unset status per provider
```

```bash
montaj install whisper --model medium.en
# Download a specific whisper model instead of the default base.en
```

### Dependency health check

```bash
montaj doctor
# Check all system dependencies. Exit 0 = OK, exit 1 = issues.
# Checks: ffmpeg (version + required filters via word-boundary match),
#          ffprobe, node, python3, whisper (optional).
# Required ffmpeg filters: zscale, tonemap, overlay, scale, format, amix, adelay
# Recommended ffmpeg filters: sidechaincompress (audio ducking)
```

### Managed ffmpeg

```bash
montaj install ffmpeg
# Downloads the pinned, checksum-verified static ffmpeg/ffprobe build
# (8.1.2, with libzimg/zscale) into ~/.local/share/montaj/models/ffmpeg/.
# Included in `montaj install all`.
```

Every step and the render engine resolve the ffmpeg/ffprobe binary via a fixed
precedence: `MONTAJ_FFMPEG`/`MONTAJ_FFPROBE` env override → the managed build
above → whatever `ffmpeg`/`ffprobe` is on `PATH`. `montaj doctor` reports which
one is actually in use (e.g. `(managed: ~/.local/share/montaj/models/ffmpeg/ffmpeg)`)
and, if `zscale` is missing, points at `montaj install ffmpeg` as the fix.

### Normalize a video clip

```bash
montaj normalize video.mov
# Normalize a video clip to the project's working color space.
# Default color space is sdr_bt709 (H.264 yuv420p bt709, 48kHz audio).
# Creates _normalized_<colorSpace>.mp4 alongside the original.

montaj normalize video.mov --color-space hdr_hlg
# Force HDR HLG output (libx265 yuv420p10le bt2020/HLG).
# Used when the source is HDR and you want to keep it HDR.

montaj normalize video.mov --color-space hdr_pq
# Force HDR PQ output (libx265 yuv420p10le bt2020/PQ + HDR10 metadata).

montaj normalize video.mov --out /tmp/normalized.mp4
# Custom output path
```

### Upgrade dependencies

```bash
montaj update            # upgrade everything (whisper binary, pip packages)
montaj update whisper    # brew upgrade whisper-cpp on macOS; build-from-source hint on Linux
montaj update pip        # pip install --upgrade montaj
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

montaj serve --debug
# Stream subprocess stderr (project init, etc.) live to the server's stderr
# for observability. Default: subprocess stderr is buffered and only surfaced
# on error. Equivalent to setting MONTAJ_DEBUG=1.

montaj render
# Render project.json [final] → final.mp4
# Uses project.json in the current directory by default

montaj render --project ./workspace/project.json --out ./output/final.mp4
# Explicit paths

montaj render --clean
# Delete intermediate files (base.mp4, per-segment WebMs) after compositing

montaj render --image-tone vivid
# Color mapping for overlay images in HDR renders (vivid | broadcast | punchy | raw)
# vivid (default): true colors at full graphics brightness. broadcast: BT.2408
# 203-nit graphics white (dimmer, TV-standard). punchy: legacy contrast with
# corrected color. raw: no conversion (legacy oversaturated look).
# Overrides settings.imageTone in project.json; ignored for SDR projects.

montaj render --export sdr
# Which deliverable(s) an HDR project renders (auto | sdr | both).
# auto (default): HDR master only. sdr: a single SDR file tone-mapped
# through --sdr-curve. both: the HDR master plus a derived SDR sibling.
# Ignored for SDR projects.

montaj render --sdr-curve vivid1-neutral
# Look curve used to derive the SDR rendition (with --export sdr|both).
# Choices: vivid1 | vivid1-neutral. Defaults to the project's master look.
```

`montaj run` works headlessly — no UI, no `montaj serve` required. The full pipeline runs in-process.

### Render pipeline internals

`montaj render` runs three stages:

1. **Normalize + base video** — normalize all sources to the project's working color space (`settings.colorSpace`), then trim and prepare source clips. Canvas projects (no video track) generate a synthetic black base from overlay durations.
2. **Overlay segments** — each JSX overlay is bundled with esbuild, rendered frame-by-frame in headless Chromium (Puppeteer), and encoded to a lossless ffv1/MKV intermediate. Segments are rendered at **design resolution (1080×1920)** regardless of output resolution — the pipeline upscales at compose time.
3. **Compose** — a segment-based pipeline encodes each timeline segment independently, concats them via the ffmpeg concat demuxer (`-c:v copy`), then mixes audio tracks. The codec and color metadata follow the project's color space: `sdr_bt709` projects emit H.264 yuv420p bt709; `hdr_hlg`/`hdr_pq` projects emit HEVC 10-bit yuv420p10le bt2020. For 4K output (2160×3840) segments are upscaled 2× before compositing.

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

---

## Sample — fast preview PNG without a full render

Two commands for visual inspection without running a complete render. The production render pipeline is unchanged.

### `montaj sample overlay`

Renders one frame of an overlay JSX through Puppeteer (same path as the production renderer) and writes a PNG. ~3s wall time.

```bash
montaj sample overlay <overlay.jsx> --out <path.png>
# Render frame 0 at 1080×1920 (defaults)

montaj sample overlay <overlay.jsx> --frame 30 --out /tmp/frame30.png
# Render frame 30 (e.g. to check an animated state)

montaj sample overlay <overlay.jsx> --measure --out /tmp/check.png
# Also return per-element bbox + overflow data as JSON on stdout
```

**Args:**

| Arg | Default | Description |
|-----|---------|-------------|
| `<overlay.jsx>` | — | Path to the JSX overlay file |
| `--out <path.png>` | required | Output PNG path |
| `--frame <N>` | 0 | Frame number to render |
| `--width <W>` | 1080 | Canvas width in pixels |
| `--height <H>` | 1920 | Canvas height in pixels |
| `--props <JSON>` | `{}` | Props to pass to the overlay component |
| `--google-fonts <spec>` | — | Comma-separated Google Fonts spec (e.g. `Syne:wght@800`) |
| `--measure` | off | Walk the DOM and return per-element bounding-box + overflow data |

**Output (no `--measure`):** the absolute PNG path on stdout.

**Output (`--measure`):** a single JSON object on stdout:
```json
{
  "pngPath": "/tmp/check.png",
  "measurements": {
    "anyOverflow": true,
    "viewport": { "w": 1080, "h": 1920 },
    "texts": [
      {
        "text": "RECURSIVE",
        "tag": "DIV",
        "fontFamily": "Syne, sans-serif",
        "fontSize": "160px",
        "fontWeight": "800",
        "position": "static",
        "transform": "matrix(1, 0, 0, 1, 0, 0)",
        "bbox": { "x": -257, "y": 740, "w": 1594, "h": 154 },
        "overflow": { "left": 257, "right": 257, "top": 0, "bottom": 0 },
        "clippingAncestor": null
      }
    ]
  }
}
```

`anyOverflow` is the go/no-go boolean. Any non-zero `overflow.{left,right,top,bottom}` on any element drives it `true`. Check `clippingAncestor` — a non-null value means the element is the child of an `overflow: hidden` parent (intentional for animation sections that clip entering/exiting elements); in that case compute `intersect(elementBbox, clippingAncestor.bbox)` for effective overflow.

**Caching:** results are content-hash cached under `${tmpdir()}/montaj-sample-cache/` (24h GC). Unchanged inputs return immediately; a changed JSX always re-renders.

**Example — check a Google Font overlay before adding it to the project:**
```bash
montaj sample overlay ~/.montaj/overlays/headline.jsx \
  --google-fonts "Syne:wght@800" \
  --measure \
  --out /tmp/headline-check.png
# Read stdout: if measurements.anyOverflow is true, the text overflows at render time.
```

### `montaj sample frame`

Renders the fully composited frame at a given timestamp: active video clip + active image items + active overlay JSXs, all at project resolution. ~10–30s wall time.

```bash
montaj sample frame <project.json> --at <seconds>
# Default output: <project_dir>/render/samples/frame-<t>s.png

montaj sample frame <project.json> --at 5.5 --out /tmp/frame5.5.png
# Explicit output path
```

**Args:**

| Arg | Default | Description |
|-----|---------|-------------|
| `<project.json>` | — | Path to project.json |
| `--at <seconds>` | required | Timestamp in seconds to sample |
| `--out <path.png>` | `<project_dir>/render/samples/frame-<at>s.png` | Output PNG path |

**Output:** the absolute PNG path on stdout.

**Notes:**
- Video seek is accurate (`-ss` after `-i`), not keyframe seek — the frame you ask for is the frame you get, at the cost of ~5–10s on long HEVC sources.
- HDR projects produce sRGB BT.709 PNGs (tonemapped). Production renders still emit correctly-tagged HDR output; samples are always display-correct for human/agent inspection.
- A timestamp that falls in a timeline gap produces an all-black frame (no error). A timestamp past project end returns an error.
- The command is read-only: no writes to project.json, no changes to render intermediates.

**Example — verify an overlay doesn't cover the speaker's face at t=5.5:**
```bash
montaj sample frame ./my-project/project.json --at 5.5 --out /tmp/t5.5.png
# Inspect /tmp/t5.5.png to see the full composite at that moment.
```

---

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
montaj step materialize_cut --input clip.mp4 --inpoint 2.5 --outpoint 8.3
# Keep only inpoint→outpoint and encode a real H.264 clip

montaj step materialize_cut --input clip.mp4 --cuts '[[0,1.2],[5.3,7.8]]'
# Remove multiple sections in one ffmpeg pass — keeps go 1.2→5.3 and 7.8→end

montaj step materialize_cut --input clip.mp4 --audio
# Audio-only output, no video stream — .wav by default (aac if --out ends in another extension)

montaj step waveform_trim --input clip.mp4 > spec.json
montaj step materialize_cut --input spec.json
# waveform_trim only detects silence and writes a trim spec {input, keeps} —
# no encode happens until materialize_cut consumes it


montaj step resize --input clip.mp4 --ratio 9:16     # TikTok / Reels / Shorts
montaj step resize --input clip.mp4 --ratio 1:1      # Instagram
montaj step resize --input clip.mp4 --ratio 16:9     # YouTube

montaj step reframe --input clip.mp4 --target 9:16
# resize encodes a new (letterboxed) file; reframe computes a crop spec to write
# onto a project clip item instead — no encode. Rotation-aware: gates and computes
# off the source's DISPLAY dimensions, never its coded width/height.
# → {"sourceCrop":{"x":0.3418,"y":0.0,"w":0.3164,"h":1.0},"sourceWidth":1920,"sourceHeight":1080,...}

montaj step reframe --input rotated_iphone_clip.mov --target 9:16
# Rotated iPhone clip: codes 1920x1080 but displays 1080x1920 (already 9:16) — no crop needed
# → {"sourceCrop":null,"sourceWidth":1080,"sourceHeight":1920,...}

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

Requires `montaj install connectors` + `montaj credentials`. See [docs/CONNECTORS.md](./CONNECTORS.md).

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
# audioInPoint → set as audio.tracks[0].inPoint in project.json

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

montaj init --prompt "..." --color-space hdr_hlg
# Force the project's working color space. Default is `auto`, which picks
# the MODAL (most common) color space across clips — outliers are
# converted on the fly. 27 HLG + 1 SDR → hdr_hlg (the SDR clip is stretched).
# Tiebreaks: PQ wins HDR-only ties; SDR wins SDR-vs-HDR ties.
# Choices: auto | sdr_bt709 | hdr_hlg | hdr_pq.
# Peer of --resolution.

montaj init --prompt "..." --no-proxy
# Skip editing-proxy generation entirely. The editor falls back to playing
# masters; proxies can be backfilled later via POST /api/proxy or
# `montaj step proxy`. Also settable per-workflow with "proxy": false.

montaj init --prompt "..." --proxy-inline-max 120
# Max source duration (seconds) proxied inline during init; longer sources
# defer to the backfill job so project creation never blocks on a long
# encode. Default 480.

montaj status
# Show current project.json state (pending / draft / final) + step progress

montaj approve
# ai_video projects only — mark the storyboard as approved (writes
# storyboard.approval). Prints the message to paste into your agent's
# chat to trigger Phase 6 scene generation. Use --project PATH for an
# explicit location; --force to refresh an existing approval.

montaj clean --proxies --dry-run
# List every editing proxy (*_proxy_*.mp4) and superseded look-tagged
# normalized master for the current project plus the shared source store
# (~/Montaj/.sources/), with sizes. Nothing is deleted without --yes.

montaj clean --proxies --yes
# Delete them, and clear the now-stale proxySrc pointers from project.json so
# the editor falls back to the full-quality master. Proxies are disposable —
# they regenerate at next import or via POST /api/proxy.

montaj clean --proxies --project ./workspace/2026-08-14-my-edit
montaj clean --proxies --all-projects
# Scope to one project directory, or the whole workspace root.
```

---

## Steps

Most built-in steps accept `--out <path>` to set the output location; a few
write JSON to stdout instead (`probe`, `waveform_peaks`) or take `--out-dir`
(`filmstrip`, `shot_sheet`). Run `montaj step <name> --help` for a step's
exact flags. Full per-step parameter docs: https://docs.montaj.ag/steps

| Directory | Steps |
|-----------|-------|
| `steps/audio/` | `extract_audio`, `mix_timeline`, `stem_separation`, `waveform_image`, `waveform_peaks`, `waveform_trim` |
| `steps/edit/` | `cross_cut`, `jump_cut`, `montage` |
| `steps/generate/` | `generate_image`, `generate_music`, `generate_voiceover`, `kling_generate` |
| `steps/lyrics/` | `caption`, `lyrics_render`, `lyrics_sync` |
| `steps/media/` | `analyze_media`, `detect_shots`, `fetch`, `fetch_image`, `filmstrip`, `normalize`, `probe`, `search_images`, `search_news`, `shot_sheet`, `snapshot` |
| `steps/render/` | `sample_frame`, `sample_overlay` |
| `steps/speech/` | `rm_fillers`, `rm_nonspeech`, `transcribe` |
| `steps/transform/` | `crop_spec`, `generate_captions`, `materialize_cut`, `normalize_window`, `proxy`, `reframe`, `remove_bg`, `resize`, `virtual_to_original` |

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
FILE=$(montaj step materialize_cut --input "$FILE" --inpoint 5 --outpoint 90)
FILE=$(montaj step resize --input "$FILE" --ratio 9:16)
# $FILE is the final output path
```

Full convention details: `docs/output-convention.md`

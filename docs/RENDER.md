> **Canonical docs:** https://docs.montaj.ag/render — this file is a local quick-reference. Update the docs site in `../landing-montaj/docs/content/docs/render.mdx` for any user-facing changes.

# Render Engine Architecture

The render engine lives in `render/` and is invoked as:

```
node render/render.js <project.json> [--out <path>] [--workers <n>] [--clean]
```

`stdout`: absolute path to the final MP4.
`stderr`: progress lines.
`exit 1` + JSON error on failure.

Project status must be `"final"` before rendering. The render is non-destructive — source files are never modified.

---

## Pipeline (render.js)

```
project.json
    │
    ├─ 1. Validate + resolve paths
    ├─ 2. Collect segment specs + video/image items
    ├─ 3. processVideoItems (remove_bg if flagged)
    ├─ 4. Bundle JSX → HTML  (bundle.js, one per overlay/caption)
    ├─ 5. Render HTML → NUT/FFV1  (renderer.js, Puppeteer pool)
    ├─ 6. Probe source video dimensions → pixelRatio
    └─ 7. compose()  →  final.mp4
```

### Step 4 — JSX bundling (bundle.js)

Each overlay/caption JSX component is compiled into a self-contained HTML page. The page exposes `window.__setFrame(n)` so Puppeteer can drive it frame-by-frame. A temporary work directory is created per segment and cleaned up after rendering.

### Step 5 — Puppeteer rendering (renderer.js)

A pool of N Chromium browsers (default: `os.cpus().length`, cap at job count) renders each segment in parallel.

**Per-job flow:**
1. Open a new page, set viewport to design resolution (1080×1920).
2. Navigate to the bundled HTML file.
3. For each frame: call `window.__setFrame(f)`, wait for `data-rendered-frame` attribute to confirm paint, double-rAF to ensure compositor flush, screenshot to PNG.
4. Encode PNG sequence → FFV1 in a **MKV container** (see Container Choice below).
5. If a segment exceeds `chunkSize` frames, it is split into chunks and concatenated after encoding.

**Browser recycling:** each worker restarts its browser every 5 jobs (`RECYCLE_AFTER = 5`). After many segments, browser processes accumulate memory and can start timing out on `page.evaluate()` calls. Recycling flushes that state.

**Segment directory:** always wiped at the start of each render (`render/segments/`). Stale files from a failed previous run cause FFV1 decode errors during compose — never rely on leftover segment files.

#### Container choice: MKV with finite-size clusters

Puppeteer segments are stored as **FFV1 in MKV** (`.mkv`) with two muxer flags:

```
-cluster_size_limit 2000000   # finite-size clusters
-reserve_index_space 1000000  # seek index written at file start
-g 1                          # all-keyframe FFV1 → cue point per frame
```

**Why not plain MKV?** The default MKV muxer writes Cluster elements with EBML unknown-size encoding. Under concurrent heavy decode (multiple segment files open simultaneously in the ffmpeg filter graph) this produces:

```
[matroska,webm] Unknown-sized element at 0x... inside parent with finite size
[ffv1] Slice pointer chain broken
Error submitting packet to decoder: Invalid data found when processing input
```

**Why not NUT?** NUT was the previous container choice (simpler than MKV, no EBML). However, the NUT muxer fails to write a proper end-of-file seek index for large files. When overlay animation frames are large (>32 KB each, typical for complex 1080×1920 content), the NUT demuxer's mandatory backward timestamp scan encounters frames without packet checksums and fails:

```
[nut] no index at the end
[nut] read_timestamp failed.
[nut] frame size > 2max_distance and no checksum
[in#N/nut] Error during demuxing: Invalid data found when processing input
```

This corruption happens during `avformat_open_input()`, leaving the demuxer state broken for all subsequent frame reads.

**Fix: MKV with `-cluster_size_limit 2000000`** forces finite-size clusters, eliminating the EBML unknown-size issue. Combined with:
- `-reserve_index_space 1000000` — seek index at the start of the file; the demuxer finds timestamps without backward scanning
- `-g 1` — every FFV1 frame is a keyframe, so the MKV muxer places a cue point before every frame for accurate per-frame seeking in the compose filter graph

---

## Project Color Space

Each project has an explicit working **color space** stored at
`settings.colorSpace` in `project.json`. This setting drives the codec, pixel
format, and color metadata the entire render pipeline emits — from the
normalize pre-pass through the segment encoder to the final concat.

Three color spaces are supported:

| Key | Encoder | Pixel format | Transfer | Typical source |
|---|---|---|---|---|
| `sdr_bt709` | `libx264` | `yuv420p` | `bt709` | most non-HDR footage |
| `hdr_hlg` | `libx265` | `yuv420p10le` | `arib-std-b67` | iPhone "HDR Video" default |
| `hdr_pq` | `libx265` | `yuv420p10le` | `smpte2084` | iPhone "Dolby Vision", HDR10 |

The taxonomy lives in `montaj_assets/schemas/color_space.json` and is loaded by both
the Python pipeline (`lib/types/colorspace.py`) and the JS render engine
(`montaj_assets/render/color-space.js`). One file, two loaders — no JS/Python
drift.

**Smart-detect at init.** When clips are added to a project (`montaj run` or
`montaj init`), each clip's `color_transfer` is probed and the project color
space is the **modal** (most common) value across all clips. Outliers get
converted on the fly: HDR sources in an SDR project are tonemapped per-segment;
SDR sources in an HDR project are stretched into the HDR container. This
matches the FCP/Resolve pattern — a single SDR clip in an iPhone-HDR project
is treated as SDR-graded content shown on an HDR canvas, not a reason to flip
the entire project down to SDR.

- All clips HLG → `hdr_hlg`.
- All clips PQ → `hdr_pq`.
- 27 HLG + 1 SDR → `hdr_hlg` (modal wins; the 1 SDR clip is stretched into HLG).
- 27 SDR + 1 HLG → `sdr_bt709` (modal wins; the 1 HLG clip is tonemapped).
- Tied modes — tiebreaks:
  - HLG + PQ tied (HDR only) → `hdr_pq` (larger gamut; HLG converts cleanly into PQ).
  - SDR + HDR tied (no clear majority) → `sdr_bt709` (conservative — tonemap-down
    is well-defined, inverse-stretch is creative when there's no signal of intent).
- No clips probed → `sdr_bt709` default.

**Override.** Pass `--color-space {sdr_bt709|hdr_hlg|hdr_pq|auto}` to
`montaj init` (default `auto` runs the smart-detect rules above), or include
`"colorSpace"` in the HTTP intake JSON, to force a specific working space
regardless of source detection.

**Per-color-space behavior in the segment encoder.** `encode-segment.js`
reads `settings.colorSpace` and looks up the spec at compose time. SDR
projects emit `libx264 yuv420p` with `bt709` color metadata; HDR projects
emit `libx265 yuv420p10le` with `bt2020nc` colorimetry plus the appropriate
transfer (`arib-std-b67` for HLG, `smpte2084` for PQ with static HDR10
mastering metadata). Sources whose color space conflicts with the project
are converted at the per-item filter chain in the segment encoder
(zscale-based tonemap for HDR→SDR; stretch into HDR container for SDR→HDR;
HLG↔PQ via zscale transfer-curve conversion).

---

## Step 6.5 — Normalize pre-pass

After `collectAllItems` (Step 2) and before `processVideoItems` (Step 3), the
render engine runs a **normalize pre-pass** on all video items. This is
enforcement point 3 — the render pipeline refuses to compose sources that
don't match the project's working color space.

The normalize pre-pass is now **color-space-aware**. A source is conformant
when its `color_transfer` and bit depth match the project's working color
space spec, and its keyframe interval is ≤ 2.0s (required for the segment
encoder's input-level fast seek). When all three hold, the source passes
through with no transcode — iPhone HDR HLG clips in an `hdr_hlg` project are
essentially a no-op at intake.

When a source conflicts, normalize emits the project's working format using
the encoder/pix_fmt/color args from the color-space spec:

- **`sdr_bt709` project:** `libx264 -pix_fmt yuv420p` with `bt709` stream
  metadata. HDR sources are tonemapped via `zscale` + `tonemap` (with a bare
  tonemap fallback when `zscale` is missing — accompanied by a loud warning).
- **`hdr_hlg` project:** `libx265 -pix_fmt yuv420p10le` with `bt2020nc` /
  `arib-std-b67` stream metadata.
- **`hdr_pq` project:** `libx265 -pix_fmt yuv420p10le` with `bt2020nc` /
  `smpte2084` stream metadata + static HDR10 mastering metadata.

All paths emit AAC 48 kHz audio and force IDR keyframes every ~1s (`-g <fps>
-keyint_min <fps>`).

**Resolution is preserved.** Source clips remain at their native resolution
through the entire pipeline; the segment encoder scales per-item at compose
time via the `scale=` filter in `encode-segment.js`. This avoids the permanent
quality loss of intake-time downscaling and preserves headroom for crops,
zooms, and re-frames.

**Parallel execution:** Both init-time and render-time pre-pass normalize
loops run with concurrency cap of 2. Memory-heavy 4K HDR encodes are the worst
case; 2 workers stays within bounds on systems with ≥8GB free RAM. The cap
applies to both libx264 (SDR projects) and libx265 (HDR projects) — both are
preset-bound CPU encodes.

The normalize step creates `_normalized_<colorSpace>.mp4` files alongside the
originals (e.g. `clip_normalized_sdr_bt709.mp4` or
`clip_normalized_hdr_hlg.mp4`) — originals are never modified and are
preserved for potential re-export. Namespacing by color space lets a project
flip between SDR and HDR without colliding with cached normalize output. The
`lib/normalize.py` module is the shared infrastructure backing this (also
used by `project/init.py` for ingest-time normalization and `steps/ai_video.py`
for generated clip normalization).

After normalization, every source entering the compose pipeline conforms to
the project's working color space. The segment encoder still handles per-item
scaling at compose time, and applies in-line color conversion for any source
that arrives in a different color space than the project (the render engine
remains permissive — sources that didn't pass through intake-time normalize
are converted lazily). Resolution is intentionally NOT unified at intake.

---

## Step 7 — Compositing (segment-based pipeline)

Compositing uses a **segment-based pipeline** that replaces the previous monolithic `filter_complex` approach. The pipeline has three stages: plan, encode, concat.

### Overview

```
normalized video items + Puppeteer segments
    │
    ├─ 1. segment-plan.js   → plan segments at clip/overlay boundaries
    ├─ 2. encode-segment.js → encode each segment independently
    ├─ 3. ffmpeg concat      → join segments via concat demuxer
    └─ 4. mix-audio.js       → mix independent audio tracks (unchanged)
```

### Stage 1 — Segment planning (segment-plan.js)

The timeline is divided into **segments** at every clip and overlay boundary. Each segment is a contiguous time range where the set of active layers does not change. Within a segment, the stack of layers is fixed — N video/image items ordered by `trackIdx`, plus any overlays and captions active during that time window.

Boundary snapping ensures clean cuts — segment boundaries align to frame boundaries at the project frame rate.

### Stage 2 — Segment encoding (encode-segment.js)

Each segment is encoded independently with its own ffmpeg call. The filter graph
for a single segment layers items by `trackIdx` (lowest first), then composites
overlays and captions on top. Items at non-project resolution are scaled by the
per-item `scale=` filter — this is what enables source-resolution preservation
at intake.

Segments are encoded in parallel using the worker pool.

### Stage 3 — Concat via demuxer

All encoded segments are joined using the **ffmpeg concat demuxer** with:

```
-c:v copy    # no re-encode — segments share the project's working codec
-c:a aac     # audio re-encoded to ensure consistent stream format
```

Because every segment in a single render is encoded to the project's working
codec (`libx264` for SDR projects, `libx265` for HDR projects), stream-copy
concat is safe — the concat invariant holds per-project, not globally. This
is a near-instant operation since the video stream is copied verbatim.

### Stage 4 — Audio mixing (mix-audio.js)

Independent audio tracks (music, voiceover, sound effects) are mixed in a final pass. This stage is unchanged from the previous pipeline — it handles volume, ducking (`sidechaincompress`), delay offsets, and in/out points.

### Debugging: `MONTAJ_KEEP_SEGMENTS=1`

By default, intermediate segment files are cleaned up after a successful concat. Set the environment variable `MONTAJ_KEEP_SEGMENTS=1` to preserve them for inspection:

```bash
MONTAJ_KEEP_SEGMENTS=1 montaj render
```

Segment files are written to `render/segments/` within the project directory.

### Clip seeking: `-ss` / `-t`

Each video clip is fed as:

```
-ss <actualInPoint> -t <duration> -i <src>
```

**Use `-t duration` (not `-to`).** After normalization, all clips have frequent keyframes (every 1s), so `-ss` lands accurately. `-t` stops after reading `duration` seconds of content, or at EOF — whichever comes first. This is safer than `-to` for clips where the source is shorter than the timeline slot (e.g., a 24fps clip normalized to 30fps may lose frames at the tail). With `-to`, ffmpeg would hold the last frame past EOF; `-t` simply stops.

### Output encoding

Per-segment encoding follows the project's color space (see *Project Color
Space* above). Within a single render every segment shares one codec and pix
format, so the concat demuxer can stream-copy video without re-encoding:

- **SDR projects (`sdr_bt709`):** `libx264 -preset fast -crf 18 -pix_fmt
  yuv420p` with `bt709` stream-level color metadata.
- **HDR projects (`hdr_hlg`, `hdr_pq`):** `libx265 -preset fast -crf 22
  -pix_fmt yuv420p10le` with `bt2020nc` colorimetry plus the project's
  transfer curve (`arib-std-b67` for HLG, `smpte2084` + static HDR10
  mastering metadata for PQ).

Per-frame `setparams` and per-stream color args come from the color-space
spec in `montaj_assets/schemas/color_space.json`, ensuring downstream players read the
same colorimetry the encoder produced.

---

## File layout

```
<project>/
└── render/
    ├── segments/           Puppeteer FFV1/MKV files + composed segment files
    │   ├── <id>-chunk-0.mkv    (Puppeteer renders)
    │   ├── seg-000.mp4         (composed segments, cleaned unless MONTAJ_KEEP_SEGMENTS=1)
    │   └── ...
    └── final.mp4           Final output
```

---

## Known failure modes

| Error | Cause | Fix |
|-------|-------|-----|
| `Runtime.callFunctionOn timed out` | Browser memory-saturated after many segments | Browser recycles every 5 jobs; reduce `--workers` if still failing |
| `Network.enable timed out` | Chromium failed to launch (memory pressure) | Reduce `--workers`; increase `protocolTimeout` in `renderer.js` |
| `Unknown-sized element` / `Slice pointer chain broken` | Default MKV Cluster EBML unknown-size encoding under concurrent decode | Fixed by `-cluster_size_limit 2000000` in the MKV muxer (Puppeteer segment encoding) |
| Clips trimmed short at cut points | Sparse keyframes caused seek overshoot | Fixed by normalize pre-pass (keyframes every 1s) + `-t duration` in segment encoder |
| Mixed HDR/SDR in compose causes color shifts | HDR and SDR sources with different pixel formats, color spaces, or transfer functions in the same filter graph | Fixed by project-color-space contract — every source is converted to the project's working color space (at intake or per-item in the segment encoder) before composing |
| `no index at the end` / `frame size > 2max_distance and no checksum` / `Invalid data found when processing input` (NUT demux) | NUT muxer fails to write end-of-file seek index for large files; backward timestamp scan hits large frames without checksums, corrupting demuxer state | Fixed by switching Puppeteer segments from NUT to MKV with `-cluster_size_limit 2000000 -reserve_index_space 1000000 -g 1` |

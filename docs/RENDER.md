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

## Step 7 — Compositing (compose.js)

`compose()` builds a single ffmpeg `filter_complex` command that layers everything onto a black canvas.

### Normal path vs chunked path

```
videoItems.length > CHUNK_VIDEO_THRESHOLD (5)?
    yes → composeChunked()   splits timeline into 30s passes
    no  → compose() directly
```

**Critical:** `composeChunked` calls `compose()` with `_lossless: true` for each chunk. The `_lossless` flag suppresses the threshold check inside `compose()`, preventing infinite recursion. Never remove that guard.

### Filter graph construction

```
color=black (canvas)
    │
    ├─ format=yuv420p10le
    │
    ├─ [each video item]  setpts → scale → overlay (enable=between(t,...))
    │       └─ audio: asetpts → adelay → amix
    │
    ├─ [each Puppeteer segment]  format=yuva420p → scale → overlay
    │
    └─ [music if present]  volume → amix  (+ sidechaincompress if ducking)
```

### Output duration cap: `-t totalDuration`

The compose command adds `-t ${totalDuration}` to the ffmpeg output. This is required.

`overlay=shortest=0` keeps the base video running until the LONGEST input ends. A Puppeteer segment that spans a chunk boundary (e.g., overlay starts at 27.7s and the chunk ends at 30s, but the segment file is 3.1s long) extends past the canvas's intended end. Without the cap, the chunk output is longer than 30s — typically 27–30 extra frames — which causes audio/video desync that compounds across chunk boundaries.

`-t totalDuration` stops the encoder at exactly the canvas duration regardless of how long any individual input runs.

### Clip seeking: `-ss` / `-to`

Each video clip is fed as:

```
-ss <inPoint> -to <outPoint> -i <src>
```

**Use `-to outPoint` (absolute file timestamp), not `-t duration`.** Fast seek (`-ss` before `-i`) lands on the nearest keyframe before `inPoint`. `-t` measures duration from that keyframe, not from `inPoint` — if the keyframe is 0.3s early, the clip is silently trimmed 0.3s short at the end. `-to` stops at the absolute file timestamp regardless of where the keyframe landed.

### Lossless chunk intermediates

When chunking, each pass writes an FFV1 MKV intermediate. These use `-reserve_index_space 1000000` to ensure a proper seek index is written at the start, required by ffmpeg's concat demuxer.

### Output encoding

Final H.264 MP4:

```
libx264 -preset fast -crf 18 -pix_fmt yuv420p
```

Color metadata is stamped **inside the filter graph** via a `setparams` filter appended as the last step before the output:

```
setparams=colorspace=bt709:color_trc=arib-std-b67:color_primaries=bt2020
```

#### Why setparams, not output stream flags

The filter graph starts with a `color=black` canvas which has no color metadata. ffmpeg propagates the canvas's unset color info to the output, silently overriding any `-colorspace`/`-color_trc`/`-color_primaries` flags set on the output stream. `setparams` is applied within the filter chain itself, so it takes precedence.

**This applies in two places:**

1. **Non-chunked path** (`compose()`): `setparams` is appended as the last filter step before `[vout_sp]` and the output is mapped from that label.
2. **Chunked path** (`concatVideoFiles()`): the lossless FFV1 MKV chunks go through a `color=black` filter graph with `_lossless: true` (no `setparams`), so their color metadata is unset. The output stream flags in `concatVideoFiles` do NOT override unset source metadata — only `-vf setparams=...` does. A `-vf` filter is therefore added to the final H.264 re-encode in `concatVideoFiles`.

#### Why these specific values

iPhone HEVC source footage is BT.2020/HLG 10-bit (`color_space: bt2020nc`, `color_transfer: arib-std-b67`, `color_primaries: bt2020`). The filter graph does not apply any gamma conversion — the implicit 10-bit→8-bit downscale just truncates values. So the output pixel values are still HLG-encoded.

- `colorspace=bt709` — corrects the YCbCr matrix coefficient (bt2020nc → bt709). Without this, the yellowish cast from the wrong matrix is visible.
- `color_trc=arib-std-b67` — preserves the HLG transfer function. If this were set to `bt709`, players would apply SDR gamma to HLG-encoded values → washed/pale output.
- `color_primaries=bt2020` — preserves the source primaries. These are kept as-is; only the matrix is corrected.

**Do not add zscale or tonemap filters** — tested and the raw + metadata approach produces better visual output than any tone-mapping chain (hable, bt2390 etc.).

---

## File layout

```
<project>/
└── render/
    ├── segments/           Puppeteer FFV1/MKV files (wiped each run)
    │   ├── <id>-chunk-0.mkv
    │   └── ...
    ├── output_chunk0.mkv   Lossless compose intermediates (if chunked)
    ├── output_chunk1.mkv
    └── final.mp4           Final output
```

---

## Known failure modes

| Error | Cause | Fix |
|-------|-------|-----|
| `Runtime.callFunctionOn timed out` | Browser memory-saturated after many segments | Browser recycles every 5 jobs; reduce `--workers` if still failing |
| `Network.enable timed out` | Chromium failed to launch (memory pressure) | Reduce `--workers`; increase `protocolTimeout` in `renderer.js` |
| `Unknown-sized element` / `Slice pointer chain broken` | Default MKV Cluster EBML unknown-size encoding under concurrent decode | Fixed by `-cluster_size_limit 2000000` in the MKV muxer (Puppeteer segment encoding) |
| `Maximum call stack size exceeded` in compose | Recursive `composeChunked → compose → composeChunked` | Fixed by `!_lossless` guard in the chunk threshold check |
| Clips trimmed short at cut points | `-t duration` measured from keyframe, not `inPoint` | Fixed by using `-to outPoint` instead |
| Pale/yellowish output color | `color=black` canvas clears color metadata; output stream flags (`-colorspace` etc.) cannot override unset source metadata | Fixed via `setparams=colorspace=bt709:color_trc=arib-std-b67:color_primaries=bt2020` inside the filter graph for the non-chunked path, and via `-vf setparams=...` in `concatVideoFiles` for the chunked path |
| `no index at the end` / `frame size > 2max_distance and no checksum` / `Invalid data found when processing input` (NUT demux) | NUT muxer fails to write end-of-file seek index for large files; backward timestamp scan hits large frames without checksums, corrupting demuxer state | Fixed by switching Puppeteer segments from NUT to MKV with `-cluster_size_limit 2000000 -reserve_index_space 1000000 -g 1` |
| Audio drifts out of sync / final video too long | `overlay=shortest=0` lets Puppeteer NUT files that span a chunk boundary extend the chunk output beyond its intended duration | Fixed by `-t totalDuration` on the ffmpeg output in `compose()`, capping each pass at exactly the canvas duration |

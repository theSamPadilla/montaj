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

## Step 6.5 — Normalize pre-pass

After `collectAllItems` (Step 2) and before `processVideoItems` (Step 3), the render engine runs a **normalize pre-pass** on all video items. This is enforcement point 3 — the render pipeline refuses to compose non-normalized sources.

Each video clip is checked and, if needed, converted to the project's working format:

- **Codec:** H.264 (`libx264`)
- **Pixel format:** `yuv420p`
- **Color space:** BT.709 (HDR sources are tonemapped via `zscale` + `tonemap` if available, with a fallback path if `zscale` is missing)
- **Resolution:** project resolution (e.g. 1080x1920)
- **Frame rate:** project fps (e.g. 30)
- **Audio:** 48 kHz, AAC

The normalize step creates `_normalized.mp4` files alongside the originals — originals are never modified and are preserved for potential re-export at different settings. The `lib/normalize.py` module is the shared infrastructure backing this (also used by `project/init.py` for ingest-time normalization and `steps/ai_video.py` for generated clip normalization).

After normalization, all sources entering the compose pipeline are guaranteed to share the same codec, pixel format, color space, resolution, and frame rate. This eliminates an entire class of filter graph bugs (mixed HDR/SDR, mismatched resolutions, incompatible pixel formats).

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

Each segment is encoded independently with its own ffmpeg call. The filter graph for a single segment layers items by `trackIdx` (lowest first), then composites overlays and captions on top. Because all sources are pre-normalized to the same format, the per-segment filter graph is simple — no format conversion, no resolution scaling, no HDR handling.

Segments are encoded in parallel using the worker pool.

### Stage 3 — Concat via demuxer

All encoded segments are joined using the **ffmpeg concat demuxer** with:

```
-c:v copy    # no re-encode — segments already share format
-c:a aac     # audio re-encoded to ensure consistent stream format
```

This is a near-instant operation since the video stream is copied verbatim.

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

Final H.264 MP4:

```
libx264 -preset fast -crf 18 -pix_fmt yuv420p
```

Because all sources are normalized to BT.709/SDR before compositing, no color metadata stamping or format conversion is needed in the compose step. The output inherits correct color metadata from the normalized inputs.

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
| Mixed HDR/SDR in compose causes color shifts | HDR and SDR sources with different pixel formats, color spaces, or transfer functions in the same filter graph | Fixed by normalize pre-pass — all sources converted to H.264/yuv420p/bt709 before compose |
| `no index at the end` / `frame size > 2max_distance and no checksum` / `Invalid data found when processing input` (NUT demux) | NUT muxer fails to write end-of-file seek index for large files; backward timestamp scan hits large frames without checksums, corrupting demuxer state | Fixed by switching Puppeteer segments from NUT to MKV with `-cluster_size_limit 2000000 -reserve_index_space 1000000 -g 1` |

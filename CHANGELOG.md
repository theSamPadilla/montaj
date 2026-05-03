# Changelog

## Unreleased

### Serve hardening
- Fixed: `GET /api/files` scopes path queries to an allowlist (workspace + `~/.montaj/overlays` + `~/.montaj/profiles`); previously served any readable filesystem path on the host. `~/.montaj/credentials.json` and other root-level files under `~/.montaj/` remain blocked.
- Added: `montaj serve` honors `MONTAJ_WORKSPACE_DIR` env var (matches the CLI's existing precedence: env > `~/.montaj/config.json` > `~/Montaj`)

### Workspace flexibility
- Added: `--project-path` flag on `montaj init` (and CLI mirror) lets callers specify the project directory's relative path under the workspace, including multi-segment paths for subnested layouts (e.g. `--project-path=teamA/my-project`). `POST /api/run` accepts the same value as a `projectPath` body field.
- Added: `montaj serve` discovers projects at any depth under the workspace via recursive globbing — listing, get, stream, delete, update, versions, restore, rerun, and render all work regardless of how deeply a project is nested.
- Default `<date>-<slug>` directory naming is preserved when `--project-path` is absent. Fully backward compatible.
- Collisions on an explicit `--project-path` are hard errors (not auto-suffixed): `POST /api/run` returns 400 with `{"error": "project_path_exists", ...}`. Validation rejections (leading `/`, `..` segments, special chars) return 400 with `{"error": "invalid_project_path", ...}`.

## v2.1.0

### Color-space-aware pipeline
- HDR end-to-end output: HLG (Rec.2100 / `arib-std-b67`) and PQ (`smpte2084`) preserved through normalize, segment encode, and compose — no implicit downconvert to SDR
- Modal-wins smart-detect picks the project working color space from per-clip transfers (tiebreaks: SDR + HDR → SDR; HLG + PQ → PQ)
- Per-clip conversion filters at the segment encoder: HDR outliers in an SDR project tonemap down via zscale (libzimg fallback to bare `tonemap` with a loud warning); SDR outliers in an HDR project stretch up
- Single source-of-truth taxonomy in `docs/schemas/color_space.json`, loaded by both Python (`lib/types/colorspace.py`) and JS (`montaj_assets/render/color-space.js`); schema-parity test enforces both stay in sync
- `--color-space` flag on `montaj init`; `settings.colorSpace` persisted to `project.json`; render auto-backfills legacy projects via smart-detect on first run
- Strict `requireValidKey()` validator at every load site — hand-edited bad values fail loudly

### Init / normalize performance
- Two-tier parallelism: outer `ThreadPoolExecutor(4)` for normalize, inner `Semaphore(2)` cap on libx264 (memory-heavy at 4K)
- Audio fast path (skip re-encode when source already conforms)
- Async render server (no more 60s HTTP timeout on 24-clip iPhone projects)
- Source resolution preserved through the pipeline; per-segment `force_original_aspect_ratio=decrease,pad=...` for mixed-aspect projects
- Normalize mtime cache: re-renders skip the python spawn entirely when `<src>_normalized_<colorSpace>.mp4` is fresher than source
- GOP enforcement at normalize (≤2.0s keyframe interval) — load-bearing for the segment encoder's input-level fast seek
- `--resolution` flag on `montaj init`

### remove_bg
- Physically rotates pixels via `transpose=N` filter so iPhone vertical clips (`-90` displaymatrix) survive RVM (which strips rotation tags)
- Emits `nobg_preview_src` (browser-friendly VP9 WebM with alpha) alongside `nobg_src` (ProRes 4444); preview pane now shows the cutout instead of the raw source
- Normalize and segment encoder skip nobg ProRes inputs (alpha pix_fmt incompatible with zscale and HEVC encoders)

### UI / preview
- `useVideoPlayback` honors `nobg_preview_src` across all five load paths (first load, gap-clock transition, scrub, end-of-clip preload, swap)
- Gesture-anchored AudioContext resume — fixes silent / frame-frozen playback after page refresh
- Cancel-during-render no longer navigates to project root
- Smart-detect uses display dimensions (post-rotation) so portrait iPhone clips aren't squeezed into a landscape canvas

### Bug fixes
- `probeColorTransfer` strips trailing comma from `ffprobe -of csv=p=0` output — without this, HLG sources were silently mis-classified as SDR and whole HDR projects rendered tonemapped
- Audio `-ac 2` at segment encoder — fixes channel-count mismatch from mono sources at concat
- Probe-cache shim race condition under `pool=4` (atomic mktemp per call)

### Tooling
- `scripts/bump-version.sh` syncs version across `pyproject.toml`, three `package.json`s, and three `package-lock.json`s atomically; pyproject is the source of truth

### Schema additions
- `settings.colorSpace` (optional; smart-detected on render if absent)
- `nobg_preview_src` on video items (optional; emitted by `remove_bg`)

## v2.0.0

### AI Video Generation
- Full AI video pipeline: storyboarding, scene-level generation, and regeneration via Kling connector
- Character and environment reference image support for multi-shot consistency
- Parallel scene generation with credentials helper
- `ai_video` workflow and dedicated skill

### Connectors
- Connector framework for external AI APIs (Kling, Gemini, OpenAI)
- Gemini connector with inline image analysis
- Kling connector with multi-shot support

### Music & Voiceover
- Music generation pipeline and step
- Voiceover generation step
- Audio track support with waveform visualization in timeline

### Lyrics Video
- Lyrics video workflows with audio support
- `lyrics_render` and `lyrics_sync` steps
- Caption step for subtitle generation

### Engine & Render
- Timeline refactored to unified `tracks` array architecture
- Deterministic type codegen from schemas
- Hardcoded render color schema corrected
- Fixed image 404 on Puppeteer when filenames contained spaces

### UI
- AI-generated project conditional intake UI
- Storyboard view for AI-generated projects
- Mixed floating head + normal video support
- Audio track waveform visualization in timeline

### CLI & Infrastructure
- Steps reorganized into subdirectories (`audio/`, `edit/`, `generate/`, `lyrics/`, `media/`, `speech/`, `transform/`)
- Project type foundations and schema updates
- PyPI release preparation (`pyproject.toml`, `MANIFEST.in`, entry points)
- CLI utility fixes and copy command improvements

## v0.1.0

Initial release — CLI-first video editing toolkit with trim-spec architecture, render engine (ffmpeg + Puppeteer/JSX), browser UI, and MCP server.

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

## v2.1.3

### Render
- Mix audio from all unmuted video items at compose, not just the first item — multi-track audio in source clips was silently being dropped
- New test coverage in `montaj_assets/render/test/encode-segment.test.mjs`
- Credit: Thanks @jazzerkay for PR #1

## v2.1.2

### Render colorspace fix
- `color_space.json` schema relocated from `docs/schemas/` to `montaj_assets/schemas/` so it ships with the render runtime cache. Previously the schema was excluded from the installed wheel, so PyPI/Homebrew users hit a missing-file error on every render that touched colorspace lookups
- Python (`lib/types/colorspace.py`) and JS (`montaj_assets/render/color-space.js`) loaders updated to the new path
- `montaj install` now copies the schemas dir into `~/.cache/montaj/schemas/` alongside the render bundle

## v2.1.1

### UI / preview
- Audio + video frame freeze after page refresh fixed: all audio tracks AND all video slots now route through a single shared `AudioContext` stashed on `window`. Per-track or per-slot contexts started suspended without a user gesture and silently halted downstream video frame production — symptom was "video plays but no frames render" after a hard refresh
- Removed leftover `console.log` debug spam from `OverlayVideo`

### Doctor / install
- `montaj doctor` warns when the cached UI bundle was built for a different package version than what's installed — covers the post-`brew upgrade` window before `montaj install ui` rewrites the cache. Points at the fix command
- Project list footer now displays the running version (`v{__APP_VERSION__}`)

## v2.0.6

### Install
- `montaj install ffmpeg` now sets `HOMEBREW_NO_INSTALL_FROM_API=1` when running `brew tap homebrew/core`. Without it, Homebrew 4.x silently skips the tap clone, leaves the formula file absent, and the ffmpeg+zscale custom build path fails with a misleading "formula not found" error
- Clearer message about the ~1GB tap clone and several-minute duration

### Misc
- Workflow resolution fix (stale package version references in `montaj_assets/{render,ui,mcp}/package.json`)
- `.gitignore` updates and docs polish

## v2.0.5

### Whisper install URL breakage
- `ggerganov/whisper.cpp` moved to `ggml-org/whisper.cpp` and stopped publishing pre-built tarballs, so `WHISPER_BINARY_URLS` in `install.py` was pointing at a 301 → 404 redirect chain. `montaj install whisper` crashed with `HTTPError` on every fresh install
- `cli/commands/install.py` — replaced the dead URL-download path with `brew install whisper-cpp` on macOS (bottled, fast) and clear build-from-source instructions on Linux. Dropped `WHISPER_VERSION` and `WHISPER_BINARY_URLS` — Homebrew owns the version pin now
- `cli/deps.py` — new `whisper_bin_path()` helper checks `PATH` first (covers brew, apt, manual installs) then montaj's legacy local paths. `doctor` and `check_deps` share the helper so they can't disagree about whether whisper is installed
- `cli/commands/update.py` — `montaj update whisper` delegates to `brew upgrade whisper-cpp` on macOS; `montaj update pip` uses `pip install --upgrade montaj` instead of `-e .` (which broke outside source trees)

## v2.0.4

### Asset namespace
- Move `render/`, `ui/`, `mcp/` → `montaj_assets/{render,ui,mcp}/`. Eliminates the PyPI collision risk (those names would otherwise be top-level Python modules after the `include-package-data` fix)
- Eight `MONTAJ_ROOT`-relative path references rewritten to prefix `montaj_assets/`
- `montaj_assets/render/bundle.js` resolves `core/` and `node_modules/` via `__dirname` (siblings of bundle.js) instead of `process.env.MONTAROOT`
- `montaj_assets/mcp/server.js` renames local `MONTAJ_ROOT` → `MCP_DIR`; reads the Python project root from `process.env.MONTAJ_ROOT` (set by `cli/commands/mcp.py`)

### Build cache
- `~/.cache/montaj/` now holds the built `node_modules` and `ui/dist`; site-packages stays immutable. Works under `sudo pip` / `pip --user` / `brew`
- `cli/deps.py` — `BUILD_CACHE_DIR`, `is_dev_checkout()`, and `ui_runtime_dir` / `render_runtime_dir` / `mcp_runtime_dir` helpers; re-exports `MONTAJ_ROOT` from `cli.main` (single source of truth)
- `cli/commands/install.py:_ensure_ui()` copies render/ui/mcp source from site-packages → cache, runs `npm install` there. Version-stamped at `~/.cache/montaj/.version`, invalidates on `pip install -U`. Dev mode (working tree) still builds in source for Vite HMR. `mcp/` is now also `npm install`-ed at install time
- `serve/server.py` lifespan, caption-template route, `render_project`, and SPA catch-all all read via runtime helpers. SPA fallback message points at `montaj install ui`. Auto-build inside lifespan removed
- `cli/commands/serve.py` runs a pre-flight `check_ui()` before `uvicorn.run`
- `cli/commands/doctor.py` gains a UI readiness section

### Release tooling
- New `scripts/build.sh` — wraps `python -m build` (the safe no-flag form) and asserts the wheel has 0 `node_modules` / 0 `ui/dist` / 0 `__pycache__` entries before allowing `twine upload`. Colorized, TTY-aware

### Docs
- `docs/ARCHITECTURE.md` — new "Asset packaging & build cache" subsection
- `docs/CLI.md` — unified install flow (drops the "brew handles this" carve-out)

## v2.0.3

- Dependency tree cleanup
- Stop committing `dist/` artifacts; add `dist/` to `.gitignore`

## v2.0.2

- `montaj --version` flag (`cli/main.py`)

## v2.0.1

- Maintenance release — version bump and dist artifact rollover; no behavior changes

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

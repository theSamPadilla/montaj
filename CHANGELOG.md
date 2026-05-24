# Changelog

## Unreleased

### Fixed
- Google Fonts in overlays and captions actually load now. The `googleFonts` array on overlay items (and on the top-level `captions` object) has been documented for a while, but the render bundler was silently dropping it — `bundleComponent` didn't read the parameter and the generated `<head>` had no font links. The bundler now emits the Google Fonts CSS2 `<link>` (plus the `preconnect` pair) and the shim awaits `document.fonts.ready` on the first frame so frame 0 paints with the requested font instead of a CSS fallback. A 5s timeout guards against network stalls — on timeout the render proceeds with whatever fallback the JSX declared rather than hanging. The captions spec in `render.js` also now forwards `googleFonts` through to the bundler so caption styles can use custom fonts the same way overlays do. Carousel renders (`render-carousel.js`) use a separate bundling path and do not honor `googleFonts` yet — that's a follow-up.

### Added
- Mobile-friendly UI. A hard width-gate at the Tailwind `md` breakpoint (768px) routes narrow viewports to dedicated mobile variants of the project list, upload form, project header, top nav, and editor surfaces. Existing desktop components are untouched — mobile and desktop layouts evolve independently.
- Mobile intake is fully functional: browse projects, create a new project (clip / AI video / carousel / music-video), pick a workflow, and submit — all on a phone.
- Mobile editor surfaces are view-only: video projects show the existing `PreviewPlayer` with a single full-width Render button; carousel projects show a vertically-stacked read-only slide viewer with a Render button; AI-video projects mid-storyboard show a "open on desktop" notice that still surfaces the live agent log line so users can watch progress from their phone.
- Mobile render modals stack vertically (video on top, info panel below) instead of the desktop side-by-side layout, so output and download controls are reachable on a narrow screen.

### Changed
- `UploadView` refactored to consume a new `useUploadForm` hook (state, effects, derived values, and `handleRun` extracted). JSX is byte-identical; the hook is shared with the new `MobileUploadView`. No behavior change on desktop.
- `AspectRatioIcon` and `CarouselAspectIcon` extracted from `UploadView` into a new `uploadConstants.tsx` module so both desktop and mobile forms import them.

### Notes
- Editing — overlays, clip trimming, slide canvas, storyboard scene editing — still requires desktop. Mobile users can browse, upload, monitor progress, and render.
- Tablets at ~800px and phones in landscape get the desktop UI by design; revisit if the cramped-tablet UX becomes a real complaint.

## v2.4.1
- Adding image cropping support
- Minor improvements in install.

## v2.4.0

### Added
- `DELETE /api/projects/:id/files` — removes files or subdirectories from the project workspace. Body: `{"paths": ["render-tmp-abc", "assets/foo.png"]}`. Completes the triangle with `/upload` (push) and `/download` (pull). Same Multi-Status envelope (`200`/`207`) and same `validate_project_subpath` traversal guards: symlinks whose target escapes the project dir are rejected at validation time. Idempotent — missing paths return `deleted` rather than error (matches `rm -f` semantics). Directories are removed recursively. Note: because validation `.resolve()`s before returning, deleting an in-project symlink removes its *target* (not the link); the link becomes dangling. This is acceptable for today's callers but diverges from POSIX `rm` semantics.

## v2.3.2

### Added
- `POST /api/projects/:id/download` — pulls remote files into the project workspace on local disk. Symmetric to existing `/upload` (which is the opposite direction). Same Multi-Status envelope, same allowlist + path-traversal guards via the existing `fetch_to_disk_async` helper.

## v2.3.1

- Fix: carousel render dispatcher now resolves `render-carousel.js` from
  `render_runtime_dir()` (the prod install cache dir) instead of
  `MONTAJ_ROOT/montaj_assets/render/`. The hardcoded site-packages path
  prevented Node from finding `esbuild` (and other render deps installed
  via `montaj install ui` into `~/.cache/montaj/render/node_modules/`),
  breaking carousel render in any prod-mode install. Affects every Montaj
  release since 2.2.0 (when carousel shipped); previously masked because
  dev-checkout installs keep `node_modules` in-tree.

## v2.3.0

- `PUT /api/projects/{id}/overlays/{name}` — write agent-authored overlay JSX into a project's workspace. Slug-only names (`^[a-zA-Z0-9_-]{1,64}$`), 64KB body cap, plain-text body, idempotent (201 create / 200 overwrite). Closes the HTTP-side gap for the project-scoped overlay model already documented in `skills/carousel/SKILL.md`; HTTP/sidecar callers can now author overlays end-to-end without needing direct filesystem access.

## v2.2.4

- `GET /api/info` now includes a `version` field (the installed `montaj` package version, or `"dev"` when running from source). Lets sidecar deployments confirm which version is live without relying on OCI labels or `pip show` inside the container.

## v2.2.3

- `POST /api/run` and `python -m project.init` now accept an optional caller-supplied project id (`id` body field / `--id` CLI flag). When provided, the value is parsed via `uuid.UUID()` and stored canonical (lowercase 8-4-4-4-12) as `project.json["id"]`; when absent, the server generates a UUID as before. Enables consumers (e.g. Hub) to maintain a single shared identifier across both systems instead of mapping between Montaj's generated id and their own.

## v2.2.2

### Packaging fix: root skill ships in the wheel
- The top-level entry `SKILL.md` lived at the repo root, which meant it never made it into the installed wheel — `MANIFEST.in` only grafted `skills/*.md`, and setuptools wheels don't drop bare top-level non-package files into `site-packages` anyway. In production builds, `GET /api/info` returned a `root_skill_path` pointing at a file that didn't exist, breaking the pending-screen "Send this to your agent" handoff. Moved to `skills/SKILL.md` so the existing `recursive-include skills *.md` picks it up; updated `serve/routes/skills.py` to advertise the new path. Internal sub-skill references inside the file rewritten from `skills/<name>/SKILL.md` to sibling-relative `<name>/SKILL.md` for unambiguous resolution from the new location. `scan_skills()` ignores the new sibling file (it only iterates subdirectories of `skills/`), so the skill list is unchanged.

## v2.2.1

### Version metadata fix
- Identical body of work as v2.2.0. The v2.2.0 tag was pushed at the commit immediately before the version-bump commit landed, so `pyproject.toml` in that tarball still read `version = "2.1.3"` and `pip install` reported the wrong version. v2.2.1 re-ships the same code with `pyproject.toml` + the three `montaj_assets/{render,ui,mcp}/package.json` files correctly set to 2.2.1.

## v2.2.0

### Image carousel projects
- Added `carousel` project type alongside `editing`, `music_video`, `ai_video`. Slide-based design surface with image and overlay elements; renders to N PNGs (`slide_NN.png` + `manifest.json`) in `<project>/render/`.
- Three aspect-ratio presets at creation: square (1:1, 1080×1080), portrait (4:5, 1080×1350), vertical (9:16, 1080×1920). Locked per project — Instagram and TikTok crop mismatched slides.
- Reuses the existing overlay system (text, shapes, anything an overlay can render). Overlays declare `frame` per element since carousels have no time axis. Default frame = duration − 1.
- **Agent-first model.** New carousel projects start in `status: "pending"` — the editor opens to a "Send this to your agent" copy panel pointing at the root `skills/SKILL.md`. The agent reads the workflow → finds the new `montaj/carousel` callable skill (`skills/carousel/SKILL.md`) → builds slides via `PUT /api/projects/{id}` → renderer produces PNGs. Once the agent flips status off `pending`, the canvas opens for direct edits (drag/resize/rotate elements, snap guides at slide center axes and edges, 90° rotation snap). Live status messages from the agent (`POST /api/projects/{id}/log`) appear in the pending screen.
- **Intake.** New project form takes a name, prompt (required), aspect ratio, optional reference assets dropped at intake. Workflow is fixed to `carousel`. Assets attached at intake are copied into the project workspace and surfaced in `project.assets[]` so the agent can reference them as backgrounds or style refs.
- **Editor.** Slide grid (left) + canvas (center) + property panel + asset library (right). Drag elements to reposition with auto-snap to slide center axes / edges (pink guide lines), snap to 90° increments on rotate. Refresh and Render buttons live in the top-left/right corners of the editing area.
- **Render UI.** Click Render → modal streams the renderer's log lines, then opens a full-screen overlay with every slide as a clickable thumbnail and a "Download all (.zip)" button. Zip endpoint at `GET /api/projects/{id}/render-zip` (excludes the on-disk `manifest.json` from the download). The existing `POST /api/projects/{id}/render` now dispatches by `projectType` — carousel projects run `render-carousel.js`, everything else runs `render.js`.
- **CLI:** `montaj init --workflow carousel --carousel-aspect <preset> --prompt "..."` creates a pending carousel project. `montaj render <project>` produces the PNGs.
- **API:** `POST /api/run` accepts `{workflow: "carousel", carouselAspect, prompt, assets?}`. `GET /api/info` continues to expose `root_skill_path` (used for the pending-screen handoff). Project mutations use the same `PUT /api/projects/{id}` endpoint as video projects.
- **Shared assets panel.** Asset list / pick / drop / preview UI extracted from `ReviewView` into a shared `AssetsPanel` component, mounted on the carousel intake form, the carousel pending screen, the carousel canvas side rail, and the existing video Review side rail. Square-thumb grid layout (3-column). Removes save immediately on every surface (matches the existing add/drop semantics).
- **Incidental cleanup paid for by this work:** fixed the broken render-script path in `project/render.py` (caller missed the `montaj_assets/` namespace rename — `montaj render` was failing for ALL project types with `Cannot find module`); generalized `scripts/gen_types.py` to support `extra:` blocks in `schema/enums.yaml` (closes a latent bug where `ASPECT_RESOLUTIONS` was hand-edited inside a "GENERATED — DO NOT EDIT" file); fixed `TS_OUT_DIR` in the same script.

### Profile assets
- Added a per-profile asset library at `~/.montaj/profiles/{name}/assets/`. Manage uploads, per-file descriptions, and an asset-library summary from the Profiles → Assets tab, or via `montaj profile asset {list,add,rm,summary}`. Attached profiles are snapshotted into project.json at init: the agent sees `availableAssets`, the hand-written `summary`, and a `styleProfilePath` pointer to the profile's `style_profile.md` for editorial direction. A side panel in StoryboardView/LiveView lets you copy specific assets into the active project.

### Internal: serve refactor
- `serve/server.py` reorganized from a single 1565-line file into a `serve/routes/` package (one module per URL prefix: `projects`, `steps`, `workflows`, `overlays`, `profiles`, `files`, `skills`) plus shared `serve/common.py` (workspace + project lookup, `Depends(get_project_dir)`, `run_subprocess`, error builders, `MONTAJ_ROOT`). `serve/server.py` is now 155 lines: imports, lifespan, app construction, `include_router` calls, and the SPA catch-all. No behavior change; same 37 routes, same wire format, same error payloads.
- Eliminated three repetition patterns: 10× project-id-to-directory lookup with 404 (now a single FastAPI dependency), 2× SSE event-loop with disconnect/keepalive (now `sse_stream` in `serve/sse.py`), 3× async-subprocess-with-timeout (now `run_subprocess` in `serve/common.py`). 57 of 62 `HTTPException` raises switched to `not_found`/`bad_request`/`server_error`/`forbidden` builders; the 5 non-standard shapes stay raw.
- `restore_version` keeps its untimed `git show` (matches pre-refactor behavior; the helper-wrapped 10s timeout was rejected as a silent behavior change).
- Tests: 8 monkeypatch targets across 3 test files bumped from `serve.server.<name>` to `serve.routes.<x>.<name>` to follow the consumer's namespace post-split. No assertion changes; full suite remains 427 passed / 1 skipped.

### Serve hardening
- Fixed: `GET /api/files` scopes path queries to an allowlist (workspace + `~/.montaj/overlays` + `~/.montaj/profiles`); previously served any readable filesystem path on the host. `~/.montaj/credentials.json` and other root-level files under `~/.montaj/` remain blocked.
- Added: `montaj serve` honors `MONTAJ_WORKSPACE_DIR` env var (matches the CLI's existing precedence: env > `~/.montaj/config.json` > `~/Montaj`)

### Remote inputs and outputs
- Added: callers can now supply remote URLs at init time to fetch clips and assets directly into the project workspace. CLI: `montaj init --remote-clip '<json>'` / `--remote-asset '<json>'` (repeatable) or `--remote-clips-file` / `--remote-assets-file` for batch JSON; API: `remoteClips` / `remoteAssets` body fields on `POST /api/run`. Each item specifies `url`, `destPath`, `contentType`, `sizeBytes`, and optional `method`/`headers`.
- Added: `montaj upload` command and `POST /api/projects/{id}/upload` endpoint push workspace files to caller-supplied URLs. Body: `{uploads: [{srcPath, url, method?, headers?}]}`. Returns 200 on full success or 207 Multi-Status on partial failure, with per-op results in the response body (per-op failures never surface as request-level 4xx).
- Added: `GET /api/projects/{id}/outputs` enumerates `<project>/output/` (depth-1) as `{outputs: [{path, sizeBytes, contentType}]}` — used by managed orchestrators to presign per-file upload URLs without guessing what the workflow produced. API-only (OS users have direct filesystem access). Not gated by `MONTAJ_HTTP_ALLOWED_HOSTS` since it makes no outbound HTTP.
- MCP: both directions are auto-introspected — agents using `montaj mcp` get `upload` and the extended `init` flags as native tools with no extra configuration.
- Existing `--clips` / `--assets` flags on `montaj init` (previously hidden in the CLI wrapper) are now exposed as `--clip` / `--asset` (repeatable) for consistency.
- Security: the feature is fail-closed. `MONTAJ_HTTP_ALLOWED_HOSTS` (comma-separated, lowercase) must be set in the server or CLI environment; requests to unlisted hosts return `host_not_allowed` / 403. Unset means no remote I/O at all — OS desktop users running without the env var are unaffected.
- Fetch side: content-type and streamed byte count are verified against declared values (`content_type_mismatch`, `size_mismatch`); writes are atomic (temp-then-replace). Push side: `Host` and `Content-Length` headers from caller input are stripped; on-disk size is authoritative. All caller-supplied paths are validated against the project directory to prevent traversal.
- URLs, methods, and headers are caller-supplied and opaque — S3 pre-signed URLs, R2, GCS, Azure SAS URLs, and custom webhooks all work without provider-specific code in Montaj.

### Fixes (caught during carousel work)
- **SSE multi-line frames.** `PUT /api/projects/{id}` and three sibling endpoints were publishing `f"data: {indent=2 JSON}\n\n"` over SSE. SSE requires a `data:` prefix per line, so the browser parser was splitting on every newline inside the JSON and logging `[sse] malformed project frame: {`. The optimistic instant-update was being dropped and the UI was relying on the watcher's later (single-line) re-broadcast to catch up. New `_sse_data_frame()` helper canonicalizes any payload to a single `data:` line; all four publish sites switched over.
- **Overlay compiler tolerates named exports.** `overlay-eval.ts` only rewrote `export default …` and let bare `export const X` / `export function X` / `export { X }` survive into `new Function(...)`, throwing `Unexpected token 'export'`. The browser preview broke for any overlay that exported anything other than the default component (e.g. an overlay declaring `export const staticFrame = 30` for the carousel renderer's static-frame default). Render path was unaffected (esbuild handled it). The compiler's normalize pass now strips the `export` keyword from named declarations and drops bare `export { ... }` lines.
- **Render dispatch by project type.** `POST /api/projects/{id}/render` hardcoded `render.js`, so calling it on a carousel project ran the video renderer (producing `final.mp4` from zero segments). The endpoint now reads `projectType` from `project.json` and routes carousel projects to `render-carousel.js` (mirroring `project/render.py`).

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

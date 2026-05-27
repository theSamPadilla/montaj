# Changelog

## Unreleased

### Added
- Carousel renderer accepts `--scale <1|2|3>` (`render-carousel.js`, `montaj render`, and `POST /projects/{id}/render?scale=N`) to rasterize slides at 2× or 3× the design resolution via Puppeteer's `deviceScaleFactor`. Overlay layout is unchanged — only the output PNG resolution scales. Manifest gains top-level `outputResolution` and `scale` fields, and each `slides[i]` now exposes both `designWidth`/`designHeight` (the design coords) and `width`/`height` (the actual PNG pixel dims). At `scale=1` the two pairs are identical, so default behavior is byte-identical for legacy consumers reading `slides[i].width`/`height`.
- Timeline editor now supports multi-select via shift+click (or cmd/ctrl+click). Shift-clicking a timeline item — video clip, visual overlay, or audio track — adds it to the current selection without disturbing what's already selected; shift-clicking a selected item removes it. A plain click still replaces the selection with just the clicked item. With multiple items selected: pressing **Delete** removes all of them in one go (ripple-aware), **dragging any edge resizes every selected item by the same delta** (relative-delta semantics — per-item duration relationships are preserved; each item respects its own `inPoint`/`outPoint` and `sourceDuration` clamps), and clicking the **mute** icon on any selected item sets every selected item's mute state to the new uniform value. Selection is cross-track: a single selection can mix items from different visual tracks and from audio lanes, so one drag can extend a clip and its companion voice-over track together. Implementation lifts a single `selectedIds: string[]` into `ReviewView`, replacing the previous separate `selectedOverlayId` / `selectedAudioTrackId` state. New `montaj_assets/ui/src/components/timeline/multiSelectOps.ts` centralizes the three cross-row mutations (`applyResizeDeltaToSelection`, `applyMuteToSelection`, `deleteSelection`) plus the selection-toggling helper. The canvas preview (`PreviewPlayer`/`OverlayItemsLayer`) intentionally still shows drag/resize/rotate handles only on the primary selected item (`selectedIds[0]`) — multi-select is a timeline-only concept. Editor help dialog gains a shift+click row under "Clips (all tracks)".
- Three SVG chart system overlays ship for carousels: `bar-chart` (single-series vertical bars), `line-chart` (1–N series with smoothing + per-series color, multi-series via a JSON-encoded `series` prop with `format: "json"` hint), and `pie-chart` (donut variant via `innerRadius` prop, no separate template). All three render via Recharts and live alongside `static-text` under `montaj_assets/render/templates/overlays/`. New globals on `montaj-overlay-runtime`'s `makeOverlayGlobals()` (consumed by `montaj_assets/ui`'s overlay-eval automatically): `BarChart`, `Bar`, `LineChart`, `Line`, `PieChart`, `Pie`, `Cell`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip`, `Legend`, `ResponsiveContainer`. Charts size themselves from the overlay element's `w`/`h` (passed through via `slide.jsx`'s `mergedProps` as `boxWidth`/`boxHeight`) rather than via Recharts' `<ResponsiveContainer>` — the latter measures asynchronously and would race the Puppeteer screenshot, producing blank charts. Each chart primitive (`<Bar>`, `<Line>`, `<Pie>`) sets `isAnimationActive={false}` so the screenshot captures the final state rather than a mid-animation frame. End-to-end render test (`tests/test_render_carousel_charts.py`) renders all three chart slides through Puppeteer and asserts the overlay element box contains non-background pixels. Bundle cost: Recharts core (~120 KB gzipped including transitive d3-shape/d3-scale/react-smooth) is paid only on slides that use a chart — esbuild tree-shakes per-segment.

### Fixed
- Carousel image elements (the no-crop branch) now render with `object-fit: contain` to match the mission-control editor preview. Previously the renderer used `object-fit: cover`, which scaled images up to fill the element box and cropped the overflow — so any image whose source aspect ratio differed from the placed box would export dramatically zoomed and clipped versus what the operator saw while authoring. Cropped images continue to use `cover` (correct — the crop fractions already define the visible window). `montaj_assets/render/templates/slide.jsx`.
- Timeline clip and overlay drag/resize now tracks the cursor 1:1 in screen pixels regardless of zoom. Previously, `montaj_assets/ui/src/components/timeline/useItemDragDrop.ts` converted mouse pixels to timeline seconds by dividing the cursor delta by `scrollRef.width × totalDuration` — but the zoom-aware inner content div is `zoom × scrollRef.width` wide, so at zoom=3 every mouse pixel was treated as 3 seconds of movement instead of 1. Result: a small wrist twitch could fling a clip across the timeline. The hook now accepts an optional `zoomRef` and divides by the true content width (`scrollRef.width × zoom`). `VisualTrackRow` and `AudioTrackRow` both pull `zoomRef` from `TimelineContext` and pass it through. Snap-threshold math uses the same content width, so the ~8px snap radius stays a constant visible distance at any zoom level. At zoom=1 behavior is byte-identical (factor of 1).

## v2.5.6

### Fixed
- `static-text` overlay's `fontSize` prop now respects edits from clients that store the value with a `px` suffix (e.g. mission-control's `FontSizePicker` writes `"60px"`). The template was coercing the incoming string via `Number(fontSize)`, which returns `NaN` for any value with a unit suffix and silently fell back to the default `80` — so every operator-driven font-size edit on a static-text overlay was discarded at render time. `montaj_assets/render/templates/overlays/static-text/static-text.jsx` now parses with `parseFloat(String(fontSize))`, which accepts both the legacy unit-less `"80"` and the canonical `"60px"` format. Author-authored overlays (e.g. `lyric-phrase.jsx`) were unaffected because they hand `fontSize` straight to React's inline style, which already tolerates `"60px"`. No schema change; existing project.json values keep working.

## v2.5.5

### Fixed
- Overlay positioning is now stable across output resolutions. Previously, when `project.settings.resolution` was set to a non-default value (e.g. `[2160, 3840]` for 4K vertical), `montaj_assets/render/render.js` derived its overlay Puppeteer viewport from `settings.resolution` directly — so JSX coordinates were interpreted in the project's *output* resolution. Overlays authored at 1080-design coords (the documented baseline) rendered at half size and snapped to the top-left of the canvas; `montaj_assets/ui/src/components/preview/{PreviewPlayer,OverlayItemsLayer}.tsx` had a symmetric bug in preview. The renderer (`render.js:86-87`) now always uses a 1080-short-edge design canvas with the aspect ratio of `settings.resolution`, and `pixelRatio` upscales the captured frame to the final video dimensions at compose time — restoring the architecture the old skill text described. The UI preview mirrors this via a new `getOverlayDesignCanvas(settings.resolution)` helper in `montaj_assets/ui/src/lib/utils.ts` so preview and render agree on the same coordinate space. Net effect for end users: overlays in any project — 1080, 4K vertical, landscape, square — sit dead-center at defaults, hand-tuned `scale`/`offsetX`/`offsetY` values mean the same thing regardless of output resolution, and JSX overlays no longer need a resolution-portable wrapper.
- Overlay skills (`skills/overlay/SKILL.md`, `skills/write-overlay/SKILL.md`) revert to their original "canvas is always 1080 on the short edge" wording. A recent edit had introduced a "Resolution-portable pattern" section that taught an inner-wrapper workaround for the renderer regression above; that workaround is no longer needed and the section has been removed. The Render Constraints bullet now explicitly states that the Puppeteer viewport is 1080-short-edge regardless of output resolution and that the compose step handles upscaling — so authors continue to write `fontSize: 120`, `bottom: 350`, etc. in fixed 1080-design coordinates.

## v2.5.4

### Fixed
- A broken overlay JSX file no longer crashes the entire editor. Previously, if a compiled overlay returned an element with an undefined component type (e.g. a typo in a Phosphor icon name like `Ph.CircuitBoard` instead of the actual export `Ph.Circuitry`), React would throw minified error #130 during reconciliation — escaping `overlay-eval.ts`'s try/catch (which only wraps the synchronous factory call, not the render phase) and unmounting the whole app tree, producing a blank page with no usable error message. New `montaj_assets/ui/src/components/OverlayErrorBoundary.tsx` is now wrapped around every overlay-eval consumer — `CustomOverlay` in `OverlayItemsLayer` (video editor preview), `OverlayElementView` in `SlideCanvas` (carousel slide editor), and the rendered element in `CaptionPreview` (caption layer). On a render-phase throw the boundary contains the fault and shows a small red box with the broken overlay's filename and the error message; everything else in the editor keeps working. The boundary auto-recovers on file save (subscribes to `/api/files/stream` via the `watchPath` prop, same EventSource the existing live-reload uses) so editing the overlay's source clears the error without a page reload. For non-path-backed sources (caption styles) it accepts a `resetKey` prop that clears the error whenever its value changes.

### Added
- Carousel text overlays now follow a 9-prop editable-text contract so the editor's floating toolbar (bold / italic / case / align / font-size / font-family / color) works uniformly across every text overlay in a carousel. The contract is taught at the skill level — no server-side validator, no runtime enforcement. New subskill `skills/editable-text/SKILL.md` spells out the required prop surface (`text`, `fontSize`, `fontFamily`, `fontWeight`, `fontStyle`, `color`, `textAlign`, `textTransform`, `bgColor`, all with string defaults applied via inline `style`) with three stylistically distinct worked examples (hook headline / body copy / eyebrow) and a counter-example. `skills/carousel/SKILL.md` declares it as a subskill (mirroring the `camera-vocabulary` → `ai-video-plan` pattern) and routes text overlays to it from §5. `skills/write-overlay/SKILL.md` gains a scope-note clarifying the video-calibrated "go large / 96px floor" rule and the hardcoded-style `Hook` example don't apply to carousel editable-text. Canonical reference template `static-text.jsx` gains `fontStyle` and `textTransform` props (defaults `'normal'` and `'none'` — visual no-op at defaults since they match CSS defaults), and the prop order across `.jsx`, `.json`, and the listing test is regrouped so font-related properties cluster together. Older per-project overlays rendered before this PR keep rendering identically; opt-in operator path to upgrade them is re-author via the editor or re-generate the carousel — no migration tooling.
- New-project intake form can now pull assets from the selected profile's asset library at create time, not only after the project exists. A "From profile" entry point lives next to the local file picker in every intake variant — the carousel `AssetsPanel`, the clip/music-video `Assets` `DropZone` (`ClipUploadFields`), and a brand-new `Assets` section on the AI-video intake that was previously absent. The trigger opens a modal listing the profile's assets (image thumbnails, mime-typed icon for audio/video) with per-file Include buttons and "Included" markers for paths already on the form. Backed by the existing `GET /api/profiles/{name}/assets` endpoint and the existing `assets?: string[]` field on `POST /api/run` — no backend or API changes; paths from the profile library are pushed into the same flat array as locally-picked files, so the project gets created with them attached on first save (no extra `addProfileAssetToProject` round-trip needed). The trigger is disabled with a tooltip when no profile is selected on the form. Wired through both desktop (`UploadView`) and mobile (`MobileUploadView`) — same component, same behavior, parity by design. New shared component: `montaj_assets/ui/src/components/upload/ProfileAssetPicker.tsx` (consumed by `AssetsPanel` and `ClipUploadFields`). `useUploadForm` gains an `aiVideoAssets: Asset[]` slot that replaces the hardcoded `assets: []` previously sent on the ai_video create call.

## v2.5.3

### Fixed
- `montaj_assets/overlay-runtime/` now ships in the wheel. v2.5.0 introduced the shared overlay-runtime bundle (peer to `render/` / `ui/` / `mcp/`, consumed via `"montaj-overlay-runtime": "file:../overlay-runtime"`), but unlike its siblings the directory has a hyphen in its name and no `__init__.py`, so `setuptools.packages.find` skipped it as a subpackage and `include-package-data` only shipped the two files matched by the `*.json` package-data glob — `package.json` and `package-lock.json`. The five `.js` files (`index.js`, `canvas-wrapper.js`, `helpers.js`, `icons.js`, `three-bridge.js`) were absent from `montaj-2.5.{0,1,2}-py3-none-any.whl`, so `pip install montaj==2.5.x && montaj install ui` blew up at the UI `npm run build` step when Vite tried to resolve `montaj-overlay-runtime`'s `main` (`index.js`) and found nothing. Fix: explicit `[tool.setuptools.package-data]` entry — `"montaj_assets" = ["overlay-runtime/**/*"]` — forces the whole subtree into the wheel via the parent package's data globs. `prune montaj_assets/overlay-runtime/node_modules` in MANIFEST.in still keeps the bundle's installed deps out. Verified by inspecting the rebuilt wheel: all five `.js` files are present alongside the two JSON files. The sdist was always fine (MANIFEST.in's `graft montaj_assets` covers it); only the wheel was broken, which is what `pip install` consumes.

## v2.5.2

### Fixed
- UI build (`npm run build` under `montaj install ui`) no longer fails with TS2322 on `Timeline.tsx` and `VisualTrackRow.tsx`. The v2.5.0 ripple-delete fix introduced two `let updated = { ...project, tracks: (project.tracks ?? []).map(...).filter(...) }` literals whose inferred type narrowed `tracks` to non-optional `VisualItem[][]`; reassigning `updated = collapseGaps(updated)` then failed because `collapseGaps` returns the full `Project` shape where `tracks?` is optional. Annotating `let updated: Project = { ... }` at both call sites (the same pattern the existing ripple-aware cut/split handlers use, since those start from helpers that already return `Project`) restores assignment compatibility. The error didn't surface during the v2.5.1 cut because no `tsc` ran between the ripple fix and the tag — `vite` dev mode strips types and the build script (`scripts/build.sh`) only verifies the Python wheel, not the UI bundle. v2.5.0 and v2.5.1 ship a UI that fails to build on the user's machine via `montaj install ui`; this is the patch that makes that command succeed again.

## v2.5.1
- Fixing release cycle

## v2.5.0

### Added
- Shipped `static-text` overlay template for carousels — a minimal, no-animation overlay that renders one styled string with `text`, `fontSize`, `color`, `fontFamily`, `fontWeight`, `textAlign`, `bgColor` props (all stored as strings for round-trip through string-only property editors). Lives at `montaj_assets/render/templates/overlays/static-text/static-text.jsx` (plus a sibling `static-text.json` prop schema) and is bundled by `render-carousel.js` via the same `resolve(template)` import path agent-authored overlays use. Distinct from the per-project user library at `~/.montaj/overlays/`: this template ships with Montaj, is versioned with the renderer, and is reached through the absolute `jsxPath` returned by the new system-overlay catalog endpoint (below). Lets clients (mission-control, Hub, etc.) drop a plain text element on a slide without the agent having to author a custom overlay template per project. Intentionally minimal: no stroke, no shadow, no gradient, no auto-fit — every prop must justify itself in the property panel for every text element on every slide; stroke/shadow are easy follow-ups when a real use case asks for them.
- `GET /api/overlays/system` — lists overlay templates packaged with Montaj (today: just `static-text`). Returns the same `{name, group?, description, props, jsxPath}` shape as `GET /api/overlays` (the user library), but scoped to the directory under `render_runtime_dir()/templates/overlays`. Separate endpoint, not a merge into `/api/overlays`, so a same-named entry in `~/.montaj/overlays/` cannot shadow a system overlay. `_allowed_file_roots()` now includes the shipped templates dir so `/api/files?path=…` can serve the JSX for client-side previews — same plumbing the existing `/api/overlays` listing relies on for user-library JSX.
- Three.js / `@react-three/fiber` available in overlay JSX. Authors can drop a `<Canvas frameloop="never">` with `<mesh>` / `<boxGeometry>` / `<meshStandardMaterial>` / lights inside and the renderer will composite real WebGL content over the footage. New globals exposed in the overlay shim: `THREE`, `Canvas`, `useThreeFrame`. The bridge hook (`useThreeFrame`, mounted as a child of `<Canvas>`) registers a synchronous render trigger that Montaj's frame-stepped renderer calls inside `__setFrame` so Three's WebGL draw stays in lockstep with Puppeteer's screenshot loop. The overlay renderer was switched from `headless: true` to `headless: 'new'` (matching the carousel renderer) to enable real WebGL in headless mode; existing 2D overlays continue to render unchanged. The non-negotiable rules — `<Canvas frameloop="never">`, mount `useThreeFrame()` once inside, drive animation from the `frame` global, no `useFrame` hook, no async-loaded assets (textures/GLTFs) — are documented in `skills/write-overlay/SKILL.md` along with a worked example (`tests/fixtures/overlays/three-cube.jsx`). Carousel renderer (`render-carousel.js`) does not yet support Three.js inside slides — follow-up.

### Fixed
- Deleting a primary-track clip with ripple ("magnet") mode on now closes the gap immediately. Both delete paths — clicking the trash on a clip (`VisualTrackRow.handleDeleteOverlay`) and pressing Delete/Backspace on a selected clip (`Timeline.handleKeyDown`) — were producing the filtered tracks but skipping the `collapseGaps` pass that every other ripple-aware mutation (cut, split, resize) runs. The fix routes both deletes through the same `if (rippleMode) updated = collapseGaps(updated)` step. Previously users had to toggle ripple off and back on to trigger the collapse — the toggle-on branch in `ReviewView.handleRippleToggle` already runs `collapseGaps`, which is why the workaround worked.
- Project names (and other creation-time metadata) no longer get wiped when the agent saves the project. `PUT /api/projects/{id}` previously did a full replace — the agent's documented save pattern (`skills/serve/SKILL.md`) shows a minimal body like `{id, status, tracks}`, so the very first agent-driven pending→draft transition was stripping `name`, `workflow`, `editingPrompt`, `projectType`, `runCount`, `settings`, `assets`, etc. from `project.json`. The endpoint now top-level-shallow-merges the body into the existing project on disk, preserving any key the caller didn't send; to explicitly clear a field, callers must send it as null. UI savers were already spreading the full project, so this is a no-op for them — the fix only changes behavior for partial bodies. Existing projects already gutted on disk can be recovered with `git show <init-commit>:project.json` against the project's git history (every project workspace is its own git repo with a `init: new project` baseline commit).
- Editor zoom (cmd/ctrl + wheel) now zooms slower and stays pivoted on the cursor instead of snapping the pivot to the center of the viewport. The pivot formula in `useTimelineZoom.ts` was computing the correct content-fraction under the cursor but writing the new scrollLeft so that the pivot landed at `containerWidth / 2`, which only matched the cursor when the cursor happened to be centered — anywhere else, the zoomed-in region drifted relative to where the user pointed. Fixed to use the actual cursor offset for both reading the pivot fraction and reseating the scroll position, so the yellow hover indicator stays exactly under the cursor through the zoom. The wheel step also switched from a fixed ±0.5 per tick to a multiplicative `exp(-deltaY * 0.002)` factor — meaningfully slower at a typical mouse-wheel tick (~18% per click vs the old jump of half a zoom level), smooth for trackpad pinch (tiny deltaY → tiny step), and perceptually consistent across zoom levels.
- Three.js overlays now render at the same size in the live UI preview as they do in the final MP4. r3f's auto-measure (`react-use-measure`) was reading the canvas-host element via `getBoundingClientRect()`, which returns post-transform dimensions — and the UI preview wraps overlays in a `transform: scale(N)` design wrapper that fits the 1080×1920 design canvas into the preview pane. So an overlay container authored at design `width: 1080, height: 500` was measured as ~245×113 px, and r3f sized the WebGL viewport + camera frustum for that tiny region; the ancestor transform then scaled the rendered output by another `N`x, so 3D content appeared at ~5× shrinkage and visually off-center compared to the final MP4 (where the same JSX renders inside Puppeteer at the full 1080×1920 layout with no transform ancestor). Passing `resize: { offsetSize: true }` through r3f to react-use-measure was *supposed* to switch to `element.offsetWidth/offsetHeight` (layout-space, transform-agnostic), but in our nested-transform setup it didn't take effect. Fix: the preview Canvas wrapper now mounts a small `PreviewForceSize` child component inside the r3f scene that reads its parent div's `offsetWidth`/`offsetHeight` directly and calls `useThree().setSize(w, h, true)`, re-applying on any subsequent resize via `ResizeObserver`. Render context is untouched — Puppeteer's headless layout has no ancestor transform, so r3f's default measurement is already correct there.
- Renders triggered from the UI no longer corrupt segment audio. The UI's `RenderModal` (and its mobile/carousel siblings) fires `api.renderProject` from a `useEffect` on mount; React StrictMode's dev-mode mount → cleanup → mount cycle fires this effect twice synchronously, sending two `POST /projects/:id/render` requests to serve, which spawned two concurrent `render.js` processes against the same workspace. Both processes wiped each other's segment directory and stamped output to the same `final.mp4.segments/seg-NNNN.mp4` paths; with `-movflags +faststart` the trailing moov-relocation pass of one would seek through bytes the other was still writing, leaving ADTS framing intact but every AAC packet payload zero-filled — segments looked valid (`ffmpeg exit 0`) but failed decode at concat with "Reserved bit set" / "channel element X.Y is not allocated" / "Number of bands exceeds limit". Three independent defenses landed: (1) `render.js` lockfile acquisition switched from check-then-write to `openSync(lockPath, 'wx')` (POSIX `O_CREAT | O_EXCL`) — atomic at the OS layer, eliminates the TOCTOU race that let both processes write their PID; (2) `serve/routes/projects.py` `/projects/{id}/render` now tracks in-flight project ids in a module-level set and returns `409 concurrent_render` for any second request before spawning render.js — defense at the serve layer where FastAPI's single asyncio loop makes the set-mutation race-free; (3) all four render modals (`RenderModal`, `MobileRenderModal`, `CarouselRenderModal`, `MobileCarouselRenderModal`) wrap their cleanup in a deferred `setTimeout(..., 0)` so StrictMode's transient unmount is "rescued" by the next mount (which calls `clearTimeout`), while a real unmount lets the timer fire and cancels the render properly. The three defenses are layered: the UI fix prevents the duplicate request at the source, the serve dedup catches anything that slips past (e.g. a misbehaving CLI client), and the lockfile is the last line of defense at the OS layer.
- Renders no longer abort on iPhone source clips that contain an Apple Positional Audio Codec (apac) track alongside the regular AAC audio. iPhone .MOV files written by recent iOS releases include TWO audio streams: stream 1 is the conventional stereo AAC, stream 2 is apac (4-channel spatial audio, codec_tag `apac`). ffmpeg's default "best audio" stream selector sometimes picked stream 2, hitting the decoder on a codec it can't actually handle — producing mis-decoded packets with weird channel counts (4–11 channels) that downstream filters couldn't downmix to stereo, aborting the whole render with `Rematrix is needed between N channels and stereo but there is not enough information to do it`. Fix: encode-segment.js's per-source audio filter now uses `[idx:a:0]` instead of `[idx:a]`, which explicitly selects the FIRST audio stream of each input (the clean AAC on iPhone clips) regardless of ffmpeg's selection heuristics. Added `aformat=channel_layouts=stereo:sample_rates=48000` as a defensive downmix for any non-iPhone source with unusual channel layouts, plus belt-and-suspenders `-err_detect ignore_err -max_error_rate 1.0` and `-af aformat=channel_layouts=stereo` in compose.js's concat re-encode. Net result: audio renders cleanly from iPhone clips even when the apac stream is present in the source.
- Google Fonts in overlays and captions actually load now. The `googleFonts` array on overlay items (and on the top-level `captions` object) has been documented for a while, but the render bundler was silently dropping it — `bundleComponent` didn't read the parameter and the generated `<head>` had no font links. The bundler now emits the Google Fonts CSS2 `<link>` (plus the `preconnect` pair) and the shim awaits `document.fonts.ready` on the first frame so frame 0 paints with the requested font instead of a CSS fallback. A 5s timeout guards against network stalls — on timeout the render proceeds with whatever fallback the JSX declared rather than hanging. The captions spec in `render.js` also now forwards `googleFonts` through to the bundler so caption styles can use custom fonts the same way overlays do. Carousel renders (`render-carousel.js`) use a separate bundling path and do not honor `googleFonts` yet — that's a follow-up.

### Added
- Mobile-friendly UI. A hard width-gate at the Tailwind `md` breakpoint (768px) routes narrow viewports to dedicated mobile variants of the project list, upload form, project header, top nav, and editor surfaces. Existing desktop components are untouched — mobile and desktop layouts evolve independently.
- Mobile intake is fully functional: browse projects, create a new project (clip / AI video / carousel / music-video), pick a workflow, and submit — all on a phone.
- Mobile editor surfaces are view-only: video projects show the existing `PreviewPlayer` with a single full-width Render button; carousel projects show a vertically-stacked read-only slide viewer with a Render button; AI-video projects mid-storyboard show a "open on desktop" notice that still surfaces the live agent log line so users can watch progress from their phone.
- Mobile render modals stack vertically (video on top, info panel below) instead of the desktop side-by-side layout, so output and download controls are reachable on a narrow screen.

### Changed
- `UploadView` refactored to consume a new `useUploadForm` hook (state, effects, derived values, and `handleRun` extracted). JSX is byte-identical; the hook is shared with the new `MobileUploadView`. No behavior change on desktop.
- `AspectRatioIcon` and `CarouselAspectIcon` extracted from `UploadView` into a new `uploadConstants.tsx` module so both desktop and mobile forms import them.
- Overlay JSX contract extracted into a shared `montaj-overlay-runtime` package (peer to `montaj_assets/render/` and `montaj_assets/ui/`, linked via `file:` paths — no workspaces required). Single source of truth for: the list of injected globals (`interpolate`, `spring`, `THREE`, `Canvas`, `useThreeFrame`, `Ph`, `FaIcon`, `FaSolid`, `FaBrands`), their implementations, and the pinned versions of `three`, `@react-three/fiber`, Phosphor, and FontAwesome. Three consumers now all consume from the runtime: the render shim (`bundle.js`), the carousel renderer's shim (`render-carousel.js`), and the UI preview evaluator (`overlay-eval.ts`). Each calls `makeOverlayGlobals(context)` instead of maintaining its own hand-written global list. Direct user-visible consequence: **Three.js overlays now render in the live UI preview**, not just the final MP4 — the drift that left the preview blind to `<Canvas>` is structurally eliminated. Two genuinely-different behaviors stay context-aware: `useThreeFrame` registers `window.__renderThree` in render and is a no-op in preview; `Canvas` respects `frameloop="never"` in render and forces `"always"` in preview so r3f's RAF takes over (trade-off: preview is smooth-RAF, not frame-stepped — visible to the user as motion that's continuous in preview vs frame-discrete in render). New contract-symmetry test (`montaj_assets/overlay-runtime/test.js`, runnable via `npm test` in the package dir) asserts both contexts expose the same set of global keys with matching types — guards against future drift.

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

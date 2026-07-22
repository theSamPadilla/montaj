# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Both editors

- **Added: visible Undo (and Redo) toolbar buttons.** Undo/redo was previously
  keyboard-only (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`) and only advertised in the
  canvas hint line + ⓘ modal. The carousel editor now shows **Undo** and
  **Redo** buttons in the left toolbar group beside Refresh, wired to the
  project-state hook's `undo`/`redo` and disabled via `canUndo`/`canRedo`. The
  video editor gains an **Undo** button in the track-controls bar, wired to the
  existing `handleUndo`/`canUndo` (video has no redo stack, so no Redo button).
  Keyboard shortcuts are unchanged.

## 0.8.10 — 2026-07-20

### Video editor

- **Added: caption color controls** in the caption panel, next to the style
  picker and font-size slider. A **Text** swatch sets the base caption color
  (`captions.color`, honored by every style), and a second **accent** swatch
  sets the highlighted/active color. The accent swatch is style-aware — it
  writes whichever field the active style's render template actually reads
  (`karaoke`→`highlightColor`, `pop`→`activeColor`, `highlight-box`/`outline`→
  `accentColor`, `subtitle`→`backgroundColor`) and relabels itself to match. It
  is hidden for `clean` and `word-by-word`, which have no accent. Colors preview
  live while picking and persist on the picker's close, mirroring the font-size
  slider. Both the browser preview and the render engine already read these
  fields, so preview and export stay in sync.
  - The native OS color picker is hex-only, so partial transparency (e.g.
    karaoke's translucent unsung words) can't be set from the UI.
- **Internal: extracted `SwatchInput`** into `src/ui/` as a shared primitive
  (gaining an `onCommit` blur hook + compact `size`/`showValue` options); the
  carousel slide panel now consumes it instead of its private copy.

## 0.8.9 — 2026-07-16

### Video editor

- **Fixed: arrow keys no longer scrub the video while editing caption text.**
  The timeline's global ←/→ frame-step handler only ignored `<input>`/
  `<textarea>` targets, so with the caret inside a caption segment (they're
  `contentEditable` spans) arrows moved the playhead as well as the text
  cursor. It now also bails when the target is contentEditable, and is
  disabled entirely while the transcript modal is open — arrows just move the
  text cursor there. Timeline scrubbing is unchanged everywhere else.

- **Added: caption style picker gains 3 styles** (`highlight-box`, `outline`,
  `clean`) alongside the existing `word-by-word`/`karaoke`/`pop`/`subtitle`.

- **Added: a font-size slider** in the caption panel — adjusts `fontsize` on
  the caption track live against the preview.

- **Added: a "Remove captions" button** with a two-step inline confirm, to
  clear the caption track from the project without hand-editing
  `project.json`.

- **`CaptionPreview` now passes theme props** (not just `segments`) through to
  the caption template factory, so style/color/size edits are reflected live
  in the preview.

## 0.8.8 — 2026-07-09

### Both editors

- **Added: an "ⓘ" controls & shortcuts reference.** A small info button in the
  video editor's toolbar and beside the carousel editor's hint line opens a
  themed modal (`ControlsInfoModal`) listing the real gestures and keyboard
  shortcuts for that editor — preview drag/scale/rotate, timeline trim, Split
  (`S`), undo/redo, `Delete`, etc. Content is sourced from the editors' actual
  handlers so it can't drift into fiction. Dismisses on backdrop-click or `Esc`.

## 0.8.7 — 2026-06-26

### Carousel editor

- **Fixed: the carousel render modal no longer hangs forever on "Starting render
  engine…".** The Hub render backend is async-only (`POST …/render` returns
  `{status:'running'}` and the render runs detached — it no longer streams SSE),
  but `CarouselRenderModal` still consumed the dead SSE `adapter.render()`
  stream, so it waited forever for a `done` event that never arrived while the
  render actually completed server-side. It now mirrors `video/RenderModal`:
  kick `renderAsync`, poll `getRenderStatus` until terminal (tolerating up to 12
  consecutive transient poll failures so a tunnel hiccup isn't mistaken for a
  failure), and build the done-state gallery from the promoted R2 `media`
  (filtered to `slide_NN.png` and sorted). The SSE `adapter.render()` path is
  preserved as a fallback for hosts without the poll API (montaj-native
  desktop). (`src/carousel/CarouselRenderModal.tsx`)

### Video editor

- **Render modal progress UI is now a host-chosen flag
  (`VideoEditorProps.renderProgressView?: 'phases' | 'logs'`, default
  `'phases'`).** montaj-native passes `'logs'` and gets the full scrolling
  render-log panel (colorized lines + Copy) back; Hub clients keep the compact
  Preparing → … → Saving stepper. The SSE render path accumulates log lines
  again for the panel. (`src/types.ts`, `src/video/RenderModal.tsx`,
  `src/video/VideoEditor.tsx`)

- **Fixed: lazy-normalize preview no longer freezes on clips with a
  `normalizedSrc` window cache.** The preview loads the per-window cache (which
  starts at 0 and is only `outPoint - inPoint` seconds long) but was still
  seeking to the original `inPoint` (e.g. 496s) — the browser clamped to EOF and
  the clip showed a frozen last frame with no playback. The preview now rebases
  the seek/window math to the cache timeline (effective inPoint 0, outPoint =
  `outPoint - inPoint`), mirroring render's `collectAllItems`. `nobg_preview_src`
  (full-source, takes precedence) is unaffected and keeps the original inPoint.
- **Fixed: preview now reflects `sourceCrop`.** Clips with a `sourceCrop`
  (clips-workflow vertical reframe) showed the full letterboxed source in
  preview while render applied the crop/zoom. The preview `<video>` now
  crop→contain-fits the sub-rect into the frame, matching render's ffmpeg
  `crop` + `scale(decrease)` + `pad` pipeline. Clips without `sourceCrop` keep
  the existing `object-contain` behavior.

- Layout brought in line with the carousel editor: the host-supplied assets
  panel (`slots.assetsPanel`) now renders as a **full-width region stacked below
  the editor** instead of crammed into the narrow right rail. The editor body
  (preview + timeline + captions) gets the full width; the right rail now carries
  only version history / run-history. Mirrors `CarouselEditor`'s stacked layout.
- Video editor chrome is now **theme-compliant**: `VersionPanel`, `VideoEditor`,
  `RenderModal`, and `CaptionRegenModal` consume the `--editor-*` theme tokens
  (via `applyTheme`) exactly like the carousel chrome, instead of hardcoding
  fixed grays + `dark:` variants. The video editor now re-skins per tenant and
  renders correctly in light-mode hubs. Brand accents (Render button, agent
  handoff, version Restore) follow `--editor-accent`; semantic colors
  (error/success/status, Ripple/Crop mode indicators) and the black video
  letterbox are unchanged. Version-history cards realigned for cleaner rows.

### Carousel editor

- Snap/alignment guides are more visible: thicker (2px), brighter, and glow so
  they're easy to see against any slide background.

## 0.5.3

### Video editor

- **Regenerate captions.** New `generateCaptions` adapter method
  (`AsyncIterable<CaptionEvent>`) + a "Regenerate captions" button in the
  caption panel. Streams multilingual transcription progress and replaces
  `project.captions` with project-time-aligned segments when done. Requires a
  host adapter that implements `generateCaptions` (mel-hub) and montaj ≥ 3.0.4
  on the sidecar.

## 0.5.2

### Video editor

- **Fix laggy playback / clips overrunning their cut.** Clip-boundary detection
  for video projects now runs on a `requestAnimationFrame` clock (~60Hz) instead
  of riding the `<video>` element's `timeupdate` event (~4Hz). Previously the
  active clip could play up to ~250ms past its `outPoint` before the swap fired
  — on a silence-trimmed single-source timeline that overshoot was trimmed-out
  footage playing past the cut ("the underlying video keeps playing"). The rAF
  clock tightens the boundary to ~1 frame (≤~16ms); measured overshoot dropped
  from ~250ms to ≤9ms. `handleTimeUpdate` is idempotent, so the coarse
  `timeupdate` event remains a harmless fallback.

## 0.4.6

### Carousel editor

- The editor controls (refresh / toolbar actions / render) now sit in a proper
  toolbar row at the top of the canvas column instead of floating over the slide.
- Add-element buttons (`+ AI Image` / `+ Upload Image` / `+ Text` / `+ Overlay`)
  render in a 2×2 grid with no mid-label wrapping.
- The three work-area columns (slides rail · canvas · controls) scroll
  independently — scrolling one no longer moves the others.

## 0.4.5

### Carousel editor

- Controls/inspector polish: the right-hand property panel restyled into a clean
  inspector — one consistent themed input style across all fields, a real color
  swatch + hex for Background color (was a blank box), a tidy X/Y/W/H transform
  grid, a segmented text-formatting toolbar, and consistent themed buttons.

## 0.4.4

### Carousel editor

- Layout: the slide editor (add-element toolbar + property panel) sits to the
  RIGHT of the canvas again (widened to 24rem) — stacking it below the canvas
  made it require too much scrolling. Project media (`assetsPanel`) stays as a
  full-width region at the bottom. Canvas height tuned down (~62vh).

## 0.4.3

### Carousel editor

- Canvas significantly larger via a tall vertically-scrolling layout.
- Left-rail slide thumbnails show the entire slide (no vertical trim) — fixed a
  flex-compression that clipped portrait thumbnails.
- Buttons stay legible on any host theme: non-primary buttons use a themed
  surface, full-strength text, and a visible border.
- (Superseded by Unreleased) below-canvas panels were stacked full-width.

## 0.4.2

### Carousel editor

- Layout: the property panel, add-element toolbar, and `assetsPanel` slot render
  in a region BELOW the canvas instead of a right sidebar. Editor controls
  (refresh / toolbar actions / render) stay on the canvas.
- Fix: overlays no longer render oversized/overlapping — overlay elements are
  authored in native slide pixels, so they're rendered at native size and
  CSS-scaled to the canvas scale (matching the renderer).
- Editor chrome honors the host `theme` via the `--editor-*` CSS variables
  (shell, panels, toolbars, buttons, selection). Added an `accentForeground`
  color token so accent-colored controls get a readable paired foreground.

## 0.4.1

### Carousel editor

- Fix: bound the `assetsPanel` slot width so a wide host panel couldn't blow out
  the right column and crush the canvas (superseded by the 0.4.2 below-canvas
  layout).

## 0.4.0

### Carousel editor

- New public `ReadOnlySlide` read-only renderer (with optional auto-fit): a thin
  wrapper over the non-interactive `SlideCanvas` exposing only read-only props,
  optionally measuring its sized parent to fit the slide.
- Crop display in non-interactive render: a committed `ImageElement.crop` now
  renders the cropped sub-rect via the oversized-cover technique (matching the
  renderer) instead of falling back to a plain `object-fit: cover`.
- Google Fonts loading for carousel overlays (`OverlayElement.googleFonts`): the
  carousel overlay render path now loads declared Google Fonts so previews use
  the same glyphs and metrics as the renderer.

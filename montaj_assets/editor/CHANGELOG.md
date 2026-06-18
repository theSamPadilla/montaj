# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Video editor

- Layout brought in line with the carousel editor: the host-supplied assets
  panel (`slots.assetsPanel`) now renders as a **full-width region stacked below
  the editor** instead of crammed into the narrow right rail. The editor body
  (preview + timeline + captions) gets the full width; the right rail now carries
  only version history / run-history. Mirrors `CarouselEditor`'s stacked layout.

### Carousel editor

- Snap/alignment guides are more visible: thicker (2px), brighter, and glow so
  they're easy to see against any slide background.

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

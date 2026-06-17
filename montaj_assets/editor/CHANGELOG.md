# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Carousel editor

- Canvas is significantly larger: the editor uses a tall, vertically-scrolling
  layout so the slide preview renders much bigger; controls stay on the canvas.
- Left-rail slide thumbnails now show the entire slide (no vertical trim) — fixed
  a flex-compression that clipped portrait thumbnails.
- Buttons stay legible on any host theme: non-primary buttons use a themed
  surface, full-strength text, and a visible border (no more faint low-contrast
  controls on dark skins).
- Below-canvas panels are stacked full-width: add-element toolbar → slide/element
  property panel → Project media (`assetsPanel`) at the very bottom.

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

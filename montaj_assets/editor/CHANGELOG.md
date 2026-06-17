# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Carousel editor

- Layout: the property panel, add-element toolbar, and `assetsPanel` slot now
  render in a full-width region BELOW the canvas (vertical stack: slide rail +
  canvas on top, panels beneath) instead of a right sidebar. The editor controls
  (refresh / toolbar actions / render) stay on the canvas.
- Fix: overlays no longer render oversized/overlapping in the canvas. Overlay
  elements are authored in native slide pixels, so they're now rendered at native
  size and CSS-scaled to the canvas scale (matching the renderer) instead of
  overflowing the shrunk element box.
- Editor chrome now honors the host `theme`: threaded the `--editor-*` CSS
  variables through the carousel editor chrome (shell, panels, toolbars,
  buttons, selection) so a host theme actually re-skins the editor. Added an
  `accentForeground` color token so accent-colored controls get a readable
  paired foreground (e.g. dark text on a light accent).
- Fix: bound the `assetsPanel` slot to the sidebar width (`w-80`) with vertical
  scroll. Without a width cap, a wide host panel (e.g. a full media-library card)
  blew out the right column and crushed the `flex-1` editing canvas to a sliver.

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

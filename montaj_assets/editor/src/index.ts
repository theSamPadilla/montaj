// @bycrux/editor — public API.
//
// The package owns the host-agnostic carousel editor: the editor-facing schema,
// the adapter/theme contracts, and the host-agnostic PIECES (state, gestures,
// crop, text, preview, overlays). Hosts (Montaj's UI, Hub clients) import from
// here and supply an EditorAdapter to drive it.

// ── Schema (single source of truth for project/slide/element shapes) ──────────
export type {
  Word,
  AudioTrack,
  CaptionSegment,
  Captions,
  VisualItem,
  Asset,
  ImageElement,
  OverlayElement,
  CarouselElement,
  Slide,
  EditorProject,
} from './schema'

// ── Contracts (adapter, theme, render, media, component props) ────────────────
// Schema types are sourced from './schema' above; here we export only the
// symbols types.ts itself owns, plus the `Project` alias (= EditorProject) that
// the ported state/reducer code is typed against.
export type {
  Project,
  OverlayFactory,
  RenderEvent,
  RenderOptions,
  MediaScope,
  MediaItem,
  GlobalOverlay,
  GlobalOverlayProp,
  EditorAdapter,
  EditorTheme,
  EditorSlots,
  CarouselEditorProps,
} from './types'

// ── Theme ─────────────────────────────────────────────────────────────────────
export { defaultMontajTheme, applyTheme } from './theme'

// ── State ───────────────────────────────────────────────────────────────────
export { useProjectState } from './state/use-project-state'
export type { Connection, UseProjectState } from './state/use-project-state'
export { projectReducer } from './state/project-reducer'
export type { Action, ProjectStatus } from './state/project-reducer'
export { createMutationQueue } from './state/mutation-queue'
export type { MutationQueue } from './state/mutation-queue'

// ── Gestures ──────────────────────────────────────────────────────────────────
export * from './gestures'

// ── Crop ──────────────────────────────────────────────────────────────────────
export {
  renderedSourceRect,
  fractionToWrapperPx,
  wrapperPxToFraction,
  applyCropHandleDrag,
} from './crop/crop-math'
export type {
  RenderedRect,
  CropFraction,
  WrapperPxRect,
  CropHandle,
} from './crop/crop-math'
export { CanvasCropOverlay } from './crop/CanvasCropOverlay'
export type { CanvasCropOverlayProps } from './crop/CanvasCropOverlay'

// ── Text ──────────────────────────────────────────────────────────────────────
export {
  FONT_OPTIONS,
  findFontOption,
  FontFamilyPicker,
  FontSizePicker,
} from './text/FontPicker'
export type { FontOption } from './text/FontPicker'
export { InlineTextEditor } from './text/InlineTextEditor'
export type { InlineTextEditorProps } from './text/InlineTextEditor'
export {
  HEX_PATTERN,
  isColorProp,
  isBold,
  isItalic,
  nextCase,
  isStyleProp,
  nonColorTextEntries,
  TextFormattingToolbar,
} from './text/TextFormattingToolbar'
export type { TextFormattingToolbarProps } from './text/TextFormattingToolbar'

// ── Preview ─────────────────────────────────────────────────────────────────
export { OverlayPreview } from './preview/OverlayPreview'
export type { OverlayPreviewProps } from './preview/OverlayPreview'

// ── Overlays ──────────────────────────────────────────────────────────────────
export {
  STANDARD_TEXT_PROPS,
  getSupportedProps,
  readPropAsString,
} from './overlays/contract'

// ── Assembled carousel editor ───────────────────────────────────────────────
export { default as CarouselEditor } from './carousel/CarouselEditor'

// ── Public carousel sub-components ────────────────────────────────────────────
// Hosts consume these beyond the assembled editor — Montaj's preview/caption
// components render SlideCanvas thumbnails and wrap overlays in the boundary.
export { default as SlideCanvas, resolveAsset } from './carousel/SlideCanvas'
export { default as OverlayErrorBoundary } from './carousel/OverlayErrorBoundary'

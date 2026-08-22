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
  VisualTrack,
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
  RenderExport,
  SampleFrameOptions,
  RenderStatus,
  RenderPhase,
  CaptionEvent,
  GenerateCaptionsOptions,
  MediaScope,
  MediaItem,
  GlobalOverlay,
  GlobalOverlayProp,
  VersionEntry,
  WaveformChunk,
  PeaksData,
  PeaksResolution,
  GetWaveformPeaksArgs,
  FilmstripSheet,
  FilmstripIndex,
  GetFilmstripArgs,
  EditorAdapter,
  EditorTheme,
  EditorSlots,
  CarouselEditorProps,
  VideoEditorProps,
} from './types'

// ── Video editor pure helpers ─────────────────────────────────────────────────
export {
  applyCutToTracks,
  applyCutToItem,
  collapseGaps,
  splitAtTime,
  rippleDelete,
  rollEdit,
  slipItem,
  slideItem,
  setClipSpeed,
} from './video/cuts'
export type { Cut } from './video/cuts'
export { getOverlayDesignCanvas } from './video/design-canvas'
// Track-shape tolerance: `project.tracks` may be on disk as the legacy
// `VisualItem[][]` or as `VisualTrack[]`. Read through `trackItems`; normalize
// on open with `normalizeTracks` (same object back when already converged).
export {
  effectiveItemAudio,
  enabledTrackItems,
  enabledTracks,
  mapTrackItems,
  normalizeTracks,
  trackItems,
  withEnabledItemTracks,
  withItemTracks,
} from './video/timeline/timeline-model'

// ── Image tone (HDR image color mapping) ─────────────────────────────────────
// The picker component is exported so hosts using `onProvideImageTone` can
// render the same control (variant="header") in their own chrome.
export { default as ImageToneMenu } from './video/ImageToneMenu'
export type { ImageToneMenuProps } from './video/ImageToneMenu'

// ── Speed control (slider + preset chips) ────────────────────────────────────
// Shared by the per-clip inspect modal (host `montaj_assets/ui`) and the
// track-wide settings popover (TrackSettingsPopover.tsx).
export { default as SpeedControl } from './video/timeline/SpeedControl'
export type { SpeedControlProps } from './video/timeline/SpeedControl'
export { default as VolumeControl } from './video/timeline/VolumeControl'
export type { VolumeControlProps } from './video/timeline/VolumeControl'
export { IMAGE_TONES, DEFAULT_IMAGE_TONE } from './video/imageTone'
export type { ImageTone, ImageToneInfo } from './video/imageTone'

// ── SDR tone curves (HDR→SDR export look) ────────────────────────────────────
// Descriptors + the modal's honesty copy. Exported so a host can label its own
// chrome with the same curve names it sends as `RenderOptions.sdrCurve`.
export { SDR_CURVES, DEFAULT_SDR_CURVE, sdrCurveInfo, honestyLine } from './video/sdrCurves'
export type { SdrCurve, SdrCurveInfo } from './video/sdrCurves'
export type { PreRenderOptions } from './video/RenderModal'

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

// ── Playback clock (external playhead store) ──────────────────────────────────
export { createPlaybackClock, usePlaybackTime } from './video/playback-clock'
export type { PlaybackClock } from './video/playback-clock'

// ── Video preview ─────────────────────────────────────────────────────────────
export { default as PreviewPlayer } from './video/preview/PreviewPlayer'
export { default as CarouselPreview } from './video/preview/CarouselPreview'
export { default as OverlayItemsLayer } from './video/preview/OverlayItemsLayer'
export { useVideoPlayback } from './video/preview/useVideoPlayback'
export { useDragOverlay } from './video/preview/useDragOverlay'
export type { Corner, DragType } from './video/preview/useDragOverlay'

// ── Overlays ──────────────────────────────────────────────────────────────────
export {
  STANDARD_TEXT_PROPS,
  getSupportedProps,
  readPropAsString,
} from './overlays/contract'

// ── Assembled editors ─────────────────────────────────────────────────────────
export { default as CarouselEditor } from './carousel/CarouselEditor'
export { default as VideoEditor } from './video/VideoEditor'

// ── Public carousel sub-components ────────────────────────────────────────────
// Hosts consume these beyond the assembled editor — Montaj's preview/caption
// components render SlideCanvas thumbnails and wrap overlays in the boundary.
export { default as SlideCanvas, resolveAsset } from './carousel/SlideCanvas'
export { default as OverlayErrorBoundary } from './carousel/OverlayErrorBoundary'
export { default as ReadOnlySlide } from './carousel/ReadOnlySlide'
export type { ReadOnlySlideProps } from './carousel/ReadOnlySlide'

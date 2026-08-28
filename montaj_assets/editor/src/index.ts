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
  Marker,
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
  AnalyzeAudioPolishArgs,
  AudioPolishAnalysis,
  FootageDropPayload,
  PendingDrop,
  TimelineDropPlacement,
  EditorAdapter,
  EditorContext,
  EditorTheme,
  EditorSlots,
  CarouselEditorProps,
  VideoEditorProps,
} from './types'
// `FOOTAGE_DND_MIME` is a value (const), not a type — exported separately so
// hosts can compare against it when reading a drag event's MIME data.
export { FOOTAGE_DND_MIME } from './types'

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
  insertClipAt,
  newClipId,
} from './video/cuts'
export type { Cut } from './video/cuts'
export { getOverlayDesignCanvas } from './video/design-canvas'
// Track-shape tolerance: `project.tracks` may be on disk as the legacy
// `VisualItem[][]` or as `VisualTrack[]`. Read through `trackItems`; normalize
// on open with `normalizeTracks` (same object back when already converged).
// `normalizeAudioTracks` is the audio sibling — `audio.tracks[*].id` is
// optional on disk but required by the editor, so it's backfilled the same
// way (same object back when already converged).
export {
  effectiveItemAudio,
  enabledTrackItems,
  enabledTracks,
  mapTrackItems,
  normalizeAudioTracks,
  normalizeTracks,
  trackItems,
  withEnabledItemTracks,
  withItemTracks,
} from './video/timeline/timeline-model'
// The one placement rule shared by both new-clip drop entry points (the
// footage-bin drag today, a filesystem drop in a later task) — public so the
// host can route either drop through it rather than each reimplementing
// "land where you dropped it, without stomping existing footage".
export { placeDroppedClip, resolveDropTrackIndex } from './video/timeline/placement'
export type { DroppedClipPlacement, PlacedClipResult } from './video/timeline/placement'
// Marker model — pure mutations over `project.markers` (see markers.ts's file
// header for the "same reference when unchanged" contract they all share).
export { addMarker, moveMarker, renameMarker, removeMarkers, nextMarkerLabel } from './video/timeline/markers'

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
export { defaultMontajTheme, lightMontajTheme, applyTheme, isLightTheme } from './theme'

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

// ── Source preview (footage-bin → main preview scrub, opt-in) ─────────────────
// External store a host's footage bin sets to drive a source-scrub overlay on
// the main preview. Pass the store to both the bin card and VideoEditor's
// `sourcePreview` prop; absent → the main preview is unchanged. See
// `video/source-preview.ts`.
export { createSourcePreviewStore, useSourcePreview } from './video/source-preview'
export type { SourcePreviewStore, SourcePreviewValue } from './video/source-preview'

// ── Video preview ─────────────────────────────────────────────────────────────
export { default as PreviewPlayer } from './video/preview/PreviewPlayer'
export { default as CarouselPreview } from './video/preview/CarouselPreview'
export { default as OverlayItemsLayer } from './video/preview/OverlayItemsLayer'
export { useVideoPlayback } from './video/preview/useVideoPlayback'
export { useReportContext, REPORT_INTERVAL_MS } from './video/use-report-context'
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

// ── Footage bin (media panel) ─────────────────────────────────────────────────
// A host's Footage/B-Roll panel drops this in per source card for the
// hover-scrub thumbnail (docs/plans/footage-bin-media-panel.md, Phase 2/3).
export { default as FilmstripScrubber } from './components/FilmstripScrubber'
export type { FilmstripScrubberProps } from './components/FilmstripScrubber'

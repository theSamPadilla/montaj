# Changelog

All notable changes to `@bycrux/editor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Video editor

- **Added: press `M` to drop a marker on the timeline — a small, named flag pinned to a moment, drawn in a strip along the very top, above the ruler.** The strip only exists once a project actually has a marker (`computeTimelineLayout` reserves it only when `project.markers` is non-empty), so a project without one lays out at the exact same pixel it always has. A new marker gets an auto-number (`nextMarkerLabel` reads the highest purely-numeric label currently in use and hands out one more) instead of an empty box to fill in, so dropping one never interrupts the edit to type a name; delete marker "2" out of 1/2/3 and the next one is still "4", never a reused "3", and naming a marker "cut this" contributes nothing to the count, so renaming can never stall or rewind it.

  `M` drops the marker at the playhead, except when the preview axis (`⌘`/`Ctrl`+`A`) is on, where it drops on the yellow line the operator is actually looking at instead (`markerDropTime`, deliberately `??` rather than `||`, since a hovered `0` — the very start of the timeline — is still a legitimate drop point, not a signal to fall back to the playhead), falling back to the playhead anyway if the axis is on but the pointer has left the timeline. This mirrors the rule Split (`S`) already follows rather than inventing a new one.

  Holding `M` down doesn't spray markers across the strip: `addMarker` hands back the exact same project reference, unchanged, whenever a marker already sits within half a frame of the requested time, and the caller reads that as a no-op instead of pushing an empty undo entry. Key repeat fires at whatever rate the OS picks — easily several times a second — and cleaning up a pile of stacked near-duplicate markers is worse than the rare case of genuinely wanting two markers a frame apart, which the half-frame window is narrow enough to leave alone.

  Double-click a marker's label to rename it inline, in a real `<input>` positioned over the canvas — the one text editor this canvas hosts directly, since caption text edits route to the sidebar instead. `Enter` or clicking away commits; `Escape` cancels; a blank or all-whitespace name is refused rather than saved, because clearing the box means "leave it alone," and deleting the marker is the actual way to get rid of it. Dragging a marker along the strip retimes it, grab-relative like every other drag on this timeline (`dragDeltaSeconds`): it preserves the offset between where the pointer grabbed the flag and the flag's own position, rather than snapping the marker to meet the cursor. That matters here specifically because a marker's clickable region is 72px wide so the *label* is grabbable and not just its 2px flag stem, which means a press routinely lands well right of the flag itself.

  Selecting a marker and pressing Delete removes it. Markers live at `project.markers`, outside `tracks`/`audio`, so the existing multi-select delete path can't see them on its own; `Timeline.tsx` folds `removeMarkers` into the same commit, so a mixed selection of clips, captions and markers deletes as one undo entry, not several. Markers are saved with the project and covered by undo/redo like any other edit, and the renderer ignores them completely — an editing and communication aid, never part of the export. That communication purpose is the actual point of the feature: every marker's name and time now reaches the agent through the editor's context endpoint, alongside the playhead, the clip under it, and the transcript it already receives, so naming a marker is how an operator tells the agent what to do and where. (`schema.ts`, `video/timeline/markers.ts`, `video/timeline/canvas/draw.ts`, `video/timeline/canvas/hit-test.ts`, `video/timeline/canvas/pointer-machine.ts`, `video/timeline/canvas/TimelineCanvas.tsx`, `video/timeline/Timeline.tsx`, `video/VideoEditor.tsx`, `ControlsInfoModal.tsx`, `index.ts`, `video/__tests__/markerDropTime.test.ts`, `video/timeline/__tests__/markers.test.ts`, `video/timeline/canvas/__tests__/draw.test.ts`, `video/timeline/canvas/__tests__/hit-test.test.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `video/timeline/canvas/__tests__/TimelineCanvas.test.tsx`, `video/timeline/__tests__/Timeline.keymap.test.tsx`, `video/__tests__/VideoEditor.keymap.test.tsx`)

- **Fixed: cutting an audio track manufactured a fade-out at the razor, every time.** `splitAudioTrack` built both halves by spreading the original track, so both fragments inherited BOTH fades — including on the two edges the cut had just created. On a voiceover carrying the usual trailing fade-out, every cut left the left fragment ramping to silence into the razor (and the right fragment fading in out of it), which the operator then had to zero by hand on each new piece. Fades are added deliberately; a cut is not a request for one. Each half now keeps only the fade whose edge it still owns — the left half the original START and its `fadeIn`, the right half the original END and its `fadeOut` — and the two new edges at the cut carry no fade at all. Splitting repeatedly follows from that: a middle fragment owns neither original edge and so carries neither fade. Each fade's curve travels with it, since a `fadeOutCurve` describing a fade-out that no longer exists is dead data and the next hand-drawn fade should start from the default shape. A kept fade is also clamped to its own fragment's span — a 3s fade-out is fine on a 20s track, but split that track 1s from its end and the fade no longer fits the fragment it lands on, and nothing downstream re-clamps (the pointer-machine and the properties panel each clamp only their own edits, and the render just anchors `st = end - fadeOut`). The auto-crossfade pass is unaffected and was never the cause: it needs a genuine overlap, and a split produces adjacent fragments. Splitting a track that carries no fades is byte-identical to before — no field is invented. (`video/cuts.ts`, `video/__tests__/cuts.test.ts`)

- **Fixed: a project whose visuals all sit on the first track would not play at all — space and the play button did nothing, on a timeline that showed the right duration.** A project with no video clips on `tracks[0]` runs the preview's canvas clock, whose ceiling was read off the *overlay* tracks alone (`tracks.slice(1)`). That is a safe reading only while `tracks[0]` holds primary footage, and in canvas mode it does not — it holds content: the background images, and on an agent-authored project frequently the overlays themselves. An animations-workflow project is routinely ONE track of nothing but overlays, and for exactly those the ceiling summed to `0`. The transport then started and stopped inside the same frame: the first tick clamped the playhead to `0` and called `setIsPlaying(false)`, so the picture never moved and nothing was logged, because nothing had failed — the clock had simply been told the project was zero seconds long. A canvas project whose track-0 background image outlasted its last overlay stopped early for the same reason. Both playback paths carried the defect independently and both are fixed, so falling back from the WebCodecs engine to the legacy `<video>` player would not have helped and no longer differs here. The ceiling now spans every enabled track, track 0 included, which is what `OverlayItemsLayer` has always DRAWN in canvas mode (`isCanvasProject ? enabledTrackItems : overlayTracks`) — the transport was the one component disagreeing with what was on screen. The clamp itself is unchanged and still stops playback at the last frame of content rather than running past it. Audio deliberately stays out of the canvas ceiling: that canvas/video divergence is documented in `timeline-core`'s `durations.js` and changing it would alter playback length for every existing canvas project, which this fix does not do. Nothing about project files changes — no migration, no re-save, and a project that played correctly before plays identically. (`engine/scheduler.ts`, `engine/__tests__/scheduler.test.ts`, `video/preview/useVideoPlayback.ts`, `video/preview/__tests__/useVideoPlayback.canvasClock.test.ts`)

- **Fixed `textTransform` at its source, so a consumer's typecheck actually passes.** `1.0.2` narrowed `CaptionSpecimen`'s `textTransform` prop to `CSSProperties['textTransform']`, but left `Captions.textTransform` in `schema.ts` as a bare `string` — so the error did not go away, it MOVED to the call site that feeds the component, surfacing as the same `TS2322` at `CaptionStyleGallery.tsx:445` instead. Because this package ships raw TypeScript, a type error inside it is a hard build failure in any consumer (`skipLibCheck` only covers `.d.ts`, and `exclude: node_modules` does not stop TypeScript following imports), so this blocked a consumer app's `next build` outright with no fix available on their side. The field is now a named, exported `CaptionTextTransform` union — `'uppercase' | 'lowercase' | 'capitalize' | 'none'`, exactly what the comment on that line already documented — and `CAPTION_STYLE_TEXT_TRANSFORM` is keyed to it too, so both the write path (the case chips, already `as const`) and the read path narrow from one declaration. No runtime or behavior change: the values written and rendered are the same ones as before. The lesson worth keeping: narrowing a consuming component instead of the field it reads relocates this class of error rather than removing it. (`schema.ts`, `video/captionStyleDefaults.ts`)

- **Added: overlapping two items on the same track — clips or overlays — now crossfades between them, live in the editor's own preview.** `computeVisualCrossfade` derives complementary `opacity` keyframes for an overlapping overlay pair (`timeline-model.ts`), the same way `computeAutoCrossfade` already did for audio tracks, and lands through the same two commit paths: `commitTimelineEdit` folds it into the SAME undo step as the gesture that created the overlap (a drag or a trim), so dragging one overlay onto another never produces a bare move followed by a separate fade commit; a second, debounced pass in `Timeline.tsx` is the catch-all for an overlap that appears OUTSIDE a gesture — ripple-delete, gap-collapse — which reach `sync.mutate` directly and never pass through `commitTimelineEdit` at all. Both passes are idempotent, so an unaffected project, or one whose fades already converged, triggers no extra save.

  An overlay track's trim now lets an edge be dragged past a neighbour's NEAR boundary — a partial overlap is a transition, not a mistake — but not far enough to fully contain it, which the validator still rejects (`timeline/canvas/pointer-machine.ts`). `tracks[0]`'s own trim is unchanged; it never had a neighbour-overlap guard to begin with.

  The engine's own preview composites the same blend the render does: two decode sessions running side by side, painted together in one `Painter.paintBlend` call each frame. The commonest crossfade on a silence-trimmed timeline is between two CUTS OF THE SAME TAKE — trim a pause out of a clip and its neighbours are two segments of one source file — which a single `FrameServer` per source (refcounted by clip) can't serve two decode positions from at once. A clip that's the incoming side of such a pair can now ask for its own exclusive decoder for the length of the transition (`SourceRequest.exclusiveServer`), so both sides decode independently instead of one starving the other.

  The legacy `<video>`-element player has no compositing stage to blend two frames with — it plays one `<video>` per clip and hard-cuts between them, which it always did and still does for everything else. A project that falls back to it (background removal in v1, or simply an older host) now shows a persistent banner reading "Crossfades will not appear in this preview. They will render in the export." instead of silently disagreeing with what the export will produce; the banner tracks live, appearing and disappearing the instant an operator drags two clips into or out of overlap. (`video/timeline/timeline-model.ts`, `video/timeline/__tests__/timeline-model.test.ts`, `video/VideoEditor.tsx`, `video/__tests__/VideoEditor.test.tsx`, `video/timeline/Timeline.tsx`, `video/timeline/canvas/pointer-machine.ts`, `video/timeline/canvas/__tests__/pointer-machine.test.ts`, `engine/scheduler.ts`, `engine/index.ts`, `engine/__tests__/scheduler.test.ts`, `engine/__tests__/engine.test.ts`, `engine/__tests__/source-host.test.ts`, `engine/eligibility.ts`, `engine/__tests__/eligibility.test.ts`, `video/preview/PreviewPlayer.tsx`, `video/preview/__tests__/PreviewPlayer.engine.test.tsx`, `video/preview/OverlayItemsLayer.tsx`, `video/preview/__tests__/OverlayItemsLayer.keyframes.test.tsx`, `schema.ts`)

- **Filesystem-drop ghost lands on the video row the clip will.** A dropped desktop video's pre-ingest ghost band used to draw on whatever row the pointer released over — an overlay or image row included — even though the finished clip always resolves to a video row. It now resolves to that same video row, via a new shared `resolveDropTrackIndex` (exported beside `placeDroppedClip`), so the ghost and the placement can never disagree. (`video/timeline/placement.ts`, `index.ts`)

- **Caption Format tab: a slider on font size, bigger row labels, and the one-word preview is gone.** Font size now has the shared slider next to its typeable box (drag for a quick size, type for an exact one — both drive the same live value), the Format-tab row labels are a touch larger, and the small specimen box that showed a single word for a whole-sentence style has been removed (the Styles gallery is the size-faithful preview). (`CaptionListPanel.tsx`, `CaptionSpecimen` usage dropped)

- **Fixed `CaptionSpecimen`'s `textTransform` TypeScript type.** The `textTransform` prop was typed as `string` and assigned into a `style` object, where React's `CSSProperties` expects a specific `TextTransform` literal union. This caused `tsc --noEmit` to fail in any consumer typechecking against the package's TypeScript sources (since the package ships raw TS, `skipLibCheck` cannot mask it). It is now correctly typed as `CSSProperties['textTransform']`. (`CaptionSpecimen.tsx`)

- **Selecting a caption anywhere jumps the left panel to its Captions tab.** Clicking a caption on the timeline, in the preview, or in the list now switches the browser panel to Captions, so its controls are in front of you. It never fights a manual tab choice on mount, and re-selecting the same caption still snaps back. (`panels/LeftPanelTabs.tsx`, `VideoEditor.tsx`)

- **Transform tab: dropped the redundant "TRANSFORM" heading.** The CONTENT/TRANSFORM tab already names the pane, so the second heading is gone; the reset-all and keyframe-all controls stay, now under a compact "All" label. (`OverlayInspector.tsx`)

- **Accent text is legible in light mode.** The indigo accent used as ~10px text was marginally under the AA contrast floor on the light theme; a new `--editor-accent-text` token darkens accent *text* to indigo-600 in light mode only (fills, borders, rings and buttons keep the accent), applied at the ducking badge and the active left-panel tab. (`theme.ts`, `panels/ClipPropertiesPanel.tsx`, `panels/LeftPanelTabs.tsx`)

- **Caption style gallery reads consistently, and the pending screen's light-mode text is visible again.** With every caption template now anchored at the same height (see the app changelog), the gallery's seven cards frame their captions identically. Separately, the "project id" line and "Back to setup" link on the pending screen were near-invisible on a light background (a var-opacity class that silently no-ops) and now use a real tint. (`CaptionStyleGallery.tsx`, `VideoEditor.tsx`)

- **One number box and one slider everywhere.** Entering a number used to mean
  a different control depending on where you were: the clip Transform tab had a
  nice typeable box with up/down arrows, caption font size was a slider you
  could not type an exact value into, and the rest were plain boxes with no
  arrows. Every numeric field in the editor now uses the same control — type a
  value, nudge it with the arrows, and it previews live and commits when you
  click away. That covers caption font size (now a typeable box with arrows
  instead of a slider), letter spacing and line height, clip fades, ducking and
  trim points, overlay properties, the custom loudness target, the carousel
  slide properties, and the text toolbar's font size. Typing an exact font size
  also reaches sizes the old 28-120 slider could not. Every remaining slider —
  scale, volume, speed, and the version-compare scrubber — is now one shared
  control with a thin track and a round accent thumb, identical in light and
  dark. The Transform tab's number boxes are unchanged — they were the
  reference the rest moved to; its scale slider picked up the new thumb along
  with every other slider.
- **Dragging a clip to the edge of the timeline now scrolls faster the harder
  you push, and the clip stays under your cursor.** Edge auto-scroll used to
  jump to one flat speed the moment the pointer reached the edge, so there was
  no way to ask for "faster" — it now ramps with how far past the edge the
  cursor sits, from a gentle nudge up to a capped maximum, still stopping
  cleanly at the start and end of the timeline and still measured in real
  elapsed time so it feels identical at 60Hz and 120Hz. The dragged clip also
  used to stay put in time while the view scrolled out from under it, drifting
  away from the pointer; every horizontal gesture (move, trim, roll, slip,
  slide, audio, keyframes, captions) now measures its travel in timeline time
  instead of screen pixels, so what you drop is what you saw under the cursor.
- **Fixed: dragging a clip onto a different track ignored the clips already on
  it.** Moving a clip onto another track used to show no snap guide and refuse
  to click into place, even when it fit a gap on that track exactly. Snapping
  now follows whichever track the clip is actually hovering over, so it lines
  up flush with the clips beside it.
- **Fixed: turning on a social-media preview from "None" showed nothing until a
  page reload.** The safe-zone chrome overlay attached its size observer only
  once, on mount — and while "None" was selected the observed element wasn't in
  the DOM, so switching to TikTok/Instagram/YouTube mounted the chrome but never
  measured it, leaving it invisible until a reload happened to remount it with a
  platform already set. The observer now re-attaches whenever the platform
  changes, so the chrome appears the instant it is turned on.
- **The social-media preview chrome is closer to each app.** TikTok and YouTube
  Shorts now draw their bottom tab bars; YouTube adds a top-left back arrow and a
  solid-white Subscribe pill; Instagram adds the reshare action to its rail and
  the bottom add-comment bar. Still generic placeholder content and icon-only
  marks throughout — never real account data or platform wordmarks.
- **Fixed: Dolby Vision sources no longer fail the export.** A DV clip (e.g. an
  iPhone HDR recording) carries a Dolby Vision RPU that propagated untouched
  through the pipeline into libx265, which re-emitted it in-band; the MP4 muxer
  then died with "Error submitting a packet to the muxer: Not yet implemented in
  FFmpeg". Montaj outputs HDR10/HLG, never Dolby Vision, so the segment encoder
  now strips the DV RPU (HEVC NAL 62) on the HDR path, leaving plain HEVC with
  its HDR10 metadata intact. No effect on SDR or non-DV sources.
- **The render progress bar tracks total work, not just phase headings.** The
  two heavy phases — overlay assembly and composition — now advance the bar by
  their real per-segment counters, so it climbs steadily through the actual work
  instead of leaping to nearly full on a phase heading and freezing there.
- **UI polish.** The clip **Crop** tab is a centered icon + description + button
  rather than a bare line of text; the Export dialog's resolution tiles drop the
  overflowing "recommended" badge (the pre-selected tile already says it).
- **Fixed: dragging the selected keyframe diamond no longer drops its selection.**
  Retiming a selected diamond used to leave the selection pointing at the OLD
  time, which the drag had just vacated, so the diamond visually deselected the
  instant you dropped it. The selection now follows the diamond to its new time,
  matching CapCut — Delete still removes the followed keyframe.

- **Video and image clips can be keyframed.** A clip's position, scale and
  rotation now animate over its own lifetime, using the same keyframe controls,
  curve maths and easings overlays already had — and, unlike before, the export
  reproduces the motion. The renderer compiles each curve into a time-varying
  ffmpeg filter expression rather than composing one static box per segment.
  Keyframing a clip previously did nothing at all: it animated neither in the
  editor nor in the export. Overlays are unchanged, and a project with no
  keyframed clips renders byte-identical ffmpeg arguments to before.

  **Opacity is the exception and cannot be animated on a clip.** ffmpeg applies
  alpha through a filter that accepts a fixed number and no expression, so a
  fade cannot be expressed on that path at any cost. The opacity keyframe
  control is therefore shown *disabled* on a video or image clip with a tooltip
  explaining why, rather than silently doing nothing, and double-clicking a clip
  to key every property skips opacity. Overlays still animate opacity normally.

- **BREAKING: the DOM timeline is removed — canvas is the only timeline.**
  The `VideoEditor` `timeline?: { canvas: boolean }` prop is gone from
  `VideoEditorProps`; a host that still passes it fails typecheck. The old
  DOM-rows implementation (one positioned `<div>` per visual clip / audio
  item) is deleted from the package outright, not kept behind a flag. A host
  that never passed the prop typechecks with no changes required, but its
  runtime behavior changes silently: it used to fall onto the DOM-rows path
  by default, and now gets the canvas timeline instead — which needs
  `EditorAdapter.getWaveformPeaks` and `getFilmstrip` implemented to draw
  per-clip/audio-lane waveforms and filmstrip thumbnails. Both stay optional
  and feature-detected, so a host missing either loses that imagery with no
  error, not a crash. A full migration runbook for consumer hosts — exact
  adapter method signatures, greppable call-site patterns, and a verification
  checklist — is maintained internally.
- **Ported the subcut-regenerate control to the canvas timeline.** It used to
  be a Scissors button on the old DOM clip rows, which would have made it
  unreachable — and effectively retired for good — once those rows came out;
  instead it moved across intact. It appears on a selected clip once the host
  enables regeneration, the clip still carries its generation provenance, and
  the clip is at least 3 seconds long, the same conditions the button always
  required. A "queued" badge shows on a clip the host reports as queued, but
  the button itself stays clickable while queued, so a queued clip can still
  be reopened and resubmitted rather than getting locked out. Clicking the
  button toggles the tool open and closed. It's rendered as a real HTML
  control positioned over the canvas surface rather than painted into it, so
  it keeps a genuine button's accessible name, title, and hover state, and it
  now has test coverage it never had before.
- **Reorganized the editor panels: left browses, right inspects.** The left
  sidebar is now a tabbed browser with an icon rail — **Media**, **Captions**
  (the default) and **Versions** — and the right panel holds only the
  properties of what is selected. Previously one sidebar stacked both jobs,
  which is why the version list felt cramped and the properties panel had
  nowhere to grow. The tab shell (`video/panels/LeftPanelTabs.tsx`) is generic:
  a new tab is one `{ id, icon, label, content }` entry, so Audio/Effects/Text
  drop in later without touching it. The active tab persists across reloads,
  and a tab keeps its state (scroll position, sub-tab, a half-finished edit)
  when you switch away and back. The right panel is always present, showing a
  short prompt when nothing is selected, so the preview and timeline never
  resize as selection changes. The preview and timeline themselves are
  unchanged. This applies to the three-column layout (the one a host opts into
  with `slots.mediaPanel`); the classic layout's arrangement is untouched.
- **The right properties panel has a real empty state, brandable by the host.**
  With nothing selected it now shows a vertically centered "Select an element"
  prompt in place of the old terse one-liner. A host can replace it via the new
  `slots.propertiesEmptyState` (Montaj renders its logo there); absent, the
  package's generic centered default shows. Classic layout unaffected.
- **Version history shows every version, by name and date.** The list no longer
  collapses to one row per backend "run", and the "Run N" prefix is gone: run
  is plumbing that was never meant to surface, and collapsing by it hid real
  saved versions. Each version is now its own row with **Compare** and
  **Restore**, newest first, with auto-generated labels humanized ("Draft",
  "Exported", "Auto-save before restore", "Untitled save") and operator-typed
  names shown verbatim. Compare and Restore behave exactly as before.
- **BREAKING: `renderClipInspector` is removed** from `VideoEditorProps`, and
  clip properties are now edited in the right panel instead of a modal.
  Selecting a video clip edits its volume, mute and speed there; selecting an
  audio track edits its label, volume, mute, fades, ducking, trim and position.
  A host no longer supplies any of that. Hosts with host-only per-clip UI use
  the new, narrower `renderGenerationPanel?: (ctx: { clipId: string }) =>
  ReactNode` seam, which the editor renders inside the properties panel beneath
  the clip properties when a video clip is selected. Deleting an audio track is
  deliberately not in the panel (destructive, and the panel is somewhere you
  land just by selecting) — the timeline's Delete/Backspace still does it.
- **Speed changes from the panel still ripple.** The retired modal closed the
  gap a speed-up leaves behind when the magnet is on; the editor's commit
  handler now owns that, folded into the same undo step as the speed change
  itself.
- **Redesigned the overlay properties panel as a Transform inspector.** The flat
  stack of five number fields is now a sectioned panel: a **Scale** slider with
  X/Y boxes and a uniform-scale lock, **Position** X/Y, a **Rotate** box with a
  circular dial (keyboard operable, Shift for coarse steps), **Opacity**, a
  six-button **Align** row that snaps to the frame edges using the same math as
  the preview's drag snapping, and a **Reset**. Every animatable row keeps its
  keyframe diamond, and the section header gains a keyframe unit covering all
  five properties at once plus arrows that jump the playhead between keyframes.
  When nothing is selected the panel shows a short prompt instead of vanishing.
  Keyframe persistence is unchanged: every control routes through the same
  auto-keyframe rule, so editing an already-animated property adds a keyframe
  at the playhead rather than overwriting the animation.
- **Keyframe diamonds are now on the canvas timeline itself, not just the
  panel.** A selected, keyframed overlay draws a diamond strip along the
  bottom of its clip, one per distinct keyframe time. Double-clicking the
  clip keys all five transform properties at the instant you clicked, each at
  the value it already holds there, so nothing moves; double-clicking a
  diamond selects it (its fill
  turns white); dragging a diamond retimes it with snapping to the item's
  other keyframe times, landing on one merges the two; right-click opens a
  menu for per-property easing and removal; and Delete/Backspace removes
  every property keyed at the selected instant. Keyframing stays
  overlay-only, a render constraint rather than a UI limitation.
- **Captions can now be generated by the host as a background job, instead of
  the editor's blocking modal.** `VideoEditorProps` gains two optional props:
  `onRegenerateCaptions` and `captionsGenerating`. When a host provides
  `onRegenerateCaptions`, the editor delegates the Captions panel's trigger to
  it and never mounts its own `CaptionRegenModal`, so the host can run
  generation in the background and report progress wherever it likes;
  `captionsGenerating` lets it disable the trigger while a job is in flight,
  and is OR'd with the editor's own modal state rather than replacing it. A
  host that passes neither prop is completely unaffected — the built-in modal
  remains the default and the only path, so embedding apps need no changes.
- **BREAKING: `OverlayPropsModal` is removed — overlay props move into the
  properties panel.** The floating "Edit overlay" modal is gone, along with
  the Pencil "Edit overlay" button that opened it. An overlay's props are now
  edited in the right properties panel under a new **Content** tab (the
  default), with the existing Transform inspector as the second tab; the
  active tab persists (`montaj.editor.overlayPanelTab`). Double-clicking an
  overlay in the preview now selects it — it no longer opens a modal. Edits
  preview live against the canvas and commit on blur as a single undo step;
  there is no Save button and no Cancel, undo is the revert path. A host that
  imported `OverlayPropsModal` directly will fail to resolve it; the file is
  deleted, not deprecated.
- **BREAKING: `PreviewPlayer` takes a `clock`, replacing `currentTime` /
  `onTimeUpdate`.** `PreviewPlayerProps` drops `currentTime: number` and
  `onTimeUpdate: (t: number) => void`, and gains a required
  `clock: PlaybackClock` — an external store for the playhead
  (`{ get, set, subscribe }`), written at playback rate so that only the
  components which actually render the time re-render. Unlike the rest of this
  release's breakage, this one fails **loudly**: the prop is required, so a
  host still passing the old pair gets a hard `TS2322` at the call site rather
  than quietly losing a feature. It affects hosts that mount `<PreviewPlayer>`
  directly only — a `<VideoEditor>`-only host is untouched, which is why it is
  easy to miss when auditing the surface. Migrate by replacing the
  `currentTime` state with a stable clock —
  `const clock = useMemo(() => createPlaybackClock(0), [])` — and passing
  `clock={clock}`; read the time, where you actually need to render it, with
  `usePlaybackTime(clock)`. Both helpers are exported from the package root.
  Two traps: the clock must have stable identity (a bare
  `createPlaybackClock(0)` in the render body mints a fresh one every render
  and breaks playback silently), and reintroducing a `useState` mirror of the
  time reinstates the per-frame re-render the external store exists to remove.
- **Overlay scale can now be non-uniform.** `VisualItem` gains optional
  `scaleX`/`scaleY`; when absent the item falls back to `scale` exactly as
  before, so every existing project renders byte-identical. The Transform
  panel's "Uniform scale" lock (previously inert) is now functional:
  unlocking it reveals independent width/height scaling, adjustable from the
  panel's X/Y boxes or by dragging the new edge handles on the preview
  selection box. Unlocking seeds both axes from the current uniform scale so
  nothing visibly jumps; re-locking keeps the X value and clears the per-axis
  fields. `KeyframeProp` widens to cover the two new props, so per-axis scale
  is keyframeable like every other transform property. Preview and render
  resolve scale through the same shared `@bycrux/timeline-core` geometry
  resolver, and the emitted CSS transform is now unconditionally the
  two-argument `scale(sx, sy)`, so the two surfaces can't drift apart.
- **Unified the overlay selection box with the clip selection box.** A
  selected overlay in the preview now gets the same crisp treatment a
  selected clip gets: a 2px `var(--editor-selection)` outline with eight
  12x12 white square handles — four corners (scale both axes) and four edge
  midpoints (scale one axis). The old faint amber ring with L-bracket corners
  is gone, and the drag snap guides are now token-driven instead of
  hardcoded amber.
- **The caption panel is now three sub-tabs, and the style picker is a live
  gallery.** The track-level caption controls used to sit behind one
  collapsible "Caption style" subsection above the transcript. They are now
  three sub-tabs: **Format** (the default), holding the fine controls — size,
  color, font, bold, case, alignment, letter spacing, line height — each now on
  its own labeled row in a single label/control column, with alignment promoted
  out of the case row onto its own;
  **Styles**, a card grid replacing the old text-chip row, with one card per
  style rendering the real `render/templates/captions/*.jsx` template — the
  same one the export uses — on a four-word sample, so hovering a card plays
  its actual animation and clicking applies it; and **Captions**, the
  transcript list, unchanged. The gallery needs two new optional props on
  `CaptionListPanelProps`, `compileOverlay` and `resolveCaptionTemplate`; a
  host that doesn't supply them (Hub, Los Parceros) falls back to a static
  styled specimen card per style, still clickable. The active sub-tab persists
  under `montaj.editor.captionPanelTab`.
- **Extracted a shared `TabNav` component for the editor's small tab
  strips.** The underline tab strip (uppercase labels, an accent underline
  under the active tab) is now one component (`video/panels/TabNav.tsx`),
  used by the caption panel's Format/Styles/Captions switch, the overlay
  panel's Content/Transform switch, and the new clip properties tabs below.
  Purely an internal de-duplication: no visual or behavioral change to any
  panel that already had tabs.
- **Video and image clips now get a tabbed properties pane, with a new
  Transform tab.** Selecting a clip used to show one flat pane with just
  Volume and, for video, Speed. It's now tabbed: **Transform, Speed,
  Volume, Crop, Generate**, opening on Transform, which is the same
  inspector overlays already use for scale, position, rotation, opacity and
  alignment. The tab set adapts to the selection: an image clip has no
  Speed or Crop tab, a clip that isn't a main-track video with a source has
  no Crop tab, and Generate only shows for a generated clip. The active tab
  is remembered per browser. Editing a transform property on a clip with no
  keyframes sets a static transform on the whole clip rather than creating
  one; once a property is keyframed, editing it at the playhead keys it
  there instead, the same auto-keyframe rule overlays already followed.
  (Opacity can be set statically but not keyframed on a clip, the same
  ffmpeg limitation noted above.) This is UI plumbing over transforms the
  render engine already supported, so an existing project with no clip
  transforms renders identically. Audio tracks keep their own untabbed
  panel, and captions are unaffected.
- **The Transform section's collapse chevron is gone.** Both the overlay
  Transform panel and the new clip Transform tab above now show the section
  permanently open, with no fold/unfold control. Now that Transform is
  reached by selecting its own tab rather than sharing a pane with other
  fields, there was nothing left to collapse it for.

### Both editors

- **Both editors now follow the app's light or dark mode.** They used to
  render dark-only, so switching Montaj into light mode left the editor
  looking broken — the surrounding chrome went light while the preview, the
  properties panel, and the timeline stayed dark. The editor now switches
  instantly the moment the app's theme toggle is used, with no reload. The
  video preview and the agent hand-off code box stay dark in both themes on
  purpose, the same way a real editor's preview always sits on black. Dark
  mode itself is unchanged — nothing looks different there.
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

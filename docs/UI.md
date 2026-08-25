> **Canonical docs:** https://docs.montaj.ag/ui — this file is a local quick-reference. Update the docs site in `../landing-montaj/docs/content/docs/ui.mdx` for any user-facing changes.

# montaj — UI

> An optional browser-based interface that wraps the entire pipeline. Not a final review step — the UI is the control plane.

```bash
montaj serve       # starts local server + opens http://localhost:3000
```

---

## What the UI is

Upload clips, watch the agent work live, tweak the result, trigger render. The UI doesn't replace the CLI — every action in the UI maps to a CLI command. `montaj serve` is optional; the full pipeline works headlessly without it.

---

## The four modes

### 1. Upload

Drop clips, write a prompt, select a workflow, hit Run.

- Drag-and-drop clip upload (or file picker)
- Free-form prompt textarea: "tight cuts, remove filler, 9:16 for Reels"
- Workflow selector: choose from available workflows (native + custom)
- Run → `POST /run` to `montaj serve` → pre-pass starts immediately

### 2. Live view

As the agent works, the UI updates in real time.

- `montaj serve` watches `project.json` for any file change
- Every write the agent makes — trim points added, clips reordered, captions cleaned — pushes to the browser via SSE
- Timeline rerenders on each update
- Preview player reflects the current state of the edit
- You watch the edit take shape as the agent builds it

### 3. Review

When the agent marks the project `draft`, the UI surfaces it for human adjustment.

- Full timeline with clip, caption, and overlay tracks
- Preview player: the WebCodecs playback engine painting to canvas (or the `<video>` fallback), with CSS-positioned overlays
- Left panel: a tabbed browser (Media / Captions / Versions) — see "Panel layout"
- Right panel: the properties of the current selection (an overlay's Content and Transform tabs)
- Caption editor: click to edit text inline, drag to retime
- Overlay editor: add/remove/reposition title cards, lower thirds
- Prompt bar: modify the prompt and re-run the agent
- Save: writes updated `project.json` to disk

Review is optional — click Render directly from live view if the first pass is good.

### 4. Render

Triggers the render pass. Progress streams back via SSE. Final MP4 lands in `workspace/`.

Before firing, the Export dialog collects a filename, a poster/cover frame, an output resolution, and an output frame rate. HDR projects also get a format choice (HDR / SDR / Both), the image-color control, and an SDR tone-curve compare.

- Resolution is source-capped by the timeline's footage: each tier the menu offers is one the largest native clip can actually produce. A project shot at 1080p won't offer 4K — that would just re-encode to a larger file with no added detail. A project with a 4K clip on the timeline can export up to 4K, and the largest available tier is marked "recommended". Frame rate is capped at the project's own `settings.fps` (30 by default), so no 60 fps option shows up on a 30 fps project.
- The chosen resolution and frame rate are persisted with the project (`settings.resolution` / `settings.fps`), so re-opening the dialog reflects the last choice.
- This does not rescale the editor preview. Resolution is applied at render time only; the preview always runs at the overlay design canvas.

---

## Tabs

The UI has four top-level tabs:

### Editor tab
The default view. Shows the current project — upload → live view → review flow described above.

### Workflows tab

Node graph UI for building and editing workflows. Inspired by n8n.

```
Sidebar                    Canvas
─────────────────────────────────────────────────────
Native steps:              ┌──────────┐
  probe                    │  probe   ├──► ┌─────────────┐
  rm_fillers               └──────────┘    │  rm_fillers │
  waveform_trim                            └──────┬──────┘
  transcribe                                      │
  trim                                   click to configure:
  concat                                 sensitivity: [====|  ] 0.8
  resize                                 words: [um, uh, hmm]  + add
  caption
  ...

Custom steps:
  viral-hook-detector
  b-roll-inserter
  + New step
```

- Drag steps from the sidebar onto the canvas
- Connect nodes to define data flow (edges = step outputs feeding next step's input)
- Click a node to configure its params — controls rendered from the step schema
- Invalid connections (type mismatch) are rejected visually
- Save → writes `workflows/<name>.json`
- Run → executes the workflow against the current clips

### Overlays tab

Live preview environment for custom JSX overlay components.

- Select any overlay JSX file from the current project or global overlays
- Overlay is compiled and rendered at 1080×1920, scaled to fit the viewport
- File watcher via SSE — recompiles and rerenders automatically on every save
- Compile errors displayed inline

### Profiles tab

View and manage creator style profiles.

- List of all profiles in `~/.montaj/profiles/`
- Each card shows name, dominant color palette, and source count
- Click a profile to inspect pacing, editorial direction, caption style, and color analysis
- Profiles are created and updated via `skills/style-profile/SKILL.md`

---

## How `montaj serve` works

`montaj serve` is a thin local HTTP + SSE server. It is the bridge between the browser and the filesystem.

```
montaj serve
  ├── POST /api/run              → receives clips + prompt + workflow, starts pre-pass
  ├── GET  /api/projects         → list projects and their status
  ├── GET  /api/projects?status=raw  → agent polls this for pending work
  ├── GET  /api/projects/:id/stream  → SSE stream of project.json changes
  └── file watcher               → watches workspace/ for project.json writes → pushes SSE
```

All API routes are namespaced under `/api/` so they never collide with React Router paths (e.g. `/projects/:id`). The SPA catch-all serves `index.html` for everything else.

**The agent polls serve — serve does not notify the agent.**

```
Agent (Claude, OpenClaw, etc.)
  ├── GET /projects?status=raw   ← polls for pending work
  ├── reads project.json [raw] from workspace/ directly
  ├── makes editorial decisions
  └── writes project.json [draft] to disk
              │
              └── file watcher detects change
                        │
                        └── SSE push → browser rerenders timeline + preview
```

The agent writes directly to disk. `montaj serve` watches. Every write immediately pushes to the browser. No polling from the browser, no API calls from the agent to update state.

---

## Panel layout

The editor uses the standard pro-editor split: **left = browse, right = inspect**,
with the preview and timeline in the center.

The left sidebar used to do both jobs at once, stacking the things you can add
(captions, versions, media) on top of the properties of whatever was selected.
That is why the version list felt cramped, and why there was nowhere sensible
for a properties panel to grow.

### Left panel: tabbed browser

`video/panels/LeftPanelTabs.tsx` is a generic tab shell: a vertical icon rail
(icon above a short label, CapCut-style) beside a content pane. It knows nothing
about what is in its tabs. The host passes an array of
`{ id, icon, label, content }`, so a new tab is one array entry and no change to
the shell. Today it carries three:

| Tab | Content |
|---|---|
| **Media** | The footage bin / assets panel |
| **Captions** (default) | `CaptionListPanel` — its own Format / Styles / Captions sub-tabs (see "Caption panel" below) |
| **Versions** | The consolidated version list (see "Version history") |

Audio, Effects and Text are the obvious future tabs; the shell is built to take
them.

Two behaviors worth knowing:

- **The active tab persists** across reloads (`localStorage`, one key). A stored
  id that no longer matches any tab falls back to the default rather than
  blanking the panel, so an older stored preference cannot strand you on an
  empty pane.
- **A tab is not mounted until you first open it, and then it stays mounted**,
  hidden rather than destroyed. So the Captions tab keeps its scroll position,
  sub-tab and any half-finished edit when you switch to Versions and back, while
  the heavier Media tab costs nothing until it is actually opened.

The rail is a real ARIA tablist: arrow keys move between tabs, Home and End jump
to the ends.

### Caption panel: Format, Styles, and Captions

`CaptionListPanel` has its own sub-tab switch above its content, **Format**
(the default), **Styles**, and **Captions**. It is one node rendered by both
layouts — the CapCut left panel's Captions tab and the classic right rail — so
neither layout can drift from the other. The active sub-tab persists across
reloads (`localStorage`, key `montaj.editor.captionPanelTab`); a `'style'`
value left over from an earlier build maps to `'format'`. That migration is
belt-and-braces rather than load-bearing: `'format'` is also the fallback for
an unrecognised stored value, so a stale entry lands on the same tab either way.

**Format.** The fine controls, moved verbatim from the retired collapsible
"Caption style" subsection: font size, base and accent colors, the font
specimen, font family picker, bold, case, alignment, letter spacing, line
height. It is the default tab — the controls an operator reaches for most
often once a style is chosen.

**Styles.** A card grid replacing the old row of text chips, one card per
caption style, each rendering that style's real
`render/templates/captions/*.jsx` template — the same one the final export
uses — on a four-word sample, so the preview and the burned-in output can't drift.
Hovering a card plays the style's actual animation (pop pops, karaoke fills,
word-by-word steps); clicking a card applies it, and the active style's card
shows a selected accent ring. This needs the host adapter's `compileOverlay`
and `resolveCaptionTemplate`, wired through as two new optional props on
`CaptionListPanelProps`; a host that omits either (Hub, Los Parceros) falls
back to a static styled specimen card per style instead — still clickable,
just not animated. Opening the tab compiles all seven caption templates (a
fetch plus a Babel transpile each, cached per source afterward) rather than
just the one the live preview already compiles; animation is hover-gated, so
only the card under the cursor is doing per-frame work.

**Captions.** The transcript list — search, row filters, per-segment editing,
footer actions. Unchanged by the Format/Styles split.

### Right panel: properties only

The right panel holds exactly one thing, the properties of the current
selection, and it is **always present** so the preview and timeline never
resize as you click around. What it shows depends on what is selected:

| Selected | Panel shows |
|---|---|
| An overlay | **Content** and **Transform** tabs (below), Content first |
| A video or image clip | **Transform, Speed, Volume, Crop** and **Generate** tabs (below); which tabs appear depends on the clip |
| An audio track | **Audio track**: label, volume, mute, fades, ducking, trim and position |
| Nothing | A short "Select an element" line |

Clip and audio properties used to live in a double-click modal. They are now
edited in place, which is why a speed change made from the panel still ripples
the timeline closed behind it when the magnet is on, exactly as the modal did.

Deleting an audio track is deliberately **not** in the panel: it is a
destructive action, and the panel is somewhere you land just by selecting.
Select the track on the timeline and press Delete or Backspace instead.

On an AI-video project, a selected generated clip also gets a **Generate**
tab, showing the frozen prompt, model and attempt history, with the
regenerate flow. That content is supplied by the host (it reads the
project's regeneration queue and storyboard, which the editor package knows
nothing about) through the `renderGenerationPanel` seam.

### Overlay properties: Content and Transform tabs

Selecting an overlay shows two tabs above its properties, **Content** (the
default) and **Transform**, in the same right panel a selected clip or audio
track uses. This replaced a floating "Edit overlay" dialog, which is gone
completely, along with the Pencil "Edit overlay" button that used to open it
from the controls bar. The active tab persists across reloads (`localStorage`,
key `montaj.editor.overlayPanelTab`) the same way the left panel's tab does.
Double-clicking an overlay in the preview now selects it — landing on
whichever tab was last open — instead of opening a modal. Every field in
either tab previews live against the canvas and commits on blur as one undo
step; there is no Save button and no Cancel, so undo is the way back out of
an edit.

The tab strip itself (`video/panels/TabNav.tsx`) is a shared component: the
same underline strip, uppercase labels with an accent underline under the
active tab, also drives the caption panel's Format/Styles/Captions switch
(see "Caption panel" above) and the clip properties tabs below, so none of
them can visually drift apart.

**Content tab.** `video/panels/OverlayContentPanel.tsx`. The overlay's own
primitive props, inferred straight from whatever the item's `props` object
carries — there's no schema to register a component with. Each field renders
as the control its value's shape calls for: a boolean as a checkbox, a finite
number as a stepper, a string matching `#hex` as a color swatch, a string that
looks like an image (a known image extension, or a `data:image/…` URL) as a
thumbnail with a file picker (degrading to a plain path text field on a host
with no upload support), and everything else as a single-line text field.
That's what makes an AI-written one-off overlay just as editable as a shipped
template. Non-primitive props (arrays, objects, null) aren't shown and aren't
touched — every write spreads the item's whole `props` record, so they ride
through unchanged. With nothing selected, or an overlay with no editable
props, the panel shows a short prompt instead of an empty field list.

**Transform tab.** `video/OverlayInspector.tsx`. One **Transform** section
over the keyframeable geometry, with a keyframe `‹ ◇ ›` unit on every
animatable row and one in the header covering all of them (see "Overlay
keyframes"). The section header used to carry a fold/unfold chevron; it's
gone now that Transform is reached by selecting its own tab rather than
sharing a pane with other fields, so there's nothing left to collapse it
for — the section is always open:

- **Scale** — a slider plus X and Y value boxes with steppers, and a
  uniform-scale lock between them. Locked (the default) is a single scale
  factor: both boxes drive the same value, and the preview selection box's
  four corner handles resize it, both axes together. Unlock it to scale width
  and height independently — from the X/Y boxes, or by dragging the preview's
  four edge handles, each of which moves one axis (the corner handles still
  move both). Unlocking seeds both axes from the scale the overlay already
  has, so nothing visibly jumps; re-locking collapses them back to one number,
  keeping the X value and dropping Y. Non-uniform scale is stored as
  `scaleX`/`scaleY` on the item (absent falls back to `scale`), and both are
  keyframeable like every other row here.
- **Position** — X and Y offset boxes, each with a stepper.
- **Rotate** — a value box plus a circular dial. The dial is keyboard operable
  (arrows step one degree, Shift steps fifteen).
- **Opacity** — a value box. This panel is still the only place opacity is
  editable at all: the preview's drag gestures cover position, scale and
  rotation, but never opacity.
- **Align** — six buttons snapping the overlay to the frame's left/center/right
  and top/middle/bottom. Alignment uses the same edge math as the preview's
  drag snapping, so a button and a snapped drag land on identical values. An
  overlay at scale 1 or above already covers the frame and has no edge to align
  to, so every alignment collapses to centered rather than pushing it off-frame.
- **Reset** (the header's ⟲) returns every property to its default. On an
  unlocked overlay that resets `scaleX` and `scaleY` to 1 each; it does not
  re-lock the overlay back to uniform scale, since the lock is an authoring
  choice, not a transform value with a default of its own. Reset deliberately
  does not delete keyframe tracks either: on an animated property it keys the
  default value at the playhead, the same non-destructive rule the rest of the
  panel follows. Clearing a track is the row diamond's job.

Editing any control while a property is already animated adds a keyframe at the
playhead instead of overwriting the animation.

### Clip properties: Transform, Speed, Volume, Crop, Generate tabs

Selecting a video or image clip on the timeline shows the same right panel,
tabbed with up to five tabs, opening on **Transform**: **Transform, Speed,
Volume, Crop, Generate**, using the shared `TabNav` strip described above.
This replaced a flat pane that only ever showed Volume and, for a video
clip, Speed, with no way to move, scale or rotate a clip from the panel.

Which tabs show depends on the selected clip, not a fixed set:

| Tab | Shown when | Content |
|---|---|---|
| **Transform** | Always | The same `OverlayInspector` scale/position/rotate/opacity/align controls overlays use — see "Overlay properties" above. Section header has no fold/unfold chevron; it's always open |
| **Speed** | Video clips only | The speed control; ripples the timeline the same way a speed change always has |
| **Volume** | Always | Volume slider and Mute |
| **Crop** | The clip is the main-track video with a source | Opens the dedicated crop tool |
| **Generate** | The clip is a generated clip | The host's regenerate flow (prompt, model, attempt history), supplied through the `renderGenerationPanel` seam, same as the Generate row described above |

The active tab is remembered per browser (`localStorage`, key
`montaj.editor.clipPanelTab`) the same way the overlay and caption panel
tabs are; selecting a clip whose tab set doesn't include the last-remembered
tab (e.g. an image clip after Speed was active) falls back to Transform
rather than showing a blank pane.

Clips keyframe the same way overlays do, through the same Transform tab:
editing a property that has no keyframes yet sets a static transform on the
whole clip rather than creating one, and only once a property already has a
keyframe does editing it at the playhead add another. Opacity is the one
property that can be set statically on a clip but never keyframed, the same
ffmpeg limitation described under "Keyframes" below. This is UI wiring over
transforms the render engine already supported for clips; a project with no
clip transforms renders exactly as it did before.

Audio tracks are unaffected by any of this and keep their own untabbed
panel (see the table above); captions keep their own left-panel flow.

---

## Preview player

The WebCodecs playback engine decodes the editing proxy directly and paints
it to a canvas. This is what `montaj serve`'s editor runs by default — see
"Playback engine" below for the prop, eligibility, and fallback rules. A
native `<video>` element with CSS-positioned overlays is the documented
fallback path, not the default: it's what a project runs when it isn't
eligible for the engine, and what a third-party host gets unless it opts in.

- Captions rendered as absolutely positioned divs, shown/hidden by the current time
- Overlays (title cards, lower thirds) same approach
- Preview time follows the shared playback clock, on both paths alike
- Preview is an **approximation** — CSS overlays are close but not pixel-perfect to the final render burn-in. The render is what matters.
- A slim controls row sits on chrome beneath the preview (not floating over the video itself): a `current / total` timecode readout on the left, and zoom-to-fit, a safe-zone preview toggle, and fullscreen on the right. The safe-zone toggle overlays a TikTok-style UI chrome guide (status bar, nav, engagement rail) on top of the video so you can see what a platform's own UI would cover, off by default. Fullscreen is also reachable via the `F` key (see "Keyboard shortcuts" below); the controls row stays available once fullscreened, and exits via `F` again, the button, or the browser's own Escape

### Selection box

A selected overlay and a selected base clip (`tracks[0]` video) draw the exact
same selection chrome, so they read as the same kind of object rather than two
different affordances: a 2px `var(--editor-selection)` outline around the
item's bounding box, plus eight 12x12 white squares with a selection-coloured
border — one at each corner and one at the midpoint of each edge. The four
corner handles resize both axes together; the four edge handles resize one
axis only, which is what makes non-uniform overlay scale (see "Overlay
properties: Content and Transform tabs" above) reachable by dragging, not just
from the Transform tab's boxes. A rotate handle sits above the box on a short
stem. Every handle counter-scales against the item's own `scale(scaleX,
scaleY)` so it stays a constant square regardless of how large or stretched
the item is. Drag snap guides (to the frame edges, other items, and the
playhead) are drawn from the same `var(--editor-selection)` token, so they
match the box and handles rather than standing out as a separate colour.

### Playback engine

A WebCodecs-based playback engine (`montaj_assets/editor/src/engine/`)
decodes the editing proxy directly and paints it to a canvas. This is what
`montaj serve`'s editor runs — `EditorPage.tsx` passes `engine={{ enabled:
true }}` unconditionally (`montaj_assets/ui/src/app/editor/EditorPage.tsx:437`).
See `docs/ARCHITECTURE.md`'s "Playback engine" section for how it works
internally.

- **The prop.** `VideoEditor` takes an optional `engine?: {enabled: boolean;
  debugHud?: boolean}` — still the package contract for a third-party host.
  Absent or `{enabled: false}` (the default for a host that doesn't pass it):
  unchanged `<video>` preview, and the engine's eligibility check never even
  runs. `{enabled: true}` — what Montaj's own UI always passes — asks the
  editor to try the engine; it does not force it on for every project (see
  eligibility below). `debugHud: true` additionally renders a small
  fps/dropped/buffered/clock readout; it has no effect while `enabled` is
  false.
- **Eligibility.** Evaluated once per project **load**, never re-evaluated on
  an edit: the browser must support WebCodecs decode of the editing proxy's
  codecs (av01 video + Opus audio), every track-0 video item must already
  carry a `proxySrc`, and none may need `nobg_preview_src` (the WebM alpha
  preview for background-removed clips — the engine's demuxer is MP4-only). A
  project that fails stays on the `<video>` player for its whole session even
  if it becomes eligible moments later (a proxy finishes encoding); a project
  that passes stays on the engine for its whole session even if a clip added
  afterward has no proxy yet.
- **Automatic fallback.** Whenever eligibility fails, the console prints one
  line — `[montaj] playback engine unavailable for this project — using the
  legacy player (<reason>)` — and playback is otherwise indistinguishable from
  the engine never having existed. This is designed behavior, not a fault.
- **Preparing placeholder.** A clip that loses its proxy after the engine
  already took over a session — still encoding, failed to load, or failed to
  decode — shows a small spinner and "Preparing preview…" over just that
  clip's range (after ~200ms of it being sustained, so an ordinary clip-cut
  never flashes it), while the rest of the project keeps playing.
- **Debug HUD.** `fps` / `dropped` / `buffered` / `clock` (`audio` or
  `fallback`), polled twice a second, drawn bottom-left of the preview. An
  operator/engineering affordance for confirming the engine is keeping up —
  not end-user copy.

### Audio sync and drag-scrub

A/V sync compensation and audible drag-scrub both run off the one shared
`AudioContext` (`video/preview/audio-context.ts`) that every playback path
already shares, and both apply to the WebCodecs engine and the legacy
`<video>` fallback alike.

- **A/V sync compensation.** A decoded frame reaches the speaker
  `baseLatency + outputLatency` before it's actually audible, so painting the
  playhead from the frame just handed to the speaker put the picture ahead of
  its own sound. The playhead paint path now subtracts that same
  `outputLatency + baseLatency`, read live off the shared `AudioContext`, so
  picture and sound land together during playback.
- **Audible drag-scrub.** Dragging the playhead or the ruler while paused now
  plays short bursts of audio at the drag position — a tape jog-wheel you can
  scrub by ear. Each new scrub position fires one short Hann-windowed grain of
  that position's audio on a throwaway audio node on the shared context, in
  parallel with (and never touching) the master playback graph.
- **The toggle.** An ear button sits in the editor toolbar, alongside the
  other editing tools (undo/redo, split, snap, crop, audio polish). It
  reflects and sets `settings.audibleScrub` on the project, off by default
  (opt in), and persists per project the same way the other preview settings
  do.
- **Device caveat.** Past about 80ms of combined output latency, the toggle
  disables itself automatically — a grain fired at a scrub position that far
  behind no longer reads as instant. Bluetooth output commonly reports
  100-300ms, a physical wall no software fix can close; wired and built-in
  output is typically 20-45ms and stays enabled.
- **Silent by design.** No grain plays over a gap between clips, on a canvas
  or overlay-only project (no track-0 video), on a clip whose editing proxy
  isn't ready yet, or on a project running the legacy `<video>` fallback path
  (which can't decode grains at all) — none of these are bugs, the same way a
  stationary hover is silent on purpose. Reverse-scrub isn't supported either:
  the decode pipeline only runs forward.

---

## Timeline

Clip, caption, and overlay tracks, rendered on one `<canvas>` surface (see
"Canvas timeline" below). A track rail runs down the left with per-track
volume, mute, and skip controls. Clips show filmstrip frames over a
full-size waveform. Selected clips grow trim handles, with tiered
snapping — a strong magnet to the next clip on the same track, a faint one
to anything on another track or the playhead — and a visible snap indicator
while you drag. Overlapping clips on the same track are marked with overlap
bands.

### Canvas timeline

The track-row area (visual tracks, audio lanes, and caption bands) draws
clips, audio bars, and caption blocks on a `<canvas>` instead of positioning
one DOM element per item, which is what keeps panning/zooming smooth
regardless of project size. This is the editor's only timeline — Montaj's
own `montaj serve` editor renders it exactly the way every other host does,
with nothing to configure. See `docs/ARCHITECTURE.md`'s "Canvas timeline"
section for how it works internally; the migration runbook for updating a
host built against the older DOM-rows timeline is maintained internally.

- **No prop, no mode.** `@bycrux/editor` used to take an optional
  `timeline?: {canvas: boolean}` prop; a host that omitted it (or passed
  `{canvas: false}`) got a degraded, DOM-rows timeline with no per-clip
  waveforms and no filmstrip thumbnails. That prop is gone — there is
  nothing to opt into, no eligibility check, and no fallback path. The
  timeline's chrome (zoom controls, the time readout, the transcript
  panel/modal) is unaffected by any of this. Captions are not a DOM
  carve-out either: caption blocks render as bands on the same canvas
  surface as clips and audio, in the same vertical stack; caption *text*
  editing happens in the Captions tab of the left panel, not inline on the
  timeline.
- **What canvas brought.** Per-clip waveforms on visual tracks (clips never
  showed a waveform before this), zoom-responsive audio-lane waveforms
  replacing fixed-resolution PNG chunks, hover-scrub filmstrip thumbnails
  once zoomed in past a threshold, one unified magnetic-snap feel across
  every drag/trim gesture, and four trim tools — ripple-delete, roll, slip,
  and slide — bound to modifier-key drags. The zoom badge reports a
  fit-relative multiple and can show a value below 1× (zooming out past "fit
  the whole project" is possible).

### Keyframes

An item's `offsetX`, `offsetY`, `scale`, `rotation`, and `opacity` can each be
animated over the item's own lifetime rather than held fixed. Two surfaces, both
canvas-timeline-only — neither exists in the Overlays tab's live-preview page.

**Video and image clips can be keyframed too**, not just overlays. Their
position, scale and rotation animate in the preview and in the export alike: the
renderer compiles each curve into a time-varying ffmpeg filter expression. This
was overlay-only until SP9d, when the ffmpeg path gained that per-frame hook.

**Opacity is the one property a clip cannot animate.** ffmpeg applies alpha
through a filter that accepts a fixed number and no expression, so there is no
way to fade a clip in the export. Rather than silently ignoring the setting, the
opacity keyframe diamond is shown **disabled** on a video or image clip, with a
tooltip explaining why; double-clicking a clip to key everything skips opacity
for the same reason. Overlays are unaffected and still animate opacity normally
— they are captured frame-by-frame in a browser, where opacity is just CSS.

- **Setting a key.** Each property gets its own keyframe diamond toggle in
  the right-hand **Transform** panel (`OverlayInspector.tsx`, see "Properties
  panel" below). Clicking it drops a keyframe at the playhead with the
  property's current value. CapCut-style auto-keyframe-on-edit: once a
  property already has at least one keyframe, changing its value with the
  playhead parked (dragging the overlay, editing its number field, moving the
  scale slider or the rotate dial) drops a new keyframe automatically, no
  diamond click needed. Every control in that panel obeys this one rule, so
  none of them can drift from the others.
- **Keying everything at once.** The panel's section header carries its own
  `‹ ◇ ›` unit covering all five properties: the diamond is filled only when
  every property has a keyframe at exactly the playhead, and clicking it keys
  all five there (reading each value off the item as it stands, so nothing on
  screen moves). Clicking it when all five are already keyed removes that
  time from each. A property whose only keyframe is the one being removed
  gets its sampled value written into its static scalar first, so it holds
  its position instead of jumping back to a stale value. The arrows jump the
  playhead to the previous/next keyframe across all five tracks. Double-clicking
  the selected overlay on the canvas does the same thing from the timeline
  side, at the instant the click landed on rather than at the playhead: it
  keys all five properties there, reading each off the item as it stands, so
  nothing on screen moves.
- **The strip.** `drawKeyframeStrip` (`timeline/canvas/draw.ts`, geometry in
  `timeline/canvas/keyframe-strip.ts`) paints one diamond per distinct
  keyframe time, in a thin zone along the bottom of the clip — only for a
  SELECTED, keyframed overlay item, nothing else ever draws a diamond.
  `hit-test.ts`'s `keyframeStripZone` gives diamonds first claim on that zone,
  ahead of the ordinary clip-body hit.
- **Selecting a diamond.** Double-clicking a diamond selects it rather than
  opening the clip's inspector, swapping its fill from amber to white with a
  thicker stroke — the same "outline thickens" language a selected clip's
  border uses. Selection is what the keyboard removal below and the
  right-click menu act on.
- **Retiming.** Dragging a diamond enters the `keyframe-move` pointer state
  (`pointer-machine.ts`), moving every prop that has a keyframe at that time
  together via `keyframeOps.moveKeyframe`, clamped to the item's own
  duration. Every OTHER keyframe time on the same item is a strong snap
  target, so a drag is actively steered onto them — landing exactly on one
  MERGES the two diamonds: for any prop they share, the dragged one's value
  wins and the target's is dropped. This reads as "drag one diamond onto
  another to collapse them," and it is a normal, undoable edit like any
  other keyframe change.
- **Remove and easing.** Right-click a diamond to fire `onKeyframeMenu`
  (`TimelineCanvas.tsx`) — the host renders a picker offering the six
  `EASING_NAMES` (via `keyframeOps.setKeyframeEasing`) and a remove action
  (via `keyframeOps.removeKeyframe`), one per keyframe track that has a point
  at that time. The easing option is omitted when `t` is the item's LAST
  keyframe: its easing governs the segment leaving it, and the last keyframe
  has no next segment to leave. Right-click only, like the `fadeCurveMenu`
  it mirrors — there is no keyboard path to open it.
- **Removing via keyboard.** With a diamond selected, Delete or Backspace
  removes every property keyed at that instant (`keyframeOps.removeKeyframesAt`)
  — same effect as the panel header diamond's un-key, and the same freeze: a
  property whose only keyframe is the one being removed gets that instant's
  sampled value written into its static scalar first, so nothing jumps. With
  no keyframe selected, Delete/Backspace deletes the selected clip exactly as
  it always has.

**Trimming an item does not rewrite its keyframes.** A keyframe's `t` is
item-relative, and no trim path touches `item.keyframes` (the only write is
`applyKeyframeMove` in `pointer-machine.ts`). Two consequences, both
deliberate rather than oversights:

- Trimming an overlay SHORTER leaves any keyframe past the new end in the
  data. The animation simply truncates — `sampleTrack` interpolates normally
  up to the last reachable instant — which is the expected behaviour and
  matches how keyframes survive a trim in other editors. Re-extending the item
  brings those keyframes back into play unchanged.
- While out of span, such a keyframe is neither drawn nor hit-testable
  (`keyframeUnionTimes` returns every time unfiltered, but the diamond's x
  falls outside the clip rect), so it cannot be removed until the item is
  extended again. The workaround is to extend, delete, and re-trim.

Clamping or deleting keyframes on trim was considered and rejected: silently
discarding a user's animation because they shortened a clip is worse than
leaving it dormant and recoverable.

---

## Audio polish

One toolbar action (`Wand2` icon, and a `Polish audio…` command-palette entry)
opening `video/AudioPolishModal.tsx`. Feature-detected on
`adapter.analyzeAudioPolish`, so a host that omits it sees no button, no palette
entry and no mount.

**Four independent pieces**, each a step call behind the adapter: `silence`
(`rm_nonspeech`), `fillers` (`rm_fillers`), `loudness` (`normalize
--measure-only`), `voice` (`stem_separation`). A fifth call, `silence-check`
(`waveform_trim`), is an internal cross-check and is not a user toggle.
Whole-source pieces (`voice`, `silence-check`) are cached per `src`; the
windowed per-clip pieces are not.

**Preview is not a rendering mode.** The draft is pushed with
`sync.mutateTransient`, so the canvas timeline, preview player and audio all
reflect it with no preview-specific code. Cancel is `discardTransient`; Apply is
`commit`, which is why the whole polish is one undo entry. An empty plan
discards rather than committing, so Apply never records a no-op undo step.

**All planning is pure and lives in `video/audioPolish.ts`** — coordinate
mapping both directions, removal pooling and merging, both guards, the gain
maths, stem-track construction and `buildDraft`. The modal owns step
orchestration and approval state only. Deliberately: that logic took several
review rounds to get right, and a second copy in React would drift from it.

**`pieceSupported(clip, piece)` is the single eligibility question**, returning
`{ available, reason? }` so the badge text lives beside the rule that produces
it rather than in the view. It covers both restrictions: `speed !== 1` blocks
`voice` only; `loop` blocks `silence`, `fillers`, `silence-check` and `voice`,
while `loudness` stays available. A clip that is both reports the loop reason,
because loop explains every unavailable piece on that clip while speed explains
one.

**Cut composition is the subtle part.** `applyCutToTracks` ripples captions
itself while clips lift, so `collapseGaps` is called with
`{ remapCaptions: false }` — see the invariant above `collapseGaps` in
`video/cuts.ts`. Removals are pooled across every targeted clip into one list
and applied descending; per-clip batching reintroduces a stale-coordinate bug
across clip boundaries. A head removal additionally needs `closeLeadGap`, which
shifts clips, overlays and audio tracks but explicitly **not** captions.

---

## Background caption generation

Regenerating captions does not block the editor. The trigger in the Captions
panel starts a job and hands the editor straight back; progress appears as a
small readout in the app's top bar next to the proxy-generation one, with the
current phase and a Cancel. On success the captions land and the readout
disappears; on failure it turns red with the reason and a dismiss.

**The job is owned above the route.** `app/editor/captionJob.tsx` is a context
provider mounted in `App.tsx`, so a running job survives navigating away from
the project and back. It does not survive a full page reload: the stream is
client-side, and making it reload-durable needs server-side job tracking the
way proxies have. `start(projectId, run)` takes a thunk returning the event
stream rather than the options themselves, so this app-root module never
imports `createMontajAdapter` and never drags the adapter graph out of the
lazy editor chunk into the main bundle.

**The editor package still owns a blocking modal, and that is still the
default.** `VideoEditorProps` gained two optional props, `onRegenerateCaptions`
and `captionsGenerating`. A host that passes the first is asserting it owns the
job: the editor delegates the trigger and never mounts `CaptionRegenModal`. A
host that passes neither (Hub, Los Parceros) behaves exactly as before. That is
why this is additive rather than a replacement.

**Nothing here saves the project.** The server persists regenerated captions
itself and broadcasts an SSE frame the mounted editor reconciles, so a save
would double-write. The host sink exists only to refresh `EditorPage`'s own
copy of the project, which is otherwise stale because it deliberately drops SSE
frames while a package editor is mounted.

**Cancel stops the request, not just the listening.** Cancelling calls the
stream iterator's `return()` immediately, which aborts the fetch and lets the
server's disconnect poll kill the pipeline. Waiting for the loop to notice on
its next event would leave the job alive through whisper's quiet stretches, and
an immediate retry would then collide with the server's one-job-per-project
guard.

---

## Version history

The left panel's **Versions** tab (`video/VersionPanel.tsx`). Git-backed snapshots: **every** saved version gets its own row, newest first.

Rows show the version's **name and date**, with **Compare** and **Restore** on each. There is no per-run grouping and no "Run N" prefix: "run" is backend plumbing (`runCount`, the Re-run flow) that stays in the backend and is no longer surfaced, and collapsing to one row per run used to hide real saved versions from the operator. The only entry still filtered out is the run-0 init baseline. Auto-generated labels are humanized for display (`draft` reads as "Draft", `export` as "Exported", `autosave before restore` as "Auto-save before restore", an empty label as "Untitled save"); an operator-typed name is shown verbatim.

- **Snapshot triggers**: each agent run, status transitions (`pending` → `draft` → `final`), and now every export too. A no-op re-export (no diff since the last snapshot) doesn't create a new one.
- **Save version**: name field + button above the list, always visible (not gated on the collapse state). Optional name, defaults to "manual save". Commit message: `version: run N — <name>` — the run number is still written to the commit message, it is just no longer displayed. No track/status side effects.
- **Restore**: `POST /api/projects/:id/versions/:commit/restore`. Non-destructive as of this change — if the working tree has uncommitted edits, they're committed first as `version: run N — autosave before restore` before checking out the target commit, so restoring never loses work. Skipped when there's nothing uncommitted.
- **Compare**: `video/VersionCompare.tsx`, opened from each version's **Compare** button. Two-pane visual diff — Left/Right pickers (any version, or the `"working"` sentinel for the live on-disk state) plus a debounced time-scrub slider, each pane an `<img>` from `GET /api/projects/:id/versions/:commit/frame?t=`. Gated on the adapter exposing `versionFrameUrl`; a host without it just doesn't render the Compare button.
- Backend routes: `POST /api/projects/:id/versions` (save), `GET /api/projects/:id/versions` (list), `POST /api/projects/:id/versions/:commit/restore` (restore), `GET /api/projects/:id/versions/:commit/frame?t=` (frame render — reuses the SDR-proxy sample-frame path).

---

## Keyboard shortcuts

Live for every user — **not** behind the canvas-timeline flag above. One
shared keymap (`video/keymap.ts`) owns every binding below; it declines
Space entirely (Space always toggles play/pause via the active playback
path, exactly as before) and suppresses everything else while typing in a
caption/overlay text field. Timeline-scoped keys (arrows, Delete, Enter,
Escape) additionally stand down while a dialog is open; the editing keys
(Split, the preview-axis toggle, Undo/Redo, ripple-delete, the palette,
J/K/L) stay live so undo works with a dialog up.

| Keys | Action |
|------|--------|
| `S` | Split at the playhead |
| `⌘/Ctrl` + `A` | Toggle the preview axis |
| `⌘/Ctrl` + `Z` | Undo |
| `⌘/Ctrl` + `⇧` + `Z` (or `⌘/Ctrl` + `Y`) | Redo |
| `Delete` / `Backspace` | Delete the selection |
| `⇧` + `Delete` / `⇧` + `Backspace` | Ripple-delete the selection — items after the deletion point shift to close the gap |
| `←` / `→` | Step one frame (`⇧` + arrow steps ten frames) |
| `J` / `K` / `L` | Shuttle backward / stop / forward, 1×/2×/4× (doubling on repeated presses in the same direction) — forward is real, pitch-corrected, audible playback on the playback engine; the `<video>` fallback plays forward at 1× only, and reverse is a silent scrub either way |
| `⌘/Ctrl` + `C` | Copy the selection to an in-memory, per-session clipboard — visual items and audio tracks only, captions are excluded; doesn't survive a page reload, doesn't use the OS clipboard, and doesn't block the browser's native text copy |
| `⌘/Ctrl` + `V` | Paste the clipboard at the playhead |
| `⌘/Ctrl` + `D` | Duplicate the selection in place |
| `⌘/Ctrl` + `⌥/Alt` + `V` | Paste attributes — apply the copied item's look (position, scale, opacity, rotation; `fit` for images; volume/muted/speed for video; volume/muted/ducking/fades for audio) onto the selected items without replacing them |
| `F` | Toggle the preview to fullscreen (`⌘/Ctrl` + `F` is left alone for the browser's native find) |
| `⌘/Ctrl` + `K` | Open the command palette |
| Click the time readout | Open the command palette straight into "go to time" (accepts bare seconds, `mm:ss`, or `hh:mm:ss`) |

The command palette (`⌘/Ctrl+K`) is a filterable list — type to narrow,
arrow keys to move the highlight, Enter to run, Escape to close. Its command
set is state-aware: Ripple-delete only appears with a selection, Undo/Redo
only appear when there's something to undo/redo. Always present: Play/Pause,
Split at playhead, Zoom to fit, Go to time…

---

## Structure

```
ui/
  src/
    app/
      ProjectList.tsx           # Project list (home)
      editor/
        EditorPage.tsx          # Editor tab — routes between upload/live/review
        UploadView.tsx          # Upload clips + prompt + workflow selector
        LiveView.tsx            # Live SSE view as agent works
        ReviewView.tsx          # Human review — timeline, captions, overlays
      WorkflowsPage.tsx         # Workflow node graph
      overlays/
        OverlaysPage.tsx        # JSX overlay live preview + file watcher
      profiles/
        ProfilesPage.tsx        # Creator style profile browser
    components/
      PreviewPlayer.tsx         # <video> + CSS overlay rendering
      Timeline.tsx              # Clip / caption / overlay tracks
      NodeGraph.tsx             # Workflow builder (nodes + edges)
      PromptBar.tsx             # Re-run agent with modified prompt
    lib/
      project.ts                # Read/write project.json (via API route to montaj serve)
      sse.ts                    # SSE client — subscribe to project.json changes
      file-watch.ts             # shared file-change watcher — one SSE connection per tab (global jsx:* channel), ref-counted per-path callbacks
      overlay-eval.ts           # Compile + cache JSX overlay components
  package.json                  # Vite + React
```

---

## Key design decisions

- **`montaj serve` is thin.** No business logic — just file watching, SSE, and process spawning. The pipeline logic lives in the scripts and workflow engine.
- **Agent polls, not push.** `GET /projects?status=raw` — agent asks for work. Same pattern as the hosted platform integration.
- **Filesystem is the source of truth.** Agent writes project.json to disk. Serve watches. Browser reflects. No intermediate state.
- **No frame-by-frame browser rendering.** Native `<video>` + CSS overlays. Fast, simple, no canvas/WebGL.
- **project.json is the only state.** All edits mutate JSON in memory. Save writes to disk. Nothing else is persisted.
- **Every UI action has a CLI equivalent.** The UI is a layer on top of the CLI, not a separate system.

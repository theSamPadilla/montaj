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
- Caption editor: click to edit text inline, drag to retime
- Overlay editor: add/remove/reposition title cards, lower thirds
- Prompt bar: modify the prompt and re-run the agent
- Save: writes updated `project.json` to disk

Review is optional — click Render directly from live view if the first pass is good.

### 4. Render

Triggers the render pass. Progress streams back via SSE. Final MP4 lands in `workspace/`.

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
- A small expand button sits in the preview's top-right corner, and the `F` key does the same thing (see "Keyboard shortcuts" below) — either one takes the preview fullscreen, and exits via `F` again, the button, or the browser's own Escape

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

---

## Timeline

Clip, caption, and overlay tracks, rendered on canvas by default (see
"Canvas timeline" below). A track rail runs down the left with per-track
volume, mute, and skip controls. Clips show filmstrip frames over a
full-size waveform. Selected clips grow trim handles, with tiered
snapping — a strong magnet to the next clip on the same track, a faint one
to anything on another track or the playhead — and a visible snap indicator
while you drag. Overlapping clips on the same track are marked with overlap
bands.

### Canvas timeline

A `<canvas>`-rendered alternative to the DOM track rows (visual tracks +
audio lanes) draws clips and audio bars on a canvas instead of positioning
one DOM element per item, which is what keeps panning/zooming smooth
regardless of project size. This is the timeline `montaj serve`'s editor
runs — `EditorPage.tsx` passes `timeline={{ canvas: true }}` unconditionally
(`montaj_assets/ui/src/app/editor/EditorPage.tsx:438`). See
`docs/ARCHITECTURE.md`'s "Canvas timeline" section for how it works
internally.

- **The prop.** `VideoEditor` takes an optional `timeline?: {canvas:
  boolean}` — still the package contract for a third-party host. Absent or
  `{canvas: false}` (the default for a host that doesn't pass it): the
  existing DOM track rows, unchanged. `{canvas: true}` — what Montaj's own UI
  always passes — renders the track-row area (visual tracks + audio lanes) on
  canvas instead; the timeline's chrome (zoom controls, the time readout, the
  transcript panel/modal) and the caption row are unaffected either way; the
  caption row always stays a real DOM component (it hosts inline
  `contentEditable` text editing, which a canvas can't do), only its
  position in the stack changes — below the canvas in canvas mode, above the
  visual tracks in DOM mode.
- **No eligibility gate.** Unlike the playback engine flag, there is no
  capability probe and no per-project fallback — `{canvas: true}` always
  takes effect, on every project, in every browser the editor runs in.
- **What's new when it's on.** Per-clip waveforms on visual tracks (clips
  never showed a waveform before this), zoom-responsive audio-lane
  waveforms replacing fixed-resolution PNG chunks, hover-scrub filmstrip
  thumbnails once zoomed in past a threshold, one unified magnetic-snap feel
  across every drag/trim gesture, and four new trim tools — ripple-delete,
  roll, slip, and slide — bound to modifier-key drags. One deliberate
  display change: the zoom badge reports a fit-relative multiple rather than
  the DOM path's old zoom number, and can now show a value below 1× (zooming
  out past "fit the whole project" is newly possible).

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

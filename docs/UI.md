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
- Preview player: native `<video>` + CSS overlays synced to scrubber
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

Native `<video>` element with CSS-positioned overlays. No canvas, no WebGL.

- Captions rendered as absolutely positioned divs, shown/hidden by `currentTime`
- Overlays (title cards, lower thirds) same approach
- Timeline scrubber synced to `video.currentTime`
- Preview is an **approximation** — CSS overlays are close but not pixel-perfect to the final render burn-in. The render is what matters.

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

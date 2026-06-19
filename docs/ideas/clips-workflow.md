# Clips Workflow — long-form source → series of vertical clips

**One-liner:** A new `clips` workflow that takes one long-form horizontal video (e.g. a YouTube export), has the agent transcribe-and-sample it to find the N best moments, and fans those out into N independently-editable vertical (9:16) clip projects with configurable framing and overlays.

## Problem & why now
Short-form vertical clips cut from a single long-form horizontal source is the dominant content-repurposing workflow (podcast → Reels, talk → TikToks, stream → Shorts). Montaj today has no path for it: every workflow assumes you already have the clips. The closest primitives — `select-takes` (cross-clip editorial reasoning), the presenter overlay pattern, `resize` — exist but were built for other jobs. This workflow stitches them into the one repurposing flow montaj is missing, and the CLIP philosophy (agent makes the editorial calls) is a natural fit for "which moments are worth clipping."

## Fit with strategy
- **CLIP positioning ([README.md](../../README.md)):** "Montaj provides the tools; the agent makes the creative decisions." Clip selection is pure editorial judgment — it belongs in an agent-authored task, not a deterministic step. This workflow is a showcase of the thesis, not a deviation from it.
- **Workflows are *suggested plans*, not rigid pipelines** — so a `clips` recipe that the agent adapts per source is on-pattern.
- **Respects the saved invariant** `tracks[0].src` = the original video, with `inPoint`/`outPoint` defining the window (see `feedback_project_json_tracks`).
- The bet: repurposing is high-frequency and high-value enough to justify montaj's first **one-source → many-projects** flow, even though it pushes on the "one project = one render" model.

## The idea (refined)
Three stages:

1. **Source pass (agent-authored task, à la `select-takes`).** The workflow's first stage transcribes the long-form source once, then the agent reads the transcript and **samples** the source to choose N clip windows (`[inPoint, outPoint]` pairs) — each a self-contained moment with a hook. No CLI step; the editorial judgment lives in the agent. Output: a list of clip specs (window + a suggested angle/title).

2. **Fan-out into N vertical projects.** For each chosen window the agent creates a **net-new vertical project** seeded with the original source as `tracks[0].src` and the window's `inPoint`/`outPoint`. Each child carries a `derivedFrom` pointer back to the source so "all clips from this video" is a real, listable relationship. **The source bytes are stored once and shared by reference (symlink into each child workspace), never copied N times.**

3. **Vertical layout + overlays per clip.** Each child is 9:16 and supports three framing modes, with the agent choosing when the user doesn't specify:
   - **Zoom** — spatially crop the horizontal source to fill the vertical frame (new render primitive).
   - **Thirds / regional** — source occupies a region (e.g. top third), the rest is background + overlays/images/action (reuses the existing presenter overlay pattern).
   - **Mix** — zoom the source into ~50% of the frame, leave the rest for content (combines both).
   The **cut and on-frame positioning of the source is configurable in the editor** (extends the existing `crop-math.ts` / `CanvasCropOverlay` from images to video).

## Product decisions
Locked during ideation — these anchor autonomous execution:

1. **Clip model: fan-out + `derivedFrom` link.** Each clip is its own vertical project (independently editable/reviewable/renderable), with a lightweight back-reference to the source project. Not a single multi-output project, not fully-independent islands.
2. **Source is referenced, not copied — one concept, two implementations.** The long-form source is stored once and shared by reference. The *mechanism is environment-specific*, and montaj-core never sees the difference (a child's `tracks[0].src` is just the source file, staged by the environment):
   - **Local `montaj serve`:** a **symlink** into each child workspace (near-zero disk; requires relaxing the serve `_is_under` guard for symlinks resolving within the projects root).
   - **Deployed (hub-driven):** a single **R2 `Media` row** referenced by N projects via `project_media` joins. R2 stores the file once; each *active* child stages a transient working copy from that one object. A literal filesystem symlink **cannot** work here — the deployed scratch dir is ephemeral (torn down on idle/delete, rebuilt from R2 on activation), so a symlink has nothing to persist it and the cross-project path fails the `_is_under` guard.
   In both cases the durable copy is singular. `init.py`'s default `shutil.copy2` is bypassed (symlink) on the local fan-out path.
3. **Clip selection is an agent-authored task**, modeled on `select-takes` — no CLI step. The recipe step (e.g. `montaj/find_clips`) loads a skill; the agent reasons over the transcript.
4. **Both layout modes ship in one plan** — zoom, thirds, and mix together (user's call; not phased). All three reduce to one render primitive: a `sourceCrop` {x,y,w,h} fraction on a video item (zoom = cropped tracks[0] item filling frame; thirds = source as an overlay-track item in a region over a background; mix = cropped source as an overlay item at ~50%). Zoom/`sourceCrop` is the new-primitive, highest-risk work.
5. **Delivered as two plans.** Plan 1 = **montaj-core** (this idea, verifiable on `montaj serve`): clips workflow, `find_clips` skill, fan-out, `derivedFrom` in project.json, `sourceCrop` render primitive, editor crop UI, local symlink staging. Plan 2 = **hub remote integration** (completes the deployed story): R2 `Media`-row source sharing, `project_media` joins, `derivedFrom` column on the `Project` entity, child staging, enable the workflow on orgs. Montaj-core is built behind an env-agnostic seam so the hub plan slots in without reworking it.
6. **Agent picks the layout** (zoom / thirds / mix) and per-clip framing when the user's prompt doesn't specify one explicitly.
7. **First pass is transcribe-only sampling** — the source pass does not clean/trim/caption the source; it only transcribes to enable selection. Cleaning happens per-clip downstream.

## Scope
- **In (MVP):**
  - New `workflows/clips.json` recipe (`project_type: editing`, single long-form source).
  - `find_clips` agent-authored task + skill (transcribe → sample → N windows).
  - Fan-out mechanism: agent creates N child vertical projects with shared-by-reference source + `inPoint`/`outPoint`.
  - `derivedFrom` linkage field on project.json (+ a way to list a source's clips).
  - Source-by-symlink seeding path (bypass the hard copy).
  - Vertical framing: **zoom** (new spatial crop field on `tracks[0]` video item + ffmpeg crop+scale in render), **thirds** (authoring pattern over existing presenter offsets), and **mix**.
  - Editor: configurable source cut/positioning for video (extend `crop-math.ts` / `CanvasCropOverlay`).
  - Overlays on clips via the existing overlay machinery.
  - Hub mirror: copy `clips.json` into `hub/.../creative/workflows/`, enable on relevant orgs.
- **Out / later:**
  - Auto-generating overlay *content* (captions/titles) for clips — clips inherit the existing caption/overlay flows; no new generative copy here.
  - Multi-source / playlist input (one source only for MVP).
  - A dedicated "source dashboard" UI for browsing all clips of a source (the `derivedFrom` link is the data foundation; a rich UI is a follow-up).
  - Speaker/face auto-tracking for zoom framing (manual/agent-chosen framing first).

## Risks & open questions
- **Weakest assumption: one-source → N-projects fits montaj's model.** The data model is "one project.json = one render" with no project relationships. `derivedFrom` is the minimum to make fan-out coherent; if review/edit ergonomics demand more (siblings list, re-fan-out on source edit), scope can grow. Watch this in `/plan`.
- **Symlink portability.** Symlinked sources break if a project dir is moved/zipped, and commit as links under per-project git. Acceptable for the local-first MVP; revisit if projects become portable artifacts. Need a fallback (re-materialize) if the symlink target is missing at render.
- **Zoom is the real engineering.** New schema field + render compositing + editor UI on a previously spatial-field-free `tracks[0]` item. It's the one task that can blow the estimate; everything else is wiring existing primitives. Keep it isolated within the plan.
- **`resize` overlap.** Today `resize` letterboxes to 9:16. Decide in `/plan` whether zoom is a new mode on `resize` or a distinct crop/reframe field — don't grow two competing reframe paths.
- **Version bumps are out of scope** per project rule — plan stops at `## Unreleased`.

---
name: onboarding
description: "Orientation skill for new agents and users. Explains what Montaj is, the project model, where things live, account styles, and the UI. Ends with a choice: set up style profiles first, or edit a video."
---

# Montaj — Orientation

---

## What Montaj is

A video editing toolkit that mounts on top of your agent. **You bring the brain. Montaj gives you the tools.**

Montaj doesn't edit on its own. It provides discrete operations — trim, transcribe, remove fillers, caption, resize, composite overlays — and the agent decides which to call, in what order, with what parameters. The agent is the editor. Montaj is the toolbox.

---

## How it compares

Most programmatic video tools (Remotion, Revideo) have the agent **write code** that describes a composition. Montaj takes the opposite approach: the agent **calls tools** against existing footage. No code authoring. The agent reasons about which steps to apply and executes them.

GUI tools (Premiere, DaVinci, Descript, Runway) are driven by a human. Every decision is a click. Montaj is designed for the agent to drive — the human reviews the result, not the process.

**Where Montaj is the right choice:**
- You have raw footage and want an agent to produce an edited video
- You need captions, overlays, and trim decisions made from the content itself
- You want to define a reusable editing style for an account and apply it automatically
- You want to run locally, no API keys required

**Where Montaj is not the right choice:**
- You want to generate video from scratch (use Veo, Runway, Sora)
- You want a human-driven GUI with fine-grained manual control

---

## What is a project

A project is one video being made. Everything lives in a single file: `project.json`.

```
pending  →  agent edits  →  draft  →  human reviews  →  final  →  render  →  MP4
```

- `pending` — created, clips and prompt attached, waiting for the agent
- `draft` — agent is done; ready for human review
- `final` — reviewed and approved; ready to render

The agent reads `project.json`, calls steps, writes it back as it works. The UI watches the file and rerenders the timeline on every write.

---

## Where things live

```
~/Montaj/                       ← workspace — all projects live here
  2025-04-01-product-demo/
    project.json                ← the project (pending → draft → final)
    clip.mp4
    clip_spec.json              ← trim spec (editing decisions, no re-encode)
    clip_transcript.json        ← word-level timestamps
    overlays/hook.jsx           ← agent-authored overlay components
    output.mp4                  ← final render

~/.montaj/                      ← user config + extensions
  config.json                   ← workspaceDir, model, render settings
  credentials.json              ← API keys (never committed)
  profiles/<name>/              ← account style profiles
  steps/                        ← custom steps
  workflows/                    ← custom workflows

montaj/                         ← built-in (ships with Montaj)
  steps/
  workflows/
  skills/
```

---

## Account styles (Style Profiles)

A style profile captures the visual and editorial identity of a social media account — pacing, cut frequency, color palette, caption style, tone. Once created, it gets injected into every project for that account so editing decisions stay consistent automatically.

Profiles live at `~/.montaj/profiles/<name>/style_profile.md` and are loaded into your agent context via `~/.claude/CLAUDE.md`.

To create or update one: load `skills/style-profile/SKILL.md`.

---

## The UI

`montaj serve` starts a local server and opens `http://localhost:3000`.

```bash
montaj serve
```

Four modes, in order:

**Upload** — drop clips, write an editing prompt ("tight cuts, remove filler, 9:16 for Reels"), pick a workflow, hit Run.

**Live view** — as the agent works, the timeline updates in real time via SSE. You watch the edit take shape — trim points appear, captions populate, overlays are placed.

**Review** — when the agent marks the project `draft`, it surfaces for human adjustment. Inline caption editing, overlay repositioning, re-run the agent with a revised prompt. Optional — if the first pass is good, render directly.

**Render** — triggers the render pass. Progress streams back. Final MP4 lands in the project directory.

Three tabs:
- **Editor** — the upload → live → review → render flow above
- **Workflows** — node graph for building and editing workflow files
- **Steps** — browse available steps, view schemas, scaffold new custom steps

The UI is a layer on top of the CLI. Every action maps to a CLI command. `montaj serve` is optional — the full pipeline works headlessly without it.

---

## Getting started

Ask the user:

> "Before we start — do you want to set up a style profile for your account first, or jump straight into editing a video?
>
> **Style profile:** I'll analyze your existing content (or a URL you paste) and build an editing style that gets applied automatically to every project for that account — pacing, caption style, color palette, tone.
>
> **Edit a video:** Drop your clips and a prompt, and I'll run the full edit pipeline now. You can always add a style profile later."

- If **style profile**: load `skills/style-profile/SKILL.md` and follow it.
- If **edit a video**: check for `montaj serve` (`GET http://localhost:3000/api/projects?status=pending`). If running, load `skills/serve/SKILL.md`. If not, load the root `SKILL.md` and follow the CLI loop.

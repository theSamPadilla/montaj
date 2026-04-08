---
name: onboarding
description: "Orientation skill for new agents and users. Explains what Montaj is and how it works. Use it when the user asks questions about montaj or is getting started"
---

# Montaj — Orientation

---

## What Montaj is

A video editing toolkit that mounts on top of an agent harness. **You bring the brain. Montaj gives agents the tools.**

Montaj doesn't edit on its own. It provides discrete operations — trim, transcribe, remove fillers, caption, resize, composite overlays — and the agent decides which to call, in what order, with what parameters. The agent is the editor. Montaj is the toolbox.

---

## How it compares

Most programmatic video tools (Remotion, Revideo) have the agent **write code** that describes a composition. Montaj takes the opposite approach: the agent **calls tools** against existing footage. Agent can still write code on top of existing footage for overlays and animations, but montaj is desigend to work **around and with existing footage**. The agent reasons about which steps to apply and executes them.

GUI tools (Premiere, DaVinci, Descript, Runway) are driven by a human. Every decision is a click. Montaj is designed for the agent to drive — the human reviews the result and performs last mile edits, the bulk of the process is agent driven.

**Where Montaj is the right choice:**
- You have raw footage and want an agent to produce an edited video
- You need captions, overlays, and trim decisions made from the content itself
- You want to define a reusable editing style for an account and apply it automatically
- You want to run locally, no API keys required

**Where Montaj is not the right choice:**
- You want to generate AI videos from scratch (use Veo, Runway, etc)
- You want a human-driven rich GUI with fine-grained manual control
- You want an agent to edit videos based purely on visuals and not on trascripts / audio

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

Profiles live at `~/.montaj/profiles/<name>/style_profile.md` and are loaded into your agent context when tagged selected in the UI or manually seeked on the prompt.

To create or update one: load `skills/style-profile/SKILL.md`.

---

## The UI

`montaj serve` starts a local server and opens `http://localhost:3000`.

The Editor tab drives the core flow: upload clips + prompt → watch the agent work live → review and tweak → render. The agent writes `project.json` as it works; the UI reflects every change in real time via SSE.

Four tabs: **Editor**, **Workflows** (node graph), **Overlays** (live JSX preview), **Profiles** (style profiles).

See [docs/UI.md](docs/UI.md) for the full breakdown.

---

## Getting started

Ask the user:

> "Before we start — do you want to set up a style profile for your account first, or jump straight into editing a video?
>
> **Style profile:** I'll analyze your existing content (or a URL you paste) and build an editing style that gets applied automatically to every project for that account — pacing, caption style, color palette, tone.
>
> **Edit a video:** Tell me the location of your clips or drop them in the UI, and I'll run the full edit pipeline for whatever content style you pick. You can always add a style profile later."

- If **style profile**: load `skills/style-profile/SKILL.md` and follow it.
- If **edit a video**: load the repo root `SKILL.md` and follow it.
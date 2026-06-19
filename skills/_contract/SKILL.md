---
name: _contract
description: "The shared vocabulary that domain skills use to name Montaj operations. Domain skills phrase every Montaj interaction as one of these verbs; an interface skill defines how each verb is actually performed. Load this to learn the canonical verbs before authoring or reading a domain skill."
---

# The Vocabulary Contract

Montaj's skills are split into **domain skills** (what to do — transport-agnostic) and **interface skills** (how Montaj is reached — native CLI/HTTP here, or a consumer's remote interface in another repo). This document is the small, stable vocabulary the two sides share.

A **domain skill** describes creative/editing work in terms of the canonical verbs below — and nothing else. An **interface skill** defines HOW each verb is performed on a particular transport. The domain skills never need to know which interface is in play.

This is a contract written for an LLM reader: it is prose conventions, not a strict schema. Phrase things naturally, but stay inside these verbs.

## The canonical verbs

Each Montaj interaction is exactly one of these:

- **run step `<name>` with `<args>`** — invoke a Montaj step and use its output. Steps are the core compute units: e.g. `waveform_trim`, `rm_nonspeech`, `transcribe`, `crop_spec`, `virtual_to_original`, `search_images`, `fetch_image`. (Authoring an overlay is NOT a step — overlays are written as files and saved into the project.)
- **read the project** — get the current project state: clips, tracks, settings.
- **save the project (delta)** — persist only the fields you changed. See the discipline below; this verb is never "save the whole thing I had cached."
- **write a file `<path>` `<contents>`** — create or overwrite a workspace file (overlay JSX, fetched images, assets).
- **read a file `<path>`** — read a workspace file back.
- **log `<message>`** — emit operator-visible progress.

## Save discipline (domain rule, transport-neutral)

Saving the project is always **GET-fresh → merge → save**:

1. **read the project** immediately before saving — get the current state right now.
2. **merge** only your changed fields into that fresh state.
3. **save the project (delta)** with those fields.

Never save from a stale cached body. The operator may be editing the project concurrently, so a body you read minutes ago can clobber their work. Re-read every time, even if you "just" read it.

## Two hard rules

**No transport language.** Domain skills MUST phrase every Montaj interaction as one of the verbs above and MUST NOT name a transport. No `localhost`, no port numbers, no `montaj run`, no `PUT /api/...`, no `curl`, no reading or writing `project.json` directly. If a domain skill mentions a URL, a port, an HTTP method, or a literal on-disk project file, it has leaked the transport and is wrong. The interface skill owns all of that.

**Name-based sub-skill references.** Refer to other skills by name, not by file path — e.g. "load skill `write-overlay`", not `skills/write-overlay/SKILL.md`. The reader resolves the name; the path may differ per interface.

## Coverage note

These verbs are sufficient for the Phase-1 domain skills:

- **select-takes** — run step `crop_spec`, run step `virtual_to_original`; read the project.
- **overlay** — read the project; save the project (delta); load skill `write-overlay`.
- **write-overlay** — save the project (delta); write a file (the JSX); reference asset paths via written/read files.
- **image-search** — run step `search_images`, run step `fetch_image`; write a file / read a file.

If a future domain skill needs an operation not on this list, extend this contract first — do not let a domain skill invent its own transport-specific phrasing.

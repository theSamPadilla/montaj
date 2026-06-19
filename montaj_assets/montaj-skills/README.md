# @bycrux/montaj-skills

Transport-agnostic **Montaj domain skills** — the prose that teaches an agent
*what* Montaj can do and *how to reason* about it, with zero assumptions about
*how* the agent talks to a Montaj server.

This bundle is published from the Montaj monorepo. The canonical source lives at
`/skills/<name>/SKILL.md`; the files shipped here are derived copies, staged at
pack time by `scripts/stage.mjs`.

## What's in the bundle

Flat Markdown files:

| File | Source skill | What it covers |
| --- | --- | --- |
| `skills/select-takes.md` | `select-takes` | Choosing the best takes from raw footage |
| `skills/overlay.md` | `overlay` | Placing graphic/text overlays on a render |
| `skills/write-overlay.md` | `write-overlay` | Authoring the copy that goes into overlays |
| `skills/image-search.md` | `image-search` | Sourcing imagery for a project |
| `contract.md` | `_contract` | The **vocabulary contract** (see below) |

Deliberately **excluded**: the `native` and `mcp` skills and the root
`SKILL.md`. Those describe a specific transport and host wiring — they are not
part of the portable domain bundle.

## The vocabulary contract

`contract.md` defines the shared vocabulary the domain skills speak: the nouns
(projects, takes, overlays, media…) and the verbs/operations the agent invokes.
The domain skills are written *against* this contract — they say "do operation
X" without saying which HTTP route, MCP tool, or CLI call performs it.

## Consumers MUST supply their own interface skill

**This package ships domain knowledge and the contract only — no transport.**
Montaj intentionally does not bundle an interface skill here.

To use these skills, a consumer must provide its **own interface skill** that
*implements* the vocabulary contract — mapping each operation in `contract.md`
to a concrete call (an HTTP request to a Montaj server, an MCP tool invocation,
a CLI command, etc.). The domain skills + contract + your interface skill
together form a working agent. Without an interface skill, the domain skills
have no way to actually reach a Montaj instance.

## Versioning / publishing

Published as `@bycrux/montaj-skills` to the public npm registry, tag-gated on
`montaj-skills-v*`. The staged files are regenerated on every pack via the
`prepack` script, so the published tarball always reflects `/skills` at the
tagged commit.

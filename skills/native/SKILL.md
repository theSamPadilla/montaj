---
name: native
description: "The native interface — how the _contract verbs are performed when Montaj runs locally, either via the HTTP server (montaj serve) or the headless CLI. The dispatcher loads this after it detects HTTP or CLI mode; domain skills never read it directly. Covers step invocation, project read/save, file read/write, logging, GET-before-save discipline, workspace resolution, and image-step credentials."
step: false
---

# Montaj Native Interface

This skill is the **native implementation of the `_contract` vocabulary**. Domain skills speak only in the canonical verbs (run step, read the project, save the project, write a file, read a file, log). This document defines HOW each of those verbs is actually performed when Montaj runs on the local machine.

Domain skills do **not** load this skill. The dispatcher (`montaj` root skill) detects the interface and loads this one; the domain skills then phrase their work in `_contract` verbs and the mapping here resolves them.

There are two native sub-modes:

- **HTTP** — `montaj serve` is running a local server. All interactions go over HTTP.
- **CLI** — no server. Steps run as `montaj <step>` subprocesses; the project is a `project.json` file on disk; logs go to stderr.

The dispatcher tells you which mode you are in. If you must decide yourself: `GET http://localhost:<port>/api/projects?status=pending` — if it responds, you are in HTTP mode; if the connection is refused, CLI mode.

---

## Verb mapping

| `_contract` verb | HTTP | CLI |
|------------------|------|-----|
| run step `<name>` with `<args>` | `POST /api/steps/<name>` | `montaj <step> …` |
| read the project | `GET /api/projects/<id>` | read `project.json` from the project directory |
| save the project (delta) | `GET` then `PUT /api/projects/<id>` | read-modify-write `project.json` |
| write a file `<path>` | `POST /api/files` (or write to disk; both modes share one filesystem) | write to disk |
| read a file `<path>` | `GET /api/files?path=…` (or read from disk) | read from disk |
| log `<message>` | `POST /api/projects/<id>/log` | print to stderr |

Both modes run on the same machine and share one filesystem, so file paths are always real on-disk absolute paths in either mode.

---

## Workspace & config resolution

- **Project directory:** `{workspaceDir}/<date>-<name>/`. `workspaceDir` defaults to `~/Montaj`; override in `~/.montaj/config.json`.
- **Step outputs** go next to their inputs. Trim-spec outputs: `<original>_spec.json`. Concat output: `<original>_concat.mp4`. Final render: `output.mp4` in the project directory. Transcripts: `<clip>_transcript.json` and `<clip>.srt`.
- **Server port (HTTP mode):** `montaj serve` listens on **port 3000** by default; override with the `MONTAJ_SERVE_PORT` environment variable. Use that port in every URL below.

---

## HTTP mode

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/projects` | GET | List projects (`?status=pending`) |
| `/api/projects/:id` | GET / PUT | Read or update (save) a project |
| `/api/projects/:id/log` | POST | Append a status log message |
| `/api/steps` | GET | List available steps |
| `/api/steps/:name` | POST | Run a step |
| `/api/files` | GET / POST | Read / write a workspace file |
| `/api/run` | POST | Create project + start edit (`clips`, `assets`, `prompt`) |

All URLs are `http://localhost:<MONTAJ_SERVE_PORT>` (default `3000`).

### run step — `POST /api/steps/:name`

```bash
# Single input
curl -s -X POST http://localhost:3000/api/steps/probe \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/to/clip.mp4"}'

# Step with params
curl -s -X POST http://localhost:3000/api/steps/trim \
  -H "Content-Type: application/json" \
  -d '{"input": "/path/to/clip.mp4", "start": 2.5, "end": 8.3}'

# Multiple inputs (rm_fillers batch, etc.)
curl -s -X POST http://localhost:3000/api/steps/rm_fillers \
  -H "Content-Type: application/json" \
  -d '{"inputs": ["/path/clip1.mp4", "/path/clip2.mp4"]}'
```

Response: `{"path": "..."}` for file outputs, a JSON object for data outputs (probe, transcribe, etc.).

**Long-running steps** (transcribe, rm_fillers, resize, remove_bg) must run in the background so you stay available for conversation:

1. **Single long step** — set `run_in_background: true` on the Bash tool call. You are notified on completion.
2. **Multiple clips in parallel** — write a shell script with `&` + `wait` to `/tmp`, execute with `run_in_background: true`.

Never block the conversation waiting on ffmpeg. Log the step, fire it in the background, then tell the user what's running.

### read the project — `GET /api/projects/:id`

```bash
# Get pending projects (to pick one up)
curl -s "http://localhost:3000/api/projects?status=pending"

# Read one project's full state
curl -s "http://localhost:3000/api/projects/{id}"
```

### save the project (delta) — `GET` then `PUT /api/projects/:id`

The body `id` must match the URL `id`.

```bash
curl -s -X PUT http://localhost:3000/api/projects/{id} \
  -H "Content-Type: application/json" \
  -d '{"id": "{id}", "status": "draft", "tracks": [...]}'
```

**Hard rule — GET fresh, merge your delta, then PUT. Every time.**

While the server is running, the user can edit `project.json` from the UI at any moment — repositioning overlays via drag, retiming items, editing text, toggling assets. **Montaj only auto-commits to git on status transitions (`pending`→`draft`, `draft`→`final`)**; mid-status UI edits are written to the working tree but never committed. A stale PUT from the agent silently overwrites those edits with no warning, no SSE distinction, and no recovery path beyond Time Machine.

Pattern — always GET, merge in your delta, then PUT:

```bash
# 1. Fetch fresh state
curr=$(curl -s http://localhost:3000/api/projects/{id})

# 2. Apply your delta (here: append a new overlay item to tracks[1])
new=$(echo "$curr" | jq --argjson item '{"id":"ov-new","type":"overlay","src":"...","start":12,"end":14}' \
  '.tracks[1] += [$item]')

# 3. PUT the merged result
curl -s -X PUT http://localhost:3000/api/projects/{id} \
  -H "Content-Type: application/json" -d "$new"
```

Notes:
- Montaj's PUT does a **shallow top-level merge** — top-level fields you omit from the body are preserved (useful for narrow updates like `{id, status}`). The shallow merge does NOT help when you update a field the user also edited (e.g. `tracks`) — it replaces the whole field. For any additive change to a nested array (adding an overlay, asset, or track item), always read-modify-write the whole top-level field.
- The rule applies to **every** PUT — status transitions, re-runs, overlay edits, asset toggles. No exceptions.
- If you do several updates in sequence (add overlay → log → update settings), re-GET between each one. The user may have edited in between.

### log — `POST /api/projects/:id/log`

```
POST /api/projects/{id}/log
{"message": "Transcribing clip 3 of 6…"}
```

Call before each step. Short and human-readable — what you're doing, not why. Appears live in the UI.

### write / read a file — `/api/files`

Files are real on-disk artifacts (overlay JSX, fetched images, assets). Because the server shares the machine's filesystem, you may either use `/api/files` or write/read the path directly on disk — both reach the same bytes. Step outputs already land on disk next to their inputs.

---

## CLI mode

Use CLI mode when `montaj serve` is NOT running.

### run step — `montaj <step> …`

```bash
montaj probe clip.mp4
montaj snapshot clip.mp4
montaj trim clip.mp4 --start 2.5 --end 8.3
montaj cut clip.mp4 --start 3.0 --end 7.5
montaj cut clip.mp4 --cuts '[[0,1.2],[5.3,7.8]]'   # multiple cuts, one ffmpeg pass
montaj cut clip.mp4 --cuts '[[3.0,7.5]]' --spec     # write trim spec instead of encoding
montaj materialize-cut clip.mp4 --inpoint 2.0 --outpoint 8.0
montaj materialize-cut spec.json
montaj waveform-trim clip.mp4 --threshold -30 --min-silence 0.3
montaj rm-nonspeech clip_spec.json --model base
montaj transcribe clip.mp4 --model base.en
montaj caption clip.mp4 --style word-by-word
montaj crop-spec --input spec.json --keep 8.5:14.8 --keep 40.0:end
montaj virtual-to-original --input spec.json 47.32
montaj normalize clip.mp4 --target youtube
montaj resize clip.mp4 --ratio 9:16
```

To see all available steps including project-local custom steps: `montaj step -h`.

Fire long-running CLI steps in the background (`run_in_background: true` on the Bash call) for the same reasons as HTTP mode.

### read / save the project — `project.json` on disk

The project lives at `project.json` in the project directory. **Read** it by reading the file; **save** by read-modify-writing the file — read the current contents, merge in only your changed fields, write it back. The GET-fresh-merge-save discipline from `_contract` still applies: re-read immediately before writing so you don't clobber a concurrent edit.

### write / read a file — filesystem

Write and read workspace files directly on disk at their absolute paths.

### log — stderr

Print progress messages to stderr.

---

## Image-step credentials

Steps that reach external image providers (`search_images`, `fetch_image`) read credentials from **`~/.montaj/credentials.json`**. This is native machine config: the keys live on the operator's machine, not in the project. If an image step fails with an auth/credentials error, check that `~/.montaj/credentials.json` exists and contains the provider key (e.g. `SERPAPI_API_KEY`). This applies in both HTTP and CLI mode — the step subprocess reads the same file either way.

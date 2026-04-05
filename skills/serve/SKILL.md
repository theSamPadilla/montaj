---
name: serve
description: "HTTP API reference for montaj serve — load this when serve is running (localhost:3000 responds). Load before making any API calls."
step: false
---

# Montaj Serve

## HTTP Loop

```
1. GET /api/projects?status=pending → pick first pending project; read id, clips, workflow, editingPrompt
2. Read workflow from workflows/{name}.json (filesystem only — not served via API)
3. Apply editorial judgment based on prompt
4. Before each step: POST /api/projects/{id}/log with a short status message
5. Execute workflow steps in dependency order (load skills/parallel/SKILL.md for multi-clip or foreach steps)
6. After each step: PUT /api/projects/{id} with updated state
7. Probe final output → set inPoint: 0, outPoint: <duration> on the clip
8. PUT /api/projects/{id} with status "draft" (triggers UI SSE refresh)
9. Human reviews in browser, may tweak → marks final
10. Render final MP4
```

## Running Steps

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

Response: `{"path": "..."}` for file outputs, JSON object for data outputs (probe, transcribe, etc.).

## Logging Status

```
POST /api/projects/{id}/log
{"message": "Transcribing clip 3 of 6…"}
```

Call before each step. Short and human-readable — what you're doing, not why. Appears live in the UI.

## Background Steps

Long steps (transcribe, rm_fillers, resize) must run in the background to stay available for conversation:

1. **Single long step** — `run_in_background: true` on the Bash tool call. You'll be notified on completion.
2. **Multiple clips in parallel** — write a shell script with `&` + `wait` to `/tmp`, execute with `run_in_background: true`.

Never block the conversation waiting on ffmpeg. Log the step, fire it in the background, then tell the user what's running.

## Project CRUD

```bash
# Get pending projects
curl -s "http://localhost:3000/api/projects?status=pending"

# Update project (body id must match URL id)
curl -s -X PUT http://localhost:3000/api/projects/{id} \
  -H "Content-Type: application/json" \
  -d '{"id": "{id}", "status": "draft", "tracks": [...]}'
```

## Endpoints

`montaj serve` runs on **port 3000** (override with `MONTAJ_SERVE_PORT`).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/projects` | GET | List projects (`?status=pending`) |
| `/api/projects/:id` | GET / PUT | Read or update a project |
| `/api/projects/:id/log` | POST | Append a status log message |
| `/api/steps` | GET | List available steps |
| `/api/steps/:name` | POST | Run a step |
| `/api/run` | POST | Create project + start edit (`clips`, `assets`, `prompt`) |

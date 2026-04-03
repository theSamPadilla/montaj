# Step Schema

> Defines the contract for montaj steps — both native and custom. Every step is an executable paired with a JSON schema file that declares its interface.

---

## What a step is

A step is two files:

```
steps/trim.py        # the executable
steps/trim.json      # the schema
```

The executable does the work. The schema declares what it does, what it accepts, and what it returns. The engine reads the schema to validate params, pipe outputs between steps, and render config controls in the UI. The agent reads it to understand what the step does and how to call it.

Any executable that follows the output convention can be a step — Python, bash, Node, binary. Language is irrelevant.

---

## Output convention

All steps follow a strict contract:

- **stdout** — the result: a local file path or a JSON object. Nothing else.
- **stderr** — errors only: `{"error": "code", "message": "detail"}`
- **exit 0** on success, **exit 1** on failure

```bash
# Success
montaj trim clip.mp4 --start 2.5 --end 8.3
# stdout: /tmp/workspace/trim-abc123.mp4

# Failure
# stderr: {"error": "file_not_found", "message": "File not found: clip.mp4"}
# exit 1
```

This makes steps composable at the shell level and predictable for the agent.

---

## Schema format

```json
{
  "name": "trim",
  "description": "Cut a clip by start/end timestamps or duration",
  "input": {
    "type": "video",
    "description": "Source video file"
  },
  "output": {
    "type": "video",
    "description": "Trimmed video file"
  },
  "params": [
    {
      "name": "start",
      "type": "float",
      "default": 0,
      "min": 0,
      "description": "Start time in seconds"
    },
    {
      "name": "end",
      "type": "float",
      "description": "End time in seconds. Omit to use duration instead."
    },
    {
      "name": "duration",
      "type": "float",
      "description": "Duration in seconds. Used only if end is omitted."
    }
  ]
}
```

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Must match the filename (e.g. `trim` for `trim.json`) |
| `description` | string | yes | One sentence. Agent reads this to understand what the step does. |
| `input` | object | yes | What the step accepts |
| `output` | object | yes | What the step returns |
| `params` | array | no | Configurable parameters. Empty array if none. |

### `input` / `output`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | See input/output types below |
| `description` | string | no | Human-readable detail |
| `multiple` | boolean | no | `true` if the step accepts or returns multiple files (e.g. `concat` takes multiple clips). Default: `false` |

**Input types:** `video`, `audio`, `srt`, `json`, `image`, `any`

**Output types:** `video`, `audio`, `srt`, `json`, `image`, `path[]`

Use `path[]` when a step returns a JSON array of file paths (e.g. `select_takes`).

### Params

Each param:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Param name. Becomes the CLI flag (`--name`) |
| `type` | string | yes | See param types below |
| `description` | string | yes | Agent reads this. Be precise. |
| `default` | any | no | Used if the param is omitted |
| `required` | boolean | no | Default: `false`. If `true`, step fails without it. |
| `min` | number | no | `float` and `int` types only |
| `max` | number | no | `float` and `int` types only |
| `options` | array | no | `enum` type only — list of valid string values |

**Param types:**

| Type | UI control | Notes |
|------|-----------|-------|
| `float` | Slider (if min/max set) or number input | |
| `int` | Slider (if min/max set) or number input | |
| `string` | Text input | |
| `bool` | Toggle | |
| `enum` | Select | Requires `options` |

---

## Example schemas

### `transcribe`

```json
{
  "name": "transcribe",
  "description": "Transcribe audio or video to SRT and word-level JSON using whisper.cpp",
  "input": {
    "type": "video",
    "description": "Video or audio file to transcribe"
  },
  "output": {
    "type": "json",
    "description": "JSON object with srt path and words path: {\"srt\": \"...\", \"words\": \"...\"}"
  },
  "params": [
    {
      "name": "model",
      "type": "enum",
      "default": "base.en",
      "options": ["tiny.en", "base.en", "medium.en", "large"],
      "description": "Whisper model. Larger = slower + more accurate."
    }
  ]
}
```

### `rm_fillers`

```json
{
  "name": "rm_fillers",
  "description": "Remove filler words (um, uh, hmm) and surrounding silence from a clip",
  "input": {
    "type": "video",
    "description": "Source video clip"
  },
  "output": {
    "type": "video",
    "description": "Cleaned clip with fillers removed"
  },
  "params": [
    {
      "name": "sensitivity",
      "type": "float",
      "default": 0.5,
      "min": 0.0,
      "max": 1.0,
      "description": "How aggressively to remove fillers. Higher = more removed."
    }
  ]
}
```

### `normalize`

```json
{
  "name": "normalize",
  "description": "Target a specific loudness level (LUFS) via ffmpeg loudnorm",
  "input": {
    "type": "video",
    "description": "Video or audio file to normalize"
  },
  "output": {
    "type": "video",
    "description": "Loudness-normalized file"
  },
  "params": [
    {
      "name": "target",
      "type": "enum",
      "default": "youtube",
      "options": ["youtube", "podcast", "broadcast", "custom"],
      "description": "Platform preset. youtube = -14 LUFS, podcast = -16 LUFS, broadcast = -23 LUFS."
    },
    {
      "name": "lufs",
      "type": "float",
      "default": -14,
      "min": -40,
      "max": 0,
      "description": "Target LUFS. Used only when target is 'custom'."
    }
  ]
}
```

---

## Three scopes

Steps are discovered automatically. Resolution order: project-local → user-global → built-in.

| Scope | Location | Prefix in workflow |
|-------|----------|-------------------|
| Project-local | `./steps/<name>.py` + `./steps/<name>.json` | `./steps/<name>` |
| User-global | `~/.montaj/steps/<name>.py` + `.json` | `user/<name>` |
| Built-in | `steps/<name>.py` + `.json` | `montaj/<name>` |

If the same name exists at multiple scopes, the most local wins.

---

## Adding a custom step

1. Create the executable — any language, follows the output convention
2. Create the `.json` schema — same filename, same directory
3. Done. Available immediately via `montaj <name>` and visible in the UI node graph.

No registration. No config changes. Discovered automatically.

```bash
montaj step validate my-step   # validate the schema against this spec
montaj step list               # confirm it appears
```

# Adaptor Schema

> Adaptors are montaj's harness for external AI APIs. Each adaptor wraps one API, manages credentials, and provides an optimized prompt template for what montaj needs from that service.

---

## What an adaptor is

A thin wrapper around an external AI API that:
1. Resolves credentials from `~/.montaj/credentials.json` or env vars
2. Applies an optimized prompt template for montaj's specific use cases
3. Calls the API
4. Returns a local file path — same output convention as every other montaj step

The agent calls an adaptor like any other tool. It passes a plain description. The adaptor handles prompting, authentication, and returning a usable file.

---

## Adaptors are an agent choice, not a step

Steps are deterministic operations — trim, transcribe, resize. They take input, return output. No judgment required.

Adaptors are options the agent selects from when it decides something needs to be *generated*. The agent reads the prompt, assesses what's needed, and decides how to produce it:

- "I need a lower third — it's simple, I'll write JSX directly"
- "I need a complex animated overlay — I'll call `montaj adaptor stitch`"
- "The prompt says add B-roll — I'll call `montaj adaptor veo`"
- "The prompt says add background music — I'll call `montaj adaptor suno`"
- "I need a voiceover — I'll call `montaj adaptor elevenlabs`"

The adaptor call is a CLI tool in the agent's toolkit, not a prescribed stage in the pipeline. The agent calls it the same way it calls `montaj trim` or `montaj transcribe` — when it decides it's the right tool for the job.

A workflow file can hint at adaptor use:

```json
{ "id": "broll", "uses": "montaj/adaptor", "params": { "adaptor": "veo" } }
```

But this is a suggestion, not a mandate. The agent can skip it if existing clips are sufficient, swap adaptors, or call multiple adaptors for different elements — its call entirely.

---

## Credentials

Resolved in order:
1. Environment variable: `MONTAJ_<ADAPTOR>_API_KEY` (e.g. `MONTAJ_STITCH_API_KEY`)
2. `~/.montaj/credentials.json`

```json
{
  "stitch": "sk-...",
  "elevenlabs": "sk-...",
  "veo": "sk-...",
  "runway": "sk-...",
  "suno": "sk-...",
  "openai-whisper": "sk-..."
}
```

`~/.montaj/credentials.json` is never committed. montaj will error clearly if a required credential is missing.

---

## CLI

```bash
montaj adaptor <name> "<description>" [--out <path>] [--json]

# Examples
montaj adaptor stitch "dark glass lower third, white @handle text, slide in from left"
# → ./workspace/overlays/stitch-abc123.jsx

montaj adaptor veo "drone shot over city at sunset, 5 seconds, cinematic"
# → ./workspace/clips/veo-abc123.mp4

montaj adaptor elevenlabs "you won't believe what happened next" --voice calm-male
# → ./workspace/audio/elevenlabs-abc123.mp3

montaj adaptor suno "upbeat electronic, no vocals, 30 seconds"
# → ./workspace/audio/suno-abc123.mp3
```

Output follows the standard convention: stdout = file path, stderr = JSON error, exit 0/1.

---

## Adaptor file structure

```
adaptors/<name>/
  adaptor.js      # API call + credential resolution + file write
  prompt.md       # optimized prompt template for montaj's use cases
  schema.json     # inputs, outputs, required credentials, options
```

### `schema.json`

```json
{
  "name": "stitch",
  "description": "Generate HTML/CSS overlay components via Google Stitch",
  "credential": "MONTAJ_STITCH_API_KEY",
  "input": {
    "description": { "type": "string", "required": true },
    "device": { "type": "string", "default": "mobile", "options": ["mobile", "desktop"] }
  },
  "output": {
    "type": "file",
    "format": "jsx",
    "description": "React overlay component ready for the render engine"
  }
}
```

### `prompt.md`

Documents how to describe things to this adaptor effectively. The agent reads this when deciding what to pass. The adaptor itself uses the template when constructing the actual API call.

Example for `stitch/prompt.md`:
```
Generate a video overlay component for a short-form vertical video (1080x1920).
The component will be composited over footage — use transparent background.
Keep text large and readable at mobile size.
Use the following description: {description}
Return HTML and CSS only. No JavaScript.
```

---

## Bundled adaptors

| Adaptor | API | Returns | Primary use |
|---------|-----|---------|-------------|
| `stitch` | Google Stitch SDK | `.jsx` overlay component | UI overlays, lower thirds, title cards |
| `veo` | Google Veo API | `.mp4` video clip | AI-generated B-roll |
| `elevenlabs` | ElevenLabs API | `.mp3` audio | Voiceover generation |
| `runway` | Runway API | `.mp4` video clip | AI-generated B-roll |
| `suno` | Suno API | `.mp3` audio | Background music generation |
| `openai-whisper` | OpenAI Whisper API | `.json` + `.srt` transcript | Transcription (alt to local whisper.cpp) |

---

## Three paths for any capability

The agent always has three options. Adaptors are the third path — optimized, credentialed, one call.

```
Need an overlay?
  1. Write JSX directly
  2. Delegate to a sub-agent (see skills/write-overlay/SKILL.md)
  3. montaj adaptor stitch "description" → file path

Need B-roll?
  1. Use a clip already in the project
  2. montaj adaptor veo "description" → clip path

Need music?
  1. Use a local audio file
  2. montaj adaptor suno "description" → audio path

Need a voiceover?
  1. montaj adaptor elevenlabs "script text" → audio path
```

---

## Adding a new adaptor

1. Create `adaptors/<name>/schema.json` — declare inputs, output format, credential key
2. Create `adaptors/<name>/adaptor.js` — resolve credential, call API, write output file, print path to stdout
3. Create `adaptors/<name>/prompt.md` — document the optimized prompt template
4. Done. Available immediately via `montaj adaptor <name>`.

No registration required. Discovered automatically on startup.

# Connectors

Connectors are Python modules in `connectors/` that wrap external vendor APIs. They turn a vendor's SDK or HTTP endpoints into a clean Python function that a Montaj step can call.

## The layering rule

**Connectors are organized by vendor. Steps are organized by use case.**

| Layer | Organized by | File name pattern | Example |
|-------|--------------|-------------------|---------|
| `connectors/<vendor>.py` | **Vendor** — one file per API key / SDK | Vendor brand | `connectors/gemini.py` exposes `analyze_video`, and could later expose `chat`, `generate_image` — all share one client, one credential |
| `steps/<verb>_<noun>.py` | **Use case** — one file per agent-callable action | What the agent wants to do | `steps/analyze_video.py` → `gemini.analyze_video`, `steps/generate_image.py` → `openai.generate_image` |
| `cli/commands/<name>.py` | Use case (mirrors the step) | Same as step | `cli/commands/analyze_video.py` |

### Why generalist connectors, specific steps?

A vendor like Gemini unlocks multiple use cases (video analysis, text generation, image generation) through **one API key and one SDK**. Splitting that into `connectors/gemini_video.py`, `connectors/gemini_text.py`, `connectors/gemini_image.py` would triplicate the client construction, credential lookup, lazy-import machinery, and error translation for zero benefit.

The specificity the agent needs lives in the step layer. `steps/analyze_video.py` and its CLI wrapper `montaj analyze-video` have unambiguous names. The fact that Gemini happens to power them is an implementation detail — tomorrow it could be a different vendor, and the step name wouldn't change.

### Corollary: connectors are never agent-callable directly

Workflows reference steps (`"uses": "montaj/analyze_video"`), never connector functions. The CLI, HTTP API, and MCP all dispatch to `steps/`. The connector layer is an internal library — it has no presence in any of Montaj's three agent interfaces. **Every connector function that needs to be agent-callable must have a step wrapping it.**

## What a connector is (and isn't)

A connector:
- Lives in a single file under `connectors/<vendor>.py`.
- Owns auth, request shape, polling, retry, response parsing for one vendor.
- Exposes functions (not classes, unless state is needed) with plain Python types.
- Reads credentials via `lib.credentials.get_credential(provider, key)`.
- Raises `ConnectorError` (from `connectors/__init__.py`) on user-facing errors. **Never calls `fail()` or `sys.exit`** — that's the step layer's job.
- Can expose multiple functions serving different use cases. One vendor = one file, even as the surface grows.

A connector is NOT:
- A CLI — that's `cli/commands/<step>.py`.
- A step — that's `steps/<step>.py` (which imports from the connector).
- An HTTP/MCP surface — those layers auto-dispatch to steps, not connectors.
- A place for workflow logic.
- Agent-facing. If an agent needs to call it, wrap it in a step.

## Architecture

    cli/commands/<step>.py     # thin argparse wrapper (agent-facing)
    serve/server.py            # generic /api/steps/{name} dispatch (agent-facing)
    mcp/server.js              # introspects CLI parsers (agent-facing)
              │
              ▼
    steps/<verb>_<noun>.py     # argparse + fail() + stdout=result (one per use case)
              │
              ▼
    connectors/<vendor>.py     # SDK/HTTP calls (one per vendor, many use cases)
              │
              ▼
    lib/credentials.py         # ~/.montaj/credentials.json + env override
    lib/common.py              # fail(), require_file(), run()

## Installing

```bash
montaj install connectors        # installs pyjwt, requests, google-genai, openai (extras)
montaj install credentials       # interactive: pick provider, hidden key input
```

Credentials live in `~/.montaj/credentials.json` (0600). See `docs/ARCHITECTURE.md`
for precedence rules.

## Current connectors

| Vendor (`connectors/*.py`) | Functions (use cases) | Wrapping steps | Model(s) | Credentials | Docs |
|----------------------------|------------------------|----------------|----------|-------------|------|
| `kling.py` | `generate` | `steps/kling_generate.py` | `kling-v3-omni` (hardcoded) | `kling.access_key`, `kling.secret_key` | https://app.klingai.com/global/dev/document-api |
| `gemini.py` | `analyze_video`, `generate_image` | `steps/analyze_video.py`, `steps/generate_image.py` | video: `gemini-2.5-flash`; image: `gemini-3-pro-image-preview` | `gemini.api_key` | https://ai.google.dev/gemini-api/docs |
| `openai.py` | `generate_image` | `steps/generate_image.py` | `gpt-image-1` | `openai.api_key` | https://platform.openai.com/docs/guides/images |

A single vendor row can grow multiple `Functions` and multiple `Wrapping steps` over time — e.g. a future `gemini.chat` function would add a second entry to the Gemini row alongside a new `steps/llm_prompt.py`. New vendors get a new row.

### Canonical example: `generate_image`

`steps/generate_image.py` is a single step that dispatches to either `connectors/gemini.py` or `connectors/openai.py` based on a `--provider` flag. This is the layering rule in practice:

- **The use case** — generating an image — has one agent-callable surface, one name, one set of flags.
- **The vendors** — Gemini and OpenAI — live in separate connector files. Each owns its own auth, SDK, and response shape.
- **The step knows about both** only enough to dispatch. The step file is ~60 lines.

If a third vendor (e.g. Flux via fal.ai) is added later, the change is: new `connectors/fal.py`, extend the `--provider` enum in the step and CLI, update the `docs/CONNECTORS.md` table. No new step. No new CLI command. No MCP tool shuffle.

## Adding a new connector (or a new function to an existing connector)

### When to create a new connector file
Only when the vendor is **new**. If you're adding a second use case for a vendor that already has a `connectors/<vendor>.py`, add a function to that file — don't create `connectors/<vendor>_<usecase>.py`.

### When to create a new step
Every new user-facing use case gets its own step, even if it reuses an existing connector. One step = one agent-callable action with a clear verb_noun name.

### Flow

1. **Read the vendor's official docs.** Do not copy shape from other repos on the same machine — docs are the source of truth.
2. **New vendor:**
   - Pick a provider name. Lowercase, matches the credentials key convention (`--provider <name>`).
   - Create `connectors/<vendor>.py` with module-level constants, private helpers prefixed with `_`, and one or more top-level entry points.
   - All credential lookups via `get_credential("<vendor>", "<key>")`.
   - Lazy-import the SDK inside functions, not at module top.
   - Translate `requests`/SDK exceptions to `ConnectorError`. Do not call `fail()`.
   - Add the provider to `KNOWN_PROVIDERS` in `lib/credentials.py` (single source of truth — `cli/commands/install.py` imports this map to know which keys to prompt for).
3. **Existing vendor, new use case:**
   - Add a new top-level function to the existing `connectors/<vendor>.py`. Keep private helpers shared.
   - No changes to `KNOWN_PROVIDERS` unless the new use case needs an additional credential key.
4. **Add a step script** in `steps/<verb>_<noun>.py` + `.json` — argparse + fail() + stdout=result. The step name describes the use case, not the vendor (`analyze_video`, not `gemini_analyze`).
5. **Add a CLI command** in `cli/commands/<verb>_<noun>.py` — subprocesses the step script. This makes it available via CLI, HTTP (`POST /api/steps/<name>`), and MCP automatically.
6. **Add unit tests** for any pure functions (payload builders, normalizers). Mock the SDK for branching logic tests.
7. **Update this doc's "Current connectors" table** to list the new function under the existing vendor row, or add a new row if this is a new vendor.

## Contract rules

- **No vendor SDK at import time.** Import inside functions so the extras are only required when the connector is actually used.
- **Credentials only from `lib.credentials`.** Never read env vars directly.
- **Errors via `ConnectorError`.** Library code raises; step code catches and translates to `fail()`. This is an inviolable boundary — `sys.exit` from a connector breaks testing, composition, and any future workflow that wants to retry/fallback.
- **Flag naming:** if your step asks a model/API for structured JSON, the flag is `--json-output` at both the step and CLI layers. Never `--json` — that's reserved globally for CLI output envelope. See `docs/ARCHITECTURE.md` → "CLI flag conventions".
- **Never redefine globally-provided flags.** `add_global_flags(p)` (in `cli/main.py`) provides `--json`, `--out`, and `--quiet` on every command. Defining these on your per-command parser raises argparse conflict errors at registration. If your step requires `--out`, validate it at runtime in `handle()` via `emit_error`, not with `required=True` at registration.
- **Long operations block.** Connectors return when done; they don't return job IDs for the step to poll. The connector owns the polling loop.
- **Files are paths, not bytes.** Connector functions take local file paths and return local file paths. Upload/download is the connector's job.

## Non-goals (today)

- No retry with exponential backoff beyond what the vendor's polling loop naturally does.
- No shared HTTP client / connection pooling across connectors.
- No streaming outputs — all connector calls are request/response or request/poll/download.

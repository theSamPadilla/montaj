> **Canonical docs:** https://docs.montaj.ag/connectors — this file is a local quick-reference. Update the docs site in `../landing-montaj/docs/content/docs/connectors.mdx` for any user-facing changes.

# Connectors

Connectors are Python modules in `connectors/` that wrap external vendor APIs. They turn a vendor's SDK or HTTP endpoints into a clean Python function that a Montaj step can call.

## The layering rule

**Connectors are organized by vendor. Steps are organized by use case.**

| Layer | Organized by | File name pattern | Example |
|-------|--------------|-------------------|---------|
| `connectors/<vendor>.py` | **Vendor** — one file per API key / SDK | Vendor brand | `connectors/gemini.py` exposes `analyze_media`, `generate_image` (and could later add `chat`, etc.) — all share one client, one credential |
| `steps/<verb>_<noun>.py` | **Use case** — one file per agent-callable action | What the agent wants to do | `steps/analyze_media.py` → `gemini.analyze_media`, `steps/generate_image.py` → `openai.generate_image` |
| `cli/commands/<name>.py` | Use case (mirrors the step) | Same as step | `cli/commands/analyze_media.py` |

### Why generalist connectors, specific steps?

A vendor like Gemini unlocks multiple use cases (video analysis, text generation, image generation) through **one API key and one SDK**. Splitting that into `connectors/gemini_video.py`, `connectors/gemini_text.py`, `connectors/gemini_image.py` would triplicate the client construction, credential lookup, lazy-import machinery, and error translation for zero benefit.

The specificity the agent needs lives in the step layer. `steps/analyze_media.py` and its CLI wrapper `montaj analyze-media` have unambiguous names. The fact that Gemini happens to power them is an implementation detail — tomorrow it could be a different vendor, and the step name wouldn't change.

### Corollary: connectors are never agent-callable directly

Workflows reference steps (`"uses": "montaj/analyze_media"`), never connector functions. The CLI and the HTTP API dispatch to `steps/`. The connector layer is an internal library with no presence in any of Montaj's agent interfaces. **Every connector function that needs to be agent-callable must have a step wrapping it.**

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
- An HTTP surface: that layer dispatches to steps, not connectors.
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
montaj credentials               # interactive: pick provider, hidden key input
```

Credentials live in `~/.montaj/credentials.json` (0600). See `docs/ARCHITECTURE.md`
for precedence rules.

## Current connectors

| Vendor (`connectors/*.py`) | Functions (use cases) | Wrapping steps | Model(s) | Credentials | Docs |
|----------------------------|------------------------|----------------|----------|-------------|------|
| `kling.py` | `generate`, `generate_speech`, `check_key` (PV29) | `steps/generate/kling_generate.py`, `steps/generate/generate_voiceover.py` (via `--vendor kling`) | video: `kling-v3-omni` (hardcoded); TTS: `kling-tts-v1` (default, `DEFAULT_TTS_MODEL` in `connectors/kling.py`) | `kling.access_key`, `kling.secret_key` | https://app.klingai.com/global/dev/document-api |
| `gemini.py` | `analyze_media`, `generate_image`, `generate_speech`, `generate_music`, `check_key` (PV29) | `steps/media/analyze_media.py`, `steps/generate/generate_image.py`, `steps/generate/generate_voiceover.py` (via `--vendor gemini`), `steps/generate/generate_music.py` | media analysis: `gemini-3.8-flash` (default, `DEFAULT_MODEL` — `gemini-2.5-flash` 404s for new API keys as of 2026-09-26; images under ~18 MB take a fast inline path, no Files API round-trip); image gen: `gemini-3-pro-image` (default `DEFAULT_IMAGE_MODEL` since PV29 T4b/2026-09-28, GA replacement for `gemini-3-pro-image-preview`); TTS: `gemini-3.8-flash-tts` (default `DEFAULT_TTS_MODEL` since PV29 T4b/2026-09-28, GA replacement for `gemini-2.5-flash-preview-tts`; default voice `Kore` via `DEFAULT_TTS_VOICE`, verified live 2026-09-28); music: `lyria-3.5` (default `DEFAULT_MUSIC_MODEL` since PV29 T4b/2026-09-28, GA replacement for `lyria-3-clip-preview`; request/response shape verified live 2026-09-28) | `gemini.api_key` | https://ai.google.dev/gemini-api/docs |
| `openai.py` | `generate_image`, `check_key` (PV29) | `steps/generate_image.py` | `gpt-image-2.5-sunburst` (default `DEFAULT_IMAGE_MODEL` since PV29 T4b/2026-09-28, taken from vendor docs, not a live call — the stored key 401s; old default `gpt-image-1`, not deprecated, kept as fallback) | `openai.api_key` | https://platform.openai.com/docs/guides/images |
| `fal.py` | `generate_video`, `check_key` (PV29) | `steps/generate/seedance_generate.py` | Seedance video: `seedance-2.5` (default `DEFAULT_MODEL`; `seedance-2.0` also available via `--model`). `RETIRED_MODELS` maps fal's deprecated `fal-ai/bytedance/seedance/v1/lite/{text,image,reference}-to-video` endpoints to `seedance-2.5`. `seedance-2.5` takes duration `4`-`30`s or `"auto"`; image-to-video's aspect ratio always follows the first frame. | `fal.api_key` | https://fal.ai/dashboard/keys |
| `elevenlabs.py` | `generate_speech`, `generate_sfx`, `generate_music`, `check_key` (PV29) | `steps/generate/generate_voiceover.py` (via `--vendor elevenlabs`), `steps/generate/generate_sfx.py`, `steps/generate/generate_music.py` (via `--vendor elevenlabs`) | TTS: `eleven_v4` (default `DEFAULT_TTS_MODEL`; `eleven_multilingual_v2` is the documented fallback for a line that needs no prompt-tag direction); SFX: `eleven_text_to_sound_v2` (`DEFAULT_SFX_MODEL`); music: no default model (`DEFAULT_MUSIC_MODEL = None`, since the verified `/v1/music` call sent no `model_id`; one is added to the request only when a caller passes `--model`). Music needs a paid ElevenLabs plan; the free tier's `POST /v1/music` 402s as `insufficient_credit`. | `elevenlabs.api_key` | https://elevenlabs.io/app/settings/api-keys |

Kling TTS calls are async/poll — same pattern as video generation. `generate_speech` returns a local audio file path.

lyria-3.5 returns a ~68 s track. For longer music beds, callers tile `AudioTrack` entries across the total duration (see Phase F director skill). Lyria 3 Pro (3-minute clips) is not yet wrapped.

Gemini prebuilt voices for TTS include `Kore` (neutral default), `Puck` (bright), `Charon` (deep). See https://ai.google.dev/gemini-api/docs/speech-generation for the full list.

> **Note on `generate_voiceover`.** The step dispatches between Kling TTS (primary), Gemini TTS (fallback/alternative) and ElevenLabs TTS via a `--vendor` flag (PV29). All three connectors listed in the table above contribute to it. This mirrors the existing dual-vendor pattern for `generate_image` (Gemini + OpenAI). See [`steps/generate/generate_voiceover.json`](../steps/generate/generate_voiceover.json) for the full flag surface.
>
> **`generate_music`** dispatches the same way between Gemini (Lyria, default) and ElevenLabs (`--vendor elevenlabs --duration <seconds>`, minimum 3s; needs a paid ElevenLabs plan). **`generate_sfx`** (PV29) is ElevenLabs-only, with no `--vendor` flag, since no second vendor exists yet for sound effects.

A single vendor row can grow multiple `Functions` and multiple `Wrapping steps` over time — e.g. a future `gemini.chat` function would add a second entry to the Gemini row alongside a new `steps/llm_prompt.py`. New vendors get a new row.

### Canonical example: `generate_image`

`steps/generate_image.py` is a single step that dispatches to either `connectors/gemini.py` or `connectors/openai.py` based on a `--provider` flag. This is the layering rule in practice:

- **The use case** — generating an image — has one agent-callable surface, one name, one set of flags.
- **The vendors** — Gemini and OpenAI — live in separate connector files. Each owns its own auth, SDK, and response shape.
- **The step knows about both** only enough to dispatch. The step file is ~60 lines.

If a third vendor (e.g. Flux via fal.ai) is added later, the change is: new `connectors/fal.py`, extend the `--provider` enum in the step and CLI, update the `docs/CONNECTORS.md` table. No new step. No new CLI command. No MCP tool shuffle.

### Audio pipeline

Audio in Montaj is produced and composed in two separate layers, and the boundary matters:

**Generation** — connectors and steps produce source audio files on disk.
- `connectors/kling.py::generate_speech`, `connectors/gemini.py::generate_speech` and `connectors/elevenlabs.py::generate_speech` produce voiceover audio.
- `connectors/gemini.py::generate_music` produces music clips via Lyria 3; `connectors/elevenlabs.py::generate_music` is the paid-plan alternative.
- `connectors/elevenlabs.py::generate_sfx` produces sound effects (PV29); no Gemini/Kling equivalent exists.
- `steps/generate/generate_voiceover.py`, `steps/generate/generate_music.py` and `steps/generate/generate_sfx.py` wrap the connectors with CLI surfaces, dispatching to vendors via `--vendor` flags where applicable.

**Composition** — `render/mix-audio.js` combines independent `AudioTrack` entries at render time via a single ffmpeg `amix` invocation, applying per-track delay, volume, trimming, and optional sidechain ducking.

**The rule: connectors and steps never invoke ffmpeg for composition.** They only generate source assets and report duration metadata. Skills and workflows (e.g. [`skills/ai-video-generate/SKILL.md`](../skills/ai-video-generate/SKILL.md) Phase 6) append `AudioTrack` entries referencing those files to `project.audio.tracks[]`; everything else flows from there to `render/mix-audio.js` at render time.

See [`skills/ai-video-plan/SKILL.md`](../skills/ai-video-plan/SKILL.md) for the director-level integration (dialogue-omission rule when voiceover is set, script-vs-brief heuristic) and [`skills/ai-video-generate/SKILL.md`](../skills/ai-video-generate/SKILL.md) for Phase 6 audio generation (Kling→Gemini TTS fallback, music looping via `AudioTrack` replication).

### Error reasons and `check_key()` (PV29)

A connector error that a step or the app needs to *branch* on, not just display, carries a **shared reason**: a fixed vocabulary defined once in `connectors/__init__.py`, set on `ConnectorError(message, reason=...)`:

| Reason | Means |
|---|---|
| `invalid_api_key` | the key was rejected |
| `model_retired` | the connector's default (or requested) model is gone |
| `insufficient_credit` | the account has no balance, quota or plan for the call |
| `unreachable` | the vendor could not be reached (network, timeout) |
| `None` | a generic error, with no distinct reason to branch on |

`classify_http_error(status, message)` maps an HTTP status and the vendor's own error text to one of these (or `None`), off fixed word lists (`_KEY_WORDS`, `_RETIRED_WORDS`, `_CREDIT_WORDS`). The lists are deliberately narrow: a false `None` only costs a less specific message, but a false `invalid_api_key` tells the user their good key is bad. Every connector runs its HTTP failures through it.

Some vendors bury the real meaning of a response somewhere `classify_http_error` can't see from status and message alone, so their connector **overrides it from the vendor's own body**:
- **Kling** carries a numeric `code` in the JSON body. `1101`/`1102` (arrears / empty balance) is always `insufficient_credit`, even though the HTTP status is `429`. `1201` "model is not supported" is `model_retired`. Only the rate-limit codes `1302`/`1303` are retried; every other `429`, including one whose body doesn't parse, is raised immediately.
- **ElevenLabs** carries the real reason in `detail.status` on a `401`: `quota_exceeded` is `insufficient_credit` (never a bad key); `missing_permissions` / `detected_unusual_activity` mean the key authenticated fine and only this call lacked a scope, so `reason=None`; only `invalid_api_key`, or any status the connector doesn't recognise, is treated as a bad key. A `402` with `detail.code == "paid_plan_required"` (seen on `/v1/music` for a free-tier account) is always `insufficient_credit` with a fixed message, whichever endpoint sent it.

**Billing errors are never retried, and only a positively identified rate limit is.** Anything that classifies as `insufficient_credit` is raised at once; waiting doesn't fix an empty balance. The reverse mistake, silently retrying a billing error as if it were a rate limit so the caller just watches it hang, is the worse one to make, so every connector's retry check starts from a *positive* rate-limit signal (Kling's `1302`/`1303` codes, ElevenLabs' `too_many_concurrent_requests`/`system_busy` statuses) rather than "retry anything that isn't obviously billing."

**`check_key()`**: every connector exposes `check_key() -> dict`, one **free** vendor call (never a billed generation), used by the `check_key` step (`steps/credentials/check_key.py`) and the app's save-then-check flow. The base contract:

```python
{
    "ok": True,
    "default_model": <str>,      # or the id of the first missing capability's model
    "default_model_ok": <bool>,  # is default_model available to this key?
    "detail": <str>,             # human-readable; never a raw key value
}
```

Optional fields, added only where a connector needs them:
- `default_model_verified: False`: the vendor gives no way to check the default live. Kling has no model-list endpoint, so it's always `False`; ElevenLabs sets it when a restricted key's scopes block `GET /v1/models`. Absent means `default_model_ok` was actually verified against a live model list.
- `music: <bool | None>`: ElevenLabs only, whether the account's plan includes music (`None` when a restricted key can't read the plan).
- per-capability flags: Gemini only, since one key backs four defaults: `image_model_ok`, `tts_model_ok`, `music_model_ok` alongside the text default's `default_model_ok`.

On failure, `check_key()` raises `ConnectorError` with a reason from the table above, same as every other connector call; there's no separate error shape for key checks.

**Every connector sets `DEFAULT_MODEL`** (or one `DEFAULT_<CAPABILITY>_MODEL` per capability; Gemini has four). Where the vendor has no live model list to check it against, the connector keeps `RETIRED_MODELS: dict[str, str]`, a retired model or endpoint ID mapped to its replacement (`kling.py`; empty when nothing's retired yet), and both `check_key()` and the generation call check membership in it before doing anything else. Where the vendor does expose a model list (Gemini, OpenAI, ElevenLabs), `check_key()` checks `DEFAULT_MODEL` against that list directly and no `RETIRED_MODELS` dict is needed. `fal.py` keeps both: its model list confirms whether the current default is still active, and `RETIRED_MODELS` separately maps specific deprecated endpoint IDs to their replacement, for a caller who passes an old one directly via `--model`.

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
4. **Add a step script** in `steps/<verb>_<noun>.py` + `.json` — argparse + fail() + stdout=result. The step name describes the use case, not the vendor (`analyze_media`, not `gemini_analyze`).
5. **Add a CLI command** in `cli/commands/<verb>_<noun>.py`, which subprocesses the step script. This makes it available via the CLI and HTTP (`POST /api/steps/<name>`).
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

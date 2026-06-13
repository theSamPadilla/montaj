---
name: image-search
description: "Find and download real images from the web — people, logos, brand/event stills, B-roll — to add as overlay image cards or project assets. Load when the prompt asks to source or insert images (e.g. 'add a photo of X', 'find images of the IPO', 'pull a shot of the factory')."
---

# Image Search

Sourcing real imagery is a two-step pipeline: **`search_images`** finds candidate URLs, **`fetch_image`** downloads the one you pick to a local file. From there the image becomes an overlay image card (see `/overlay`) or a project asset.

Use this when the editing prompt asks for outside imagery — a person ("a photo of Elon Musk"), an event ("the IPO"), a logo, a brand still, or B-roll the footage doesn't contain. Never fabricate an image path or hotlink a remote URL into the project — always `fetch_image` to a real local file first (the preview player and render engine read local files).

## Step 1 — `search_images`

Returns candidate results, no download. **Input is params-only** (no file input).

| Param | Default | Notes |
|-------|---------|-------|
| `query` | — | Search string. Be specific: `"Elon Musk portrait 2025"` beats `"elon"`. |
| `provider` | `commons` | `commons` · `sportsdb` · `web` (see below) |
| `limit` | `10` | Max results, capped at 30 |

Output: `{ "results": [ { title, url, width, height, mime, license, artist, source, thumbnail? } ] }`
`url` is always an HTTPS original (so the downstream `fetch_image` accepts it).

### Providers

- **`commons`** (Wikimedia Commons, **keyless**) — license-clean, well-labeled. First choice for historical figures, landmarks, public-domain/CC imagery, and anything not time-sensitive.
- **`sportsdb`** (TheSportsDB, **keyless**) — team badges / escudos. Use for sports crests.
- **`web`** (open-web Google Images via **SerpApi**, **needs a key**) — broadest coverage. Use for current events, specific living people, brand/product shots, and anything Commons won't have. License is reported `"unknown"` — web results are **not** license-filtered; editorial use is the caller's judgment.

Pick the **narrowest provider that will have the subject.** Reach for `web` only when `commons` won't cover it (recent news, a specific private individual, a current product). 

### SerpApi credentials (`provider: web` only)

The `web` provider reads the key from the `SERPAPI_API_KEY` env var. You supply it; the step never reads a file itself, and the key must never be logged, echoed, or written into the project.

- **HTTP mode** — add a reserved `credentials` field to the step body. The serve layer pops it, injects `SERPAPI_API_KEY` into that one subprocess, and strips it from all logs/errors. Source the value from `~/.montaj/credentials.json` (`serpapi.api_key`).

  ```bash
  KEY=$(python3 -c "import json;print(json.load(open('$HOME/.montaj/credentials.json'))['serpapi']['api_key'])")
  curl -s -X POST http://localhost:3000/api/steps/search_images \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"SpaceX IPO New York Stock Exchange\",\"provider\":\"web\",\"limit\":6,
         \"credentials\":{\"serpapi\":{\"api_key\":\"$KEY\"}}}"
  ```

- **CLI mode** — export the env var yourself:

  ```bash
  SERPAPI_API_KEY=$(python3 -c "import json;print(json.load(open('$HOME/.montaj/credentials.json'))['serpapi']['api_key'])") \
    montaj step search_images --provider web --query "SpaceX IPO" --limit 6
  ```

If the key is missing the step fails with `missing_credentials` — tell the human to run `montaj credentials` (or `montaj install credentials --provider serpapi --key api_key`).

## Step 2 — `fetch_image`

Downloads one HTTPS URL to a local path. No credentials. Private/internal IPs are blocked; non-image and oversized responses are rejected.

| Param | Default | Notes |
|-------|---------|-------|
| `url` | — | HTTPS URL from a search result's `url` |
| `out` | — | Destination path. Use `<project>/assets/<name>.jpg` |
| `max-bytes` | 25 MiB | Size cap |

Output: `{ "path": "/abs/path/to/file.jpg" }`. Some hosts return `403` to non-browser fetches — if one fails, fetch the next candidate instead of fighting it.

## Picking the right image

Search returns more than you need. Before committing:

1. **Right subject** — read the `title` and dimensions. For a named person or specific event, confirm it's actually them/it, not a lookalike or a generic stock shot.
2. **High enough resolution** — prefer ≥1000px on the long edge for full-frame cards. Tiny thumbnails upscale badly on 4K output.
3. **Clean frame — verify visually.** After fetching, **look at the file** (read it as an image, or run `analyze_media` with a "is there burned-in text or a watermark?" prompt). **Reject** images with burned-in captions, news-chyron bars, watermarks, logos stamped across them, or collages. Plain, uncluttered shots composite far better behind text overlays. This matters most for `web` results, which are unfiltered.
4. **Fetch 1–2 backups** per subject when the first pick is uncertain — hosts 403, or the image turns out cluttered.

## Where the image goes

- **As an overlay image card** — the usual choice for a B-roll insert synced to a beat. Author/point a `photo_card`-style JSX overlay at it and pass the local path via `props`. See `/overlay` and `/write-overlay`.
- **As a project asset** — add to `project.assets[]` (`{ id, type: "image", src, name }`) so it's tracked and reusable.

Always use the **local fetched path** (absolute), never the remote URL.

## Worked example (HTTP)

```
1. POST /api/steps/search_images  {query:"Elon Musk portrait 2025", provider:"web", limit:6, credentials:{serpapi:{api_key:…}}}
2. Eyeball results → pick a clean ≥1500px original
3. POST /api/steps/fetch_image    {url:"https://…/elon.jpg", out:"<project>/assets/elon_musk.jpg"}
4. Read the downloaded file → confirm subject + no watermark/chyron
5. Add an image-card overlay (props.src = the fetched path) → see /overlay
```

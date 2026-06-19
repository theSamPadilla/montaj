---
name: image-search
description: "Find and download real images from the web — people, logos, brand/event stills, B-roll — to add as overlay image cards or project assets. Load when the prompt asks to source or insert images (e.g. 'add a photo of X', 'find images of the IPO', 'pull a shot of the factory')."
---

# Image Search

Sourcing real imagery is a two-step pipeline: **`search_images`** finds candidate URLs, **`fetch_image`** downloads the one you pick to a workspace path. From there the image becomes an overlay image card (load skill `overlay`) or a project asset.

Use this when the editing prompt asks for outside imagery — a person ("a photo of Elon Musk"), an event ("the IPO"), a logo, a brand still, or B-roll the footage doesn't contain. Never fabricate an image path or hotlink a remote URL into the project — always run step `fetch_image` to a real local file first (the preview player and render engine read local files).

## Step 1 — `search_images`

Run step `search_images` with the following args. Returns candidate results; no download is performed.

| Arg | Default | Notes |
|-----|---------|-------|
| `query` | — | Search string. Be specific: `"Elon Musk portrait 2025"` beats `"elon"`. |
| `provider` | `commons` | `commons` · `sportsdb` · `web` (see below) |
| `limit` | `10` | Max results, capped at 30 |

Output: `{ "results": [ { title, url, width, height, mime, license, artist, source, thumbnail? } ] }`
`url` is always an HTTPS original (so the downstream `fetch_image` step accepts it).

### Providers

- **`commons`** (Wikimedia Commons, **keyless**) — license-clean, well-labeled. First choice for historical figures, landmarks, public-domain/CC imagery, and anything not time-sensitive.
- **`sportsdb`** (TheSportsDB, **keyless**) — team badges / escudos. Use for sports crests.
- **`web`** (open-web Google Images via SerpApi, **needs a key**) — broadest coverage. Use for current events, specific living people, brand/product shots, and anything Commons won't have. License is reported `"unknown"` — web results are **not** license-filtered; editorial use is the caller's judgment.

Pick the **narrowest provider that will have the subject.** Reach for `web` only when `commons` won't cover it (recent news, a specific private individual, a current product).

If the key is missing the step fails — tell the human to set up their SerpApi key via the native interface.

## Step 2 — `fetch_image`

Run step `fetch_image` with the following args. Downloads one HTTPS URL to a workspace path. Private/internal IPs are blocked; non-image and oversized responses are rejected.

| Arg | Default | Notes |
|-----|---------|-------|
| `url` | — | HTTPS URL from a search result's `url` field |
| `out` | — | Destination path. Use `<project>/assets/<name>.jpg` |
| `max-bytes` | 25 MiB | Size cap |

Output: `{ "path": "/abs/path/to/file.jpg" }`. Some hosts return `403` to non-browser fetches — if one fails, run step `fetch_image` with the next candidate instead of fighting it.

## Picking the right image

Search returns more than you need. Before committing:

1. **Right subject** — read the `title` and dimensions. For a named person or specific event, confirm it's actually them/it, not a lookalike or a generic stock shot.
2. **High enough resolution** — prefer ≥1000px on the long edge for full-frame cards. Tiny thumbnails upscale badly on 4K output.
3. **Clean frame — verify visually.** After fetching, **look at the file** (read it as an image, or run step `analyze_media` with a "is there burned-in text or a watermark?" prompt). **Reject** images with burned-in captions, news-chyron bars, watermarks, logos stamped across them, or collages. Plain, uncluttered shots composite far better behind text overlays. This matters most for `web` results, which are unfiltered.
4. **Fetch 1–2 backups** per subject when the first pick is uncertain — hosts 403, or the image turns out cluttered.

## Where the image goes

- **As an overlay image card** — the usual choice for a B-roll insert synced to a beat. Author/point a `photo_card`-style JSX overlay at it and pass the local path via `props`. Load skill `overlay` and load skill `write-overlay`.
- **As a project asset** — add to `project.assets[]` (`{ id, type: "image", src, name }`) so it's tracked and reusable.

Always use the **local fetched path** (absolute), never the remote URL.

## Worked example

```
1. Run step `search_images` with {query:"Elon Musk portrait 2025", provider:"web", limit:6}
2. Eyeball results → pick a clean ≥1500px original
3. Run step `fetch_image` with {url:"https://…/elon.jpg", out:"<project>/assets/elon_musk.jpg"}
4. Read the downloaded file → confirm subject + no watermark/chyron
5. Add an image-card overlay (props.src = the fetched path) → load skill `overlay`
```

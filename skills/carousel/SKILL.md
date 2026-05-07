---
name: carousel
description: "Agent-authored workflow task: build slides for a carousel project — pick aspect-aware images via generate_image, position image and overlay elements on each slide, set base colors, and render to PNGs. Load this when you hit montaj/carousel in a workflow."
step: true
---

# Carousel Skill

Use this skill whenever you are working on a `carousel` workflow project in montaj.

---

## 1 — What a carousel is

A carousel is N still slides at one fixed aspect ratio, rendered to `slide_01.png` … `slide_NN.png` in `<project>/render/`. There is no time axis, no audio, no video export.

| Aspect | Constant | Resolution | Platform |
|--------|----------|------------|----------|
| `square` | `CAROUSEL_ASPECTS[0]` | 1080 × 1080 | Instagram square |
| `portrait` | `CAROUSEL_ASPECTS[1]` | 1080 × 1350 | Instagram portrait (dominant in 2026) |
| `vertical` | `CAROUSEL_ASPECTS[2]` | 1080 × 1920 | TikTok photo mode, Stories |

The aspect is **locked at project creation** — Instagram and TikTok enforce uniformity across all slides in a carousel. Read it from `project.carousel.aspect`; read pixel dimensions from `project.settings.resolution` (`[width, height]`). Never attempt to change the aspect after init.

Reference: `/Users/Sam/Work/ByCrux/dev/montaj/lib/types/carousel.py` — `CAROUSEL_ASPECTS`, `CAROUSEL_RESOLUTIONS`.

---

## 2 — Inputs you have

- `project.editingPrompt` — the user's natural-language instruction for the whole carousel (e.g. "5-slide skincare routine, clean aesthetic, soft pastels").
- `project.assets` — list of reference images the user attached at intake or in the editor: `[{ id, src, type, name }]`. `src` is an absolute path (the file lives inside the project workspace directory). Pass these as `--ref-image` to `generate_image` when style consistency matters, or use them directly as image-element `src` values on slides.

---

## 3 — Slide schema

```jsonc
// project.slides: Slide[]
{
  "id": "uuid",               // crypto.randomUUID() — never positional IDs
  "base_color": "#ffffff",    // background fill shown wherever no image covers
  "elements": [               // z-order: bottom → top
    // Image element
    {
      "id": "uuid",
      "type": "image",
      "src": "/abs/path/to/project/slide1_bg.png",   // absolute path; file lives in the project workspace
      "x": 0, "y": 0,                  // absolute pixels from top-left
      "w": 1080, "h": 1350,
      "rotation": 0                    // degrees
    },
    // Overlay element
    {
      "id": "uuid",
      "type": "overlay",
      "overlay": {
        "template": "<overlay-id>",    // path or name returned by GET /api/overlays
        "props": {
          // overlay-specific knobs (text, color, animation timing, etc.)
          // DO NOT set offsetX / offsetY / scale here — they are forced to
          // identity at render time. Slide-side x/y/w/h/rotation own position.
        }
      },
      "frame": 59,                     // static frame to render; default = overlay's
                                       // staticFrame export, or duration - 1
      "x": 140, "y": 200,
      "w": 800, "h": 300,
      "rotation": 0
    }
  ]
}
```

Key rules:
- Use `crypto.randomUUID()` for every `id` on slides and elements.
- Element ordering in `elements[]` is z-order, bottom → top. Put full-bleed images at index 0.
- A "background" image is just an image element sized to the slide at index 0. No special background type exists.
- Text and shapes are overlays, not dedicated element types.
- `frame` selects which frame of an overlay's animation gets statically rendered. Default: the overlay's declared `staticFrame`, or `duration - 1` (end of entrance animation) when `staticFrame` is absent.

Reference: `/Users/Sam/Work/ByCrux/dev/montaj/montaj_assets/render/templates/slide.jsx` — the React component that receives and renders this shape.

---

## 4 — Generating images

Use the existing `generate_image` step (`/Users/Sam/Work/ByCrux/dev/montaj/steps/generate/generate_image.json`). Always generate at the project's native resolution so the image fills the slide without scaling artifacts.

```bash
montaj generate-image \
  --prompt "soft pastel background, skincare product flat lay, minimalist" \
  --out <project_workspace>/assets/slide1_bg.png \
  --provider gemini \
  --aspect-ratio "4:5"       # match the project aspect: square → 1:1, portrait → 4:5, vertical → 9:16
```

CLI signature summary:

| Param | Required | Notes |
|-------|----------|-------|
| `--prompt` | yes | Describe the image |
| `--out` | yes | Absolute path, `.png` |
| `--provider` | no | `gemini` (default) or `openai` |
| `--ref-image` | no, repeatable | Reference images from `project.assets` for style consistency |
| `--aspect-ratio` | no | Gemini only. `1:1`, `4:5`, `9:16` — match the carousel aspect |
| `--model` | no | Override the connector's default model |

After generation, store the file under the project workspace (e.g. `<workspace>/assets/`) and set the element's `src` to the relative path from the workspace root (e.g. `"assets/slide1_bg.png"`).

---

## 5 — Overlays

Carousel overlays are **custom JSX written per project** — there is no built-in template library. Author each overlay you need (headline, subhead, callout, etc.) by following `skills/write-overlay/SKILL.md`. Save the JSX under the project workspace (e.g. `<workspace>/overlays/headline.jsx`) and reference it by absolute path in `overlay.template`.

Carousel-specific rules layered on top of `write-overlay`:

- **Position belongs to the slide, not the overlay.** Do not set `offsetX`, `offsetY`, or `scale` in `overlay.props` — the slide-side `x/y/w/h/rotation` always win, and the renderer forces those three fields to identity at render time (see `slide.jsx`).
- **Pick the static frame explicitly.** Carousels render a single still frame from the overlay's animation. If the JSX module exports `staticFrame`, use that value. Otherwise default to `duration - 1` (the settled pose after any entrance animation). Always store the resolved value explicitly in `project.json` — do not rely on defaults.

Reference: `/Users/Sam/Work/ByCrux/dev/montaj/docs/plans/2026-05-04-image-carousel.md` — Decisions section ("Overlay-coordinate precedence", "Static rendering of frame-driven overlays").

---

## 6 — Persisting slide edits

`PUT /api/projects/{id}` with the entire project body. The server writes `project.json` and SSE-broadcasts the updated state.

```bash
# Example via curl (agent-side calls go through api.saveProject in the UI,
# or direct HTTP from a script)
curl -s -X PUT http://localhost:<port>/api/projects/<id> \
  -H "Content-Type: application/json" \
  -d @project.json
```

Every save is a whole-project PUT. If streaming live drag/resize updates, debounce at ~100 ms trailing to avoid one PUT per pointer-move frame.

---

## 7 — Render

Set `project.status` to `"final"` via `PUT /api/projects/{id}` before running render — the render command requires it.

```bash
montaj render <project_workspace>/project.json
```

Output: `<project_workspace>/render/slide_01.png` … `slide_NN.png` plus a `manifest.json` describing the run.

The renderer (`render-carousel.js`) launches Puppeteer, bundles each slide's JSX via esbuild, screenshots at the project resolution, and writes PNGs. No ffmpeg, no audio, no video encoding. Pass `--out <dir>` to write PNGs elsewhere; pass `--clean` to delete only prior `slide_*.png` + `manifest.json` without touching any coexisting video renders.

Reference: `/Users/Sam/Work/ByCrux/dev/montaj/montaj_assets/render/render-carousel.js`.

---

## 8 — Status lifecycle

```
pending  →  (build slides)  →  final  →  render
```

New carousel projects start at `status: "pending"` — same as video projects. The pending status signals that this carousel is waiting on you (the agent) to do the initial build. Build and populate all slides, then:

1. `PUT /api/projects/{id}` with `status: "final"` (and the complete `slides` array).
2. `montaj render <project_workspace>/project.json`

The project is complete when `render/slide_01.png` … `slide_NN.png` exist.

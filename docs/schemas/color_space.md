# Color Space Taxonomy

> **Canonical, language-agnostic source of truth** for the project working color spaces. Both Python (`lib/types/colorspace.py`) and JS (`montaj_assets/render/color-space.js`) load this file at runtime — the JSON is the data, the language modules are loaders.

---

## File location

`montaj_assets/schemas/color_space.json` (the JSON is the data; this `*.md` documents it). The schema lives alongside the render bundle so `montaj install` copies it into `~/.cache/montaj/schemas/` next to `~/.cache/montaj/render/`.

---

## Top-level shape

```json
{
  "default": "sdr_bt709",
  "all": ["sdr_bt709", "hdr_hlg", "hdr_pq"],
  "specs": { "sdr_bt709": {...}, "hdr_hlg": {...}, "hdr_pq": {...} }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `default` | string | Fallback color space when nothing else applies (smart-detect with no clips, unknown source transfer values, validation fallback). Always points at a key that exists in `all` and `specs`. |
| `all` | string[] | Ordered list of supported color-space keys. Used by argparse `choices=...` and HTTP intake validation. |
| `specs` | object | Per-color-space record, keyed by the same string keys that appear in `all`. |

---

## Per-color-space spec fields

```json
{
  "key": "hdr_hlg",
  "transfer_values": ["arib-std-b67"],
  "pix_fmts": ["yuv420p10le"],
  "encoder": "libx265",
  "output_pix_fmt": "yuv420p10le",
  "encoder_params": {"preset": "fast", "crf": "22", "x265-params": "..."},
  "output_color_args": ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc"],
  "setparams": "setparams=colorspace=bt2020nc:color_trc=arib-std-b67:color_primaries=bt2020"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | The same key that appears in `all` and as the dict key under `specs`. Repeated for convenience so consumers handed a single spec object can self-identify. |
| `transfer_values` | string[] | ffprobe `color_transfer` strings that classify a source into this color space. `"unknown"` (only on `sdr_bt709`) matches sources without a transfer tag (typically older or low-end SDR content). |
| `pix_fmts` | string[] | Pixel formats considered already-conformant for this space — sources matching one of these don't need bit-depth conversion. SDR is 8-bit `yuv420p`/`yuvj420p`; HDR is 10-bit `yuv420p10le`. |
| `encoder` | string | The libav encoder name. `libx264` for SDR; `libx265` for HDR (HEVC is the universal codec for iPhone HDR and the only widely-supported encoder for HDR HEVC output). |
| `output_pix_fmt` | string | The pixel format the encoder emits. Matches one of `pix_fmts`. Passed to ffmpeg as `-pix_fmt <value>`. |
| `encoder_params` | object | ffmpeg encoder flags as a dict of `{key: value}`. Insertion order is preserved when expanded into argv form (`-key value`). Examples: `preset`, `crf`, encoder-specific keys like `x265-params`. |
| `output_color_args` | string[] | Stream-level container metadata flags (passed verbatim to ffmpeg). Tells the container what color the stream is in; complements the per-frame `setparams` filter. |
| `setparams` | string | ffmpeg filter chain that stamps per-frame color metadata. Used by the segment encoder to tag each segment with the project's color metadata. |

---

## Loaders

```
                    ┌────────────────────────────────────────┐
                    │  montaj_assets/schemas/color_space.json │
                    │  (canonical data — never duplicated)    │
                    └────────┬──────────────────┬─────────────┘
                             │                  │
                       loads at runtime    loads at runtime
                             │                  │
              ┌──────────────▼──────┐  ┌────────▼─────────────────┐
              │ lib/types/colorspace.py │  │ montaj_assets/render/   │
              │ (Python helpers)        │  │ color-space.js          │
              │                          │  │ (JS helpers)             │
              └──────────────────────────┘  └──────────────────────────┘
```

Both loaders expose a frozen view of the JSON plus helpers for detection (`detect_from_transfer`) and smart selection (`smart_detect`). Neither contains taxonomy data — they are loaders, not authorities.

---

## Smart-detect policy

`smart_detect(detected_keys)` picks the project's working color space from the per-clip detected keys. Policy is **modal wins**: the most common color space across all clips defines the project. Outliers get converted on the fly — HDR sources in an SDR project are tonemapped per-segment; SDR sources in an HDR project are stretched into the HDR container.

This matches the Final Cut Pro / DaVinci Resolve pattern: a single SDR clip dropped into an iPhone-HDR project is treated as SDR-graded content shown on an HDR canvas, not a reason to flip the entire project down to SDR.

**Tiebreaks (when two or more keys are tied for most common):**

- **HDR-only tie (HLG + PQ, no SDR) → `hdr_pq`.** PQ has the larger gamut, and HLG → PQ is a clean transfer-curve conversion.
- **SDR tied with HDR → `sdr_bt709`.** Conservative when there's no clear majority signal — tonemap-down is mathematically well-defined for all sources, while inverse-stretch is creative guesswork without a stronger signal of intent.
- **No clips probed → `default`** (currently `sdr_bt709`).

**Examples:**

| Per-clip detected | smart_detect result | Why |
|---|---|---|
| `[hlg, hlg, hlg]` | `hdr_hlg` | Single mode |
| `[hlg, hlg, sdr]` | `hdr_hlg` | Modal wins; SDR clip will be stretched on the fly |
| `[hlg, sdr, sdr]` | `sdr_bt709` | Modal wins; HLG clip will be tonemapped |
| `[hlg, sdr]` (1+1 tie) | `sdr_bt709` | Tie → SDR (conservative on inverse-stretch) |
| `[hlg, pq]` (1+1 tie) | `hdr_pq` | Tie among HDR variants → PQ (larger gamut) |
| `[]` (empty) | `sdr_bt709` | No-clip fallback |

Override the smart-detect with `--color-space sdr_bt709|hdr_hlg|hdr_pq` (CLI) or `"colorSpace": "..."` (HTTP intake JSON).

---

## When to add a new color space

1. Add a new key to `all`.
2. Add a new entry under `specs` with all the fields above filled in.
3. Update the `Literal` type in `lib/types/colorspace.py` to include the new key.
4. Run the verification snippet in `docs/plans/2026-04-28-color-space-aware-pipeline.md` Task 1 Step 4 to confirm both loaders see the new key.
5. Update tests in `tests/test_normalize.py` and `tests/test_init.py` to cover the new variant.

The `transfer_values` list is the smart-detect's only input — make sure the `color_transfer` strings ffprobe emits for the new space are listed there.

---

## Notes

- JSON has no string-concat or comments; the `x265-params` value for PQ is one long colon-separated string. Readability lives in this markdown doc, not the JSON.
- The `master-display` and `max-cll` static HDR10 metadata in PQ's `x265-params` is generic Rec.2020 / 1000-nit values — appropriate for v1. Dynamic Dolby Vision passthrough (Profile 8.4 RPU) is a future follow-up.
- **`hdr-opt=1` is on PQ but NOT on HLG.** x265's HDR10-opt block-level optimization is HDR10-specific (it relies on `master-display` and `max-cll` metadata). Setting it on HLG content triggers a runtime warning ("Recommended Settings for HDR10-opt: ..."). HLG signals brightness via the transfer curve itself, so it doesn't need (or benefit from) hdr-opt. Both modes still set `colorprim`, `transfer`, `colormatrix` for VUI tagging; that's separate from hdr-opt.
- `setparams` and `output_color_args` carry the same color triple from two angles: the filter stamps per-frame metadata, the args stamp container metadata. Players read both; segment encoder writes both.

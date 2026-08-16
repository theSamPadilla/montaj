# fixtures/ — the shared timeline corpus

Thirteen committed `project.json`-shaped fixtures (`"version": "0.2"`, the
shape cribbed from `tests/test_sample_steps.py:129-151`), one per named SP2
scenario. Every `src` under `/corpus/...` is a **plausible-but-nonexistent
path** — the corpus intentionally depends on no real media, so it runs
identically on any machine and in CI. Do not point a fixture at a real file.

`node scripts/regen-goldens.mjs` reads every `*.json` in this directory
(except this README) and (re)writes the matching `expected/<name>.json`
golden. `test/corpus.test.mjs` recomputes the same goldens fresh on every run
and deep-equals them against the committed files — see that test's header for
what to do when it fails.

> ## ⚠️ `expected/encode-args.*.json` are FROZEN — do not regenerate them
>
> The two `expected/encode-args.*.json` files are **not** resolver goldens and
> `scripts/regen-goldens.mjs` does not write them. They are the **render
> pipeline's** output (`collectAllItems` + `planSegments` +
> `encodeSegment(..., {_dryRun:true})`) captured by T5 **before** SP2 swapped
> render onto this package (pre-T7).
>
> That timing is the whole value. They are the only artifact proving the
> migration did not change what ffmpeg is asked to encode. Since T7/T8 the
> generator *is* the resolver, so regenerating them silently downgrades the
> gate from *"render output is unchanged since before SP2"* to *"the resolver
> agrees with itself"* — a test that can never fail again, including across a
> real regression.
>
> They are checked on every render test run by
> `montaj_assets/render/test/encode-args-golden.test.mjs`. **If that test
> fails, fix the render code — do not regenerate.** Regeneration exists only
> behind a deliberate, staged opt-in:
>
> ```sh
> MONTAJ_UNFREEZE_ENCODE_ARGS_GOLDENS=1 \
>   node montaj_assets/render/test/encode-args-golden.test.mjs --regen
> ```
>
> **That command compares only — it does not write.** Per file: bytes still
> matching are never rewritten (the file is not opened, so its mtime does not
> move); bytes that CHANGED are refused with the diff printed, and overwriting
> them additionally requires `--i-am-deliberately-changing-render-output`. A
> changed golden is the gate firing, and it is the only time it will fire for
> that change.
>
> Read the banner it prints first. If you do overwrite, say so in
> `CHANGELOG.md` — it means render output deliberately changed.

## Scenario → fixture → registry map

| Fixture | Pins | Registry entry (KNOWN-DIVERGENCES.md) |
| --- | --- | --- |
| `gaps.json` | A timeline gap between two clips resolves to an EMPTY Scene (no last-clip fallback) at `resolveAt`, and contributes two distinct boundaries to `planBoundaries`. | none — this is baseline resolver contract, not a divergence |
| `negative-start.json` | An item with `start < 0` (the "background reel anchored at `-firstClipInPoint`" case `frameGrid`'s own comment describes): `planBoundaries` floors the negative boundary at 0; `resolveAt`/`containsTime` still activates the item for `t < 0`; the resolved `seek` at `t=0` is `0.5` (already 0.5s into itself) — the exact "black top for the first ~0.3s" shape. | none — baseline resolver contract for negative starts |
| `windowed-cache-normalized-inpoint.json` (**Bug A**) | `normalizedSrc` cache with an explicit `normalizedInPoint: 0` that no longer equals the item's current `inPoint` (`0.9157`) — the cache was built before a start-trim. Origin = `normalizedInPoint`, NOT `inPoint`; getting this wrong (rebasing to `inPoint` instead) is Bug A. | none — this is the FIX itself (source-window.js `usedNormalizedCacheFor`/`sourceWindow`), verified working |
| `trim-after-cache.json` | Two items: `trimLegacy` (no `normalizedInPoint` → origin defaults to `inPoint` 3.5 → rebases to 0/5.0, the legacy "assume cache starts at inPoint" behavior) and `trimNonZero` (`normalizedInPoint: 5` explicit, non-zero origin → rebases inPoint 6→1, outPoint 11→6). | none — both are correct current behavior, contrasted side by side |
| `source-crop.json` (**Bug B**) | `sourceCrop` + `sourceWidth` + `sourceHeight` all present on a video item — `geometryFor` forwards all three verbatim by reference. Also the fixture used for the **Part C encode-args golden** (`expected/encode-args.source-crop.json`). | none — this is the FIX (verbatim forwarding), verified working |
| `source-crop-missing-dims.json` | `sourceCrop` present, `sourceWidth`/`sourceHeight` absent. `geometryFor` still forwards `sourceCrop` (it has no opinion on the combination) — the crop is silently DROPPED one layer downstream, in `encode-segment.js`'s `buildVideoItemFilterParts:243` gate, not in this package. | `sourcecrop-missing-dims-silent-drop` |
| `nobg-matrix.json` | The 2×2×2 matrix of `remove_bg` × `nobg_src` × `nobg_preview_src`, every row also carrying `normalizedSrc`. Row `nobg-110` (`remove_bg: true`, `nobg_src` present, `nobg_preview_src` ABSENT) is the headline case: preview falls through to the normalized cache (rebased) because it has no `nobg_preview_src` to prefer, while render picks the un-rebased `nobg_src`. | `nobg-precedence` |
| `nan-case.json` | A `normalizedSrc` item with **neither** `normalizedInPoint` nor `inPoint`. The resolver's origin computation ends `?? 0`, so `sourceWindow` returns a real number (`inPoint: 0`). Legacy `render.js:613` has no such tail (`item.normalizedInPoint ?? item.inPoint`, no `?? 0`) and produces `NaN`, which used to reach ffmpeg's `-ss`. Empirically confirmed against the actual `collectAllItems` — see the T5 report. | none as a KNOWN-DIVERGENCES entry — this is the ONE sanctioned T2 behavior change (see `src/source-window.js`'s module header, "the one sanctioned behavior change in SP2 T2") |
| `opaque-overlay.json` | An `opaque: true` overlay stacked over a video item. The resolver's `Scene` includes BOTH items unconditionally at every variant/timestamp — "opaque hides the video" is a DOWNSTREAM render-only rule (`segment-plan.js`'s `opaqueVideo` flag, applied in `encode-segment.js` Step 2), never applied by `resolveAt`/`resolveSegment` themselves. Also used for an additional (non-mandatory) Part C encode-args capture. | `opaque-in-preview` |
| `adjacent-grid-boundaries.json` | Two clips whose raw boundaries (`4.7677`, `4.8001`) quantize to ADJACENT-but-distinct fps-30 frames (143/30 and 144/30, gap ≈ exactly `1/30`) — the exact IEEE-754-cancellation case `segment-plan.js:76-84`'s comment (ported into `activation.js`'s `boundariesFrom`) describes. Both boundaries must survive the dedupe pass distinctly. | none — this is the FIX (integer-frame dedupe), verified working |
| `loop-item.json` | A video item with `loop: true` and a `transition` object, and a source window (`outPoint - inPoint = 2s`) much shorter than its timeline span (`end - start = 10s`). Neither field is read anywhere in `src/*.js` — `seek` at `t` near the item's end runs far past the 2s source window, because nothing in the resolver (or render) loops it. `transition` is carried on `item` but never consulted by any function in this package. | `loop-not-rendered-transition-dead-field` |
| `audio-outlasts-video.json` | `project.audio.tracks[0].end` (8s) exceeds every visual item's `end` (5s). `visualDuration` (audio EXCLUDED) reports `5`; `projectEnd` (audio INCLUDED) reports `8`. Also exercises `audioWindow` at the track's start/mid/end. | `audio-duration-mismatch` |
| `canvas-only.json` | An image-only `tracks[0]` (no video item anywhere). `visualDuration` correctly reports `6` (every track, every kind). `projectEnd`'s `videoEnd` is TRACK-0-VIDEO-ONLY and reports `0` — despite 6 seconds of on-screen picture. | `audio-duration-mismatch` shares the fixture (see `projectEnd`'s module header, "TRACK-0 VIDEO ONLY" faithfulness note) — no separate registry id; documented in `durations.js`'s own T3 suite |

## The golden shape (`expected/<name>.json`)

Each golden is a single JSON object, produced by `computeGolden(project)` in
`scripts/regen-goldens.mjs`:

```
{
  "planBoundaries": { "24": number[], "30": number[], "60": number[] },
  "durations": { "visualDuration": number, "projectEnd": number },
  "resolveAt": {
    "timestamps": number[],               // the sampled t values, ascending
    "preview":  Scene[],                  // one Scene per timestamp, variant 'preview'
    "render":   Scene[]                   // one Scene per timestamp, variant 'render'
  },
  "resolveSegment": {
    "fps": number,                        // the project's own settings.fps
    "segments": [{ "segStart": number, "segEnd": number, "scene": Scene }, ...]
  },
  "sourceWindow": {
    "<itemId>": { "preview": SourceWindow, "render": SourceWindow }
  },
  "seekTime": {
    "<itemId>": {
      "preview": { "<t>": number, ... },  // keyed by String(t) at item.start / midpoint / item.end
      "render":  { "<t>": number, ... }
    }
  },
  "synthesizedOutPoint": {
    "<itemId>": { "preview": number, "render": number }
  },
  "audioWindow": {
    "<audioTrackId>": { "<t>": AudioWindow, ... }  // keyed by String(t), only for fixtures with project.audio.tracks
  }
}
```

`Scene` is `{ t: number, items: SerializedResolvedItem[] }`. A
`SerializedResolvedItem` is a `ResolvedItem` (see `index.d.ts`) with `item`
replaced by `itemId` (the original item's `id` field) — the golden never
embeds a copy of the item itself, only the ID plus everything the resolver
*computed*: `trackIdx`, `kind`, `window`, `seek`, `geometry`.

**This is the shape T10's Python parity test reads.** `sourceWindow` and
`seekTime` are keyed by `itemId`, so a Python harness can look up any video
item from a fixture by its `id` field and compare its own computation against
`golden.sourceWindow[itemId][variant]` / `golden.seekTime[itemId][variant][String(t)]`
without needing to re-derive timestamps itself. Do not rename or restructure
these two keys without updating T10.

## Regenerating

```sh
cd montaj_assets/timeline-core
node scripts/regen-goldens.mjs
```

This overwrites every resolver golden under `expected/*.json`. It does **not**
touch `expected/encode-args.*.json` — those are frozen; see the warning at the
top of this file. **Hand-audit the diff against the legacy code paths cited in
`src/*.js`'s module headers and in `KNOWN-DIVERGENCES.md` before committing —
a regenerated golden is not self-validating.** `npm test` only checks that the
committed goldens match what the CURRENT resolver computes; it cannot tell you
whether that computation is actually correct.

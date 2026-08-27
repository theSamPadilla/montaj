# Known divergences

SP2 builds `@bycrux/timeline-core` as a faithful PORT of three existing
implementations (editor preview, render engine, `sample-frame.js`). Porting
three independently-evolved codebases into one resolver surfaces places where
they already disagree with EACH OTHER today, in production, before SP2
touched anything. This file is the registry of those disagreements.

**SP2 documents these. It does not fix them.** Each entry names the SP that
owns the eventual fix. The resolver reproduces whichever behavior each
consumer currently gets — see the cited `src/*.js` module header for exactly
which branch encodes which side.

Four fixtures are call-outs of two genuinely different kinds, and are labeled
as such inline: `source-crop.json` ("Bug B"), `adjacent-grid-boundaries.json`,
and `windowed-cache-normalized-inpoint.json` ("Bug A") each pin a FIX that
already shipped in T2/T3/T4 (no registry entry — they are positive findings,
not open divergences), and `nan-case.json` pins the ONE sanctioned SP2
behavior change (`?? 0` on the normalized-cache origin — see
`src/source-window.js`'s module header). None of the four belongs in this
file; they are called out here only so a reader doesn't go looking for them.

## Summary

| id | what | preview | render | owner | fixture |
| --- | --- | --- | --- | --- | --- |
| `rotation` | An overlay/image's `rotation` field | Applied to the on-canvas transform | **RESOLVED SP9a-2 (2026-08-23)** — applied at render on all three paths | ✅ closed | none needed (see entry 1 for where the tests live) |
| `video-rotation-not-previewed` | The **`tracks[0]` MAIN CLIP's** `rotation` field (overlay-track video is NOT affected — it previews rotated and is at full parity) | NEVER applied — `videoTransformContainerStyle` emits `translate`/`scale` only, so neither the legacy `<video>` path nor the engine canvas rotates the main clip | Applied since SP9a-2 — a rotated main clip exports rotated | backlog | none — no corpus fixture carries a rotated video item (0/229 real items carry `rotation` at all) |
| `opaque-in-preview` | An overlay's `opaque` flag | SP4 engine: unified to render semantics by construction (picture suppressed, audio kept). Legacy `<video>` path: never read — the video underneath stays visible | Gates video COMPOSITING only (audio still sourced) via the segment-level `opaqueVideo` flag | SP4 — engine unified (T5); legacy path open until removed | `fixtures/opaque-overlay.json` |
| `dead-render-outpoint` | A video item's stored `outPoint` when it has drifted from `end - start` | N/A (preview derives its own effective outPoint) | See `audio-outpoint-not-derived` below — render mirrors this same "trust the stored value" pattern for the AUDIO track case; the VISUAL item case is the base entry here | SP4 (visual-item case) / render backlog (audio case — `mix-audio.js`, see D1) | `fixtures/trim-after-cache.json` (rebase math), `fixtures/audio-outlasts-video.json` (companion audio-track case) |
| `audio-duration-mismatch` | Project "duration" | `projectEnd` — `max(videoEnd, overlayEnd, audioEnd)`, AUDIO INCLUDED | `visualDuration` — max `end` over every VISUAL item, AUDIO EXCLUDED | SP4 — preview half CLOSED (T8: `projectEnd` adopted in both the legacy hook and the engine); render/truncation half open, see follow-up in the entry | `fixtures/audio-outlasts-video.json` |
| `caption-1080x1920-hardcode` | The caption PAINT layer's render resolution | `CaptionPreview.tsx:40-41` hardcodes `RENDER_W=1080`/`RENDER_H=1920` regardless of the project's actual resolution | N/A (render's caption Puppeteer segment already uses the project's real canvas) | SP5 | none — no fixture in this corpus exercises caption painting (out of scope for `activeCaptionSegment`, which is SELECTION not sizing; see `src/captions.js`'s module header) |
| `nobg-precedence` | Which src an item with `remove_bg` + `nobg_src` but no `nobg_preview_src` plays | Falls through to `normalizedSrc` (rebased) | Uses `nobg_src` (un-rebased, full source) | SP4 | `fixtures/nobg-matrix.json` (row `nobg-110`) |
| `loop-not-rendered-transition-dead-field` | A video item's `loop` and `transition` fields | `loop` is honored (`useVideoPlayback.ts:633/700/779`); `transition` is read NOWHERE in the editor either. SP4's engine reimplements `loop` (`engine/scheduler.ts`'s `placeInSource`/`endsOnLoopBoundary`); dropping loop support entirely was considered and rejected — it stays flagged as an operator option, not defaulted | Neither field is read anywhere under `montaj_assets/render/*.js` (grepped — zero hits) | SP4 / schema-cleanup backlog | `fixtures/loop-item.json` |
| `sourcecrop-missing-dims-silent-drop` | A `sourceCrop` with no `sourceWidth`/`sourceHeight` | `sourceCropVideoStyle` (`sourceCropStyle.ts:32`) returns `null` early (`!sourceWidth \|\| !sourceHeight`) — falls back to full-frame, same as render. SP4's engine (`engine/scheduler.ts`'s `sourceCropDrawPlan`) keeps the same parity-safe no-dims→no-crop guard rather than the `PreviewPlayer.tsx` call-site fallback that would have made the divergence worse | `buildVideoItemFilterParts`'s gate (`encode-segment.js:243`, `if (sc && item.sourceWidth && item.sourceHeight)`) silently skips the crop filter step entirely | SP3 / SP4 | `fixtures/source-crop-missing-dims.json` + `expected/encode-args.source-crop-missing-dims.json` (no `crop=` filter step present — verified empirically) |

## 1. `rotation` — ✅ RESOLVED IN SP9a-2 (2026-08-23)

**Retained rather than deleted**: this entry tracked the divergence from SP2
until SP9a-2 closed it, and the resolution is the useful part of the record.

**What it was.** Preview (`OverlayItemsLayer.tsx:392/507` apply
`rotate(${rotation}deg)` to the on-canvas CSS transform — two call sites, one
for track-0 canvas items, one for overlay tracks) read `item.rotation ?? 0` via
`geometryFor`. Render (`encode-segment.js`'s `buildImageItemFilterParts`,
`buildVideoItemFilterParts`, `buildOverlayFilterParts`) had no rotation handling
anywhere — grepped, zero hits. An overlay or image rotated in the editor
exported un-rotated, silently.

**What shipped.** `toRotatedPixelBox` (`src/geometry.js`) is the rotation-aware
sibling of `toPixelBox`: it delegates for the unrotated numbers and adds the
even-rounded grown bounding box plus a centre-preserving adjusted origin.
`encode-segment.js`'s `rotateFilterStep()` owns all rotation filter syntax and
appends an ffmpeg `rotate=` step on the image, video, and overlay paths;
`render.js` and `sample-frame.js` forward `rotation` to them. ffmpeg's `rotate`
is clockwise-positive, matching CSS — verified empirically, there is no sign
flip.

**`toPixelBox` was NOT modified and must stay rotation-blind** — its
ignores-rotation contract is still pinned by `test/geometry.test.mjs`, and
`toRotatedPixelBox` is the only rotation-aware adapter. Do not "simplify" the
two into one.

**Where the tests live.** `test/geometry.test.mjs` (the helper's matrix,
including centre-preservation and grown-box integrality across a sweep);
`render/test/encode-segment.test.mjs` and `overlay-filter.test.mjs` (per-path
`{absent, 0, 360}` byte-identity plus rotated-case assertions);
`render/test/rotation.integration.test.mjs` (pixel probes that fail under a sign
flip — strings cannot catch that); `render/test/encode-args-golden.test.mjs`
(asserts no frozen golden contains `rotate=`, so the identity gate can't pass
vacuously).

**Owner: ✅ closed (SP9a-2).** The video-preview half is a separate, still-open
entry — see `video-rotation-not-previewed` below.

## 2. `opaque-in-preview`

**STATUS CHANGED IN SP4 T5 — unified for the ENGINE path; the LEGACY `<video>`
path still diverges.**

An overlay item's `opaque: true` means "this overlay replaces the picture
underneath, but the underlying item's audio must still be heard" — the doc
comment at `segment-plan.js:9-12` states this explicitly. Render honors it:
`planSegments` computes `opaqueVideo = overlays.some(o => o.opaque)` per
segment, and `encode-segment.js` Step 2 skips VIDEO compositing for every item
in an opaque segment while still extracting its audio (Step 2's `if
(!item.muted && ...)` audio branch runs unconditionally regardless of
`opaqueVideo`).

**SP4's WebCodecs engine unifies preview onto RENDER semantics, by
construction, now that there is a compositing stage to make the choice in.**
`engine/scheduler.ts`'s `planTick` sets `TickPlan.opaque` from any active
OVERLAY item's `item.opaque === true` (matching render's `overlays.some(o =>
o.opaque)`), and `SchedulerImpl.apply`'s picture-selection step (§4) sets
`picture = 'opaque'` when `plan.opaque` is true — the canvas paints black
(`pullFrame` still PULLS the frame off the active clip's decoder to keep the
buffer from stalling, then closes it unpainted) while the clip's audio, and the
master clock derived from it, keep running. See `scheduler.ts`'s own module
header ("MAPPING FROM THE LEGACY HOOK", the `opaque` row) for the explicit
disposition: "NOT a legacy behavior... the registry disposition... is to unify
on RENDER semantics now that there is a compositing stage: skip the paint,
keep the audio."

**The LEGACY `<video>` path is UNCHANGED and keeps the old divergent
behavior for as long as it exists**: `item.opaque` is still never read
anywhere in `OverlayItemsLayer.tsx` or `useVideoPlayback.ts` (grepped — zero
hits) — the video underneath an opaque overlay stays fully visible when the
legacy player is in use. The divergence is therefore now LEGACY-PATH-ONLY: a
project played through the SP4 engine sees render-accurate opaque behavior in
preview; the same project played through the legacy `<video>` player (still
the fallback for engine-ineligible projects, per `engine/eligibility.ts`) does
not.

**The resolver itself is variant-agnostic here by design**: `resolveAt` and
`resolveSegment` return the SAME `Scene.items` (both the video and the opaque
overlay, `item.opaque` carried verbatim on the overlay's `TimelineItem`) for
both `'preview'` and `'render'` at the same instant — see
`fixtures/opaque-overlay.json` / `expected/opaque-overlay.json`, where
`resolveAt(..., {variant:'preview'})` and `resolveAt(..., {variant:'render'})`
at `t=2.5` are identical scenes. "Hide the video" is a downstream, render-only
COMPOSITING rule applied by `encode-segment.js`, never a resolver-level
activation rule — which is exactly why this is a documented divergence and not
a resolver bug: the resolver reports what's ON THE TIMELINE, not how each
consumer chooses to composite it.

**Owner: SP4 — CLOSED for the engine path (T5 unified it onto render
semantics); OPEN for the legacy `<video>` path until that player is retired.**

## 3. `dead-render-outpoint` (and its audio-track sibling)

Visual items: after a trim, a video item's stored `outPoint` can drift out of
sync with the `start`/`end` span it now actually occupies. Preview never
trusts the stored value for the ACTIVE WINDOW — `synthesizedOutPoint`
(`src/source-window.js`, porting `useVideoPlayback.ts:683`) falls back to
`effectiveInPoint + (end - start)` whenever the stored value is absent, and
even when present, the stored `outPoint` is only used to know where to STOP —
not to define the active window, which `containsTime`/`coversSegment` compute
from `start`/`end` regardless. `fixtures/trim-after-cache.json` pins the
rebase math this depends on. SP4's engine inherits this unchanged — `scheduler.ts`'s
`placeInSource` is driven entirely by `SourceWindow.inPoint`/`.outPoint` as
returned by `resolveAt`, never by a raw stored field.

Audio tracks have the SAME underlying failure mode but in the opposite
direction — see the newly-discovered `audio-outpoint-not-derived` entry below,
which is the sharper, independently-confirmed version of this issue for
`project.audio.tracks`. Both used to be filed under one owner because the fix
is the same shape: stop trusting a stored `outPoint` that can drift, derive it
from `start`/`end` instead.

**Per decision 7 (SP4 T8): the two halves now have different owners.** The
VISUAL-item case above is preview/engine-observable behavior and stays
**Owner: SP4**. The AUDIO-track case (the `mix-audio.js` half — see D1 below)
is a render/Python-side fix (`mix-audio.js`'s `buildAudioTrackInputs`, not
anything under `editor/src/engine/`), so it is reassigned to **render/backlog**
— fixing it is not engine work, and SP4's scope ends at the preview/engine
boundary.

## 4. `audio-duration-mismatch`

`visualDuration(project)` (render semantics, `render.js:821-825`
`getTotalDurationSeconds`) is the max `end` over every VISUAL item on every
track. `project.audio` is never read. `projectEnd(project)` (editor semantics,
`useVideoPlayback.ts:158-163`) is `max(videoEnd, overlayEnd, audioEnd)`, and
`audioEnd` folds in `project.audio.tracks`.

A project whose music bed outlasts its picture previews longer than it
renders: `fixtures/audio-outlasts-video.json` has a 5s video and an 8s audio
track. `visualDuration` = 5 (what the renderer actually encodes to and what
`sample-frame.js:520-525` range-checks against); `projectEnd` = 8 (what the
editor uses to decide whether to keep the transport running).

**This entry asks for two things; SP4 T8 lands one half and files the other.**

**Half 1 — PREVIEW-SIDE CONSISTENCY: CLOSED.** `timeline-core`'s
`projectEnd` (`src/durations.js`) is now the single source both preview
surfaces defer to, rather than each hand-rolling the same `max(videoEnd,
overlayEnd, audioEnd)` arithmetic. The legacy hook's video-mode `projectEnd`
memo (`useVideoPlayback.ts:158-163`) now calls `timelineProjectEnd(project)`
directly — this is the formula `src/durations.js` was ported FROM, so the
substitution is a no-op by construction, verified by the full editor suite
staying green with no expectation edits. The engine's `transportEndFor`
(`engine/scheduler.ts:433-444`) already called `timelineProjectEnd` for the
video-project branch since T5. Both preview surfaces and `sample-frame.js`'s
`getTotalDurationSeconds` (render semantics) now agree with each other WITHIN
their own variant; the preview/render VARIANT mismatch this entry is about is
unchanged (see next paragraph) — this closes the "two hand-written copies of
the same editor-semantics formula" hazard, not the divergence itself.

**Half 2 — THE ACTUAL PREVIEW/RENDER MISMATCH: still open, filed as a named
follow-up so it does not silently drop.** A project whose audio outlasts its
picture still previews 8s and renders 5s — `projectEnd` (preview) and
`visualDuration` (render) are DELIBERATELY different formulas (audio
included vs. excluded), and nothing in T8 changes that. Two possible fixes,
neither implemented here:

  1. **Surface the truncation in the UI** — warn the author when
     `projectEnd(project) > visualDuration(project)` (e.g. "your audio track
     extends 3s past your last clip; the render will be shorter than the
     preview"), so the mismatch is visible before export rather than
     discovered in the output file.
  2. **Fix render-side** — make `visualDuration`/the render pipeline account
     for trailing audio the way `projectEnd` does, closing the gap instead of
     just naming it.

**Owner: SP4** (preview-side half CLOSED by T8; the UI-surfacing/render-fix
follow-up above is unassigned — flagged for a future SP to pick one of the two
options).

## 5. `caption-1080x1920-hardcode`

`CaptionPreview.tsx:40-41` hardcodes `RENDER_W = 1080` / `RENDER_H = 1920` for
the caption layer's own on-screen sizing, regardless of the project's actual
`settings.resolution` / `designCanvas`. A landscape or 4K project's caption
preview is still measured against a fixed 1080×1920 layer.

This is a SIZING concern of the caption PAINT layer, not the time-based
SELECTION `activeCaptionSegment` (`src/captions.js`) performs — the two are
independent, and `activeCaptionSegment` itself has no render-side divergence
(every render caption template computes the identical `t = frame/fps` +
half-open predicate — see that module's header). No fixture in this corpus
exercises caption painting; this entry exists so the finding isn't lost.

**Owner: SP5.**

## 6. `nobg-precedence`

`sourceWindow`'s src-selection chain (`src/source-window.js`'s `chooseSrcRaw`)
differs by variant. Both original call sites this was extracted FROM (SP2 T8)
now just delegate to it rather than carrying the formula inline:
`useVideoPlayback.ts`'s `playbackSrcFor` (line 66, `resolvePlaybackSrc(gateProxy(clip),
'preview')`) — the precedence order itself is documented at `useVideoPlayback.ts:52-53`
(`// SP3 precedence, most to least specific: nobg_preview_src > proxySrc >
normalizedSrc > src.`) — and `render.js:652`'s `sourceWindow(item, 'render')`
call. The variant-aware logic these two delegate to:

    preview: nobg_preview_src ?? proxySrc ?? normalizedSrc ?? src
    render:  (nobg_src && remove_bg) ? nobg_src : (normalizedSrc ?? src)

**Alpha-ordering note (SP3):** `proxySrc` — a full-source 720p AV1+Opus
editing proxy — sits AFTER `nobg_preview_src` in the preview chain, never
ahead of it, and never appears in the render chain at all. `nobg_preview_src`
is VP9-with-alpha; an opaque proxy ahead of it would resurrect a removed
background in preview while render still composites the alpha artifact
underneath — a new preview/render divergence on top of this one. See
`src/source-window.js`'s `chooseSrcRaw` for the full rationale and
`fixtures/proxy-matrix.json` for the corpus coverage.

For an item with `remove_bg: true` + `nobg_src` present but NO
`nobg_preview_src`, the two variants pick different files — and which files
depends on whether an SP3 proxy is present (post-SP3, import writes one on
essentially every video item, so the WITH-proxy case is the norm):

- **With `proxySrc` (the post-SP3 norm):** preview falls through past the
  (absent) preview alpha artifact to the PROXY — full-source, unrebased
  (`usedNormalizedCache: false`, raw `inPoint`/`outPoint`). Render picks
  `nobg_src` — also full-source, also unrebased. **Both variants are
  unrebased**, so the in/out-point mismatch half of this divergence
  disappears; what remains is preview showing the un-cut-out proxy pixels
  where render composites the alpha cutout (visual-content divergence only).
- **Without `proxySrc`** (proxy failed/deferred/cleaned, or `--no-proxy`):
  the original drift applies — preview falls to `normalizedSrc`, which IS a
  window cache and gets rebased, while render's `nobg_src` is never rebased.
  The two variants can play/encode different in/out points for the same item.

Fixture coverage: `fixtures/nobg-matrix.json` rows carry NO `proxySrc`, so its
`nobg-110` encodes the WITHOUT-proxy drift: preview resolves to
`{src: normalizedSrc, inPoint: 2, outPoint: 8, usedNormalizedCache: true}`;
render to `{src: nobg_src, inPoint: 3, outPoint: 9, usedNormalizedCache:
false}` — verified during SP2 T5's audit. The WITH-proxy norm's combination
(`remove_bg` + `nobg_src` + `proxySrc`, no `nobg_preview_src`) has **no
fixture row yet** — `proxy-matrix.json` covers proxy × `nobg_preview_src`
only. **Corpus gap, flagged for SP4's fixture additions.** (Entry rewritten
post-SP3 — fix S8: the pre-SP3 text presented the rebase drift as the
universal case, which stopped being true for real imports the moment proxies
shipped on every item.)

**Owner: SP4.**

## 7. `loop-not-rendered-transition-dead-field`

Two VisualItem schema fields (`montaj_assets/editor/src/schema.ts:87-88`),
video-type only:

- `loop?: boolean` — "loop source clip within project window." Preview honors
  it (`useVideoPlayback.ts:633`, `:700`, `:779` — the scrub-into-loop, wrap-at-
  outPoint, and stop-at-clip.end sites respectively). `montaj_assets/render/*.js`
  never reads `.loop` anywhere (grepped — zero hits): a looped clip in the
  editor freezes on its last decoded frame (or worse) once rendered past its
  actual source duration, instead of looping.

  **SP4 note (decision 7):** the WebCodecs engine REIMPLEMENTS loop rather than
  dropping it — `engine/scheduler.ts`'s `placeInSource` (the three legacy sites'
  arithmetic made total, with the loop offset DERIVED from project time instead
  of accumulated across three mutable-ref writers) and `endsOnLoopBoundary`
  (which reproduces the legacy "stop mid-loop rather than fall through to the
  next clip" behavior verbatim — see that function's own doc comment for why
  this looks like a bug and is kept anyway). Dropping loop support in the
  engine was considered during planning and rejected: per decision 7 it stays
  an operator-facing option to turn off, not something the engine silently
  defaults away. This entry's divergence (render never honors `loop` at all) is
  therefore UNCHANGED by SP4 — the engine now matches legacy preview more
  faithfully, which if anything widens the preview-vs-render gap this entry
  tracks until render's own owner picks it up.
- `transition?: { type: string; duration: number }` — "transition into next
  clip." Grepped across `montaj_assets/editor/src` and `montaj_assets/render`:
  zero non-CSS hits. The field is round-tripped through the schema and read by
  NOTHING. Fully dead.

`fixtures/loop-item.json` pins the `loop` half concretely: the item's source
window is 2 seconds (`outPoint - inPoint`) but its timeline span is 10 seconds
(`end - start`). At `t=5`, the resolved `seek` is `5` — already 2.5× past the
source window's own length, because nothing (resolver OR render) loops it back
to the window start. The same item also carries a `transition` object purely
to document that the field exists and is inert; no assertion targets it
specifically since nothing anywhere reads it.

**SP9d-T7 note — `transition` is STILL DEAD, and the near-collision of names is
a trap.** T7 added `ResolvedItem.crossfade`, the live per-instant blend factor
for a clip pair. It did **not** revive `VisualItem.transition`, and the two are
unrelated:

- `VisualItem.transition` is AUTHORED data (`{ type, duration }`) persisted on
  the item. Still read by nothing, in the editor or in render. Still fully dead.
- `ResolvedItem.crossfade` is DERIVED — computed from the OVERLAP between two
  neighbouring clips on one track (`src/transitions.js`'s `transitionPairs`),
  never read off the item. Deleting every `transition` object in a project would
  not change a single `crossfade` value.

The resolver field is deliberately named `crossfade` rather than `transition`
precisely so a live field and a dead field never share a name on the same
conceptual object. If this entry ever closes by deleting `VisualItem.transition`
from the schema, that deletion does not touch `crossfade`.

**Owner: SP4 / schema-cleanup backlog.**

## 8. `sourcecrop-missing-dims-silent-drop`

`geometryFor` (`src/geometry.js`) forwards `sourceCrop` verbatim whenever the
item carries it — REGARDLESS of whether `sourceWidth`/`sourceHeight` are also
present. It has no opinion on that combination; it just reports what the item
carries (`fixtures/source-crop-missing-dims.json`'s golden geometry has
`sourceCrop` set and `sourceWidth`/`sourceHeight` simply absent — see
`expected/source-crop-missing-dims.json`).

The DROP happens one layer downstream, in
`encode-segment.js`'s `buildVideoItemFilterParts:243` gate:

    const sc = item.sourceCrop
    if (sc && item.sourceWidth && item.sourceHeight) { ...crop filter... }

`expected/encode-args.source-crop-missing-dims.json` is the empirical proof:
running the REAL `collectAllItems` + `planSegments` + `encodeSegment(...,
{_dryRun:true})` over this fixture produces a filter chain with NO `crop=...`
step at all — compare against `expected/encode-args.source-crop.json` (same
pipeline, same fixture shape, but WITH dims), whose filter chain has
`crop=1536:972:192:54,` as the first step of the video filter chain.

Editor-side, `sourceCropStyle.ts:32`'s own guard (`if (!sourceWidth ||
!sourceHeight || !frameWidth || !frameHeight) return null`) makes the SAME
choice — fall back to full-frame — so this is not a preview/render
disagreement so much as a shared "we can't crop without dims" fallback that
both sides reach independently. Filed here anyway because it's a real
information-loss point or authors can lose data silently (a crop set without
its dims companion just vanishes, with no error, on both sides).

**SP4 note (decision 7):** the WebCodecs engine's `sourceCropDrawPlan`
(`engine/scheduler.ts:220-229`) keeps this SAME no-dims guard — a deliberate
parity-safe choice, not an oversight. `PreviewPlayer.tsx`'s `<video>`-based
call site falls back to the loaded element's intrinsic dims
(`activeClip?.sourceWidth ?? videoDims?.w`) when the item itself carries none,
which would make the LEGACY preview crop something render does not; the engine
does not reproduce that fallback, so it stays exactly as parity-safe as
render, not more permissive. See `sourceCropDrawPlan`'s own doc comment ("The
no-dims guard (a parity decision, not an oversight)") for the full reasoning.

**Owner: SP3 / SP4.**

---

# Discovered during SP2

T2-T4's implementation and review passes surfaced additional divergences
beyond the eight mandated above. Same treatment: what diverges, exact
`file:line` on both sides, user-visible consequence, owner, fixture pointer.
Every one below was independently re-verified against the cited source during
T5 (grepped/read the actual lines, not transcribed on faith) — see the T5
report for what was checked.

## D1. `audio-outpoint-not-derived` — a genuine, distinct bug-class finding

**Verified.** `mix-audio.js`'s `buildAudioTrackInputs` (lines 18-29) uses the
STORED `track.outPoint` directly:

    const outPt = track.outPoint ?? null
    if (outPt !== null) args.push('-to', String(outPt))

while the preview's `syncAudioTracks` DELIBERATELY DERIVES
`outPoint = inPt + (end - start)` (`src/audio.js:98`, inside `audioWindow` —
`useVideoPlayback.ts` no longer computes this inline as of SP4 T8; the hook's
`syncAudioTracks` now calls `audioWindow(track, playhead)` for this exact
arithmetic, same as `useEnginePlayback.ts` already did), with the comment:
"Derived, not stored — see the module header," `audio.js`'s module header
carrying the original "the stored outPoint can drift out of sync with
start/end during trim operations, causing premature silence" reasoning in
full. `audioWindow` therefore ports exactly that derived rule (no stored-
`outPoint` read at all).

Consequence: a trimmed audio track can preview at full length (correctly,
because the editor never trusts the stale stored value) but export TRUNCATED
(because `mix-audio.js` hands ffmpeg's `-to` the stale value directly). This is
sharper than — and distinct from — entry 4 (`audio-duration-mismatch`), which
is about the whole-PROJECT duration figure; this is about a single audio
TRACK's own trim staying in sync with itself.

**Owner: render/backlog** (reassigned from SP4 per decision 7, SP4 T8 —
`mix-audio.js` is render/Python-side JS, not `editor/src/engine/` work, so
fixing it does not belong to the playback-engine sprint). No fixture in
`fixtures/` targets `mix-audio.js` directly (it's outside `src/audio.js`'s
pure-arithmetic scope — see that module's header); `fixtures/audio-outlasts-video.json`'s
audio track is a plain non-trimmed case and does not exercise the
stale-outPoint path. Flagging here so whoever picks this up from render/backlog
knows to add a dedicated fixture when fixing `mix-audio.js`.

## D2. `mix-audio-afade-curve-unverified` — ⚠️ REOPENED, THEN FIXED (2026-08-26)

**The curve half was right. The entry as a whole was wrong, and its wrongness
shipped a silent bug.** The real defect was `st=` in the wrong time base — see
"What it missed" and "Resolution" below.

### What this entry used to say

It concluded **"RESOLVED — CHECKED IN SP4 T8. NOT a live divergence: both sides
are linear."** The reasoning: the preview computes a linear ramp
(`src/audio.js:105-110`), `mix-audio.js` emitted a bare `afade=t=in:d=${fadeIn}`
with no explicit `curve=`, and `ffmpeg -h filter=afade` documents `tri`
("linear slope") as the default curve. Both sides therefore agreed on fade
SHAPE, and no code change was needed.

That much is still true, and the curve question is genuinely closed —
`mix-audio.js` now passes `curve=` explicitly via `ffmpegFadeCurve()`.

### What it missed

The audit read these exact filter strings, line by line, and did not see that
**`st=` was computed in the wrong time base**. `adelay` prepends `start` seconds
of silence, so everything chained after it runs in stream time; `st` was being
computed as `(end - start) - fadeOut`, track-local. For any track with
`start > 0` the fade-out fired `start` seconds early, and `afade=t=out` holds
zero for the remainder of the stream. A music bed at start 27.67 / end 53.8 with
a 3.08s fade-out reached zero gain at stream time 26.13s — before its own audio
began. All 26.1s of that bed was zeroed, and the 54-second deliverable measured
−91.0 dB (`volumedetect`) across its last 24 seconds, once the voiceover
underneath it ended. The render reported success.

`afade=t=in` carried the same fault: with no `st` at all it ran at stream time 0,
entirely inside the silent padding, so an offset track received no fade-in.

### Why it was missed — the reusable lesson

**The audit picked the degenerate case.** It worked its example with `start: 0`,
where `(end - start) - fadeOut` and `end - fadeOut` are *numerically identical*.
The broken expression and the correct one produce the same number at the origin,
so no amount of care spent reading that example could have surfaced the bug. The
unit tests in `render/test/mix-audio.test.mjs` made the same choice
independently — all five sat at `start: 0`, and the four that set a fade landed
on the one value where the broken and correct expressions are numerically
identical (the fifth sets no fade, so it never evaluated the expression at all)
— and `integration-compose.test.mjs` used `audio: { tracks: [] }` in every
fixture, so the mixing path had no end-to-end coverage whatever.

Three separate checks, all landing on the one input value that cannot
discriminate. **An audit that exercises the degenerate case proves nothing about
the general one** — when a divergence check has a parameter, deliberately pick a
value where a wrong implementation and a right one must disagree, and say in the
entry which value you picked and why it discriminates.

A narrower lesson too: this entry scoped itself to fade *shape* and answered that
question well. But it was filed against the fade filters as a whole, and its
"RESOLVED / NOT a live divergence" verdict read — to everyone downstream — as a
clearance of those filters, not of the one attribute actually examined. State the
attribute in the verdict, not just in the body.

### Resolution

**Fixed 2026-08-26.** Both `st=` values are now expressed in delayed-stream time
by a single shared `buildFadeFilters()` helper in `mix-audio.js` (which also
closes D3 below): `st = end - fadeOut` for the fade-out, `st = start` for the
fade-in. Regression coverage is a `start > 0` fixture in both branches
(`render/test/mix-audio.test.mjs`) plus the first end-to-end test of the audio
mixing path (`render/test/integration-compose.test.mjs`), which renders an
offset track and asserts on measured level — it reproduces −91 dB against the
unfixed code. Making `st` explicit on the fade-in is a verified no-op at the
origin: mixing a `start: 0` fixture before and after and decoding to raw PCM
gives byte-identical output (sha256 `014ab3916dad500302c577374cb550c51e2755c1acb84acfa0efe09cf7e99ac9`).

**Owner: ✅ closed (render, 2026-08-26).** D1 above remains open and untouched —
same file, adjacent lines, different bug.

## D3. `mix-audio-duplicated-fade-formula` — ✅ RESOLVED (2026-08-26)

**The drift hazard was real and it cashed in.** Both copies carried the D2
stream-time bug, and both had to be fixed. Resolved by extracting the shared
`buildFadeFilters()` helper in `mix-audio.js` — there is now one copy, so the
next fix cannot land on one branch and miss the other. The description below is
retained as the historical finding; its snippet and line numbers predate both
this fix and the earlier `curve=` addition.

**Verified at the time — drift hazard, not a live divergence.** `mix-audio.js`'s
`buildAudioTrackFilters` has two branches for the same computation: the
`ducking` branch (lines 52-70) and the non-ducking branch (lines 71-83). Both
independently compute:

    const fadeIn = track.fadeIn ?? 0
    const fadeOut = track.fadeOut ?? 0
    const trackDur = (track.end ?? 0) - (track.start ?? 0)
    if (fadeIn > 0) fadeFilters += `,afade=t=in:d=${fadeIn}`
    if (fadeOut > 0) fadeFilters += `,afade=t=out:st=${Math.max(0, trackDur - fadeOut)}:d=${fadeOut}`

Literal duplication, confirmed by direct comparison of both blocks. Not
currently divergent (both branches compute the same thing), but a future edit
to one without the other silently reintroduces a divergence. Not something
`src/audio.js` can guard against — it's an internal `mix-audio.js` code-health
issue, not a preview/render behavior difference.

~~**Owner: render/backlog** (reassigned from `schema-cleanup / SP4 backlog` per
decision 7, SP4 T8 — this is internal `mix-audio.js` code health, not
`editor/src/engine/` work; SP4's scope ends at the preview/engine boundary).~~

**Owner: ✅ closed (render, 2026-08-26)** — picked up off render/backlog and
fixed alongside D2, which is what the duplication cost.

## D4. `boundary-totality-guard` — ADOPTED BY RENDER IN T7 (was: resolver vs. legacy)

**Verified empirically. STATUS CHANGED IN T7 — this is no longer a live
divergence; it is a landed behavior change.**

`activation.js`'s `finiteOr0` (used only inside `boundariesFrom`'s
boundary-collection loop, never inside the activation predicates) maps a
non-finite or missing `start`/`end` to `0`. The PRE-T7 `segment-plan.js`
boundary pipeline had no such guard: `boundary(undefined)` evaluated
`quantize(undefined) = Math.round(NaN * fps) / fps = NaN`, then
`Math.max(0, NaN) = NaN`, and that `NaN` was added to the boundary set and
could reach the encoder as a literal `-ss NaN` / `-t NaN` argument.

Confirmed by running BOTH pipelines on the same malformed single-item project
(`{ start: 0, end: undefined }`) during T5's audit: legacy
`planSegments([item], [], 1080, 1920, 30)` returned one segment with
`end: NaN`; `boundariesFrom([{start:0, end:undefined}], 30)` returns `[0]`
(one boundary — no segment at all, since a length-1 boundary list describes
zero segments).

**As of T7, `render/segment-plan.js` delegates its boundary pipeline to
`boundariesFrom`, so render now follows the resolver's guard.** The legacy
`-t NaN` path is GONE from the render engine: a malformed item is dropped from
boundary space instead of poisoning the timeline. The two sides no longer
disagree, which is why this entry is closed rather than open.

It remains **unreachable in production** either way: `collectAllItems`
(`render.js:588-598`) copies `start`/`end` straight off schema-required fields,
so every item reaching `planSegments` has finite endpoints, and every fixture in
this corpus is well-formed on purpose (see `fixtures/README.md`'s "never depend
on real files" framing, which extends to "never depend on malformed data").

Pinned by a dedicated test — `render/test/resolver-parity.test.mjs`,
"divergence (KNOWN-DIVERGENCES D4): non-finite endpoints — resolver drops,
legacy emits NaN" — which asserts BOTH sides explicitly (frozen legacy still
produces the `NaN`-ended segment; the shipped `planSegments` produces none), so
the difference is locked in place rather than silently absorbed. NO corpus
fixture exercises it, which is exactly why that test exists.

**Owner: SP2 — CLOSED by T7 (render adopted the guard).**

**SP4 note on D5/D6/D7/D10 (decision 7, the last sentence):** these four
entries are all about the project-shaped `resolveAt`/`activation.js` API
disagreeing with render's flat, pre-split legacy pipeline
(`collectAllItems`/`collectPuppeteerSegments`/`compose.js`'s tie order/the
pre-T7 `trackIdx` comparator). Until now that API had exactly one live
consumer to speak of (tests, plus `sample-frame.js`'s own recent adoption —
see D5 above). **SP4's WebCodecs engine is now a second, PREVIEW-FACING
consumer**: `engine/scheduler.ts`'s `planTick` calls `resolveAt(project, t,
{variant:'preview'})` (the `previewResolver` default) every tick. The engine
therefore inherits `resolveAt`'s 'preview' semantics — including D5's
uniform per-track walk, D6's single consistent quantization, and D7's
document-order (not image-then-video) tie order — wherever they differ from
what `collectAllItems`/`compose.js`/legacy `segment-plan.js` still do on the
RENDER side. This does not create a NEW divergence (the engine's preview
answers still agree with the legacy `<video>` player, since both are
'preview'-variant consumers of the same project), but it DOES widen the
existing preview-vs-legacy-render distance these four entries track: two
preview surfaces now agree with the resolver's project-shaped semantics while
render's legacy pipeline has not adopted them, until render's own
project-shaped adoption (tracked separately per-entry above) closes the gap.

## D5. `track-0-overlay-items`

**Verified.** `collectAllItems` (`render.js:582-688`) only collects `type ===
'image'` / `type === 'video'` items, from EVERY track including track 0.
`collectPuppeteerSegments` (`render.js:504`, `overlayTracks =
(projectJson.tracks ?? []).slice(1)`) only looks at tracks 1+. The combined
effect: an `overlay`-type item placed on track 0 contributes NO boundary and
NEVER RENDERS today. `sample-frame.js` has no such track-0 exclusion — it now
calls the shared resolver directly (`resolveAt(resolvedProject, atSeconds,
{variant:'render'})`, `sample-frame.js:537`) rather than hand-walking tracks,
so it inherits the resolver's uniform per-track walk and honors a track-0
overlay. The resolver's project-shaped `collectScene` (`activation.js`) is
exactly that walk: every track uniformly, so a track-0 overlay is a
first-class item.

No fixture in this corpus places an overlay on track 0 specifically (all
overlay-bearing fixtures here use track 1, matching the common case); this is
inert for T7's `planSegments`/`collectAllItems`/`collectPuppeteerSegments` path
(whose parity harness is fed by `compose.js`'s pre-split
`imageItems`/`videoItems`/`puppeteerSegs` arrays, which already have this
exclusion baked in before the resolver ever sees them) but is REAL for any
consumer of the project-shaped API — which now concretely includes
`sample-frame.js` (see above) and SP4's engine (`planTick`, next entry's note),
not just a hypothetical future one. Pinned instead by
`test/activation.test.mjs` per that module's own header.

**Owner: SP4.**

## D6. `overlay-boundary-quantization`

**Verified.** `collectPuppeteerSegments` pre-quantizes overlay
`startSeconds`/`endSeconds` to the frame grid (`render.js:` inside that
function, `quantize(item.start)` / `quantize(item.end)`) before legacy
`planSegments` ever sees them, while legacy `planSegments` receives VISUAL
items' raw (unquantized) `start`/`end` and quantizes those itself inside its
own boundary pipeline. So legacy ends up comparing overlays against
ALREADY-quantized bounds and items against bounds it quantizes fresh — two
different roundings of what should be the same number, off by at most half a
frame. The resolver's project-shaped `planBoundaries`/`resolveAt` compare
every item (visual or overlay) using its OWN raw `start`/`end`, quantized
identically by the shared `frameGrid`, every time — a single consistent
rounding.

The difference can only surface within half a frame of a boundary and is
inert for T7 (which delegates through the flat LEVEL-1 primitives using the
caller's own already-quantized/raw arrays, preserving today's asymmetry
exactly). Pinned by `test/activation.test.mjs` per `activation.js`'s own
module header; no dedicated corpus fixture (the effect is sub-frame and not
independently observable through this corpus's `resolveAt`/`planBoundaries`
goldens without reproducing `collectPuppeteerSegments`' own quantization
inline, which duplicates test/activation.test.mjs's existing parity harness).

**Owner: SP4.**

## D7. `same-trackidx-tie-order`

**Verified.** `compose.js:64` builds the merged item array as `[...imageItems,
...videoItems]` before handing it to `planSegments`, so `Array.prototype.sort`
(stable) puts ALL image items before ALL video items whenever two items share
a `trackIdx` — regardless of their actual order within that track. The
resolver's project-shaped `collectScene` (`activation.js`) walks each track in
DOCUMENT order instead, so two same-`trackIdx` items keep whatever order they
were authored in, image-or-video notwithstanding.

Inert for T7 (`planSegments` itself has no opinion on ordering beyond "stable
sort on the array it's handed" — the tie-order is baked in by `compose.js`
BEFORE the array reaches `planSegments`/the resolver's LEVEL-1 primitives), but
a real difference for the project-shaped API, where two items sharing a
`trackIdx` is common (most fixtures in this corpus put unrelated items on
distinct tracks specifically to avoid this ambiguity — see
`fixtures/README.md`).

**Owner: SP4.**

## D8. `render-src-undefined-equals-undefined-quirk`

**Verified — preserved verbatim, not a resolver bug.** For a RENDER-variant
item with neither `src` nor `normalizedSrc` set, the comparison `usedNormalized
= chosenSrc === item.normalizedSrc` evaluates `undefined === undefined`, which
is `true` — so render treats such an item as "using the normalized cache" and
rebases its `inPoint`/`outPoint` to 0, even though there is no cache. This
comparison used to live inline in `render.js`; SP2's own T8 already extracted
it (see `render.js:652`'s comment "the arithmetic above moved") into
`src/source-window.js`'s `usedNormalizedCacheFor` (`source-window.js:213-214`,
`chosenSrcRaw === item.normalizedSrc`), which `render.js:652` now calls via
`sourceWindow(item, 'render')`. The resolver inherits this quirk on purpose —
"fixing" it here would change render's dry-run/encode output, which T8's
encode-args golden is specifically built to catch.

**CLOSED BY SP3 — both variants now share this quirk.** Preview's old check
(`!clip.nobg_preview_src && !!clip.normalizedSrc`) was guarded on
`normalizedSrc` truthiness and did NOT rebase in this case, which is what made
this a divergence. SP3 inserted the `proxySrc` tier ahead of `normalizedSrc`,
breaking that shortcut's "exactly one tier precedes `normalizedSrc`"
assumption, so `usedNormalizedCacheFor` collapsed to render's unconditional
`chosenSrcRaw === item.normalizedSrc` for BOTH variants — preview now inherits
the rebase-to-0 behavior too. See `src/source-window.js`'s "PRESERVED LEGACY
QUIRK, NOW SHARED BY BOTH VARIANTS" comment. The entry is retained because the
underlying render-side behavior is still deliberately preserved.

Such an item is already unrenderable (no playable source at all), so the
quirk has no independent user-visible consequence beyond the malformed-item
case D4 already covers. Pinned by `test/source-window.test.mjs`'s "Degenerate
item with no src, no normalizedSrc" describe block (line 488, updated in SP3
to assert both variants alike) — no dedicated
corpus fixture (deliberately: this corpus's fixtures all carry a real `src`,
per `fixtures/README.md`'s "never depend on real files" framing extended to
"never author a genuinely unplayable fixture item").

**Owner: SP4 — CLOSED by SP3 T4 (preview adopted render's unconditional
comparison; the two variants no longer diverge).**

## D9. `geometry-duplication-hazard` (was: `designcanvas-duplication-hazard`)

**Hazard, not a live divergence. Sub-entry (b) RETIRED 2026-08-23 (SP9a-1);
(a) and (c) remain open.** `src/geometry.js` extracts three formulas that
used to — and, for (a) and (c), still do — live independently on both the
editor and render sides. Extraction alone proves the two sides agree; it
does NOT retire an original copy on its own. All three started out as the
same shape of hazard: a future edit to one copy without the other silently
introduces a real divergence, with no test to catch it until editor/render
output actually shifts. SP9a-1 closed that hazard for (b) by switching every
call site over to the shared implementation; see (b) below for what proved
it safe. (a) and (c) still carry the open hazard — their original call sites
have not been switched.

**(a) `designCanvas` — the 1080-short-edge formula. OPEN.**
`editor/src/video/design-canvas.ts:5-11` (`getOverlayDesignCanvas`) and
`render/render.js:263-269` (inline in `render()`, no named export) implement
the identical formula:

    ratio = 1080 / min(w, h)
    [round(w*ratio/2)*2, round(h*ratio/2)*2]

Confirmed algebraically identical by direct comparison of both blocks (T4's
finding, re-verified during T5). They AGREE today — this is a positive
finding, not a divergence. Neither original copy has been switched over to
`src/geometry.js`'s `designCanvas` export. That export does have a consumer
today, though: `editor/src/engine/index.ts:801` (imported at `:46`), the SP4
WebCodecs engine, calls it directly — a THIRD call site sitting alongside the
two still-unswitched originals, not a replacement for either. (An earlier
version of this entry claimed none of the four `geometry.js` exports named
below had a consumer; that was true when written and has been false since
`b9562ce`.)

**(b) `toPixelBox`/`toCssBoxPct` — the scale/offset transform box. RETIRED
2026-08-23 (SP9a-1).** This was always THREE render-side copies, not two —
`render/encode-segment.js`'s `buildImageItemFilterParts`,
`buildVideoItemFilterParts` AND `buildOverlayFilterParts` all carried the
identical inline formula; the overlay copy went undocumented in this entry
until now. Plus the one editor copy, `editor/src/video/preview/transformStyle.ts`'s
`videoTransformBoxPct`. All four implemented the same scale/offset box
formula — see `src/geometry.js`'s module header for the side-by-side.
Confirmed algebraically identical (`test/geometry.test.mjs`'s cross-check
table); they agreed throughout, so this was always a positive finding, never
a live divergence.

SP9a-1 retired the hazard itself: all four call sites now route through
`toPixelBox`/`toCssBoxPct` instead of carrying their own copy —
`encode-segment.js:245` (image), `:305` (video), `:457` (overlay), and
`transformStyle.ts:36` (editor). Pinned by two things, in order: (1) a
15,309-combination differential switchover sweep in `test/geometry.test.mjs`
(`describe('D9 switchover gate — toPixelBox is byte-identical to the inline
formula')`) proving the shared implementation byte-identical to every inline
copy across 3 kinds x 7 canvases x 9 scales x 9x9 offsets, run BEFORE any
call site moved; and (2) the `geometry-non-identity` encode-args golden,
captured pre-refactor and byte-identical after. No copy of this formula
remains outside `src/geometry.js`.

**(c) `isFullFrameCrop` — the full-frame-crop short-circuit. OPEN.**
`editor/src/video/preview/sourceCropStyle.ts:35` (inside
`sourceCropVideoStyle`) implements `crop.x === 0 && crop.y === 0 && crop.w
=== 1 && crop.h === 1`. `src/geometry.js`'s `isFullFrameCrop` is a verbatim
port of that same check. Render has no equivalent call site (nothing on the
render side short-circuits a full-frame crop today), so this pair is
editor-vs-`geometry.js` only, not editor-vs-render. Not touched by SP9a-1 —
out of that plan's scope; `sourceCropStyle.ts:35` still holds its own inline
copy, unswitched.

`src/geometry.js`'s `designCanvas`/`toPixelBox`/`toCssBoxPct`/`isFullFrameCrop`
are the single implementations for all three formulas. As of SP9a-1,
`designCanvas` has one consumer (`engine/index.ts:801`) and `toPixelBox`/
`toCssBoxPct` have four consumers between them — the four call sites listed
under (b). `isFullFrameCrop` alone still has none. No fixture for (a)/(c):
both remain internally-agreeing hazards, not divergences, so there is no
editor/render behavior difference for a corpus fixture to pin.

**Owner: (a) SP3/SP4 backlog — designCanvas still duplicated in `render.js`
and `design-canvas.ts`. (b) CLOSED by SP9a-1 — no further owner. (c) SP3/SP4
backlog — `isFullFrameCrop` still duplicated in `sourceCropStyle.ts`.**

## D10. `bytrackidx-missing-trackidx-tie` — discovered in T7

**Verified empirically.** For an item carrying NO `trackIdx`, the pre-T7
comparator and `byTrackIdx` order differently.

- **Legacy** (`render/segment-plan.js:106`, pre-T7):
  `(a, b) => a.trackIdx - b.trackIdx`. Against a missing `trackIdx` this
  evaluates to `NaN`. Per ECMA-262 `SortCompare` — *"Let v be ? ToNumber(?
  Call(comparefn, …)). If v is NaN, return +0𝔽."* — a `NaN` result is coerced
  to `+0`, i.e. the pair is treated as EQUAL, and `Array.prototype.sort`'s
  stability leaves them in input order.
- **Resolver** (`src/activation.js:508`, `byTrackIdx`):
  `(a.trackIdx ?? 0) - (b.trackIdx ?? 0)`. The missing `trackIdx` reads as
  track 0, so the item sorts to the BACK of the stack (composited first).

Confirmed by direct execution rather than from the spec alone: sorting
`[{id:'x', trackIdx:5}, {id:'y'}]` yields `x,y` with the legacy comparator and
`y,x` with `byTrackIdx`.

**Unreachable in production.** `collectAllItems` (`render.js:598`) stamps
`trackIdx` on every item it emits, unconditionally, and it is the only producer
of the array `compose.js` hands to `planSegments`. The difference is therefore
reachable only by a direct caller or a test that omits the field.

**Disposition: keep `byTrackIdx` as-is; do NOT restore the legacy comparator.**
`?? 0` is defined behavior, whereas legacy's ordering was an accident of
`NaN`-coerced-to-`+0`. The primitive is shared with the project-shaped path and
with T9's `sample-frame.js` adoption, where inheriting that accident would be a
worse contract.

Pinned by `render/test/resolver-parity.test.mjs`, "divergence: an item with NO
trackIdx sorts differently (byTrackIdx treats it as 0)", which asserts both
orderings explicitly and confirms boundaries and activation are otherwise
identical — the divergence is ordering only. No corpus fixture: every fixture
here is well-formed, and this needs a deliberately field-less item.

**Owner: SP4** (alongside the other ordering entries, D7 in particular).

## D11-D13. Python (`serve/caption_job.py`) vs the TS resolver — ✅ ALL RESOLVED (2026-08-24)

**Resolved by deletion, not by porting the fix.** All three entries described
`serve/caption_job.py`'s `extract_segments` — a THIRD, independent port of
source-window math (Python can't import a TS package), kept in agreement with
the resolver by `tests/test_caption_job.py` running against this corpus's
fixtures/goldens rather than by shared code.

That function no longer exists. The caption job used to build a VIDEO cut of
`tracks[0]` and transcribe it, which is why it needed source-window resolution
at all: the `normalizedSrc` rebase existed so ffmpeg's concat never mixed HDR
originals with SDR caches in one graph. Captions are now transcribed from an
AUDIO mix of the whole audible timeline (`build_audio_mix_spec` →
`steps/audio/mix_timeline.py`), and an audio mix has no colour-space problem to
solve: every segment reads the ORIGINAL `src` with the raw, un-rebased
`inPoint`, and window LENGTH comes from the item's timeline span rather than a
stored `outPoint`. No cache selection, no rebase, no `outPoint` read — so none
of D11, D12 or D13 has any code left to diverge.

Python is consequently no longer a fourth reader of this corpus;
`tests/test_caption_job.py` now pins the audibility/positioning contract
instead. The three entries are kept below for the record.

The entries were never TS-vs-TS, so they were never in the Summary table
above, and their closure does not change it.

### D11. `python-all-or-nothing-cache-selection` — ✅ RESOLVED (2026-08-24, code deleted)

**Verified.** `extract_segments`'s cache switch (`serve/caption_job.py:47`,
`use_cache = bool(clips) and all(c.get("normalizedSrc") for c in clips)`) is
ALL-OR-NOTHING across every clip in `tracks[0]`: one clip missing
`normalizedSrc` drops the cache for every clip, including ones that have it.
`src/source-window.js`'s `sourceWindow` decides PER ITEM — each clip's cache
choice is independent of its neighbors, exactly matching what the editor
preview and render already do.

Consequence: a mixed `tracks[0]` (some clips cached, some not) gets NO
rebasing at all from the caption cut, while the TS resolver would rebase the
clips that do have a cache. No fixture in this corpus has a mixed `tracks[0]`
(every cache-related fixture here is uniformly all-cached or all-uncached) —
a corpus gap; T10 constructed the mixed case inline in
`tests/test_caption_job.py` (`test_all_or_nothing_cache_selection_diverges_from_ts_per_item`)
instead.

**Owner: closed.** (Was render/backlog, reassigned from SP4 per decision 7,
SP4 T8.) `extract_segments` was deleted when captions moved to the audible
timeline mix — see the section header above.

### D12. `python-negative-inpoint-clamp` — ✅ RESOLVED (2026-08-24, code deleted)

**Verified — includes a docstring/code mismatch, not just a divergence.**
`extract_segments` floors a negative rebased in-point at 0
(`serve/caption_job.py:59`, `in_pt = max(0.0, in_pt)`). `src/source-window.js`'s
`sourceWindow` never clamps — a negative `inPoint - origin` is returned
verbatim.

The clamp's own docstring (`serve/caption_job.py:31-32`) frames it as
protection against "tiny negative values (float rounding when inPoint ==
normalizedInPoint)", but the code clamps UNCONDITIONALLY on any negative
value — not just float noise near equality. T10 deliberately picked a
clearly-negative, non-tiny case to pin the actual (broader) code behavior
against the narrower docstring description.

No fixture in this corpus produces a negative rebased in-point (checked every
clip in the cache-bearing fixtures — none has `inPoint < normalizedInPoint`) —
another corpus gap; T10 constructed this inline too
(`test_cache_rebase_negative_in_point_clamped_to_zero`,
`test_outpoint_fallback_uses_unclamped_in_point_internally`).

**Owner: closed.** (Was render/backlog, reassigned from SP4 per decision 7,
SP4 T8.) `extract_segments` was deleted when captions moved to the audible
timeline mix — see the section header above.

### D13. `python-outpoint-null-vs-absent` — ✅ RESOLVED (2026-08-24, code deleted)

**Verified — narrow, reachable only outside type-checked authoring.**
`extract_segments`'s outPoint fallback (`serve/caption_job.py:58` in the cache
branch, `:63` in the non-cache branch) is `c.get("outPoint", <default>)`,
which only supplies `<default>` when the key is ABSENT. A clip carrying an
explicit `"outPoint": null` makes `.get()` return `None`, and the surrounding
`float(...)` call raises `TypeError: float() argument must be a string or a
real number, not 'NoneType'` — reproduced by T10's review rather than merely
asserted. `src/source-window.js`'s `sourceWindow` handles the same input via
`item.outPoint ?? undefined` (`source-window.js:253`), which treats `null` and
`undefined` identically and falls through to the derived-outPoint path with no
error.

`montaj_assets/editor/src/schema.ts:86` types `outPoint?: number` — optional,
not nullable — so type-correct editor code cannot author a literal `null`
here; the value is reachable only via raw JSON edits or an external writer
bypassing the schema. No fixture in this corpus authors an explicit `null`
outPoint (every cache-related fixture either sets a real number or omits the
key), so this is unexercised in the golden suite too.

**Owner: closed.** (Was render/backlog, reassigned from SP4 per decision 7,
SP4 T8.) `extract_segments` was deleted when captions moved to the audible
timeline mix — see the section header above.

---

# Discovered during SP4

SP4 T8's registry audit (decision 7) surfaced one further divergence, not
previously registered anywhere: preview never simulates audio ducking, while
render actually applies it. Same treatment as the SP2 finds above: what
diverges, exact `file:line` on both sides, user-visible consequence, owner,
fixture pointer.

## D14. `ducking-not-simulated-in-preview`

**Verified — an UNREGISTERED preview/render divergence, both sides read
directly.** `project.audio.tracks[].ducking` (`editor/src/schema.ts:25-30`,
`{ enabled: boolean, depth?: number, attack?: number, release?: number }`) is
authored in the operator UI — `montaj_assets/ui/src/components/timeline/ClipInspectModal.tsx:47-51`
seeds the panel's open state and its four fields from the track, `:75-79` writes them back into
`track.ducking` on save, and `:284-342` is the collapsible "Ducking" panel
itself, whose own help text (`:342`) states the intent plainly: "this track
automatically lowers in volume whenever a louder track is playing. Typical
use: enable on music so it ducks under voiceover."

**Render applies it for real.** `mix-audio.js`'s `buildAudioTrackFilters`
(`mix-audio.js:52-70`) branches on `track.ducking?.enabled`: it `asplit`s the
running mix into a `speech` copy and a sidechain-detector copy, applies the
track's own volume/fade to a scaled copy of itself, and feeds both through
ffmpeg's `sidechaincompress` filter (`mix-audio.js:67`) — `depth` (dB) is
mapped to a compressor `ratio`, `attack`/`release` pass straight through in
milliseconds — so the ducked track's volume genuinely drops whenever the rest
of the mix ("speech") is loud, then recovers.

**Preview never reads `ducking` anywhere.** Grepped across the whole editor
package (`montaj_assets/editor/src`, both the legacy `useVideoPlayback.ts`
audio lanes and SP4's own `useEnginePlayback.ts`) — zero hits outside
`schema.ts`'s type declaration. `timeline-core`'s `audioWindow`
(`src/audio.js`), which BOTH preview surfaces now call for their per-tick
audio-lane sync (legacy `useVideoPlayback.ts` as of this same T8; the engine
path since T6), computes `gain = baseVolume * max(0, fadeMul)` from
`volume`/`fadeIn`/`fadeOut` only — `AudioTrack`'s own JSDoc typedef
(`src/audio.js:57-67`) does not even list a `ducking` field. A track with
ducking enabled previews at its flat fade-envelope volume for the whole
timeline; the sidechain drop only appears in the rendered output, the first
time the author hears it.

**Consequence:** an author previewing a project with ducking enabled cannot
hear (or see, via any level meter) the effect they configured until they
render — the preview is silently wrong about what the final mix will sound
like, in the opposite direction from most of this file's entries (here render
has the extra behavior, not preview).

No fixture in this corpus exercises `ducking` (it is outside `src/audio.js`'s
pure per-tick-window scope the way `mix-audio.js`'s sidechain graph as a whole
is — see that module's own "not part of the pure arithmetic" framing used for
D1/D3 above).

**Owner: backlog** (genuinely unclear — simulating a real-time sidechain
compressor in the Web Audio graph is audio-DSP feature work, not something any
currently-scoped SP task claims. It is NOT SP4: plan decision 5 keeps
`project.audio.tracks` on plain `<audio>` elements with volume/fade only, and
adding a compressor node would be new engine scope beyond "WebCodecs video
playback," not a bookkeeping fix. Flagged here, matching how
`video-rotation-not-previewed` (D15) is flagged, so it isn't lost rather than
assigned to a sprint that isn't actually going to build it. This sentence used
to cite entry 1 (`rotation`) as the precedent; entry 1 closed in SP9a-2, so the
pointer moved to the open entry that still demonstrates the pattern.)

## D15. `video-rotation-not-previewed` — introduced by SP9a-2

**This is the registered trade of SP9a-2, not an oversight.** SP9a-2 taught
render to apply `rotation` on all three paths.

**Scope: the `tracks[0]` MAIN CLIP only.** Everything rendered by
`OverlayItemsLayer` is at full parity — image items, JSX overlays, **and
overlay-track video items**. `OverlayItemsLayer.tsx:507` puts
`rotate(${rotation}deg)` on the wrapper of every item in `interactiveTracks`,
and the `item.type === 'video'` branch (`:547`) renders `<OverlayVideo>` INSIDE
that wrapper with `{handles}` (`:588`) — so an overlay-track video both previews
rotated and is directly rotatable by the on-canvas handle. Only the main clip,
which `OverlayItemsLayer` never touches, is affected.

**The mechanism, stated precisely** (it is worth being exact, because a wrong
description sends the next maintainer to the wrong file — an earlier draft of
this entry blamed "the experimental engine canvas", which is not where the gap
lives):

`PreviewPlayer.tsx:3` imports `videoTransformContainerStyle` from
`preview/transformStyle.ts`. That function (`:24-30`) emits
`translate(${ox}%, ${oy}%) scale(${s})` — **no `rotate()` term at all** — and
`PreviewPlayer.tsx` contains zero occurrences of `rotate`. `toCssBoxPct`
(`src/geometry.js`) likewise ignores rotation by contract, the CSS-side twin of
`toPixelBox`'s pin.

Because `EngineSurface.tsx` renders *inside* that same transform container, the
legacy `<video>` path and the WebCodecs engine canvas share one origin for this
gap. **Both fail identically**, so this is not an engine-only issue, and fixing
it means teaching `videoTransformContainerStyle` to emit a `rotate()` term —
**one function** — rather than touching the engine compositor.

**How the main clip acquires `rotation` at all.** The on-canvas rotate handle
(`useDragOverlay.ts:54/139`) drives `OverlayItemsLayer`, which never renders the
main clip — so the handle cannot reach it. Two routes remain: paste-attributes
(`clipboard-ops.ts:287` forwards `rotation` when the source carries it, and the
source may be a rotated overlay-track item), and direct project-JSON authoring
by an agent — the ordinary path in an agent-native tool. So this is reachable,
not theoretical.

**Severity: low today, and here is the honest reason.** 0 of 229 items across
every real project carry a `rotation` key at all, so nothing in the workspace is
affected right now. That is exactly why SP9a-2 shipped the render half first:
closing the silent-drop trap before anyone falls into it.

**Owner: backlog.** Precedent for registering rather than fixing a
preview/render split mid-flight: `opaque-in-preview` (entry 2), which carried a
partially-unified state across SP4 with the legacy path left open.

## D16. `clip-crossfade-not-blended-on-the-legacy-video-path`

**Verified.** `ResolvedItem.crossfade` gives every consumer the blend factor
for a clip crossfade. The SP4 WebCodecs engine honours it (two decode sessions,
one composited paint) and render honours it (`encode-segment.js`'s `blend`
branch). The LEGACY `<video>` player cannot: it mounts one `<video>` element per
active clip and has no compositing stage in which to mix two decoded frames.

The disposition is NOT "let the legacy path hard-cut silently" — that is
exactly the preview/export divergence v4 was spent eliminating, and a silent
one would be invisible until export. **What actually shipped (Task 10b) is
narrower than an earlier draft of this entry described**: `eligibility.ts`'s
`engineRequiredReason(project)` answers "does this project need the engine
for a reason the legacy player can't serve" — clip crossfades are its one
reason today — but that answer is deliberately **NOT folded into
`checkProjectShapeEligibility`/`evaluateEngineEligibility`'s eligibility
verdict**. See `engineRequiredReason`'s own doc comment in `eligibility.ts`:
"Additive to the checks above... this is not part of
`checkProjectShapeEligibility`/`evaluateEngineEligibility`'s eligibility
verdict, it answers a different question." A project containing a clip
crossfade does **not** become engine-only, and an engine-ineligible project
with a crossfade does **not** get blocked from previewing.

Instead, `PreviewPlayer.tsx:650-659` renders a persistent, NON-BLOCKING
banner — "Crossfades will not appear in this preview. They will render in
the export." — whenever `playback.mode === 'legacy' && engineRequiredReason(project)
!== null`. The legacy `<video>` player still mounts and still plays; the
banner is the only difference, and it is recomputed on EVERY render
(deliberately not memoized into the once-per-load `useEngineMode`/`mode`
check — see the comment at that call site) so it appears the instant an
operator drags two clips into overlap and disappears the instant they pull
them apart, without remounting the player.

**Why non-blocking, not a hard eligibility gate.** Making crossfade detection
part of the eligibility verdict would make a WHOLE PROJECT un-previewable
over ONE transition — including during the perfectly ordinary window where a
project sits on the LEGACY player for a reason that has nothing to do with
crossfades at all: `checkProjectShapeEligibility` requires every `tracks[0]`
video item to carry `proxySrc` (`eligibility.ts:77-78`), and `proxySrc` is
written best-effort at import and can still be mid-encode. A project with one
freshly-imported, not-yet-proxied clip is legacy-bound for that reason alone
— and, per `useEngineMode`'s "evaluated once per project LOAD" rule, STAYS
legacy-bound for the rest of the session even once the proxy finishes, a
reload being the only way back onto the engine. Folding crossfade detection
into eligibility would mean a project in exactly that ordinary transient
state — proxy still encoding, nothing wrong with the project — could become
unpreviewable in ANY player the moment it also contained a crossfade, which
also compounds with the pre-existing `nobg_preview_src`-requires-legacy case
(v1's background-removed projects are legacy-only). A visible, honest notice
that the preview and the export will differ satisfies v4's "never silently
disagree" rule without paying that cost.

**The D17 qualification no longer applies (SP-transitions 9b).** It read: "two
decode sessions" exist only when the two clips resolve to DIFFERENT preview
srcs, so a pair off one proxy could not blend either. 9b closed that — the
incoming side of a blend now asks for a decoder of its own, and the engine
honours a crossfade whatever the two sides resolve to. The statement above is
unqualified again: the engine blends, render blends, and only the legacy
`<video>` player cannot.

**Owner: SP4 — closes when the legacy `<video>` player is retired.**

## D17. `same-src-clip-crossfade-not-blended-in-preview` — ✅ RESOLVED IN SP-transitions 9b (2026-08-26)

**Retained rather than deleted**, in the style of entry 1: this tracked the gap
from the moment T9 found it to the moment 9b closed it, hours later, and the
reasoning is the useful part of the record — particularly the argument for why
the invariant it bends was right in the first place.

**What it was.** Verified against the code, not inferred. A clip crossfade blended at render
and hard-cut in the ENGINE preview whenever both sides of the pair resolved to
the same preview src. Different srcs blended correctly, playing and scrubbing
alike. This was narrower than D16 — not the legacy `<video>` player, the
WebCodecs engine itself — and it had a different mechanism.

**The mechanism.** Three facts compose into the gap:

1. `FrameServer` is **one per `src`, refcounted by clip** (`engine/index.ts`'s
   module header states it outright: "Two clips never stream from one server at
   once"), and `acquireServer` (`engine/index.ts:618`) keys the map on `src`.
2. A frame server serves **one decode intent at a time**. `startStream`
   (`frame-server.ts:335`) and `seek` (`:310`) both open by calling
   `stopStream()`, and `claimReqId` (`:293`) marks every older pending seek
   superseded so it resolves `null`.
3. `engineSrcFor` (`engine/scheduler.ts`) always resolves to `item.proxySrc` —
   proxy-only playback is structural, not a preference.

So two clips cut from ONE take share a single decoder, and a crossfade between
them asks that decoder for two positions in the same file at the same instant.
There is no second position to read.

**Why the engine declined rather than trying.** `blendSideFor`
(`engine/scheduler.ts`) gated the blend on
`blendSource.frameServer !== outgoing.frameServer` and fell back to painting
the outgoing clip alone — the same fallback an undecoded incoming frame takes.
Without that guard the naive implementation is **worse than the hard cut it
replaces**: opening the incoming stream would stop the outgoing clip's stream,
and `nextFrameFor` would answer from the wrong place in the file. A stalled
picture reads as a decoder bug, not a missing transition.

**Severity: this was the COMMON case, not the exotic one** — which is why it was
closed the same day rather than carried. A silence-trimmed or select-takes
timeline is many clips off one proxy, so a dissolve between two adjacent cuts of
a single take — the ordinary jump-cut softener — landed here. Cross-source
crossfades, the rarer authoring gesture, were the ones that worked.

**What shipped (9b).** `SourceRequest.exclusiveServer` asks the host for a
decoder of this clip's own; `serverKeyFor` (`engine/index.ts`) files such a
session under `` `${src}#${clipId}` `` instead of `src`, and the session stores
the key it acquired so it releases that one rather than the one its current
request implies. `retainFor` sets the flag for `plan.blend`'s clip — and ONLY
when the two sides resolve to one src, because a cross-source pair already has
two decoders and the flag would just force the host to respawn a session it had
prewarmed. The invariant in fact 1 above is bent, not overturned: what it
actually saves is the demux, and `demuxCache` is keyed by `src` independently of
the server map, so the second decoder costs one worker and zero extra fetches
(pinned by `source-host.test.ts`'s "reuses the cached demux rather than
re-fetching"). The exclusive entry is re-filed under the shared key once that
key is free, so the extra worker does not outlive its reason.

**The same-server check in `blendSideFor` was KEPT as an assertion**, not
deleted: `exclusiveServer` makes the two sides distinct by construction, but if
they ever resolve to one server again, painting the outgoing frame alone is
still better than reading a stream from the wrong position. Pinned by
`engine/__tests__/scheduler.test.ts`'s "still paints the outgoing frame alone if
the host hands both sides one server", which reaches that branch through a fake
host that deliberately ignores the flag — the only way in now.

**Owner: ✅ closed (SP-transitions 9b).** D16's qualification is lifted with it;
the legacy `<video>` half of D16 is still open.

## D18. `audio-fade-curve-three-way-disagreement` — discovered 2026-08-26

**Open. Measured, not inferred.** Found while fixing D2; deliberately left
unfixed so it gets its own change rather than being folded into a timing fix.

Three consumers compute the audio fade envelope and **all three disagree** —
not by a shade of curve, but by 44 dB.

`fade-curve.ts`'s module header does enumerate "three consumers that must never
disagree about what a given shape sounds/looks like" — but **playback is not one
of them.** The three it lists are the envelope drawn on the bar
(`draw.ts`'s `drawFadeEnvelope`), the waveform's amplitude scaling
(`waveforms.ts`'s `drawWaveformBars`), and the rendered mix. Two of the three
are drawing consumers. The file that exists to enumerate who depends on this
math never counted the audible path at all, which is very likely why nobody
noticed that the audible path ignores the curve entirely.

| Consumer | Formula for `exp` | Where |
|---|---|---|
| Editor **playback** (what the operator HEARS) | linear `elapsed / fadeIn` — **the curve is never read at all** | `timeline-core/src/audio.js:108-111` (`audioWindow`) |
| Editor **drawing** (what the operator SEES) | `t²` | `editor/src/video/timeline/canvas/fade-curve.ts` (`fadeGain`) |
| **Render** (what ships) | ffmpeg `afade curve=exp` — a decade curve, ≈`10^(-5t)` | `render/mix-audio.js` (`buildFadeFilters`) |

`audioWindow` takes no `fadeInCurve`/`fadeOutCurve` argument and contains no
reference to either — so an operator who picks a curve changes the drawn
envelope and the exported audio, but never what they hear while editing.

### Why the gap is enormous, not cosmetic

ffmpeg's `exp` is nothing like the editor's `t²`. Measured by applying each
curve to a 1 kHz tone, decoding to raw PCM and taking the peak envelope per
200 ms window (normalised against an unfaded reference — lavfi's `sine` peaks
at 0.125, not full scale, which will silently halve your numbers if missed):

```
ffmpeg exp OUT: 0.999 0.562 0.316 0.177 0.100 0.056 0.031 0.018 0.010 0.006 0.003 ... 0
ffmpeg tri OUT: 1.000 0.949 0.900 0.850 0.800 0.750 0.700 0.650 0.600 0.550 0.500 ...
editor  t²  OUT: 1.000 0.902 0.810 0.722 0.640 0.562 0.490 0.422 0.360 0.302 0.250 ...
```

ffmpeg's `exp` is already at 0.1 one-fifth of the way through the fade and at
0.01 two-fifths through. The editor's `t²` is still at 0.64 and 0.36.

### The consequence: every auto-crossfade exports with a hole in it

`computeAutoCrossfade` (`editor/src/video/timeline/timeline-model.ts:517`)
builds a crossfade out of a fade-out plus a fade-in of equal length wherever
two audio tracks overlap — `a.fadeOut = b.fadeIn = round(overlap, 0.1s)`. It
pairs only ADJACENT tracks in start-sorted order (`i`, `i+1`), so three mutually
overlapping tracks get pairs (0,1) and (1,2) and no others.

It does this for any overlapping pair and does **not** look at whether the two
tracks share a source — nor at `lane` (`docs/schemas/project.md`: "independent of
`lane`, so tracks on different rows still crossfade with each other"). That makes
the correlated/uncorrelated caveat below load-bearing rather than academic: a 60s
music bed under a 60s voiceover on separate lanes is an overlapping adjacent
pair, so it gets `fadeOut = fadeIn = 60s` applied to both. The uncorrelated case
is not a hypothetical edge — it is this function's routine behaviour.

The case that surfaced this was two slices of the SAME file. That material is
maximally correlated, so the amplitudes ADD — unity sum is the criterion for an
inaudible crossfade. Sum of the two gains at the crossfade midpoint:

| curve | midpoint sum | worst dip |
|---|---|---|
| `tri` (linear) | 1.0000 | 0.00 dB — exactly flat |
| `exp` (**`DEFAULT_FADE_CURVE`**) | 0.0063 | **−44.0 dB** |
| `log` | 1.8796 | +5.5 dB boost |

Exact values, sampled at the fade midpoint. The 200 ms peak-envelope method
below reproduces them to within ±0.03 — close enough to trust the method, not
close enough to quote its output as the figure.

And across the three consumers, for the default `exp`:

| | midpoint sum | |
|---|---|---|
| playback (linear) | 1.000 | 0 dB — flat, sounds correct |
| drawing (`t²`) | 0.500 | −6 dB |
| render (ffmpeg `exp`) | 0.007 | **−43 dB** |

So the operator hears a clean crossfade and exports a near-total dropout. The
middle row is derived, not seen: the canvas draws each track's OWN envelope via
`fadeGain` and never draws the sum, so −6 dB is what the two drawn envelopes
imply if you add them by eye. Since `exp` is the default, this
affects every multi-clip audio timeline that has not had its curve changed by
hand.

### Corroborated end-to-end in a real render

The table above is synthetic (envelope probe). The same hole shows up in an
actual export. Two beds at −24 dB steady state, A fading out 4→5s and B fading
in 5→5.5s, both on the default `exp`, measured with `volumedetect` in 200 ms
windows:

```
4.2-4.4s  -50.8 dB      5.0-5.2s  -90.3 dB
4.4-4.6s  -70.8 dB      5.2-5.4s  -53.8 dB
4.6-4.8s  -90.3 dB      5.4-5.6s  -26.3 dB
4.8-5.0s  -91.0 dB      5.6-5.8s  -24.1 dB
```

Roughly **0.8 seconds of audible silence** (4.4→5.2s below −70 dB) in material
that never drops below −24 dB on either side of it.

Note this particular fixture is a *non-overlapping* seam — A ends exactly where
B begins — so nothing is summing here; each track is simply already inaudible
well before its own fade edge, because `exp` reaches 0.01 two-fifths of the way
through. An overlapping crossfade (what `computeAutoCrossfade` actually
produces) sums the two and lands at the −43 dB figure in the table above. Same
root cause, and neither case is visible in preview.

### The fix is `tri` — but ONLY because the material is correlated

**Do not write down "linear is correct" without this qualifier.** For two
slices of the same file the amplitudes add, so linear (`tri`) summing to 1.0
is exactly right. For UNCORRELATED material — music under a voiceover, two
different beds — the powers add instead, the correct choice is an equal-power
crossfade, and linear would itself dip about 3 dB. A fix that blanket-switches
every crossfade to linear will improve the same-source case and degrade the
music-under-voice case.

`ffmpegFadeCurve()`'s `linear → tri` mapping in `mix-audio.js` is correct and
is not implicated; the question is which curve `computeAutoCrossfade` should
CHOOSE for a same-source crossfade, plus whether `audioWindow` should honour
the curve at all so preview stops lying about it.

**Owner: unassigned (render + editor — needs its own plan).** Out of scope for
the D2 timing fix, which deliberately changed no curve and did not touch
`computeAutoCrossfade`. Note this is a strictly separate axis from D14
(`ducking-not-simulated-in-preview`) and from D2: D2 was WHEN the fade fires,
this is WHAT SHAPE it has once it does.

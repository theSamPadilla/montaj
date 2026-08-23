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
| `rotation` | An overlay/image's `rotation` field | Applied to the on-canvas transform | NEVER read anywhere in the encode path — exports un-rotated | backlog / SP7 | none (documented in `src/geometry.js`'s module header; `Geometry.rotation` is carried but `toPixelBox` refuses to consume it) |
| `opaque-in-preview` | An overlay's `opaque` flag | SP4 engine: unified to render semantics by construction (picture suppressed, audio kept). Legacy `<video>` path: never read — the video underneath stays visible | Gates video COMPOSITING only (audio still sourced) via the segment-level `opaqueVideo` flag | SP4 — engine unified (T5); legacy path open until removed | `fixtures/opaque-overlay.json` |
| `dead-render-outpoint` | A video item's stored `outPoint` when it has drifted from `end - start` | N/A (preview derives its own effective outPoint) | See `audio-outpoint-not-derived` below — render mirrors this same "trust the stored value" pattern for the AUDIO track case; the VISUAL item case is the base entry here | SP4 (visual-item case) / render backlog (audio case — `mix-audio.js`, see D1) | `fixtures/trim-after-cache.json` (rebase math), `fixtures/audio-outlasts-video.json` (companion audio-track case) |
| `audio-duration-mismatch` | Project "duration" | `projectEnd` — `max(videoEnd, overlayEnd, audioEnd)`, AUDIO INCLUDED | `visualDuration` — max `end` over every VISUAL item, AUDIO EXCLUDED | SP4 — preview half CLOSED (T8: `projectEnd` adopted in both the legacy hook and the engine); render/truncation half open, see follow-up in the entry | `fixtures/audio-outlasts-video.json` |
| `caption-1080x1920-hardcode` | The caption PAINT layer's render resolution | `CaptionPreview.tsx:40-41` hardcodes `RENDER_W=1080`/`RENDER_H=1920` regardless of the project's actual resolution | N/A (render's caption Puppeteer segment already uses the project's real canvas) | SP5 | none — no fixture in this corpus exercises caption painting (out of scope for `activeCaptionSegment`, which is SELECTION not sizing; see `src/captions.js`'s module header) |
| `nobg-precedence` | Which src an item with `remove_bg` + `nobg_src` but no `nobg_preview_src` plays | Falls through to `normalizedSrc` (rebased) | Uses `nobg_src` (un-rebased, full source) | SP4 | `fixtures/nobg-matrix.json` (row `nobg-110`) |
| `loop-not-rendered-transition-dead-field` | A video item's `loop` and `transition` fields | `loop` is honored (`useVideoPlayback.ts:633/700/779`); `transition` is read NOWHERE in the editor either. SP4's engine reimplements `loop` (`engine/scheduler.ts`'s `placeInSource`/`endsOnLoopBoundary`); dropping loop support entirely was considered and rejected — it stays flagged as an operator option, not defaulted | Neither field is read anywhere under `montaj_assets/render/*.js` (grepped — zero hits) | SP4 / schema-cleanup backlog | `fixtures/loop-item.json` |
| `sourcecrop-missing-dims-silent-drop` | A `sourceCrop` with no `sourceWidth`/`sourceHeight` | `sourceCropVideoStyle` (`sourceCropStyle.ts:32`) returns `null` early (`!sourceWidth \|\| !sourceHeight`) — falls back to full-frame, same as render. SP4's engine (`engine/scheduler.ts`'s `sourceCropDrawPlan`) keeps the same parity-safe no-dims→no-crop guard rather than the `PreviewPlayer.tsx` call-site fallback that would have made the divergence worse | `buildVideoItemFilterParts`'s gate (`encode-segment.js:243`, `if (sc && item.sourceWidth && item.sourceHeight)`) silently skips the crop filter step entirely | SP3 / SP4 | `fixtures/source-crop-missing-dims.json` + `expected/encode-args.source-crop-missing-dims.json` (no `crop=` filter step present — verified empirically) |

## 1. `rotation`

Preview (`OverlayItemsLayer.tsx:377/451` read `g.rotation`, falling back from
any live drag state; `:379/494` apply `rotate(${rotation}deg)` to the on-canvas
CSS transform — two call sites, one for track-0 canvas items, one for overlay
tracks) ultimately reads `item.rotation ?? 0` via `geometryFor` (see below).
Render (`encode-segment.js`'s `buildImageItemFilterParts`, `buildVideoItemFilterParts`,
`buildOverlayFilterParts`) has no rotation handling anywhere — grepped, zero
hits. An overlay or image rotated in the editor exports un-rotated.

`geometryFor` (`src/geometry.js:264-276`) carries `item.rotation ?? 0` (line 274)
on the returned `Geometry` so a future fix has somewhere to read it from, but
`toPixelBox` (the render pixel adapter) deliberately does not consume it —
see `test/geometry.test.mjs` for the assertion that pins that boundary.

**Owner: backlog / SP7.**

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

## D2. `mix-audio-afade-curve-unverified`

**RESOLVED — CHECKED IN SP4 T8. NOT a live divergence: both sides are linear.**

The preview computes a LINEAR fade ramp (`elapsed / fadeIn`,
`src/audio.js:105-110`, inside `audioWindow` — `useVideoPlayback.ts` no longer
computes this inline as of SP4 T8; the hook's `syncAudioTracks` now calls
`audioWindow` for the gain envelope, same as `useEnginePlayback.ts` already
did). `mix-audio.js` emits `afade=t=in:d=${fadeIn}` (line 62) /
`afade=t=out:...` (line 63) with no explicit `curve=` parameter, which means
ffmpeg's `afade` filter uses its OWN DEFAULT curve.

**The check:** `ffmpeg -h filter=afade` (ffmpeg 8.1.2, this machine) documents:

    curve             <int>        ..F.A....T. set fade curve type (from -1 to 22) (default tri)
      tri             0            ..F.A....T. linear slope

`tri` — ffmpeg's own name for "linear slope" — is the DEFAULT `curve`, and it
is exactly the linear ramp the preview computes. `mix-audio.js`'s bare
`afade=t=in:d=...` / `afade=t=out:...` (no `curve=` override) therefore
renders a linear fade, matching preview's `elapsed / fadeIn` /
`remaining / fadeOut` ramp. No divergence exists here; this was an honestly-
flagged unknown that resolved in the "they already agree" direction once
checked.

**Owner: SP4 — CLOSED (T8, verified via `ffmpeg -h filter=afade`; no code
change needed since there is nothing to fix).**

## D3. `mix-audio-duplicated-fade-formula`

**Verified — drift hazard, not a live divergence.** `mix-audio.js`'s
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

**Owner: render/backlog** (reassigned from `schema-cleanup / SP4 backlog` per
decision 7, SP4 T8 — this is internal `mix-audio.js` code health, not
`editor/src/engine/` work; SP4's scope ends at the preview/engine boundary).

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

## D11-D13. Python (`serve/caption_job.py`) vs the TS resolver

D1-D10 above are all TS-vs-TS (preview vs render) — the axis this file's
Summary table tracks. `serve/caption_job.py`'s `extract_segments` is a THIRD,
independent port of source-window math (Python can't import a TS package),
kept in agreement with the resolver by `tests/test_caption_job.py` running
against this corpus's fixtures/goldens rather than by shared code (see
`docs/ARCHITECTURE.md`'s resolver section). T10 built that test and, in doing
so, found three places Python's port disagrees with `src/source-window.js`.
None of these are TS-vs-TS, so none belong in the Summary table above — same
treatment T10 itself used, filed here as an extension of "Discovered during
SP2" rather than a ninth Summary row.

### D11. `python-all-or-nothing-cache-selection`

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

**Owner: render/backlog** (reassigned from SP4 per decision 7, SP4 T8 —
`serve/caption_job.py` is the Python captioning pipeline, not `editor/src/engine/`
work; SP4's scope ends at the preview/engine boundary).

### D12. `python-negative-inpoint-clamp`

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

**Owner: render/backlog** (reassigned from SP4 per decision 7, SP4 T8 —
`serve/caption_job.py` is the Python captioning pipeline, not `editor/src/engine/`
work; SP4's scope ends at the preview/engine boundary).

### D13. `python-outpoint-null-vs-absent`

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

**Owner: render/backlog** (reassigned from SP4 per decision 7, SP4 T8 —
`serve/caption_job.py` is the Python captioning pipeline, not `editor/src/engine/`
work; SP4's scope ends at the preview/engine boundary).

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
playback," not a bookkeeping fix. Flagged here, matching how entry 1
(`rotation`) is flagged, so it isn't lost rather than assigned to a sprint that
isn't actually going to build it.)

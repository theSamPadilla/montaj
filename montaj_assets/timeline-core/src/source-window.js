// @ts-check
// montaj_assets/timeline-core/src/source-window.js
//
// Source-window math: given a timeline item, which file does the consumer
// actually load, and what in/out points does it seek to inside THAT file?
//
// This module is the single implementation of logic that shipped twice:
//
//   (1) editor preview — montaj_assets/editor/src/video/preview/useVideoPlayback.ts:29-88
//       (`playbackSrcFor` / `effectiveInPoint` / `effectiveOutPoint`)
//   (2) render         — montaj_assets/render/render.js:605-632, inside `collectAllItems`
//
// Both originals are quoted verbatim below next to the branch that reproduces
// them, so the port stays auditable and the legacy copies were
// deletable-by-inspection once T6 / T8 swapped them over — which they have:
// useVideoPlayback.ts and render.js both now call this module's exports
// directly (see their own headers) instead of carrying their own copies.
//
// ── The domain, in one paragraph ────────────────────────────────────────────
//
// A timeline item stores `inPoint` / `outPoint` in ORIGINAL-SOURCE coordinates
// — always, without exception. `video/cuts.ts` and every editing operation
// write them that way and never rebase; rebasing is deliberately a READ-TIME
// concern, which is exactly why it lives here. But the file a consumer loads is
// not always the original:
//
//   • `normalizedSrc` is a per-window normalized CACHE. It covers exactly
//     [normalizedInPoint, normalizedInPoint + duration] of the original and
//     plays from its own time 0. When a consumer substitutes the cache it MUST
//     rebase in/outPoint by the cache origin, or every seek lands in the wrong
//     place. The origin is `normalizedInPoint ?? inPoint ?? 0`: when the field
//     is present the cache was built for a specific window that may no longer
//     equal the current inPoint (e.g. the user start-trimmed after the cache
//     was built — Bug A); when it is absent (legacy caches) the cache was built
//     assuming it starts at the clip's inPoint, so origin = inPoint and the
//     rebase collapses to the old "rebase to 0" behavior.
//
//   • `nobg_preview_src` (VP9 WebM with alpha, browser-decodable) and
//     `nobg_src` (ProRes 4444, render-only — browsers cannot decode it) are
//     background-removal artifacts covering the FULL source, not a window.
//     They are NOT caches, so they must keep the original in/outPoint. Getting
//     this wrong shifts every bg-removed clip by the cache origin.
//
// ── Purity ──────────────────────────────────────────────────────────────────
//
// No Date, no Math.random, no I/O, no globals, no mutation of the input item.
// Same inputs always produce the same outputs. Every function is total over
// valid inputs: `inPoint` is always a finite number, `src` is always a string.
// An invalid `variant`, by contrast, throws — see `assertVariant`.

/**
 * Which consumer is asking. Preview and render legitimately differ (src
 * precedence, and therefore whether the normalized cache is in play at all);
 * this package is variant-aware rather than silently unifying them, because
 * collapsing the two would change render output.
 *
 * @typedef {'preview' | 'render'} Variant
 */

/**
 * The subset of a timeline `VisualItem` (montaj_assets/editor/src/schema.ts:78)
 * that source-window math actually reads. Deliberately structural and minimal:
 * anything not listed here is not consulted.
 *
 * `start` / `end` are required by the project schema but typed optional here so
 * the functions stay total over partial fixtures; absent means 0.
 *
 * @typedef {Object} SourceWindowItem
 * @property {string} [src]               Original source file (never replaced on the item itself).
 * @property {string} [normalizedSrc]     Per-window normalized cache; plays from its own time 0.
 * @property {number} [normalizedInPoint] Source-time the cache starts at. Absent ⇒ assume `inPoint`.
 * @property {string} [proxySrc]          Full-source 720p AV1+Opus editing proxy (SP3). Like the
 *                                        `nobg_*` artifacts, covers the WHOLE source — never a
 *                                        window, so never rebased. Preview-only: render must never
 *                                        choose it (see the render-guard test in
 *                                        test/source-window.test.mjs).
 * @property {string} [nobg_src]          ProRes 4444 alpha artifact — render only, full source.
 * @property {string} [nobg_preview_src]  VP9 WebM alpha artifact — preview only, full source.
 * @property {boolean} [remove_bg]        Whether background removal is active for this item.
 * @property {number} [inPoint]           Original-source in point, seconds.
 * @property {number} [outPoint]          Original-source out point, seconds.
 * @property {number} [start]             Timeline start, seconds.
 * @property {number} [end]               Timeline end, seconds.
 */

/**
 * The resolved window: what to load and where to seek inside it.
 *
 * @typedef {Object} SourceWindow
 * @property {string | undefined} src        File the consumer should load. PREVIEW always yields a
 *                                           string — `''` when the item has no src field at all,
 *                                           the tail useVideoPlayback.ts:30 has always had. RENDER
 *                                           can yield `undefined`, faithfully reproducing
 *                                           render.js:611, which has no such tail. The asymmetry is
 *                                           deliberate: preview's totality guarantee is stronger
 *                                           than render's by design (see `sourceWindow`).
 * @property {number} inPoint                In point in the CHOSEN src's own timeline. Always finite.
 * @property {number | undefined} outPoint   Out point in the chosen src's timeline, or undefined
 *                                           when the item stores none (callers synthesize — see
 *                                           `synthesizedOutPoint`). A stored `null` normalizes to
 *                                           `undefined`, matching the legacy `== null` checks.
 * @property {boolean} usedNormalizedCache   Whether the normalized cache was chosen, i.e. whether
 *                                           in/outPoint above were rebased by the cache origin.
 */

/**
 * A bad `variant` is a programming bug, never a runtime condition, so it throws
 * instead of quietly defaulting. Defaulting would make preview/render mix-ups
 * invisible, and the preview↔render differences are exactly what this module
 * exists to keep honest.
 *
 * @param {Variant} variant
 * @returns {void}
 */
function assertVariant(variant) {
  if (variant !== 'preview' && variant !== 'render') {
    throw new TypeError(
      `@bycrux/timeline-core: unknown variant ${JSON.stringify(variant)} — expected 'preview' or 'render'.`,
    )
  }
}

/**
 * Src selection, before the totality `?? ''` tail. The raw (possibly undefined)
 * value is what the render guard compares against, so it must stay un-tailed
 * internally — see `usedNormalizedCacheFor`.
 *
 * Preview, verbatim from useVideoPlayback.ts:29-31:
 *
 *     return clip.nobg_preview_src ?? clip.normalizedSrc ?? clip.src ?? ''
 *
 * Render, verbatim from render.js:611:
 *
 *     const chosenSrc = item.nobg_src && item.remove_bg ? item.nobg_src : (item.normalizedSrc ?? item.src)
 *
 * @param {SourceWindowItem} item
 * @param {Variant} variant
 * @returns {string | undefined}
 */
function chooseSrcRaw(item, variant) {
  if (variant === 'preview') {
    // SP3: `proxySrc` — a full-source 720p AV1+Opus editing proxy — is
    // inserted here, AFTER `nobg_preview_src`, not at the head of the chain.
    // `nobg_preview_src` is VP9-with-alpha; an opaque proxy ahead of it would
    // resurrect a removed background in preview while render (which never
    // reads `proxySrc` at all — see chooseSrcRaw's render branch below and
    // the render-guard test) still composites the alpha artifact underneath.
    // That would be a NEW preview/render divergence of exactly the class this
    // module exists to eliminate, so the ordering is load-bearing, not
    // cosmetic. Like the nobg artifacts, `proxySrc` is full-source — no
    // `proxyInPoint`, no window — so the cache guard below already refuses to
    // rebase it.
    return item.nobg_preview_src ?? item.proxySrc ?? item.normalizedSrc ?? item.src
  }
  // Render never loads nobg_preview_src (it wants the ProRes) and never loads
  // nobg_src unless remove_bg is actually on — a stale nobg artifact on an item
  // whose bg-removal was switched off must not resurrect itself.
  return item.nobg_src && item.remove_bg ? item.nobg_src : (item.normalizedSrc ?? item.src)
}

/**
 * Whether the normalized cache is the chosen src, and therefore whether the
 * in/outPoint rebase applies.
 *
 * Render, verbatim from render.js:612:
 *
 *     const usedNormalized = chosenSrc === item.normalizedSrc
 *
 * SP3: preview now uses this SAME expression instead of its own shortcut.
 * Before `proxySrc` existed, preview's check was, verbatim from
 * useVideoPlayback.ts:61 / :84:
 *
 *     const usingNormalizedCache = !clip.nobg_preview_src && !!clip.normalizedSrc
 *
 * That shortcut only worked because exactly one tier (`nobg_preview_src`)
 * could precede `normalizedSrc` in the preview chain — "nothing preferred
 * normalizedSrc" and "normalizedSrc IS the chosen src" were the same fact.
 * Inserting `proxySrc` between them broke that equivalence: an item carrying
 * BOTH `proxySrc` and `normalizedSrc` (a real case — lazy clips get an
 * import-time proxy while `normalize_window` later writes `normalizedSrc` on
 * the same items) still satisfies the old shortcut (no `nobg_preview_src`,
 * `normalizedSrc` present) and would rebase by `normalizedInPoint` even
 * though the chosen src is the full-source proxy — seeking the wrong time
 * silently. Comparing `chosenSrcRaw` directly, like render always has, asks
 * "is the cache literally what got picked" instead of "did nothing else win
 * first", so it stays correct no matter how many tiers precede
 * `normalizedSrc` in the future.
 *
 * KNOWN DIVERGENCE — "nobg precedence" (registry: KNOWN-DIVERGENCES.md, created
 * in T5; owner SP4). For an item with `remove_bg` + `nobg_src` but NO
 * `nobg_preview_src`, preview picks the normalized cache (rebased) while render
 * picks the un-rebased nobg ProRes. That is currently-shipping behavior; SP2
 * documents it and does not fix it. See the matrix test in
 * test/source-window.test.mjs.
 *
 * PRESERVED LEGACY QUIRK, NOW SHARED BY BOTH VARIANTS — an item with neither
 * `src` nor `normalizedSrc` (nor `proxySrc` nor `nobg_preview_src`) compares
 * `undefined === undefined`, which is TRUE, so `usedNormalizedCache` is true
 * and in/outPoint rebase to 0 even though there is no cache at all. Before
 * SP3 this was render-only (preview's old shortcut was guarded on
 * `!!normalizedSrc` and did not rebase here); unifying the two expressions
 * means preview now inherits it too. Such an item is already unrenderable —
 * no playable source at all — so the quirk has no independent user-visible
 * consequence. See test/source-window.test.mjs's "Degenerate item with no
 * src, no normalizedSrc" describe block, updated in T4 to assert both
 * variants alike.
 *
 * @param {SourceWindowItem} item
 * @param {Variant} variant
 * @param {string | undefined} chosenSrcRaw
 * @returns {boolean}
 */
function usedNormalizedCacheFor(item, variant, chosenSrcRaw) {
  return chosenSrcRaw === item.normalizedSrc
}

/**
 * Resolve which file to load for `item` and the in/out points inside that
 * file's own timeline.
 *
 * The rebase origin is `normalizedInPoint ?? inPoint ?? 0` for BOTH variants.
 *
 * The `?? 0` tail is the one sanctioned behavior change in SP2 T2: render.js:613
 * reads `item.normalizedInPoint ?? item.inPoint` with no tail, so a
 * `normalizedSrc` item carrying neither origin field produced `NaN` and fed it
 * straight to ffmpeg's `-ss`. The editor already had the tail; render now
 * matches. A missing origin means "origin 0", never NaN.
 *
 * @param {SourceWindowItem} item
 * @param {Variant} variant
 * @returns {SourceWindow}
 */
export function sourceWindow(item, variant) {
  assertVariant(variant)

  const chosenSrcRaw = chooseSrcRaw(item, variant)
  const usedNormalizedCache = usedNormalizedCacheFor(item, variant, chosenSrcRaw)
  // The `?? ''` tail is PREVIEW-ONLY, exactly as in the originals.
  //   • preview: useVideoPlayback.ts:30 ends its chain with `?? ''`, so the
  //     editor never assigns `undefined` to `video.src`.
  //   • render: render.js:611 has NO tail — `chosenSrc` can be `undefined` and
  //     flows into collectAllItems' output that way today. That is preserved
  //     verbatim for legacy fidelity: a src-less video item is unrenderable
  //     either way, but `''` and `undefined` fail DIFFERENTLY downstream
  //     (`item.src.split('/')`, `existsSync(item.src)`), and collectAllItems'
  //     output must stay byte-identical for T8's encode-args golden. Do not
  //     "make render total" here — that is a behavior change with its own plan.
  const src = variant === 'preview' ? (chosenSrcRaw ?? '') : chosenSrcRaw
  const inPointRaw = item.inPoint ?? 0
  // Legacy checks `clip.outPoint == null` (useVideoPlayback.ts:83, render.js:620),
  // which catches both null and undefined; `?? undefined` reproduces that and
  // normalizes a stored null to undefined so the return type stays honest.
  const outPointRaw = item.outPoint ?? undefined

  if (!usedNormalizedCache) {
    // Full-source src (original, or a nobg alpha artifact): the stored points
    // are already in this file's coordinates.
    return { src, inPoint: inPointRaw, outPoint: outPointRaw, usedNormalizedCache: false }
  }

  const origin = item.normalizedInPoint ?? item.inPoint ?? 0
  return {
    src,
    inPoint: inPointRaw - origin,
    outPoint: outPointRaw === undefined ? undefined : outPointRaw - origin,
    usedNormalizedCache: true,
  }
}

/**
 * The src-selection half of `sourceWindow` on its own, for callers that only
 * need the file path (e.g. preloading the next clip into an idle video element).
 * Always agrees with `sourceWindow(item, variant).src`, including the
 * preview-only `?? ''` tail: preview always returns a string, render can return
 * `undefined` for an item with no src field, faithfully reproducing
 * render.js:611. See the `src` note on the `SourceWindow` typedef.
 *
 * T6 turns the editor's `playbackSrcFor` into a one-line wrapper that pins
 * `variant` to `'preview'`, which is the branch that keeps the string guarantee.
 *
 * @param {SourceWindowItem} item
 * @param {Variant} variant
 * @returns {string | undefined}
 */
export function playbackSrcFor(item, variant) {
  assertVariant(variant)
  const chosenSrcRaw = chooseSrcRaw(item, variant)
  return variant === 'preview' ? (chosenSrcRaw ?? '') : chosenSrcRaw
}

/**
 * Where to seek inside the chosen src to show timeline time `t`.
 *
 *     effectiveInPoint + max(0, t - item.start)
 *
 * Both consumers already compute exactly this:
 *   • useVideoPlayback.ts:680 — `Math.max(inPoint, inPoint + (currentTime - clip.start))`
 *   • encode-segment.js:217-218 — `seekOffset = Math.max(0, segStart - item.start); actualIn = inPt + seekOffset`
 *
 * The clamp matters for items whose window starts before the requested time
 * (render segments and preview scrubs both hand in times outside the item).
 *
 * @param {SourceWindowItem} item
 * @param {number} t Timeline time in seconds.
 * @param {Variant} variant
 * @returns {number}
 */
export function seekTime(item, t, variant) {
  const { inPoint } = sourceWindow(item, variant)
  return inPoint + Math.max(0, t - (item.start ?? 0))
}

/**
 * The out point to use when the item stores none: fall back to the item's
 * timeline duration measured from the EFFECTIVE in point.
 *
 * This is useVideoPlayback.ts:707's rule:
 *
 *     const clipInPoint = effectiveInPoint(clip)
 *     const outPoint = effectiveOutPoint(clip) ?? clip.end - clip.start + clipInPoint
 *
 * NOT cuts.ts:120-121's rule, which looks similar but is not the same function:
 *
 *     const inPoint  = item.inPoint  ?? 0
 *     const outPoint = item.outPoint ?? (inPoint + (item.end - item.start))
 *
 * cuts.ts builds on the RAW in point on purpose: it edits the project and must
 * write results back in original-source coordinates, where no rebase applies.
 * This function builds on the EFFECTIVE in point because its consumers compare
 * the result against a playhead in the chosen src's coordinates. With a
 * normalized cache in play the two disagree by exactly the cache origin — that
 * is correct, not a bug, and neither should be "fixed" into the other.
 *
 * Takes a `variant` for the same reason `sourceWindow` does: the effective in
 * point it builds on is variant-dependent, and an implicit default would hide
 * preview/render mix-ups.
 *
 * @param {SourceWindowItem} item
 * @param {Variant} variant
 * @returns {number}
 */
export function synthesizedOutPoint(item, variant) {
  const w = sourceWindow(item, variant)
  if (w.outPoint !== undefined) return w.outPoint
  return w.inPoint + ((item.end ?? 0) - (item.start ?? 0))
}

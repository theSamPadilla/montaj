/**
 * SP4 T1 — the playback engine's own eligibility gate.
 *
 * `../video/preview/proxySupport.ts` already gates the LEGACY `<video>`
 * player: it probes `<video>`/MediaSource decode support for the H.264+Opus
 * proxy MIME and strips `proxySrc` from an item when unsupported. The engine
 * never touches `<video>` — it decodes via WebCodecs directly — so it cannot
 * reuse that probe or its cache; it runs its OWN capability read via the
 * `VideoDecoder`/`AudioDecoder` `isConfigSupported` statics. Same target
 * codecs (avc1 video + opus audio, muxed in the SP3 editing-proxy's MP4),
 * two independent browser API surfaces, evaluated independently. Do NOT
 * import `proxySupport.ts` here, and do not import this module there — see
 * the plan's decision 2.
 *
 * Two halves, deliberately separable so the pure part is trivially unit
 * tested without touching the (jsdom-less, WebCodecs-less) browser probe:
 *   - `checkProjectShapeEligibility` — pure, sync: every track-0 video item
 *     must carry `proxySrc`, and none may require `nobg_preview_src` (a VP9
 *     WebM-with-alpha preview — the engine's demuxer is MP4-only in v1).
 *   - `engineCapabilitySupported` — async, session-cached, same
 *     cache-and-test-hook shape as `proxySupport.ts`'s
 *     `proxyPlaybackSupported`.
 * `evaluateEngineEligibility` composes both: shape first (cheap, sync, no
 * await needed when a project already disqualifies itself on content), then
 * the capability probe — matching decision 2's "(a) AND (b)" gate.
 *
 * Called once per project-load; the call-site semantics (a React effect,
 * re-evaluated only on project identity change, with per-clip Preparing-
 * placeholder fallback rather than a whole-project revert) land in T6. This
 * module is the pure/async logic T6 calls into.
 */
import { transitionPairs } from '@bycrux/timeline-core'
import type { EditorProject as Project } from '../schema'
import { enabledTrackItems, trackItems } from '../video/timeline/timeline-model'

export interface EligibilityResult {
  eligible: boolean
  reason?: string
}

/**
 * The SP3 editing proxy's video codec — matches `proxySupport.ts`'s
 * PROXY_MIME target (same encoder output, independently probed via a
 * different API). avc1.640028 = High profile @ level 4.0: libx264's actual
 * default output (High, not Main; 720p above 30fps needs level 4.0 over
 * 3.1). Keep in sync with `lib/proxy.py`'s encoder params — this describes
 * what libx264 emits, not a target to constrain it to.
 */
const ENGINE_VIDEO_CODEC = 'avc1.640028'
/**
 * Opus decodes at a fixed internal rate of 48kHz regardless of source/encode
 * rate (a codec-level guarantee, not a pipeline convention), so probing at
 * 48kHz/stereo is representative of every proxy — see `lib/proxy.py`'s
 * `libopus` encode, which sets no explicit `-ar`/`-ac` and relies on exactly
 * this. Channel count is not load-bearing for `isConfigSupported`'s verdict;
 * 2 matches the documented pipeline assumption.
 */
const ENGINE_AUDIO_CODEC = 'opus'
const ENGINE_AUDIO_SAMPLE_RATE = 48000
const ENGINE_AUDIO_CHANNELS = 2

/**
 * Pure project-shape check: every track-0 video item is proxied and
 * MP4-safe. Vacuously eligible for a project with no track-0 video items
 * (e.g. a canvas-only background-image project) — the scheduler's
 * wall-clock-fallback clock covers those (T5), no video decode required.
 */
export function checkProjectShapeEligibility(project: Project): EligibilityResult {
  const videoClips = (trackItems(project)[0] ?? []).filter((item) => item.type === 'video')
  for (const clip of videoClips) {
    if (clip.nobg_preview_src) {
      return {
        eligible: false,
        reason: `clip "${clip.id}" requires nobg_preview_src (WebM alpha) — the engine's demuxer is MP4-only in v1`,
      }
    }
    if (!clip.proxySrc) {
      return { eligible: false, reason: `clip "${clip.id}" has no proxySrc yet` }
    }
  }
  return { eligible: true }
}

let capabilityCache: boolean | null = null

/**
 * WebCodecs capability probe: can this browser decode the SP3 editing
 * proxy's codecs (avc1 video + opus audio)? Cached for the session — same
 * shape as `proxySupport.ts`'s `proxyPlaybackSupported`, an independent
 * cache (see the module doc for why the two probes don't share one).
 * `VideoDecoder`/`AudioDecoder` are absent in jsdom/vitest (there is no
 * WebCodecs polyfill for the test environment) and in real non-WebCodecs
 * browsers alike, so the absence branch is the common real-world failure
 * path, not just a test artifact.
 */
export async function engineCapabilitySupported(): Promise<boolean> {
  if (capabilityCache !== null) return capabilityCache
  let ok = false
  try {
    if (typeof VideoDecoder !== 'undefined' && typeof AudioDecoder !== 'undefined') {
      const [video, audio] = await Promise.all([
        VideoDecoder.isConfigSupported({ codec: ENGINE_VIDEO_CODEC }),
        AudioDecoder.isConfigSupported({
          codec: ENGINE_AUDIO_CODEC,
          numberOfChannels: ENGINE_AUDIO_CHANNELS,
          sampleRate: ENGINE_AUDIO_SAMPLE_RATE,
        }),
      ])
      ok = !!video.supported && !!audio.supported
    }
  } catch {
    ok = false
  }
  capabilityCache = ok
  return capabilityCache
}

/** Test hook: force (true/false) or reset (null) the cached probe result. */
export function __setEngineCapabilityForTests(value: boolean | null): void {
  capabilityCache = value
}

/**
 * The full gate a project must pass for the engine to take it over. Either
 * half failing produces a console-ready `reason` (the caller logs it — see
 * T6). `enabled` on the host's `engine` prop is a separate, prior gate (does
 * the host even want to try) — this function only answers "can this
 * specific project run on the engine right now."
 */
export async function evaluateEngineEligibility(project: Project): Promise<EligibilityResult> {
  const shape = checkProjectShapeEligibility(project)
  if (!shape.eligible) return shape
  const capable = await engineCapabilitySupported()
  if (!capable) {
    return {
      eligible: false,
      reason: 'WebCodecs avc1/opus decode is not supported in this browser',
    }
  }
  return { eligible: true }
}

/**
 * Does this project need the engine for a reason the LEGACY `<video>` player
 * cannot serve on its own? Additive to the checks above — this is not part of
 * `checkProjectShapeEligibility`/`evaluateEngineEligibility`'s eligibility
 * verdict, it answers a different question ("is legacy playback wrong here",
 * not "can the engine run this project").
 *
 * Today the only such reason is a CLIP (video/image) crossfade on the
 * PRIMARY footage track (`tracks[0]`): the resolver stamps
 * `ResolvedItem.crossfade` for clip pairs per `transitionPairs`
 * (`@bycrux/timeline-core`, matching `activation.js`'s `crossfadesAt`), and
 * both render and the engine's own preview blend it — but the legacy player
 * mounts one `<video>` element per clip with no compositing stage, so it can
 * only hard-cut. Clip pairs on an OVERLAY track are excluded, and not just
 * because their fade is baked `opacity` keyframe data
 * (`computeVisualCrossfade`, which the legacy player already renders
 * correctly via the DOM/CSS layer): `OverlayItemsLayer` blends overlay clip
 * pairs itself in legacy mode too, so there is nothing here the legacy path
 * cannot already serve. A track-0-only check also means `transitionPairs`
 * naturally short-circuits (needs 2+ items) so an empty or single-clip
 * primary track costs nothing extra.
 *
 * Reads via `enabledTrackItems`, not `trackItems`: a `enabled: false` track's
 * clips are invisible to every real blend consumer (preview, render), so an
 * overlapping pair sitting on a skipped track must not raise this banner —
 * there is no crossfade for the legacy player to fail at rendering.
 */
export function engineRequiredReason(project: Project): 'clip-crossfade' | null {
  const primary = enabledTrackItems(project)[0] ?? []
  const clips = primary.filter((item) => item.type === 'video' || item.type === 'image')
  if (clips.length < 2) return null
  if (transitionPairs(clips).length > 0) return 'clip-crossfade'
  return null
}

/**
 * §190 T3: the project's audio plan, built from the timeline for the mixer.
 *
 * This is the contract between the plan builder and the engine wiring. The
 * builder is pure: project + what has been conformed in, MixPlan out. The
 * engine owns fetching conform status and deciding when to hand the plan to
 * MixClock.
 */
import type { EditorProject } from '../../schema'
import type { MixPcmFormat, MixPlan } from './mix-protocol'

/** One source's conformed PCM, as `GET /api/audio/conformed` reports it. */
export interface ConformedSource {
  /** URL the Worker range-fetches (page-relative is fine; MixClock resolves it). */
  url: string
  format: MixPcmFormat
  sampleRate: number
  channels: number
  /** Total frames in the conformed file. Every segment built from it carries this. */
  frames: number
  /** The source has no audio stream, or only silence: no segment is built for it. */
  silent?: boolean
}

/** A source path as the project names it → its conform, or null while it has none (yet, or ever). */
export type ConformLookup = (src: string) => ConformedSource | null

export interface ProjectMixPlan {
  plan: MixPlan
  /** Main-track sources with audio that the plan needed but `lookup` had no conform for. */
  unconformedMain: string[]
  /** Lane (audio track) sources the plan left out for want of a conform; they keep today's playback. */
  unconformedLanes: string[]
  /** Overlay-track video sources the plan left out for want of a conform; they keep today's playback. */
  unconformedOverlays: string[]
}

/** Every source path whose audio the plan may need, for the conform request when a project opens. */
export function audioSourcePaths(project: EditorProject): string[] {
  void project
  throw new Error('audioSourcePaths: not implemented (§190 T3)')
}

export function buildMixPlan(project: EditorProject, lookup: ConformLookup): ProjectMixPlan {
  void project
  void lookup
  throw new Error('buildMixPlan: not implemented (§190 T3)')
}

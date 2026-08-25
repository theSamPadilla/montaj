// Pure timeline math shared by the DOM track-row area (today) and the canvas
// track-row area (T4 — see Timeline.tsx's `timeline` flag). Anything lifted
// here is behavior BOTH surfaces must reproduce identically, so it lives
// outside either render path.

import type { AudioTrack, VisualItem, VisualTrack } from '../../schema'
import type { Project } from '../../types'

// ── Row geometry ─────────────────────────────────────────────────────────
// Named constants for the row-height magic numbers used in cross-row drag
// math (the canvas pointer machine, Timeline.tsx). Centralized so the canvas
// painter (T4) draws rows at these heights consistently.

/** Vertical travel, in px, that a cross-track drag must cover to move an item
 *  one visual track. NOT the rendered row height (see
 *  VISUAL_ROW_RENDER_HEIGHT_PX) — it is deliberately shorter than the row so a
 *  drag reaches the neighbouring track before the cursor fully leaves the
 *  current one. Lifted verbatim from VisualTrackRow's drag math. */
export const VISUAL_ROW_HEIGHT_PX = 24

/** Audio-lane row height in px. Sized to fit the rail's stacked controls: mute,
 *  magnet, and the volume gear share one vertical column (TrackGutter's
 *  RailCell), and three 14px buttons plus their gaps need ~58px — at the old
 *  40px the third control (the volume gear) was clipped below the fold once the
 *  magnet was added. Doubles as the lane-index drag divisor, so drag travel and
 *  rendered height stay coincident for audio lanes. */
export const AUDIO_LANE_HEIGHT_PX = 64

/** Rendered height of a non-base visual track row — 40px. Held at that height
 *  on purpose: these rows carry overlays, which have no waveform and no
 *  filmstrip to show, so the extra height the base track needs would just be
 *  empty space here. */
export const VISUAL_ROW_RENDER_HEIGHT_PX = 40

/** Rendered height of the BASE visual track (index 0). No longer the DOM
 *  `h-14` its name came from: a video clip splits its height between a
 *  filmstrip and a waveform (see `canvas/clip-bands.ts`), and 56px left ~27px
 *  for each — too short to read either. */
export const BASE_VISUAL_ROW_RENDER_HEIGHT_PX = 120


/** Vertical gap between rows — the `gap-1` (0.25rem = 4px) on the DOM track
 *  list's flex column. */
export const ROW_GAP_PX = 4

/** Caption row height — matches the `h-10` (2.5rem = 40px) Tailwind class the
 *  retired DOM caption row (CaptionTrackRow.tsx) used to draw. The only
 *  direct reader is `computeTimelineLayout` (canvas/draw.ts), which seeds
 *  each `layout.captions`/`resolved.captions` band with it; TrackGutter's
 *  rail cells and the hit-tester both take the rectangles from THAT output
 *  rather than reading this constant themselves, so every reader agrees on
 *  the same rectangles by construction. */
export const CAPTION_ROW_HEIGHT_PX = 40

// ── Audio lane grouping ──────────────────────────────────────────────────

export interface AudioLane {
  laneIndex: number
  tracks: AudioTrack[]
}

/** Span given to an audio track that declares no `end` and whose source length
 *  the project does not record: enough bar to see and grab, nothing more. */
export const AUDIO_FALLBACK_SPAN_SECONDS = 5

/** The value when it is a real, finite number; `null` otherwise. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The timeline window an audio track occupies.
 *
 * NOT to be confused with `@bycrux/timeline-core`'s `audioWindow(track, t)`,
 * which takes a PLAYHEAD and answers "is this track audible right now, and at
 * what gain". This one takes the project's content duration and answers "where
 * does this bar sit on the timeline". Both are imported into this package, so
 * the names are kept distinct on purpose.
 *
 * `start` and `end` are OPTIONAL on an audio track. `docs/schemas/project.md`
 * marks only `src` required, and the renderer agrees: `render/mix-audio.js`
 * delays by `start ?? 0` and never trims on `end` (it reads `end` only to
 * place a fade-out), so the source window is `inPoint`/`outPoint` alone and a
 * music bed with neither field plays its natural length. The `AudioTrack`
 * type here declares both required — a convenience for the many call sites
 * that do arithmetic on them, not a claim about what is on disk.
 *
 * That gap produced a real defect: a track written without `start`/`end`
 * computed `NaN` for its left and width, so the DOM lane drew an invisible
 * bar and the canvas painter culled it entirely, while the export was
 * correct. Resolving the window here — and only here, at the one funnel every
 * audio surface reads lanes from — is what keeps painter, hit-test and the
 * pointer machine agreeing on where a bar is.
 */
export function resolveAudioWindow(
  track: AudioTrack,
  contentDuration = 0,
): { start: number; end: number } {
  const start = finiteNumber(track.start) ?? 0
  // `> start`, not merely present: a declared window of zero or negative width
  // is the sibling of the missing-window bug and fails the same way. `start: 0,
  // end: 0` is the exact shape `skills/lyrics-video` told agents to write until
  // recently, so projects carrying it exist; `engine/validate.py` rejects it now,
  // but validation does not run on project open, so the editor still has to cope.
  // Treat it as undeclared and fall through to the natural-length chain below.
  const declaredEnd = finiteNumber(track.end)
  if (declaredEnd !== null && declaredEnd > start) return { start, end: declaredEnd }

  // No `end`: the track plays its natural length. Prefer the source's own
  // length when the project records it, then the rest of the project's
  // content, then a fixed span — so the bar is never zero-width.
  // `outPoint` wins over `sourceDuration` only when it is actually past the
  // in-point. A stale `outPoint: 0` is finite, so a bare `??` would let it beat
  // a perfectly good `sourceDuration` and collapse `natural` to zero.
  const inPt = finiteNumber(track.inPoint) ?? 0
  const outPt = finiteNumber(track.outPoint)
  const sourceEnd = outPt !== null && outPt > inPt ? outPt : finiteNumber(track.sourceDuration)
  const natural = sourceEnd === null ? null : sourceEnd - inPt
  if (natural !== null && natural > 0) return { start, end: start + natural }
  // Guard the horizon too. `contentDuration` comes from `computeDerivedTiming`,
  // which reduces with `Math.max(m, i.end ?? 0)` — so ONE item anywhere in the
  // project with a non-numeric `end` makes it `NaN`, and an unguarded `Math.max`
  // would propagate that straight back into the invisible bar this function
  // exists to prevent. Falling back to 0 yields the fixed span instead.
  const horizon = finiteNumber(contentDuration) ?? 0
  return { start, end: Math.max(horizon, start + AUDIO_FALLBACK_SPAN_SECONDS) }
}

/**
 * Group audio tracks into rendered lanes, in ascending lane order. Tracks
 * carrying an explicit `lane` keep it; the rest are auto-assigned lanes above
 * the highest explicit one, in array order. Lifted out of Timeline's inline
 * IIFE so the DOM rows and the canvas painter can't drift on which track lands
 * in which row.
 *
 * Also resolves each track's timeline window (see `resolveAudioWindow`). A track
 * whose `start` and `end` are both already finite is returned as the SAME
 * object — no copy, no change — so nothing about a well-formed project is
 * different from before this existed. Only a track missing one of them gets a
 * resolved copy, and edits are applied by `id` (`updateAudioTrack`) rather
 * than by object identity, so a drag or trim on that copy commits back to the
 * right track and writes it a concrete window in passing.
 */
export function groupAudioLanes(tracks: AudioTrack[], contentDuration = 0): AudioLane[] {
  const laneMap = new Map<number, AudioTrack[]>()
  let nextAutoLane = 0
  for (const t of tracks) {
    if (t.lane != null && t.lane >= nextAutoLane) nextAutoLane = t.lane + 1
  }
  for (const t of tracks) {
    const lane = t.lane ?? nextAutoLane++
    if (!laneMap.has(lane)) laneMap.set(lane, [])
    const { start, end } = resolveAudioWindow(t, contentDuration)
    laneMap.get(lane)!.push(start === t.start && end === t.end ? t : { ...t, start, end })
  }
  return [...laneMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([laneIndex, laneTracks]) => ({ laneIndex, tracks: laneTracks }))
}

// ── Item labels ──────────────────────────────────────────────────────────

/** Longest run of an overlay's own text kept in its label; past this it stops
 *  being scannable and starts being a smear. */
const LABEL_TEXT_MAX = 28

/** Basename without extension, for either separator. */
function stem(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = cut === -1 ? path : path.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * The first human-readable string an overlay's props carry, if any. Overlay
 * components are free-form, so this checks the handful of prop names the shipped
 * ones actually use for their visible copy, in the order a reader would care
 * about: the text of the first line, then a caption, then generic single-string
 * fields.
 */
function overlayText(props: Record<string, unknown> | undefined): string | null {
  if (!props) return null
  const lines = props.lines
  if (Array.isArray(lines) && lines.length > 0) {
    const first = lines[0]
    if (first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      const text = (first as { text: string }).text.trim()
      if (text) return text
    }
  }
  for (const key of ['caption', 'text', 'title', 'label', 'headline'] as const) {
    const value = props[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * What a timeline block says it is.
 *
 * Every overlay used to read `▪ overlay`, which on a project carrying twenty of
 * them identified nothing — you had to click each one to find out which was
 * which. An overlay's component file names its KIND (`text_line`, `photo_hero`)
 * and its props usually carry the copy actually on screen, so the two together
 * say what the block is at a glance:
 *
 *   `text_line · we still need them`
 *   `photo_hero · ex-googler`
 *   `cold_open`                      (no text of its own)
 *
 * Video clips get NO label: the track rail already says the row is video, and
 * the filmstrip inside the clip identifies which shot it is far better than a
 * word would. Images fall back to their own filename.
 */
export function visualItemLabel(item: VisualItem): string {
  if (item.type === 'video') return ''
  if (item.type === 'image') return item.src ? stem(item.src) : 'image'

  const kind = item.src ? stem(item.src) : 'overlay'
  const text = overlayText(item.props)
  if (!text) return kind
  const trimmed = text.length > LABEL_TEXT_MAX ? `${text.slice(0, LABEL_TEXT_MAX - 1)}…` : text
  return `${kind} · ${trimmed}`
}

// ── Cross-track move ─────────────────────────────────────────────────────

export interface CrossTrackMoveArgs {
  /** The project's visual tracks as they stand mid-drag. */
  tracks: VisualTrack[]
  /** The item being dragged, at its ORIGINAL props — only start/end change. */
  item: VisualItem
  /** The dragged item's new timeline window. */
  start: number
  end: number
  /** Which track the drag began on. */
  sourceTrackIdx: number
  /** Vertical travel of the drag in raw pixels (positive = downward). */
  dy: number
  /** Magnet/ripple mode (`ctx.rippleMode`). When true, a colliding target
   *  track is no longer disqualifying — the drop RIPPLE-INSERTS on it instead
   *  of fanning out to a different track. See the "ripple-insert" section of
   *  this function's own doc comment. Defaults to false, which reproduces the
   *  function's pre-existing (magnet-off) behaviour byte-for-byte. */
  makeSpace?: boolean
}

/**
 * Place a dragged item on the visual track its vertical travel points at,
 * searching outward for one where it does not collide.
 *
 * Extracted verbatim from VisualTrackRow's drag handler so the canvas pointer
 * machine (SP5 T5) lands items in exactly the same track the DOM rows would.
 * The rules it encodes, none of them obvious from the outside:
 *
 * - Vertical travel is divided by `VISUAL_ROW_HEIGHT_PX` (24), not the rendered
 *   row height, so a drag reaches the neighbouring track before the cursor has
 *   fully left the current one. Downward travel LOWERS the track index, because
 *   tracks are stacked with the highest index on top.
 * - "Collision" means overlapping an existing item by more than 30% of the
 *   dragged item's duration; brushing past a neighbour is allowed.
 * - When the target track is occupied the search fans out — one above, one
 *   below, then two, and so on — and one step past the end of the array is a
 *   legal answer, which is how a drag creates a new top track.
 * - Tracks left empty by the move are pruned, so dragging the last item off a
 *   track collapses it. The surviving TRACK OBJECTS are carried through the
 *   prune, so each keeps its own id and its own volume/muted/enabled. (This is
 *   the whole reason tracks are objects: with settings held in a parallel array
 *   indexed alongside `tracks`, a prune shifts every index above it and hands
 *   the wrong settings to the wrong track.)
 * - A drag past the top of the stack mints a new track, with a fresh id from
 *   the same rule the normalizer uses and deduped against the ids already in
 *   play, so it can never collide with a surviving track.
 *
 * ── Ripple-insert (`makeSpace`, magnet/ripple mode ON) ────────────────────
 * Everything above is the magnet-OFF path and is completely unchanged by
 * `makeSpace` being available — with it omitted or false this function is
 * byte-identical to before. When `makeSpace` is true (the pointer machine
 * passes `ctx.rippleMode`), a collision at the pointed-at track (`targetIdx`)
 * stops being disqualifying, CapCut-style: instead of fanning out to another
 * track, the drop lands exactly where the drag points and PUSHES every item
 * on that track whose `start` is at/after the dropped item's own `start` to
 * the right by the dropped item's duration, making room for it in place. The
 * search below still runs — so the kind-lock and the "one past the end mints
 * a track" rule are unchanged — but with `makeSpace` on it only ever fans out
 * for a KIND mismatch, never for a collision, since collision no longer
 * disqualifies a candidate. Dropping into a genuine gap (no collision at
 * `targetIdx`) is identical in both modes — there is nothing to push.
 */
export function moveItemAcrossTracks({ tracks, item, start, end, sourceTrackIdx, dy, makeSpace = false }: CrossTrackMoveArgs): VisualTrack[] {
  const trackDelta = Math.round(dy / VISUAL_ROW_HEIGHT_PX)
  const targetIdx = Math.max(0, sourceTrackIdx - trackDelta)
  const duration = end - start
  const overlapMin = duration * 0.3

  function hasOverlap(items: VisualItem[]): boolean {
    return items.some(other => {
      if (other.id === item.id) return false
      return Math.min(end, other.end) - Math.max(start, other.start) > overlapMin
    })
  }

  // Coarse kind gate: video and overlay/image tracks are different worlds
  // (an overlay is composited on top of the video underneath it, not spliced
  // into its timeline), so a candidate track is only valid if it's either
  // empty or already carries the dragged item's own coarse kind. This is
  // deliberately narrow — just "don't let a video item land on an overlay
  // track or vice versa" — NOT the fuller "video tracks form their own block
  // below overlays" reorganization, which is separate follow-up work.
  const coarse = (type?: string) => (type === 'video' ? 'video' : 'overlay')
  const itemKind = coarse(item.type)
  const kindOk = (items: VisualItem[]) => {
    const others = items.filter(o => o.id !== item.id)
    // Every OTHER item, not just the first — a track is allowed to hold both
    // kinds (see TrackGutter's own note on a track that "also holds a
    // clip"), and sampling only `others[0]` would make the check depend on
    // array order rather than actually vetting every item already there.
    return others.length === 0 || others.every(o => coarse(o.type) === itemKind)
  }

  let bestIdx = targetIdx
  outer: for (let delta = 0; delta <= tracks.length; delta++) {
    for (const i of delta === 0 ? [targetIdx] : [targetIdx - delta, targetIdx + delta]) {
      if (i < 0) continue
      // Past the end of the array is a new track — it inherits the dragged
      // item's own kind by construction, so `[]` always passes `kindOk`.
      const candidateItems = i < tracks.length ? tracks[i].items : []
      // In ripple mode a collision is no longer disqualifying (it becomes a
      // ripple-insert below), so the gate drops to kind-only — which is what
      // keeps the search from fanning out past the pointed-at track just
      // because something is sitting there.
      const collisionOk = makeSpace || !hasOverlap(candidateItems)
      if (collisionOk && kindOk(candidateItems)) { bestIdx = i; break outer }
    }
  }

  const removed = tracks.map(t => ({ ...t, items: t.items.filter(other => other.id !== item.id) }))
  const movedItem = { ...item, start, end }
  const newTrack = (): VisualTrack => ({
    id: assignTrackId(removed.length, new Set(removed.map(t => t.id))),
    items: [movedItem],
  })

  let placed: VisualTrack[]
  if (bestIdx >= removed.length) {
    placed = [...removed, newTrack()]
  } else if (makeSpace && hasOverlap(removed[bestIdx].items)) {
    // Ripple-insert: push every item on the target track that starts at or
    // after the drop point to the right by the dragged item's own duration —
    // `removed[bestIdx].items` already excludes the dragged item itself, so
    // this can't shift the very item being placed — then land the dragged
    // item at its dropped window.
    placed = removed.map((t, i) => {
      if (i !== bestIdx) return t
      const shifted = t.items.map(other =>
        other.start >= start ? { ...other, start: other.start + duration, end: other.end + duration } : other,
      )
      return { ...t, items: [...shifted, movedItem] }
    })
  } else {
    placed = removed.map((t, i) => i === bestIdx ? { ...t, items: [...t.items, movedItem] } : t)
  }

  // Re-group into the canonical video-block/overlay-block stack (see
  // `normalizeTrackOrder`'s doc). This is what makes a freshly-minted video
  // track — appended at the top by the mint above — land in the video block
  // rather than staying stranded above the overlays, and makes every
  // mid-drag transient frame already-canonical instead of relying on some
  // later pass to re-normalize it.
  return orderedTrackArray(placed.filter(t => t.items.length > 0))
}

// ── Audio track update ───────────────────────────────────────────────────

/** Patch one audio track by id, leaving the rest of the project alone. Shared
 *  by the canvas pointer machine and Timeline.tsx so audio edits take the
 *  same shape wherever they're made. */
export function updateAudioTrack(project: Project, trackId: string, changes: Partial<AudioTrack>): Project {
  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: (project.audio?.tracks ?? []).map(t =>
        t.id === trackId ? { ...t, ...changes } : t,
      ),
    },
  }
}

// ── Derived timing ───────────────────────────────────────────────────────

export interface DerivedTiming {
  snapBoundaries: number[]
  contentDuration: number
  totalDuration: number
}

/** Snap boundaries, content duration, and the zoom/scroll-padded total
 *  duration for a project's tracks + audio. Lifted from the render-time memo
 *  that used to live inline in Timeline so the canvas surface (T4) computes
 *  timing identically to the DOM surface. */
export function computeDerivedTiming(project: Project): DerivedTiming {
  const allTracks = trackItems(project)
  const audioTracks = project.audio?.tracks ?? []
  const snapBoundaries = [...new Set([
    ...allTracks.flat().flatMap(c => [c.start, c.end]),
    ...audioTracks.flatMap(t => [t.start, t.end]),
  ])]
  const contentDuration = Math.max(
    allTracks.flat().reduce((m, i) => Math.max(m, i.end ?? 0), 0),
    audioTracks.reduce((m, t) => Math.max(m, t.end ?? 0), 0),
  )
  // Add 20% padding beyond content so the rightmost item can always be
  // dragged or resized further out. Minimum 5s headroom.
  const totalDuration = contentDuration + Math.max(5, contentDuration * 0.2)
  return { snapBoundaries, contentDuration, totalDuration }
}

// ── Auto-crossfade ───────────────────────────────────────────────────────

/**
 * Auto-crossfade: when two audio tracks overlap, apply fade-out on the
 * earlier track and fade-in on the later one, each equal to the overlap
 * duration. Lifted out of Timeline's render-time effect — previously a
 * hidden project mutation with no test coverage — so the canvas timeline
 * (T4) can't silently drop the behavior.
 *
 * Returns `null` — the no-change signal — when no track's fade needs to
 * change, so the caller's effect can skip calling `onProjectChange` and
 * avoid re-triggering itself forever.
 */
export function computeAutoCrossfade(project: Project): Project | null {
  const audioTracks = project.audio?.tracks ?? []
  if (!audioTracks.length) return null

  const sorted = [...audioTracks].sort((a, b) => a.start - b.start)
  let changed = false
  const updated = sorted.map(t => ({ ...t }))

  // We only auto-set fades where overlap exists
  for (let i = 0; i < updated.length - 1; i++) {
    const a = updated[i]
    const b = updated[i + 1]
    if (a.end > b.start && !a.muted && !b.muted) {
      // Overlap detected. Round ONCE and compare against the rounded value —
      // comparing against the raw `overlap` made this non-idempotent whenever
      // the overlap wasn't already a multiple of 0.1s (e.g. 0.37): the stored
      // fade (0.4) would never equal the raw overlap (0.37), so `changed` was
      // permanently true and this function kept reporting a change on a
      // project it had already converged. Since Timeline.tsx's effect commits
      // on every non-null result, that meant merely opening such a project
      // wrote to disk and pushed a no-op undo entry, re-firing on every
      // unrelated edit too.
      const overlap = Math.min(a.end - b.start, a.end - a.start, b.end - b.start)
      const rounded = Math.round(overlap * 10) / 10  // round to 0.1s
      if ((a.fadeOut ?? 0) !== rounded) {
        a.fadeOut = rounded
        changed = true
      }
      if ((b.fadeIn ?? 0) !== rounded) {
        b.fadeIn = rounded
        changed = true
      }
    }
  }

  if (!changed) return null

  const trackMap = new Map(updated.map(t => [t.id, t]))
  return {
    ...project,
    audio: {
      ...project.audio,
      tracks: audioTracks.map(t => trackMap.get(t.id) ?? t),
    },
  }
}

// ── Track shape (legacy VisualItem[][] ⟷ VisualTrack[]) ───────────────────

/**
 * Both-shapes tolerance for `project.tracks`.
 *
 * A project's `tracks` is on disk in one of two shapes. The legacy shape is a
 * bare array of arrays — `[[item, item], [item]]` — with nowhere to hang a
 * property that belongs to the TRACK rather than to a clip. The object shape
 * (`VisualTrack[]`, see schema.ts) gives each track that place:
 *
 *     [{ id: 'trk-0', items: [...] },
 *      { id: 'trk-1', items: [...], volume: 0.8, muted: false }]
 *
 * `volume`/`muted`/`enabled` are optional and ABSENT by default, so a
 * normalized project behaves identically to the legacy one it came from. Track
 * order is unchanged and still meaningful (`tracks[0]` is the primary footage
 * track; higher indices render on top).
 *
 * The house rule is read-tolerant everywhere, write-normalized on open: readers
 * call `trackItems()` and never care which shape is on disk; whoever opens the
 * project calls `normalizeTracks()` and persists the result.
 *
 * Mirrored, semantics for semantics, by `lib/project_tracks.py` and
 * `montaj_assets/render/project-tracks.js`. Change one, change all three — a
 * legacy project normalized by any of them must produce the same ids and the
 * same structure.
 */

/** Plain object (not an array, not null) — the shape a track object arrives as. */
function isTrackObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A usable track id: a non-empty string. */
function isTrackId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** True when `tracks` needs no work: every element is an object carrying a
 *  non-empty string `id` and an array `items`, and no two share an id. */
function isTrackObjectForm(tracks: unknown[]): boolean {
  const seen = new Set<string>()
  for (const track of tracks) {
    if (!isTrackObject(track)) return false
    if (!isTrackId(track.id)) return false
    if (!Array.isArray(track.items)) return false
    if (seen.has(track.id)) return false
    seen.add(track.id)
  }
  return true
}

/** Generate an id for the track at `index`, avoiding every id in `taken`. The
 *  rule: `trk-<index>`; if that is already taken, append an incrementing
 *  counter starting at 2 — `trk-<index>-2`, `trk-<index>-3`, … — until one is
 *  free. Deterministic and collision-free. `taken` is updated in place with the
 *  id handed out. */
function assignTrackId(index: number, taken: Set<string>): string {
  let candidate = `trk-${index}`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `trk-${index}-${suffix}`
    suffix += 1
  }
  taken.add(candidate)
  return candidate
}

// ── Track group ordering ─────────────────────────────────────────────────
// Sam's decision: the timeline ALWAYS stacks (top→bottom) overlay tracks,
// then the caption band(s), then every VIDEO track as one contiguous block
// (base video at the bottom), then audio lanes. Video and overlay tracks
// stay SEPARATE — the kind-lock in `moveItemAcrossTracks` already blocks new
// cross-kind mixing, so this only has to group what's already there, never
// merge or split a track.

/** A track's coarse kind for STACKING purposes: 'video' if it holds at least
 *  one video item, 'overlay' otherwise (overlay/image items, or none at
 *  all). Distinct from `moveItemAcrossTracks`'s own item-level `coarse` —
 *  that one classifies a single dragged ITEM to gate a move; this one
 *  classifies a whole TRACK by its content, to group tracks for display. A
 *  track holding even one video item groups as video, mixed or not. */
function trackGroupKind(track: VisualTrack): 'video' | 'overlay' {
  return track.items.some(item => item.type === 'video') ? 'video' : 'overlay'
}

/**
 * Stably partition `tracks` into the video group (in existing relative
 * order) followed by the overlay group (in existing relative order).
 * Returns the SAME array reference when the input is already in that order
 * — the shared core both `normalizeTrackOrder` (below) and `normalizeTracks`
 * call, so the identity contract lives in exactly one place.
 */
function orderedTrackArray(tracks: VisualTrack[]): VisualTrack[] {
  const video: VisualTrack[] = []
  const overlay: VisualTrack[] = []
  for (const track of tracks) (trackGroupKind(track) === 'video' ? video : overlay).push(track)
  const reordered = [...video, ...overlay]
  return reordered.every((track, i) => track === tracks[i]) ? tracks : reordered
}

/**
 * Reorder `project.tracks` into the canonical video-block/overlay-block
 * stack (see the section header above) — a STABLE partition, so it only
 * moves the two groups past each other and never reorders within one. Base
 * video (index 0 today) is always video-kind, so it always stays first.
 *
 * Only reorders `tracks` itself — never touches items, captions, or audio —
 * and assumes `tracks` is already in `VisualTrack[]` object form; call
 * `normalizeTracks` first for a project that might still be in the legacy
 * array-of-arrays shape (its own hook below already applies this after).
 *
 * Identity-preserving: when `tracks` is ALREADY in canonical order, returns
 * the exact SAME `project` object — no new array, no new project, not even
 * a shallow copy. This is load-bearing, not a micro-optimisation: a
 * normalizer that changes identity on already-canonical state defeats "same
 * reference → no re-render, no new undo entry" for a project that hasn't
 * actually changed, silently eating whatever gesture is mid-flight when it
 * runs (see the `normalizeTrackOrder(canonical) === canonical` test).
 */
export function normalizeTrackOrder<P extends Project>(project: P): P {
  const tracks = project.tracks
  if (!Array.isArray(tracks) || tracks.length === 0) return project
  const reordered = orderedTrackArray(tracks)
  return reordered === tracks ? project : { ...project, tracks: reordered }
}

/**
 * Return `project` with `tracks` in object form AND in canonical stacking
 * order (see `normalizeTrackOrder`). Accepts either shape.
 *
 * Pure — never mutates the input, at any depth. New track objects and new item
 * ARRAYS are built; the item objects themselves are carried over by reference.
 *
 * Idempotent, and identity-preserving: when `tracks` is already in object form
 * AND already in canonical order, the input object itself is returned, so
 * `normalizeTracks(p) === p`. That identity is what the lazy on-open
 * migration reads as "nothing to write" — a converged project must trigger
 * no save. Same for a project with no `tracks`, a `tracks` of
 * `null`/`undefined`, or a `tracks` that is not an array; validation is
 * someone else's job and normalization never throws.
 *
 * Per element of `tracks`:
 *   - an array  → `{ id: <generated>, items: <copy> }`
 *   - an object → preserved, with every other key (`volume`, `muted`,
 *     `enabled`, anything unknown) carried through untouched; `items` coerced
 *     to an array (missing / null / non-array → `[]`); `id` filled in when
 *     missing, not a string, empty, or a duplicate of an earlier track's id.
 *   - anything else (null, a string, a number) → `{ id: <generated>, items: [] }`
 * Then the whole array is re-ordered per `normalizeTrackOrder` — so this is
 * the ONE place that migrates a project to the current canonical shape,
 * called on every open and after every track-affecting change (Sam's "always
 * normalize" decision), rather than something callers opt into separately.
 *
 * The input side is deliberately structural and loose so this keeps compiling
 * both while `Project.tracks` is `VisualItem[][]` and after it becomes
 * `VisualTrack[]`.
 */
export function normalizeTracks<T extends { tracks?: unknown }>(project: T): T {
  if (project === null || typeof project !== 'object') return project
  const tracks: unknown = project.tracks
  if (!Array.isArray(tracks)) return project
  if (isTrackObjectForm(tracks)) {
    const reordered = orderedTrackArray(tracks as VisualTrack[])
    return reordered === tracks ? project : ({ ...project, tracks: reordered } as T)
  }

  // Every explicit id in the project, collected up front so a generated
  // `trk-<i>` can never land on an id a LATER track already claims.
  const taken = new Set<string>()
  for (const track of tracks) {
    if (isTrackObject(track) && isTrackId(track.id)) taken.add(track.id)
  }

  const kept = new Set<string>()  // ids handed out so far, so a duplicate loses to the first holder
  const out = (tracks as unknown[]).map((track, index) => {
    let normalized: Record<string, unknown>
    if (Array.isArray(track)) {
      normalized = { id: assignTrackId(index, taken), items: [...track] }
    } else if (isTrackObject(track)) {
      const items = Array.isArray(track.items) ? [...track.items] : []
      const id = isTrackId(track.id) && !kept.has(track.id)
        ? track.id
        : assignTrackId(index, taken)
      normalized = { ...track, id, items }
    } else {
      normalized = { id: assignTrackId(index, taken), items: [] }
    }
    kept.add(normalized.id as string)
    return normalized
  })

  // The spread widens T to `T & { tracks: … }`; the cast restores the caller's
  // own project type, which is what it was apart from the tracks rebuild.
  // A brand-new `tracks` array either way, so no identity to preserve here —
  // just order it before handing it back.
  return { ...project, tracks: orderedTrackArray(out as unknown as VisualTrack[]) } as T
}

/**
 * Just the items, in track order — for the many callers that only read.
 * `[]` when the project has no tracks (or a `tracks` too malformed to
 * normalize). The returned arrays are the normalized project's own item
 * arrays; treat them as read-only.
 */
export function trackItems(project: { tracks?: unknown } | null | undefined): VisualItem[][] {
  if (project === null || project === undefined || typeof project !== 'object') return []
  const tracks: unknown = normalizeTracks(project).tracks
  if (!Array.isArray(tracks)) return []
  return (tracks as Array<{ items: VisualItem[] }>).map(t => t.items)
}

/**
 * The items of ENABLED tracks only, in track order — for the surfaces that
 * PRODUCE picture and sound.
 *
 * The counterpart to `trackItems`, and the split between them is the whole of
 * the skip feature: editing surfaces (timeline, hit-testing, drag, trim, split,
 * selection) call `trackItems` and keep seeing a skipped track, because you have
 * to be able to see it and turn it back on. Playback and export call this one.
 * Routing by which accessor a call site uses keeps the rule in one reviewable
 * place instead of scattering `track.enabled === false` through a dozen files.
 *
 * `enabled` is absent by default, so `!== false` is the test: an untouched
 * project has every track enabled.
 *
 * A skipped track's slot is EMPTIED, not removed — this maps, it does not
 * filter. Every consumer of this array indexes it positionally (`[0]` is "the
 * base footage track", `.slice(1)` is "the overlay tracks"); filtering would
 * shift every later track's index down and silently reassign it to the wrong
 * role. Emptying preserves position while still contributing nothing to
 * playback or export.
 *
 * Items are passed through BY REFERENCE, never copied — the renderer's
 * `resolveProjectPaths` mutates `item.src` in place through this view, so a
 * defensive copy here would break path resolution with nothing failing.
 */
export function enabledTrackItems(project: { tracks?: unknown } | null | undefined): VisualItem[][] {
  if (project === null || project === undefined || typeof project !== 'object') return []
  const tracks: unknown = normalizeTracks(project).tracks
  if (!Array.isArray(tracks)) return []
  return (tracks as Array<{ items: VisualItem[]; enabled?: boolean }>)
    .map(t => (t.enabled !== false ? t.items : []))
}

/**
 * The ENABLED tracks themselves, in track order — the object-shape sibling of
 * `enabledTrackItems`, for callers that need a track's own settings
 * (`volume`, `muted`) alongside its items, not just the items. Both preview
 * paths need it: they read their clips out of the first enabled track and then
 * have to fold that track's audio settings into each one
 * (`effectiveItemAudio`), which the flattened item-array view has nowhere to
 * carry.
 *
 * Same treatment as `enabledTrackItems`: a skipped track's slot is emptied in
 * place (`items: []`) rather than removed, so index i here is always index i
 * there — the two accessors can never disagree about which tracks are "in",
 * and neither shifts a later track into an earlier, positionally-meaningful
 * slot.
 *
 * Tracks and items alike pass through BY REFERENCE; see `enabledTrackItems` on
 * why copying items would break path resolution.
 *
 * Mirrors `enabledTracks` in `montaj_assets/render/project-tracks.js`.
 */
export function enabledTracks(project: { tracks?: unknown } | null | undefined): VisualTrack[] {
  if (project === null || project === undefined || typeof project !== 'object') return []
  const tracks: unknown = normalizeTracks(project).tracks
  if (!Array.isArray(tracks)) return []
  return (tracks as VisualTrack[]).map(t => (t.enabled !== false ? t : { ...t, items: [] }))
}

// ── Effective per-item audio (track × item fold) ────────────────────────

/**
 * Fold a track's volume/mute settings into one of its item's effective audio
 * values. Volume **multiplies** — never replaces — so a clip an editor
 * already turned down stays proportionally quieter under a track that's also
 * pulled down; replacing would silently discard that per-clip work. Mute is
 * **either/or** — either the track or the item being muted silences it.
 *
 *     effectiveVolume = (track.volume ?? 1) * (item.volume ?? 1)
 *     effectiveMuted  = track.muted === true || item.muted === true
 *
 * Pure, and tolerant of absent fields on either argument — `track`/`item` may
 * each be `undefined`/`null`/`{}`. That is the common case: nothing writes
 * `track.volume`/`track.muted` by default, so most calls see an absent track
 * side and the result reduces to the item's own settings, unchanged.
 *
 * Mirrored by `effectiveItemAudio` in `montaj_assets/render/project-tracks.js`
 * — the two must agree or preview and render will disagree on how loud a clip
 * actually is.
 */
export function effectiveItemAudio(
  track: Pick<VisualTrack, 'volume' | 'muted'> | null | undefined,
  item: Pick<VisualItem, 'volume' | 'muted'> | null | undefined,
): { volume: number; muted: boolean } {
  const volume = (track?.volume ?? 1) * (item?.volume ?? 1)
  const muted = track?.muted === true || item?.muted === true
  return { volume, muted }
}

/**
 * `project` with its `tracks` swapped for the bare items view — the adapter for
 * the `@bycrux/timeline-core` boundary.
 *
 * That package is plain JS and its contract (`ResolverProject`,
 * `DurationProject`) still reads `tracks` as an array of item arrays. It takes
 * the WHOLE project, not just the tracks, so a caller can't route it through
 * `trackItems()` the way every in-package reader does. Everything but `tracks`
 * passes through by reference.
 */
export function withItemTracks<T extends { tracks?: unknown }>(
  project: T,
): Omit<T, 'tracks'> & { tracks: VisualItem[][] } {
  return { ...project, tracks: trackItems(project) }
}

/**
 * `withItemTracks`, but showing only the enabled tracks — the timeline-core
 * adapter for playback and export.
 *
 * Both halves are required together. Filtering without the unwrap re-breaks
 * `@bycrux/timeline-core` (it reads `tracks` as bare item arrays and throws
 * `TypeError: object is not iterable` on the object shape); unwrapping without
 * the filter silently ignores skip, so a skipped track keeps rendering. Use
 * this at every project-level timeline-core call on a playback path.
 */
export function withEnabledItemTracks<T extends { tracks?: unknown }>(
  project: T,
): Omit<T, 'tracks'> & { tracks: VisualItem[][] } {
  return { ...project, tracks: enabledTrackItems(project) }
}

/**
 * Rewrite every track's items, preserving each track's id and settings.
 *
 * The shape almost every edit takes: "map over the tracks, produce new items
 * per track, keep everything else". Doing that by hand invites the bug this
 * whole shape change exists to kill — rebuilding a track as a bare
 * `{ id, items }` silently drops its `volume`/`muted`/`enabled`.
 *
 * Both-shapes tolerant on input (it normalizes first), always returns the
 * object shape. Pure: new track objects, never a mutation of the input. `fn`
 * receives the track's own item array — treat it as read-only — and the
 * track's index, which is unchanged by this function (order is meaningful).
 *
 * Tracks left with no items are KEPT; pruning is `moveItemAcrossTracks`'
 * and `deleteSelection`'s business and is spelled out explicitly there.
 */
export function mapTrackItems(
  project: { tracks?: unknown },
  fn: (items: VisualItem[], trackIndex: number) => VisualItem[],
): VisualTrack[] {
  const tracks: unknown = normalizeTracks(project).tracks
  if (!Array.isArray(tracks)) return []
  return (tracks as VisualTrack[]).map((track, i) => ({ ...track, items: fn(track.items, i) }))
}

/**
 * AudioPolishModal — the one "Polish audio" surface over the four audio
 * cleanups (silence, fillers, loudness, voice isolation).
 *
 * WHAT THIS FILE IS NOT. It is not a planner. Every piece of maths — source ↔
 * timeline mapping, the two safety guards, the loudness gain, the stem track,
 * the apply order — lives in `audioPolish.ts` and is called from here. This file
 * owns three things and nothing else: which step calls to make, what the
 * operator sees, and what the operator has approved.
 *
 * ── PREVIEW IS NOT A RENDERING MODE ─────────────────────────────────────────
 *
 * The modal snapshots the project on open (`baselineRef`) and, on EVERY change
 * to a toggle or a checkbox, rebuilds the whole draft from that snapshot with
 * `buildDraft` and pushes it through `mutateTransient`. The timeline, the
 * preview player and the audio path all read the project, so they all show the
 * polished result with no preview-specific code anywhere. Rebuilding from the
 * baseline (never mutating the previous draft) is what makes unticking a
 * removal put that clip material straight back.
 *
 *   Cancel / Escape / close → `discardTransient()`. No save, no undo entry.
 *   Apply                   → `commit()`. One save, ONE undo step.
 *
 * ── ANALYSIS IS TRIGGERED BY THE OPERATOR, NOT BY MOUNT ─────────────────────
 *
 * Unlike `CaptionRegenModal`, the sidecar work here does not start on mount: the
 * language select must be chosen BEFORE speech detection runs, because a wrong
 * language silently corrupts detection instead of failing (the documented
 * incident where Spanish speech was mistaken for silence and 37 to 86% of real
 * speech was cut). So there is an explicit Analyse action.
 *
 * The StrictMode deferred-teardown pattern from `CaptionRegenModal` is still
 * required and is implemented below, for the same underlying reason: React
 * StrictMode fires mount → cleanup → mount synchronously, and this component's
 * teardown is NOT idempotent either — it discards the operator's transient draft
 * and it stops in-flight step calls from landing. Treating a StrictMode
 * remount as a real unmount would throw away a running analysis.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NumberField, stepValue } from '../ui'
import type { AudioPolishAnalysis, EditorAdapter, Project } from '../types'
import type { VisualItem, VisualTrack } from '../schema'
import { normalizeTracks } from './timeline/timeline-model'
import {
  buildDraft,
  captionWordsInSourceTime,
  flagRemovals,
  loudnessGainDb,
  mapRemovals,
  pieceSupported,
  targetClips,
  timelineToSource,
  volumeCeilingClamps,
  type ClipPlan,
  type PolishPiece,
  type PolishPlan,
  type Removal,
} from './audioPolish'

// ── Constants ───────────────────────────────────────────────────────────────

/** In-flight step calls. Each one is a real sidecar job; two at a time keeps the
 *  machine responsive while still overlapping the wait. */
const MAX_INFLIGHT = 2

/** Total proposed removal above this fraction of a clip's duration raises the
 *  banner. Not a block: the operator may well mean it. */
const OVERCUT_FRACTION = 0.6

type Piece = 'silence' | 'fillers' | 'loudness' | 'voice'
type SpeechPiece = Extract<Piece, 'silence' | 'fillers'>

const SPEECH_PIECES: SpeechPiece[] = ['silence', 'fillers']

const PIECES: Array<{ id: Piece; label: string; blurb: string }> = [
  { id: 'silence', label: 'Remove silence', blurb: 'Cut the gaps where nobody is speaking.' },
  { id: 'fillers', label: 'Remove filler words', blurb: 'Cut the ums, uhs and likes.' },
  { id: 'loudness', label: 'Match loudness', blurb: 'Level every clip to one target.' },
  { id: 'voice', label: 'Isolate voice', blurb: 'Separate the voice from what is behind it.' },
]

/** Voice isolation is off by default: it is the slowest of the four (a full
 *  Demucs pass over the source) and it mutes the clip's own audio, which is the
 *  most opinionated thing this modal can do. The other three are cheap and
 *  reversible, so they start on. */
const DEFAULT_PIECES: Record<Piece, boolean> = {
  silence: true,
  fillers: true,
  loudness: true,
  voice: false,
}

const LOUDNESS_TARGETS = [
  { id: 'youtube', label: 'YouTube, -14 LUFS', lufs: -14 },
  { id: 'podcast', label: 'Podcast, -16 LUFS', lufs: -16 },
  { id: 'broadcast', label: 'Broadcast, -23 LUFS', lufs: -23 },
  { id: 'custom', label: 'Custom', lufs: -14 },
] as const

type TargetId = (typeof LOUDNESS_TARGETS)[number]['id']

/** Speech-recognition language hint. Visible, never buried: see the module
 *  header for what a wrong one does. */
const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'it', label: 'Italian' },
  { id: 'nl', label: 'Dutch' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'zh', label: 'Chinese' },
  { id: 'hi', label: 'Hindi' },
  { id: 'ar', label: 'Arabic' },
  { id: 'ru', label: 'Russian' },
]

const NO_CAPTIONS_NOTE =
  'This project has no captions, so the caption word check did not run on these removals.'
const NO_SILENCE_CHECK_NOTE =
  'The independent silence check could not run, so these removals were not cross checked.'

// ── Local view types ────────────────────────────────────────────────────────

/** One proposed removal as the operator sees it. Carries BOTH coordinate
 *  spaces on purpose: `source` is what the plan needs (the planner maps it),
 *  `tlStart`/`tlEnd` are what the operator is shown and are already clipped to
 *  the clip's span by `mapRemovals`, so they are exactly what will be cut. */
interface RemovalRow {
  key: string
  piece: SpeechPiece
  /** SOURCE time. Goes straight into `ClipPlan.removals`. */
  source: Removal
  /** TIMELINE time, clipped to the clip. Display only. */
  tlStart: number
  tlEnd: number
  text?: string
  flagged: boolean
  reason?: string
}

interface ClipAnalysis {
  rows: RemovalRow[]
  /** Target-independent, so changing the loudness target rebuilds the draft
   *  without re-analysing anything. */
  loudness?: { measuredI: number; measuredTP: number }
  vocalsPath?: string
  vocalsUrl?: string
  /** Per-piece failures, reported inline. A piece failing here leaves every
   *  other piece on this clip fully usable. */
  errors: Partial<Record<Piece, string>>
  /** Set when a guard could not run, so the UI says so rather than implying a
   *  check happened. */
  notes: string[]
}

interface Progress {
  done: number
  total: number
  label: string
}

export interface AudioPolishModalProps<P extends Project = Project> {
  projectId: string
  /** Adapter driving the four analyses. Must implement `analyzeAudioPolish` —
   *  callers gate rendering on its presence, exactly as with
   *  `generateCaptions`. */
  adapter: EditorAdapter<P>
  /** The live project. Snapshotted once on mount as the polish baseline, and
   *  watched afterwards so an external (SSE) frame landing mid-preview does not
   *  silently drop the draft. Pass `sync.project`. */
  project: P
  /** Current multi-selection. Empty or absent means every video clip on
   *  `tracks[0]`. */
  selectionIds?: readonly string[]
  /** `sync.mutateTransient` — local-only apply, no save, no undo push. */
  mutateTransient: (fn: (p: P) => P) => void
  /** `sync.commit` — one queued save, one undo step. */
  commit: () => Promise<void>
  /** `sync.discardTransient` — drop the draft, no save, no undo entry. */
  discardTransient: () => void
  onClose: () => void
  /** Editor theme mode — light/dark. The panel follows `--editor-surface`, so
   *  warning/error hues need to darken in light mode. Absent -> dark,
   *  matching every existing caller. */
  mode?: 'light' | 'dark'
}

// ── Small pure helpers (display only) ───────────────────────────────────────

/** `m:ss.s`. Display only. */
function clock(sec: number): string {
  const t = Math.max(0, sec)
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function clipLabel(clip: VisualItem): string {
  return clip.src ? basename(clip.src) : clip.id
}

function signedDb(db: number): string {
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Whether `piece` may run on `clip`.
 *
 * Every site that needs to know asks `pieceSupported` and nothing else: never
 * `clip.loop`, never `clip.speed`, never `voiceTrackFor` directly. The rules
 * (voice needs speed 1, the three mapping-dependent pieces need a non-looping
 * clip) and the wording that explains them both live in `audioPolish.ts`, so
 * neither can drift from the other.
 */
function supports(clip: VisualItem, piece: PolishPiece): boolean {
  return pieceSupported(clip, piece).available
}

/**
 * The clip's window into its source file, for the windowed step calls.
 *
 * The `out` fallback is `timelineToSource`, the planner's own mapping, NEVER a
 * second hand-written copy of `inPoint + (end - start) * speed`. `mapRemovals`
 * maps the results back through that same relation, so a private copy here that
 * drifted from it would window the analysis somewhere other than where the
 * removals it returns can be applied, on a feature whose whole job is deciding
 * what audio to delete.
 *
 * A stored `outPoint` still wins when there is one, matching the convention
 * `cuts.ts`'s own `sourceWindow` already sets. That is not just deference to the
 * schema: on a LOOPING clip `outPoint` IS the source window and `clip.end` is
 * many loops past it (`scheduler.ts`'s loop arithmetic reads exactly this pair),
 * so deriving from `clip.end` there would ask the step for a span far past the
 * end of the file.
 *
 * It wins only when it is actually past the in-point, though. A stale
 * `outPoint: 0` is a real state in this tree, and it is finite, so a bare `??`
 * would let it through and hand the step an inverted window. This is the same
 * guard, for the same reason, as the one on `outPt > inPt` in
 * `timeline-model.ts`'s audio-track sizing.
 */
function sourceWindow(clip: VisualItem): { in: number; out: number } {
  const inPoint = clip.inPoint ?? 0
  const stored = clip.outPoint
  return {
    in: inPoint,
    out: stored !== undefined && stored > inPoint ? stored : timelineToSource(clip, clip.end),
  }
}

/**
 * Speech detection reads the proxy when there is one: it is full-source and
 * never windowed, so its timeline is 1:1 with the original and the timings come
 * back needing no rebasing, and it decodes far faster.
 *
 * Loudness measurement, stem separation and the silence cross-check all read
 * `src` instead — fidelity matters for the first two, and the third is only
 * worth anything as an INDEPENDENT check of the real audio.
 */
function speechSrc(clip: VisualItem): string {
  return clip.proxySrc ?? clip.src ?? ''
}

/** Run `jobs` with at most `limit` in flight. Each job owns its own error
 *  handling; this never rejects. */
async function runPool(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= jobs.length) return
      await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

// ── Component ───────────────────────────────────────────────────────────────

export default function AudioPolishModal<P extends Project = Project>({
  projectId,
  adapter,
  project,
  selectionIds,
  mutateTransient,
  commit,
  discardTransient,
  onClose,
  mode = 'dark',
}: AudioPolishModalProps<P>) {
  // The polish baseline: the project as it was when the modal opened. Every
  // draft is rebuilt from this, never from the previous draft.
  const baselineRef = useRef<P>(project)
  const baseline = baselineRef.current

  const [pieces, setPieces] = useState<Record<Piece, boolean>>(DEFAULT_PIECES)
  const [language, setLanguage] = useState('en')
  const [targetId, setTargetId] = useState<TargetId>('youtube')
  const [customLufs, setCustomLufs] = useState(-14)
  const [phase, setPhase] = useState<'setup' | 'analysing' | 'review'>('setup')
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0, label: '' })
  const [analysis, setAnalysis] = useState<Record<string, ClipAnalysis>>({})
  const [analysedPieces, setAnalysedPieces] = useState<Record<Piece, boolean>>({
    silence: false,
    fillers: false,
    loudness: false,
    voice: false,
  })
  const [approved, setApproved] = useState<Record<string, boolean>>({})

  const runningRef = useRef(false)
  const closingRef = useRef(false)
  const unmountedRef = useRef(false)
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPushedRef = useRef<P | null>(null)
  // Mirrored so the mount effect below can keep empty deps: it must run exactly
  // once per REAL mount, whatever the host does with function identity.
  const discardRef = useRef(discardTransient)
  discardRef.current = discardTransient

  const targetLufs = targetId === 'custom' ? customLufs : LOUDNESS_TARGETS.find(t => t.id === targetId)!.lufs

  // Deliberately keyed on the selection's CONTENT rather than the array's
  // identity: a host that rebuilds `selectionIds` every render would otherwise
  // rebuild the target list, the plan and the whole draft with it.
  const selectionIdsRef = useRef(selectionIds)
  selectionIdsRef.current = selectionIds
  const selectionKey = (selectionIds ?? []).join(' ')
  const targets = useMemo(
    () => targetClips(baseline, selectionIdsRef.current ?? []).filter(c => Boolean(c.src)),
    [baseline, selectionKey],
  )

  const trackVolume = useMemo(
    () => ((normalizeTracks(baseline).tracks ?? []) as VisualTrack[])[0]?.volume,
    [baseline],
  )

  // ── StrictMode-safe lifecycle ─────────────────────────────────────────────
  //
  // Teardown here is destructive twice over: it stops in-flight analysis from
  // landing, and it discards the operator's unsaved draft. StrictMode's
  // synchronous mount → cleanup → mount would do both to a live modal, so the
  // teardown is deferred a tick and rescued if a remount arrives first. Same
  // pattern as CaptionRegenModal and RenderModal.
  useEffect(() => {
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
      unmountedRef.current = false
      return scheduleCleanup
    }
    unmountedRef.current = false
    return scheduleCleanup

    function scheduleCleanup() {
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
        // An unmount that did not come through Cancel or Apply (a project
        // switch, a host teardown) would otherwise strand the transient draft
        // on screen, unsaved and undiscardable. A no-op after Apply: commit()
        // clears the transient baseline.
        if (!closingRef.current) discardRef.current()
      }, 0)
    }
  }, [])

  // ── The plan, the draft, and the push ─────────────────────────────────────

  const plan: PolishPlan = useMemo(() => {
    const clips: Record<string, ClipPlan> = {}
    for (const clip of targets) {
      const a = analysis[clip.id]
      if (!a) continue

      const removals: Removal[] = []
      for (const row of a.rows) {
        if (!pieces[row.piece] || !approved[row.key]) continue
        // A piece the planner refuses on this clip can never reach the plan,
        // whatever is ticked. Analysis does not schedule those jobs, so there
        // should be no such row; this is the gate that makes that a guarantee
        // rather than a coincidence of scheduling.
        if (!supports(clip, row.piece)) continue
        removals.push(row.source)
      }

      const cp: ClipPlan = {}
      if (removals.length > 0) cp.removals = removals
      if (pieces.loudness && a.loudness) cp.gainDb = loudnessGainDb(a.loudness, targetLufs)
      // Ineligible clips are left out of the plan entirely rather than handed a
      // path the planner will refuse: a clip listed as an owner but minting no
      // stem would drop stems a previous run left on it.
      if (pieces.voice && a.vocalsPath && supports(clip, 'voice')) cp.vocalsPath = a.vocalsPath

      if (cp.removals || cp.gainDb !== undefined || cp.vocalsPath !== undefined) clips[clip.id] = cp
    }
    return { clips }
  }, [targets, analysis, pieces, approved, targetLufs])

  const draft = useMemo(
    () => (phase === 'review' ? buildDraft(baseline, plan) : baseline),
    [baseline, plan, phase],
  )

  // Every toggle and every checkbox lands here: rebuild from the baseline, push
  // the whole thing, no incremental mutation of the previous draft.
  useEffect(() => {
    if (phase !== 'review' || closingRef.current) return
    lastPushedRef.current = draft
    mutateTransient(() => draft)
  }, [draft, phase, mutateTransient])

  // Watch item from the plan: an external frame (SSE, refetch) arriving while
  // the modal is open would `applyExternal` straight over the draft, leaving the
  // operator reviewing a preview that is no longer on screen. Re-push instead of
  // assuming it cannot happen. Identity is the test, and our own pushes come
  // back as the same object, so this cannot loop.
  useEffect(() => {
    const pushed = lastPushedRef.current
    if (pushed === null || closingRef.current || project === pushed) return
    mutateTransient(() => pushed)
  }, [project, mutateTransient])

  // ── Close paths ───────────────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    discardTransient()
    onClose()
  }, [discardTransient, onClose])

  const handleApply = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    // A polish that changes nothing is discarded, not committed. `buildDraft`
    // returns the baseline BY REFERENCE when the plan is empty (every removal
    // unticked, every piece off, or nothing found), so identity is an exact test
    // for it. Committing that would still push one undo entry, and the operator
    // pressing undo on it would see nothing happen: that reads as broken undo
    // rather than as an empty change.
    if (draft === baseline) discardTransient()
    else void commit()
    onClose()
  }, [commit, discardTransient, draft, baseline, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleCancel])

  // ── Analysis ──────────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    const analyze = adapter.analyzeAudioPolish
    if (!analyze || runningRef.current) return

    const enabled = PIECES.filter(p => pieces[p.id]).map(p => p.id)
    if (enabled.length === 0 || targets.length === 0) return

    runningRef.current = true
    setPhase('analysing')

    // Raw, per clip and per source. Rows are derived from this AFTER the pool
    // drains, because a silence removal cannot be flagged until the whole-source
    // cross-check for its src has come back.
    const raw: Record<string, { silence?: Removal[]; fillers?: Removal[]; loudness?: { measuredI: number; measuredTP: number }; errors: Partial<Record<Piece, string>> }> = {}
    for (const clip of targets) raw[clip.id] = { errors: {} }

    const bySrc: Record<string, { keeps?: Array<[number, number]>; checkFailed?: boolean; vocalsPath?: string; url?: string; error?: string }> = {}
    const srcOf = (clip: VisualItem) => clip.src ?? ''
    for (const clip of targets) bySrc[srcOf(clip)] ??= {}

    const jobs: Array<() => Promise<void>> = []
    let done = 0
    const bump = (label: string) => {
      done += 1
      if (!unmountedRef.current) setProgress(p => ({ ...p, done, label }))
    }

    const push = (label: string, body: () => Promise<void>) => {
      jobs.push(async () => {
        if (unmountedRef.current || closingRef.current) return
        setProgress(p => ({ ...p, label }))
        try {
          await body()
        } finally {
          bump(label)
        }
      })
    }

    // Per-clip, windowed calls.
    for (const clip of targets) {
      const window = sourceWindow(clip)
      for (const piece of SPEECH_PIECES) {
        if (!pieces[piece] || !supports(clip, piece)) continue
        push(`${clipLabel(clip)}: ${piece === 'silence' ? 'silence' : 'filler words'}`, async () => {
          try {
            const res: AudioPolishAnalysis = await analyze({
              projectId, piece, src: speechSrc(clip), window, options: { language },
            })
            if (res.piece === piece) raw[clip.id][piece] = res.removals
          } catch (e) {
            raw[clip.id].errors[piece] = messageOf(e)
          }
        })
      }
      if (pieces.loudness && supports(clip, 'loudness')) {
        push(`${clipLabel(clip)}: loudness`, async () => {
          try {
            const res: AudioPolishAnalysis = await analyze({
              projectId, piece: 'loudness', src: srcOf(clip), window, options: { targetLufs },
            })
            if (res.piece === 'loudness') {
              raw[clip.id].loudness = { measuredI: res.measuredI, measuredTP: res.measuredTP }
            }
          } catch (e) {
            raw[clip.id].errors.loudness = messageOf(e)
          }
        })
      }
    }

    // Whole-source calls, once per distinct source. Both are expensive and both
    // are 1:1 with the whole file, so two clips off one source share a result.
    for (const src of Object.keys(bySrc)) {
      if (pieces.silence && targets.some(c => srcOf(c) === src && supports(c, 'silence-check'))) {
        push(`${basename(src)}: silence cross check`, async () => {
          try {
            const res: AudioPolishAnalysis = await analyze({ projectId, piece: 'silence-check', src })
            if (res.piece === 'silence-check') bySrc[src].keeps = res.keeps
          } catch {
            // Not a piece failure: the removals are still valid, they are just
            // uncrosschecked. Said plainly in the UI rather than passed off as
            // a check that ran.
            bySrc[src].checkFailed = true
          }
        })
      }
      if (pieces.voice && targets.some(c => srcOf(c) === src && supports(c, 'voice'))) {
        push(`${basename(src)}: isolate voice`, async () => {
          try {
            const res: AudioPolishAnalysis = await analyze({ projectId, piece: 'voice', src })
            if (res.piece === 'voice') {
              bySrc[src].vocalsPath = res.vocalsPath
              bySrc[src].url = res.url
            }
          } catch (e) {
            bySrc[src].error = messageOf(e)
          }
        })
      }
    }

    setProgress({ done: 0, total: jobs.length, label: '' })
    await runPool(jobs, MAX_INFLIGHT)

    if (unmountedRef.current || closingRef.current) {
      runningRef.current = false
      return
    }

    // Rows, guards, and defaults. Everything below is source time until
    // `mapRemovals`; see audioPolish.ts's coordinate note.
    const hasCaptions = (baseline.captions?.segments?.length ?? 0) > 0
    const nextAnalysis: Record<string, ClipAnalysis> = {}
    const nextApproved: Record<string, boolean> = {}

    for (const clip of targets) {
      const src = srcOf(clip)
      const captionWords = hasCaptions ? captionWordsInSourceTime(baseline, clip) : undefined
      const rows: RemovalRow[] = []

      for (const piece of SPEECH_PIECES) {
        const list = raw[clip.id][piece]
        if (!list) continue
        const guards = piece === 'silence'
          ? { captionWords, silenceKeeps: bySrc[src]?.keeps }
          : { captionWords }
        flagRemovals(list, guards).forEach((f, i) => {
          const [mapped] = mapRemovals(clip, [f])
          if (!mapped) return // survives as nothing on this clip: nothing to approve
          const key = `${clip.id}::${piece}::${i}`
          rows.push({
            key,
            piece,
            source: f.text !== undefined ? { start: f.start, end: f.end, text: f.text } : { start: f.start, end: f.end },
            tlStart: mapped.start,
            tlEnd: mapped.end,
            text: f.text,
            flagged: f.flagged,
            reason: f.reason,
          })
          // Flagged removals require a deliberate tick.
          nextApproved[key] = !f.flagged
        })
      }

      const notes: string[] = []
      if (rows.length > 0 && !hasCaptions) notes.push(NO_CAPTIONS_NOTE)
      if (pieces.silence && supports(clip, 'silence') && bySrc[src]?.checkFailed) notes.push(NO_SILENCE_CHECK_NOTE)

      const errors = { ...raw[clip.id].errors }
      if (pieces.voice && supports(clip, 'voice') && bySrc[src]?.error) errors.voice = bySrc[src].error

      nextAnalysis[clip.id] = {
        rows,
        loudness: raw[clip.id].loudness,
        vocalsPath: bySrc[src]?.vocalsPath,
        vocalsUrl: bySrc[src]?.url,
        errors,
        notes,
      }
    }

    // Approvals are rebuilt, not merged: a re-run at different settings returns
    // a different set of removals, and carrying stale ticks across would silently
    // approve something the operator never saw.
    setAnalysis(nextAnalysis)
    setApproved(nextApproved)
    setAnalysedPieces({
      silence: pieces.silence,
      fillers: pieces.fillers,
      loudness: pieces.loudness,
      voice: pieces.voice,
    })
    setPhase('review')
    runningRef.current = false
  }, [adapter, projectId, targets, pieces, language, targetLufs, baseline])

  // ── Derived display state ─────────────────────────────────────────────────

  /** Per clip: the timeline seconds this plan currently removes, and that as a
   *  fraction of the clip. Overlapping silence and filler ranges would be
   *  double counted here; they are disjoint by construction (fillers sit inside
   *  speech, silence sits outside it), and this drives a warning, not a cut. */
  const overcut = useMemo(() => {
    const out: Array<{ clip: VisualItem; removed: number; fraction: number }> = []
    for (const clip of targets) {
      const a = analysis[clip.id]
      if (!a) continue
      let removed = 0
      for (const row of a.rows) {
        if (!pieces[row.piece] || !approved[row.key]) continue
        removed += row.tlEnd - row.tlStart
      }
      const span = clip.end - clip.start
      const fraction = span > 0 ? removed / span : 0
      if (fraction > OVERCUT_FRACTION) out.push({ clip, removed, fraction })
    }
    return out
  }, [targets, analysis, pieces, approved])

  const totalApproved = useMemo(
    () => Object.values(analysis).reduce(
      (n, a) => n + a.rows.filter(r => pieces[r.piece] && approved[r.key]).length,
      0,
    ),
    [analysis, pieces, approved],
  )

  const anyPiece = PIECES.some(p => pieces[p.id])
  const busy = phase === 'analysing'

  // ── Render ────────────────────────────────────────────────────────────────

  const panel = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div
        role="dialog"
        aria-label="Polish audio"
        className="w-full max-w-4xl max-h-[90vh] bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold text-[var(--editor-text)]">Polish audio</h2>
            <p className="text-[11px] text-[var(--editor-text)]/55">
              {targets.length === 1
                ? '1 clip in scope. Nothing is saved until you press Apply.'
                : `${targets.length} clips in scope. Nothing is saved until you press Apply.`}
            </p>
          </div>
          <button
            onClick={handleCancel}
            aria-label="Close"
            className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Settings */}
        <div className="px-5 py-4 border-b border-[var(--editor-border)] flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {PIECES.map(p => (
              <label
                key={p.id}
                className="flex items-start gap-2 rounded-lg border border-[var(--editor-border)] p-2.5 cursor-pointer hover:bg-[var(--editor-text)]/5 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={pieces[p.id]}
                  aria-label={p.label}
                  onChange={() => setPieces(s => ({ ...s, [p.id]: !s[p.id] }))}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-semibold text-[var(--editor-text)]">{p.label}</span>
                  <span className="text-[10px] leading-snug text-[var(--editor-text)]/55">{p.blurb}</span>
                  {phase === 'review' && pieces[p.id] && !analysedPieces[p.id] && (
                    <span className={`text-[10px] ${mode === 'light' ? 'text-amber-700' : 'text-amber-400'}`}>Not analysed yet. Run Analyse again.</span>
                  )}
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">
                Spoken language
              </span>
              <select
                value={language}
                aria-label="Spoken language"
                onChange={e => setLanguage(e.target.value)}
                className="text-sm px-3 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]"
              >
                {LANGUAGES.map(l => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-[var(--editor-text)]/45 max-w-[15rem] leading-snug">
                Set this before analysing. The wrong language makes real speech look like silence.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">
                Loudness target
              </span>
              <select
                value={targetId}
                aria-label="Loudness target"
                onChange={e => setTargetId(e.target.value as TargetId)}
                className="text-sm px-3 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]"
              >
                {LOUDNESS_TARGETS.map(t => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>

            {targetId === 'custom' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">
                  Custom LUFS
                </span>
                <NumberField
                  name="Custom LUFS"
                  value={customLufs}
                  // Local modal state with no separate save step, exactly like
                  // FontSizePicker — every valid edit writes straight through,
                  // so both callbacks point at the same setter. LUFS values are
                  // negative (e.g. -14): no `min` is passed, deliberately, so a
                  // typed `-` and negative numbers pass through untouched (see
                  // NumberField's contract — a typed value is never clamped).
                  // Same reasoning for the stepper's own `stepValue` call below:
                  // no `min`/`max` there either, so nudging past a round target
                  // like -14 keeps working in both directions.
                  onPreview={setCustomLufs}
                  onCommit={setCustomLufs}
                  step={0.5}
                  onStep={d => setCustomLufs(stepValue(customLufs, d, { step: 0.5 }))}
                  className="w-24"
                />
              </label>
            )}

            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => void runAnalysis()}
                disabled={busy || !anyPiece || targets.length === 0}
                className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] disabled:opacity-40 hover:opacity-90 transition-opacity"
              >
                {busy ? 'Analysing…' : phase === 'review' ? 'Analyse again' : 'Analyse'}
              </button>
              {busy && (
                <span className="text-[10px] text-[var(--editor-text)]/55">
                  {`Analysing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}. ${progress.label}`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Over-cut warning */}
        {overcut.length > 0 && (
          <div className={`px-5 py-2 text-[11px] leading-snug ${mode === 'light' ? 'text-amber-700' : 'text-amber-400/90'} border-b border-[var(--editor-border)] flex flex-col gap-0.5`}>
            {overcut.map(o => (
              <span key={o.clip.id}>
                {`Warning: ${clipLabel(o.clip)} would lose ${Math.round(o.fraction * 100)}% of its length, ${o.removed.toFixed(1)}s. Check the ticked removals below.`}
              </span>
            ))}
          </div>
        )}

        {/* Review */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5 min-h-[12rem]">
          {phase === 'setup' && (
            <p className="text-xs text-[var(--editor-text)]/50 italic">
              Pick the cleanups you want, set the language, then press Analyse. You see every proposed
              change on the timeline before anything is saved.
            </p>
          )}

          {phase !== 'setup' && targets.map(clip => {
            const a = analysis[clip.id]
            const rows = (a?.rows ?? []).filter(r => pieces[r.piece])
            const gainDb = a?.loudness ? loudnessGainDb(a.loudness, targetLufs) : undefined
            const clamped = gainDb !== undefined && volumeCeilingClamps(gainDb, trackVolume)

            return (
              <section key={clip.id} className="flex flex-col gap-2">
                <header className="flex items-baseline justify-between gap-3 border-b border-[var(--editor-border)] pb-1">
                  <span className="text-xs font-semibold text-[var(--editor-text)] truncate">{clipLabel(clip)}</span>
                  <span className="text-[10px] font-mono text-[var(--editor-text)]/45 shrink-0">
                    {`${clock(clip.start)} to ${clock(clip.end)}`}
                  </span>
                </header>

                {/* Per-piece failures. One piece failing leaves the rest usable. */}
                {a && Object.entries(a.errors).map(([piece, msg]) => (
                  <p key={piece} className={`text-[11px] leading-snug ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>
                    {`${piece} could not be analysed: ${msg}`}
                  </p>
                ))}

                {a?.notes.map(note => (
                  <p key={note} className={`text-[11px] leading-snug ${mode === 'light' ? 'text-amber-700' : 'text-amber-400/90'}`}>{note}</p>
                ))}

                {/* Loudness */}
                {pieces.loudness && a?.loudness && gainDb !== undefined && (
                  <p className="text-[11px] text-[var(--editor-text)]/70">
                    {`Loudness: measured ${a.loudness.measuredI.toFixed(1)} LUFS, true peak ${a.loudness.measuredTP.toFixed(1)} dBTP. Gain ${signedDb(gainDb)} to reach ${targetLufs} LUFS.`}
                    {clamped && (
                      <span className={mode === 'light' ? 'text-amber-700' : 'text-amber-400'}>
                        {' '}Held at the +6 dB ceiling, so this clip stays under the target.
                      </span>
                    )}
                  </p>
                )}

                {/* Every enabled piece this clip cannot take, with the planner's
                    own wording. Rendered verbatim: no period appended, no
                    rephrasing. Loudness never appears here, it runs on any clip. */}
                {PIECES.filter(p => pieces[p.id] && !supports(clip, p.id)).map(p => (
                  <p
                    key={p.id}
                    className={`self-start text-[11px] px-2 py-0.5 rounded ${mode === 'light' ? 'bg-amber-50 border border-amber-300 text-amber-800' : 'bg-amber-400/10 border border-amber-400/40 text-amber-300'}`}
                  >
                    {pieceSupported(clip, p.id).reason}
                  </p>
                ))}

                {/* Voice isolation A/B, when this clip can take it */}
                {pieces.voice && supports(clip, 'voice') && (
                  a?.vocalsUrl ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[11px] text-[var(--editor-text)]/70">
                        Isolated voice. Compare the two before you apply.
                      </span>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[10px] text-[var(--editor-text)]/55">Original</span>
                          <audio
                            controls
                            preload="none"
                            src={adapter.fileUrl(clip.src ?? '')}
                            aria-label={`Original audio for ${clipLabel(clip)}`}
                          />
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[10px] text-[var(--editor-text)]/55">Isolated voice</span>
                          <audio
                            controls
                            preload="none"
                            src={a.vocalsUrl}
                            aria-label={`Isolated voice for ${clipLabel(clip)}`}
                          />
                        </span>
                      </div>
                    </div>
                  ) : null
                )}

                {/* Removals */}
                {rows.length === 0 ? (
                  <p className="text-[11px] text-[var(--editor-text)]/45 italic">No removals proposed for this clip.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {rows.map(row => (
                      <li key={row.key}>
                        <label className="flex items-start gap-2 text-[11px] text-[var(--editor-text)]/80 cursor-pointer hover:bg-[var(--editor-text)]/5 rounded px-1 py-0.5">
                          <input
                            type="checkbox"
                            checked={Boolean(approved[row.key])}
                            aria-label={`${row.piece === 'silence' ? 'Remove silence' : `Remove filler ${row.text ? `"${row.text}"` : ''}`.trim()} at ${clock(row.tlStart)}`}
                            onChange={() => setApproved(s => ({ ...s, [row.key]: !s[row.key] }))}
                            className="mt-0.5"
                          />
                          <span className="font-mono shrink-0">{clock(row.tlStart)}</span>
                          <span className="font-mono text-[var(--editor-text)]/50 shrink-0">
                            {`${(row.tlEnd - row.tlStart).toFixed(2)}s`}
                          </span>
                          <span className="text-[var(--editor-text)]/50 shrink-0">
                            {row.piece === 'silence' ? 'silence' : 'filler'}
                          </span>
                          {row.text && <span className="italic truncate">{`"${row.text}"`}</span>}
                          {row.flagged && (
                            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded leading-snug ${mode === 'light' ? 'bg-amber-50 border border-amber-300 text-amber-800' : 'bg-amber-400/10 border border-amber-400/40 text-amber-300'}`}>
                              {`Flagged. ${row.reason ?? ''}`.trim()}
                            </span>
                          )}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
          <span className="text-[11px] text-[var(--editor-text)]/50">
            {phase === 'review'
              ? `${totalApproved} removal${totalApproved === 1 ? '' : 's'} ticked. The timeline is showing the result.`
              : 'Nothing is saved until you press Apply.'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCancel}
              className={`text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 transition-colors ${mode === 'light' ? 'hover:bg-red-50 hover:border-red-300 hover:text-red-700' : 'hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'}`}
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={phase !== 'review' || busy}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // Portal to document.body so a transformed host ancestor cannot trap this
  // `fixed` overlay and push the panel off-screen (see RenderModal).
  return createPortal(panel, document.body)
}

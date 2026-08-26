/**
 * timelineImport — the host half of "drag a video file from Finder straight
 * onto the timeline". The editor package's canvas half only knows WHERE the
 * pointer released (time + row) and WHAT was dropped (`File[]`); everything
 * from there — staging the upload, running the server-side ingest, and
 * placing the finished clip — is Montaj's job, via `VideoEditor`'s
 * `onImportFilesToTimeline` prop (this hook's `handleImportFilesToTimeline`)
 * and `pendingDrops` prop (this hook's `pendingDrops`).
 *
 * THE CENTRAL DESIGN DECISION — A GHOST IS NOT A TIMELINE ITEM:
 * A drop must feel instant, but a dropped `File` has no server-assigned
 * `src`, no proxy, and no confirmed duration until ingest finishes — which
 * can take anywhere from a second to a couple of minutes for a large source.
 * Rather than either blocking the drop until ingest completes, or inserting
 * a half-real placeholder clip onto the timeline and mutating it in place
 * later, this hook keeps the "mid-import" state OUTSIDE the project
 * entirely: `pendingDrops` is host-local React state, rendered by the
 * package as a ghost band at the drop point. A ghost is deliberately NOT a
 * timeline item — it is never selectable, persistable, undoable, renderable,
 * or exportable, and it can never leak into a saved project.json, because it
 * never enters `project.tracks` in the first place. Only when the ingest job
 * resolves `done` does a REAL clip get placed (via the shared
 * `placeDroppedClip` rule, the same one the footage-bin drag uses), built
 * from the job's own result — never from anything guessed at drop time.
 *
 * WHY THE JOB RESULT'S `src` IS THE ONLY ONE USED:
 * `POST /projects/:id/sources` (serve/routes/projects.py,
 * `_run_ingest_detached`) probes and colour-normalizes the file INLINE
 * before it ever appends anything to `project.sources` — normalization can
 * rewrite `src` to point at a new file entirely. The upload path this hook
 * hands to `ingestSource` is therefore never the right `src` for a placed
 * clip; only `status.result.src`, read back after the job reports `done`, is
 * trustworthy. This is exactly why placement waits for the job instead of
 * placing something optimistically from the upload.
 *
 * THE SSE RACE (see `commitIngestedClip` below):
 * The same server call that finishes the job also appends the clip to
 * `project.sources` and broadcasts it over SSE, independently of this hook's
 * poll noticing `status: done`. The poll can (and does, often) observe
 * `done` before that SSE frame reaches this tab. Saving a project snapshot
 * whose `sources` doesn't yet contain the new entry would silently overwrite
 * the server's own append the instant this save lands — so every commit
 * checks first and only appends when the entry is genuinely missing,
 * regardless of which side won the race.
 *
 * THE PROJECT-SWITCH RACE (see `commitIngestedClip` and the `projectId`
 * effect below): an import's poll can easily outlive the page it started
 * on — the app's `<Route path="projects/:id">` has no `key`, so navigating
 * A → B RE-RENDERS `EditorPage` rather than remounting it, and a job that
 * resolves after that navigation must never commit into whatever project
 * happens to be open by then. Two mechanisms cooperate: the effect keyed on
 * `projectId` (the ROUTE id, authoritative independent of `projectRef`'s own
 * staleness) stops every in-flight poll and clears every ghost the instant
 * the route changes, and `commitIngestedClip` separately refuses to commit
 * when the project it would write into isn't the one the drop started on —
 * the belt to that effect's suspenders, for the narrow case where a poll
 * tick is already mid-flight past the effect's cleanup.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { api } from '@/lib/api'
import { probeVideoDuration } from '@/lib/videoDuration'
import { normalizeTracks, placeDroppedClip, resolveDropTrackIndex, type EditorAdapter, type PendingDrop, type TimelineDropPlacement } from '@bycrux/editor'
import type { Project, VisualItem } from '@/lib/types/schema'

export interface UseTimelineImportArgs {
  /** Only `ingestSource` is used — narrowed rather than taking the whole
   *  adapter so this module doesn't widen its surface with the editor's
   *  render/caption/etc. methods it has no business touching. */
  adapter: Pick<EditorAdapter<Project>, 'ingestSource'>
  /** The authoritative latest project (EditorPage's `projectRef`), read
   *  fresh at commit time rather than closed over — see EditorPage.tsx's
   *  own comment on `projectRef` for why. */
  projectRef: MutableRefObject<Project | null>
  /** Propagates a committed project the same way every other EditorPage
   *  mutation does (`handleAssetsChange`, `handleRemoveSource`, ...). */
  onProjectChange: (p: Project) => void
  /** The route's project id (EditorPage's `id` param) — see the module
   *  header's PROJECT-SWITCH RACE note. Always fresh, unlike `projectRef`,
   *  which is why this is what drives the "the operator navigated away"
   *  cleanup rather than reading `projectRef.current?.id`. */
  projectId: string | undefined
}

export interface UseTimelineImportResult {
  /** Ghost bands to render — fed straight to `VideoEditor`'s `pendingDrops`. */
  pendingDrops: PendingDrop[]
  /** Fed straight to `VideoEditor`'s `onImportFilesToTimeline`. */
  handleImportFilesToTimeline: (files: File[], placement: TimelineDropPlacement) => void
}

/** A host-owned id for one in-flight drop, used both as the `PendingDrop.id`
 *  and as the poll-timer key. Same shape as FootagePanel's `InFlightImport`
 *  ids — collision-safe enough for a handful of concurrent drops. */
function newDropId(): string {
  return `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A dropped file's ingest is polled until the server reports `done` or
 *  `error`. If it reports NEITHER for this long — a hung ffmpeg probe/normalize
 *  is the usual cause — give up rather than leave the ghost band on the
 *  timeline forever (it is not a project item, so nothing else — undo included
 *  — can clear it). The server keeps ingesting after the client stops polling,
 *  so a slow-but-successful source still lands in the footage bin; we just stop
 *  auto-placing it. Generous on purpose: a large HDR normalize is minutes of
 *  legitimate work, and this must only fire on a genuine stall. */
const INGEST_POLL_TIMEOUT_MS = 5 * 60_000

export function useTimelineImport({
  adapter,
  projectRef,
  onProjectChange,
  projectId,
}: UseTimelineImportArgs): UseTimelineImportResult {
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([])
  // One poll timer per in-flight drop, keyed by the drop's id. Mirrors
  // FootagePanel's `pollTimers` ref exactly, including the unmount cleanup
  // below — a timer that outlives this page and then calls setState is a
  // leak and a React warning, not just untidy. `setTimeout`, not
  // `setInterval` — see `importOneFile`'s `poll` for why.
  const pollTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Set once this hook's owning component unmounts. Checked from inside an
  // in-flight async chain (a poll tick, or the upload itself) at every point
  // that would otherwise touch React state or schedule a new timer — a plain
  // `clearTimeout` in the unmount cleanup only cancels a timer that has
  // already been registered; it cannot reach back into a promise chain that
  // is still awaiting something upstream of that registration.
  const unmountedRef = useRef(false)

  useEffect(() => {
    // Reset on EVERY (re)mount, not only set-true on cleanup. React StrictMode
    // (dev) mounts → unmounts → remounts, and the cleanup below sets this true;
    // without resetting here it stays true after the remount, and then every
    // guard that reads it (see importOneFile's `poll`) bails — the ingest still
    // finishes server-side, but the client never polls it, so the ghost never
    // resolves. This exact stuck-`true` was the "drop never resolves" bug.
    unmountedRef.current = false
    const timers = pollTimers.current
    return () => {
      unmountedRef.current = true
      timers.forEach(t => clearTimeout(t))
      timers.clear()
    }
  }, [])

  // The operator navigated to a DIFFERENT project (see the module header's
  // PROJECT-SWITCH RACE note). Every poll still running belongs to the OLD
  // project and must stop now, and every ghost on screen belongs to the OLD
  // project's timeline and must go with it — leaving either behind would
  // show project A's imports finishing on project B's canvas. Runs on mount
  // too (harmlessly: both are empty then).
  useEffect(() => {
    pollTimers.current.forEach(t => clearTimeout(t))
    pollTimers.current.clear()
    setPendingDrops([])
  }, [projectId])

  const stopPolling = useCallback((dropId: string) => {
    const timer = pollTimers.current.get(dropId)
    if (timer !== undefined) {
      clearTimeout(timer)
      pollTimers.current.delete(dropId)
    }
  }, [])

  const removeDrop = useCallback((dropId: string) => {
    setPendingDrops(prev => prev.filter(d => d.id !== dropId))
  }, [])

  // Commit one finished ingest job into the project: reconcile `sources`
  // (idempotently — see the SSE-race comment in the module header) and, if
  // this file had a usable local probe at drop time, place the real clip via
  // the shared drop rule. Runs once per file, the moment its job reports
  // `done`. `atTime === null` means the local probe failed at drop time (no
  // ghost was ever shown for this file) — the clip still joins `sources` so
  // it lands in the footage bin, but nothing is placed on the timeline.
  // `dropProjectId` is the project this file was DROPPED on (captured by
  // `importOneFile` before anything async happened) — see the module
  // header's PROJECT-SWITCH RACE note for why it's checked against
  // `projectRef.current.id` rather than trusted blindly.
  const commitIngestedClip = useCallback(
    async (result: VisualItem, atTime: number | null, trackIndex: number, ripple: boolean, dropProjectId: string) => {
      const base = projectRef.current
      if (!base) return // the project was navigated away from entirely
      // Never commit an import onto a project other than the one it was
      // dropped on — mirrors the `captionJob.projectId` guard EditorPage
      // already applies to the caption job for the identical "this job
      // outlives its route" reason (see EditorPage.tsx's own comment there).
      if (base.id !== dropProjectId) return

      const hasSource = (base.sources ?? []).some(s => s.id === result.id)
      const withSource: Project = hasSource
        ? base
        : { ...base, sources: [...(base.sources ?? []), result] }

      let updated = withSource
      if (atTime != null) {
        // `placeDroppedClip` returns `withSource` back BY REFERENCE when it
        // places nothing (e.g. the server's own `sourceDuration` came back
        // missing) — `updated` then stays exactly `withSource`, i.e. the
        // sources reconciliation is still committed and the clip is
        // recoverable from the bin, same as any other probe-less source.
        const placed = placeDroppedClip(withSource, {
          atTime,
          preferredTrackIndex: trackIndex,
          ripple,
          clip: {
            src: result.src ?? '',
            proxySrc: result.proxySrc,
            sourceDuration: result.sourceDuration ?? 0,
            sourceWidth: result.sourceWidth,
            sourceHeight: result.sourceHeight,
          },
        })
        updated = placed.project
      }

      onProjectChange(updated)
      await api.saveProject(base.id, updated)
    },
    [projectRef, onProjectChange],
  )

  // The full per-file pipeline: import -> poll -> commit-or-fail.
  // `atTimePromise` is this file's OWN drop-order position — see
  // `handleImportFilesToTimeline`'s cursor-chain comment for how it's built
  // and why awaiting it can never deadlock. It resolves to `null` on a
  // failed local probe (no ghost was ever shown for this file). `dropId`
  // names its ghost, if it has one.
  const importOneFile = useCallback(
    (file: File, atTimePromise: Promise<number | null>, trackIndex: number, ripple: boolean, dropId: string) => {
      // Captured now, once, rather than re-read from `projectRef` later —
      // this IS "the project the drop happened on" for the rest of this
      // file's pipeline, including the `commitIngestedClip` guard above.
      const dropProjectId = projectRef.current?.id
      if (!dropProjectId) return

      // Shared failure exit: every "something went wrong" path — a thrown
      // upload/ingest call, a job that reports `error`, a `done` with no
      // usable result, or a commit that itself throws (e.g. `saveProject`
      // rejecting) — converges here. Mirrors EditorPage's
      // `handleStartManual`: log it, surface it via `alert` (this
      // codebase's established failure surface — see MobileLiveView,
      // ProjectHeader, MobileVideoPreview), and never leave a ghost stranded.
      const fail = (message: string) => {
        stopPolling(dropId)
        removeDrop(dropId)
        console.error(message)
        alert(`Could not import "${file.name}": ${message}`)
      }

      void (async () => {
        let jobId: string
        try {
          const res = await adapter.ingestSource!(dropProjectId, file)
          jobId = res.jobId
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e))
          return
        }

        // The upload above can take minutes for a large source. If this hook
        // (or this project) has since gone away, there is nothing left to
        // poll for — checked BEFORE the first timer is even created, because
        // a timer registered after the unmount cleanup already ran would
        // never be cleared by it.
        if (unmountedRef.current) return

        // When this file's ingest began polling — the deadline for
        // INGEST_POLL_TIMEOUT_MS below, so a hung job never polls (or ghosts)
        // forever.
        const startedAt = Date.now()

        // Self-rescheduling `setTimeout`, not `setInterval`: a tick's own
        // `await api.getSourceJobStatus` can take longer than the 1s cadence
        // while a large source normalizes, and `setInterval` does not wait
        // for the previous tick to finish — two overlapping "done"
        // observations would each call `commitIngestedClip`, placing the
        // clip twice. Only ever scheduling the NEXT tick from inside the
        // current one's own completion makes "at most one tick in flight at
        // a time" a property of the structure, not something a flag has to
        // enforce.
        const poll = () => {
          void (async () => {
            if (unmountedRef.current) return
            try {
              const status = await api.getSourceJobStatus(dropProjectId, jobId)
              if (unmountedRef.current) return
              if (status.status === 'done') {
                stopPolling(dropId)
                if (!status.result || typeof status.result !== 'object') {
                  fail('Import finished with no result')
                  return
                }
                // Awaited HERE, at commit time, rather than before starting
                // the upload above — ingest takes seconds to minutes, so by
                // the time a job reports `done` this file's drop-order
                // position has essentially always settled already; this
                // await only ever has real work to do if an EARLIER file's
                // own probe is still bizarrely slow. Never deadlocks on a
                // failed predecessor: see the cursor-chain comment in
                // `handleImportFilesToTimeline` for why.
                const atTime = await atTimePromise
                if (unmountedRef.current) return
                await commitIngestedClip(status.result as VisualItem, atTime, trackIndex, ripple, dropProjectId)
                if (unmountedRef.current) return
                removeDrop(dropId)
              } else if (status.status === 'error') {
                fail(status.error ?? 'Import failed')
              } else if (Date.now() - startedAt > INGEST_POLL_TIMEOUT_MS) {
                // Staging/normalizing has run far too long — the server ingest
                // is hung (a stuck ffmpeg is the usual cause). Stop polling and
                // clear the ghost so it is never permanent; the source may still
                // land in the footage bin if the server eventually finishes.
                fail('Import is taking too long and was stopped. If it finishes, the clip will appear in the footage bin.')
              } else {
                // Still staging/normalizing/queueing — schedule the next tick.
                pollTimers.current.set(dropId, setTimeout(poll, 1000))
              }
            } catch (e) {
              fail(e instanceof Error ? e.message : String(e))
            }
          })()
        }
        // 1s cadence matches FootagePanel.startImport's own poll.
        pollTimers.current.set(dropId, setTimeout(poll, 1000))
      })()
    },
    [adapter, projectRef, commitIngestedClip, removeDrop, stopPolling],
  )

  const handleImportFilesToTimeline = useCallback(
    (files: File[], placement: TimelineDropPlacement) => {
      // A host that never wired an ingest adapter method has nothing this
      // hook can do with a dropped file. Same shape as the non-video filter
      // right below: silently accept nothing rather than throw on the `!`
      // inside `importOneFile`.
      if (!adapter.ingestSource) return

      // Non-video files are out of scope for this feature — matches
      // FootagePanel.handleDrop's own filter exactly.
      const videoFiles = files.filter(f => f.type.startsWith('video/'))
      if (videoFiles.length === 0) return

      // Every file's UPLOAD starts here, immediately and unconditionally —
      // `importOneFile` below is called synchronously for every file in this
      // loop, before any probe has even settled. `ingestSource` needs only
      // the `File`, never a duration or a timeline position, so nothing
      // about placement has any business gating it: gating it on a
      // `Promise.all` of every probe was the actual "must feel instant"
      // violation this hook exists to avoid (`probeVideoDuration` gives up
      // after 10s, so one bad-header file in a five-file drop used to blank
      // the WHOLE drop, uploads included, for ten seconds).
      //
      // A file's GHOST and its eventual `atTime`, unlike its upload, DO have
      // to respect drop order — the operator picked an order when they
      // selected these files, and reordering their clips because one file's
      // probe happened to answer faster would read as a bug, not a feature.
      // `cursorPromise` threads the running position through the loop below
      // to preserve that: `cursorBeforeThisFile` is captured before it's
      // reassigned, so it names "the position once every file AHEAD of this
      // one, in drop order, has settled" — regardless of whether any of them
      // succeeded. Each file's `settled` promise pairs that with its OWN
      // probe outcome (mapped so a rejection resolves to `null` rather than
      // propagating — this is what stops a failed probe from stranding
      // every file behind it: it contributes zero duration and the chain
      // moves on) to derive both `atTimePromise` (this file's own position,
      // fed to its ghost and to `importOneFile`'s eventual commit) and the
      // NEXT file's `cursorBeforeThisFile`. A ghost therefore appears the
      // moment ITS OWN position is computable — one at a time, left to
      // right, as probes land in drop order — while the uploads themselves
      // already started, in parallel, without waiting on any of this.
      let cursorPromise: Promise<number> = Promise.resolve(placement.atTime)
      videoFiles.forEach(file => {
        const cursorBeforeThisFile = cursorPromise

        const ownProbe: Promise<number | null> = probeVideoDuration(file).then(
          d => d,
          () => null, // no ghost, no placement target — see the comment below
        )

        const settled = Promise.all([cursorBeforeThisFile, ownProbe]).then(
          ([cursorBefore, durationSec]) => ({ cursorBefore, durationSec }),
        )
        const atTimePromise: Promise<number | null> = settled.then(
          ({ cursorBefore, durationSec }) => (durationSec != null ? cursorBefore : null),
        )
        cursorPromise = settled.then(
          ({ cursorBefore, durationSec }) => (durationSec != null ? cursorBefore + durationSec : cursorBefore),
        )

        const dropId = newDropId()

        void atTimePromise.then(atTime => {
          if (atTime == null) {
            // This file's OWN local probe failed — no ghost, no placement
            // target (a failed PREDECESSOR never makes this null; it only
            // ever costs this file zero duration's worth of cursor advance —
            // see `cursorPromise` above). Its import still runs below, so it
            // lands in the footage bin. If the server's own probe also
            // fails, FootagePanel's existing "Duration unknown" recovery
            // state (dimmed card, amber label, a manual "Get duration"
            // button) is the fallback — this hook builds nothing new for
            // that case.
            return
          }
          // `durationSec` is guaranteed non-null whenever `atTime` is —
          // `atTimePromise` above derives both from the same `settled`
          // result — so this second `.then` never actually waits.
          void ownProbe.then(durationSec => {
            // Draw the ghost on the VIDEO row the clip will actually land on,
            // NOT the raw row the pointer released over — that raw row can be
            // an overlay/image row, and a ghost there is misleading (the clip
            // itself always resolves to a video row via `placeDroppedClip`).
            // Same selection rule, so the ghost and the eventual placement can
            // never disagree. If the project momentarily isn't available, fall
            // back to the raw index (the canvas ghost renderer clamps an
            // unknown row to the base video row regardless).
            const project = projectRef.current
            const trackIndex = project
              ? resolveDropTrackIndex(project, {
                  atTime,
                  preferredTrackIndex: placement.preferredTrackIndex,
                  ripple: placement.ripple,
                  clip: { sourceDuration: durationSec as number },
                })
              : placement.preferredTrackIndex
            // `resolveDropTrackIndex` returns exactly
            // `normalizeTracks(project).tracks.length` — a row that does not
            // exist yet — for the "no existing video row fits, mint a new
            // one" case (see its own doc, and `placeDroppedClip`, which uses
            // this SAME test to decide when to call `placeOnNewTrack`). The
            // canvas ghost renderer has no row to look up for that index, so
            // it needs telling explicitly rather than falling back to the
            // base video row, which may already carry footage this drop has
            // nothing to do with. `undefined`, not `false`, for the common
            // case — `PendingDrop.newTrack` is optional precisely so a normal
            // drop's ghost object is unchanged from before this field existed.
            const newTrack = project != null && trackIndex >= (normalizeTracks(project).tracks?.length ?? 0)
              ? true
              : undefined
            setPendingDrops(prev => [
              ...prev,
              { id: dropId, atTime, durationSec: durationSec as number, trackIndex, newTrack, label: file.name },
            ])
          })
        })

        importOneFile(file, atTimePromise, placement.preferredTrackIndex, placement.ripple, dropId)
      })
    },
    [adapter, importOneFile],
  )

  return { pendingDrops, handleImportFilesToTimeline }
}

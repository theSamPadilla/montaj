import { useCallback, useEffect, useRef, useState } from 'react'
import { Crop, Info, Magnet, Undo2 } from 'lucide-react'
import type { Project, VideoEditorProps } from '../types'
import { VideoSourceCropModal } from '../crop/VideoSourceCropModal'
import ControlsInfoModal, { VIDEO_CONTROLS } from '../ControlsInfoModal'
import { getOverlayDesignCanvas } from './design-canvas'
import { applyTheme, defaultMontajTheme } from '../theme'
import { applyCutToItem, applyCutToTracks, collapseGaps, splitAtTime } from './cuts'
import { repairCaptionWords } from './captionRepair'
import Timeline from './timeline/Timeline'
import PreviewPlayer from './preview/PreviewPlayer'
import VersionPanel from './VersionPanel'
import RenderModal from './RenderModal'
import CaptionRegenModal from './CaptionRegenModal'

// Generic over the host's concrete project type `P` (default = the package's
// own `Project`). Montaj passes its richer Project; the index signature on
// EditorProject absorbs host-only pipeline fields so a full host Project
// round-trips through edit→save (and `onProjectChange`) without casts.
type Props<P extends Project = Project> = VideoEditorProps<P>

/**
 * `<VideoEditor>` — the assembled, host-agnostic video editor.
 *
 * Absorbs Montaj's former LiveView (pending/processing surface) and ReviewView
 * (draft/final surface) into one component driven by the `EditorAdapter`.
 * Controlled like `<CarouselEditor>`: the host owns `project` and is notified of
 * edits via `onProjectChange`; persistence flows through `adapter.saveProject`.
 * It does NOT own a `useProjectState` reducer — it preserves the original
 * Live/Review save model exactly (mutate → onProjectChange → adapter.saveProject
 * fire-and-forget), so the host's pipeline fields survive untouched.
 *
 * ProjectHeader is lifted out (the host renders it in its shell). This component
 * renders: timeline + preview + version panel + render modal + the host-supplied
 * inspector/subcut render-prop seams + an optional back-to-setup affordance.
 */
export default function VideoEditor<P extends Project = Project>({
  project,
  adapter,
  onProjectChange,
  theme,
  slots,
  onBackToSetup,
  assetsPlacement = 'right',
  renderProgressView = 'phases',
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
}: Props<P>) {
  const emit = onProjectChange ?? (() => {})

  // ── Theme: apply tokens onto the editor container. ──
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (containerRef.current) applyTheme(containerRef.current, theme ?? defaultMontajTheme)
  }, [theme])

  const isPending = project.status === 'pending'

  // ── Shared injected adapter fns, threaded to Timeline + PreviewPlayer. ──
  const getWaveformChunks = adapter.getWaveformChunks
  const resolveFilePath   = adapter.fileUrl
  const save = (p: P) => { void adapter.saveProject(p.id, p) }

  if (isPending) {
    return (
      <div ref={containerRef} className="flex flex-col h-full bg-[var(--editor-bg)]">
        <PendingSurface
          project={project}
          adapter={adapter}
          onProjectChange={emit}
          slots={slots}
          onBackToSetup={onBackToSetup}
          getWaveformChunks={getWaveformChunks}
          resolveFilePath={resolveFilePath}
          save={save}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <ReviewSurface
        project={project}
        adapter={adapter}
        onProjectChange={emit}
        slots={slots}
        assetsPlacement={assetsPlacement}
        renderProgressView={renderProgressView}
        getWaveformChunks={getWaveformChunks}
        resolveFilePath={resolveFilePath}
        save={save}
        renderClipInspector={renderClipInspector}
        renderSubcutRegen={renderSubcutRegen}
        regenEnabled={regenEnabled}
        isClipQueued={isClipQueued}
        onProvideRenderTrigger={onProvideRenderTrigger}
      />
    </div>
  )
}

// ── Version-history hook (shared by both surfaces) ───────────────────────────

function useVersionHistory<P extends Project>(adapter: VideoEditorProps<P>['adapter'], project: P) {
  const [versions, setVersions]   = useState<{ hash: string; message: string; timestamp: string }[]>([])
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    adapter.listVersionHistory?.(project.id).then(setVersions).catch(() => {})
  }, [adapter, project.id, project.status])

  return { versions, restoring, setRestoring }
}

// ── Pending / processing surface (former LiveView) ───────────────────────────

interface SurfaceProps<P extends Project> {
  project: P
  adapter: VideoEditorProps<P>['adapter']
  onProjectChange: (p: P) => void
  slots?: VideoEditorProps<P>['slots']
  assetsPlacement?: VideoEditorProps<P>['assetsPlacement']
  renderProgressView?: VideoEditorProps<P>['renderProgressView']
  getWaveformChunks?: VideoEditorProps<P>['adapter']['getWaveformChunks']
  resolveFilePath: (path: string) => string
  save: (p: P) => void
  onProvideRenderTrigger?: VideoEditorProps<P>['onProvideRenderTrigger']
}

function PendingSurface<P extends Project>({
  project,
  adapter,
  onProjectChange,
  slots,
  onBackToSetup,
  getWaveformChunks,
  resolveFilePath,
}: SurfaceProps<P> & { onBackToSetup?: () => void }) {
  const [currentTime, setCurrentTime] = useState(0)
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

  useEffect(() => {
    adapter.getInfo?.().then(info => setSkillPath(info.root_skill_path ?? null)).catch(() => {})
  }, [adapter])

  const clips           = project.tracks?.[0] ?? []
  const hasTrimmedClips = clips.some(c => c.inPoint !== undefined && c.outPoint !== undefined)
  // The back-to-setup affordance is gated on the host supplying it AND the
  // project being safe to discard (no manual trims yet). Mirrors LiveView's
  // canGoBack rule.
  const canGoBack = !hasTrimmedClips && !!onBackToSetup

  async function handleRestoreVersion(hash: string) {
    if (!adapter.restoreVersion) return
    setRestoring(hash)
    try {
      const restored = await adapter.restoreVersion(project.id, hash)
      onProjectChange(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-4">
          {hasTrimmedClips ? (
            <PreviewPlayer
              project={project}
              currentTime={currentTime}
              onTimeUpdate={setCurrentTime}
              compileOverlay={adapter.compileOverlay}
              clearOverlayCache={adapter.clearOverlayCache}
              watchFile={adapter.watchFile}
              fileUrl={adapter.fileUrl}
              resolveCaptionTemplate={adapter.resolveCaptionTemplate}
            />
          ) : (
            <div className="flex flex-col items-center gap-6 text-center max-w-lg w-full">
              {/* Host feeds live agent progress through the pendingStatus slot;
                  absent → skill-path card (if info available) or a minimal default. */}
              {slots?.pendingStatus ?? (
                <>
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-[var(--editor-text)] text-lg font-semibold">Message your agent to start</p>
                    <p className="text-[var(--editor-text)]/60 text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
                  </div>
                  {skillPath && (
                    <div className="w-full rounded-xl border-2 border-[var(--editor-accent)]/50 bg-[var(--editor-surface)] p-5 flex flex-col gap-3 text-left shadow-lg shadow-[var(--editor-accent)]/10">
                      <p className="text-[var(--editor-accent)] text-xs font-bold uppercase tracking-widest">Send this to your agent</p>
                      <div className="flex items-start justify-between bg-black/60 border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                        <span className="text-gray-200 text-[12px] leading-relaxed break-all">
                          There is a new project pending: &quot;{project.name ?? project.id}&quot;. Please see @{skillPath} and start. Talk to me if you run into questions.
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start. Talk to me if you run into questions.`
                            )
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          }}
                          className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                            copied ? 'bg-green-700 text-green-200' : 'bg-[var(--editor-text)]/10 text-[var(--editor-text)]/80 hover:bg-[var(--editor-text)]/20 hover:text-[var(--editor-text)]'
                          }`}
                          title="Copy prompt"
                        >
                          {copied ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              <p className="text-[var(--editor-text)]/40 text-xs font-mono">project id: {project.id}</p>
              {canGoBack && (
                <button
                  onClick={onBackToSetup}
                  className="text-xs text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors underline underline-offset-2"
                >
                  ← Back to setup
                </button>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <Timeline
            project={project}
            currentTime={currentTime}
            onTimeUpdate={setCurrentTime}
            getWaveformChunks={getWaveformChunks}
            resolveFilePath={resolveFilePath}
            onSaveProject={(p) => adapter.saveProject(p.id, p as P)}
          />
        </div>
      </div>

      {/* Right sidebar — version history (hidden when the capability is absent) */}
      {adapter.listVersionHistory && (
        <div className="w-48 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />
        </div>
      )}
    </div>
  )
}

// ── Draft / final surface (former ReviewView) ────────────────────────────────

function ReviewSurface<P extends Project>({
  project,
  adapter,
  onProjectChange,
  slots,
  assetsPlacement = 'right',
  renderProgressView = 'phases',
  getWaveformChunks,
  resolveFilePath,
  save,
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
  onProvideRenderTrigger,
}: SurfaceProps<P> & {
  renderClipInspector?: VideoEditorProps<P>['renderClipInspector']
  renderSubcutRegen?: VideoEditorProps<P>['renderSubcutRegen']
  regenEnabled?: boolean
  isClipQueued?: (itemId: string) => boolean
}) {
  const [currentTime, setCurrentTime] = useState(0)
  const [canUndo, setCanUndo]         = useState(false)
  const historyRef = useRef<P[]>([])
  // Multi-select: all currently-selected timeline item ids. Single-select
  // consumers (canvas preview, cut/split) use selectedIds[0] as the primary.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const primarySelectedId = selectedIds[0] ?? null
  const [rippleMode, setRippleMode]   = useState(false)
  const [showControls, setShowControls] = useState(false)
  // Source-crop mode: when on, the VideoSourceCropModal opens for the selected
  // tracks[0] video item. Cleared when selection changes.
  const [cropMode, setCropMode]       = useState(false)
  const [renderOpen, setRenderOpen]   = useState(false)
  const [regenCaptionsOpen, setRegenCaptionsOpen] = useState(false)
  // The clip/audio inspector target — derived from the timeline's inspect
  // callbacks. A Montaj-agnostic { kind, id } selector, not a project entity.
  const [inspecting, setInspecting]   = useState<{ kind: 'clip' | 'audio'; id: string } | null>(null)

  // Render trigger — marks the project final, saves, and opens the RenderModal.
  // Kept stable (latest project/onChange/save read via refs) so a host that
  // places Render in its own header (onProvideRenderTrigger) can store the
  // callback once without it going stale.
  const projectRef         = useRef(project);         projectRef.current = project
  const onProjectChangeRef = useRef(onProjectChange); onProjectChangeRef.current = onProjectChange
  const saveRef            = useRef(save);            saveRef.current = save
  const openRender = useCallback(() => {
    const final = { ...projectRef.current, status: 'final' } as P
    onProjectChangeRef.current(final)
    saveRef.current(final)
    setRenderOpen(true)
  }, [])
  useEffect(() => { onProvideRenderTrigger?.(openRender) }, [onProvideRenderTrigger, openRender])

  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

  // Repair caption segments whose words[] text has diverged from edited seg.text.
  // Inline caption edits update seg.text but not seg.words; this normalizes the
  // data so PreviewPlayer's word-level timing is correct. Runs once per project.id.
  useEffect(() => {
    const captions = project.captions
    if (!captions?.segments?.length) return
    const repaired = repairCaptionWords(captions)
    if (!repaired) return
    const next = { ...project, captions: repaired } as P
    onProjectChange(next)
    void adapter.saveProject(next.id, next)
  }, [project.id]) // intentionally keyed on project.id only — runs once per project load

  const clips      = project.tracks?.[0] ?? []
  const hasContent = clips.length > 0 || (project.tracks?.slice(1).flat().length ?? 0) > 0 || (project.captions?.segments?.length ?? 0) > 0

  // The selected tracks[0] video item, if any — the only thing source-crop mode
  // can target. Source crop is a tracks[0]-video primitive (the renderer applies
  // it to the original clip before compositing).
  const cropTarget = primarySelectedId
    ? clips.find(c => c.id === primarySelectedId && c.type === 'video' && !!c.src) ?? null
    : null

  // Selecting a different item (or nothing croppable) exits crop mode.
  useEffect(() => {
    if (!cropTarget && cropMode) setCropMode(false)
  }, [cropTarget, cropMode])

  function pushHistory(prev: P) {
    historyRef.current = [...historyRef.current.slice(-49), prev]
    setCanUndo(true)
  }

  // Edits coming from the timeline (drag/move/track changes): snapshot for undo,
  // notify host, persist.
  function handleProjectChange(p: Project) {
    pushHistory(project)
    onProjectChange(p as P)
    save(p as P)
  }

  function handleUndo() {
    const hist = historyRef.current
    if (!hist.length) return
    const prev = hist[hist.length - 1]
    historyRef.current = hist.slice(0, -1)
    setCanUndo(hist.length > 1)
    onProjectChange(prev)
    save(prev)
  }

  function handleCut(cut: { start: number; end: number }) {
    pushHistory(project)
    let updated = primarySelectedId
      ? applyCutToItem(project, primarySelectedId, cut)
      : applyCutToTracks(project, cut)
    if (rippleMode) updated = collapseGaps(updated)
    onProjectChange(updated as P)
    save(updated as P)
    setSelectedIds([])
  }

  function handleOverlayChange(id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number; fit?: 'cover' | 'contain' | 'fill'; sourceCrop?: { x: number; y: number; w: number; h: number }; sourceWidth?: number; sourceHeight?: number }) {
    pushHistory(project)
    const updated = {
      ...project,
      tracks: (project.tracks ?? []).map(track =>
        track.map(item => item.id !== id ? item : { ...item, ...changes })
      ),
    } as P
    onProjectChange(updated)
    save(updated)
  }

  function handleSplit(at?: number) {
    const updated = splitAtTime(project, at ?? currentTime, primarySelectedId ?? null)
    if (updated === project) return
    pushHistory(project)
    onProjectChange(updated as P)
    save(updated as P)
  }

  function handleRippleToggle() {
    const next = !rippleMode
    setRippleMode(next)
    if (next) {
      const collapsed = collapseGaps(project)
      if (collapsed !== project) {
        pushHistory(project)
        onProjectChange(collapsed as P)
        save(collapsed as P)
      }
    }
  }

  // Keyboard: split (S) and undo (cmd/ctrl-Z). Guarded against text inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); handleSplit() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); handleUndo() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [project, currentTime, primarySelectedId, canUndo])

  async function handleRestoreVersion(hash: string) {
    if (!adapter.restoreVersion) return
    setRestoring(hash)
    try {
      const restored = await adapter.restoreVersion(project.id, hash)
      onProjectChange(restored)
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Work area — editor body + version rail, side by side */}
      <div className="flex flex-1 overflow-hidden min-h-0">
      {/* Main: preview + timeline */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-2">
          {hasContent ? (
            <div
              className="relative h-full max-w-full"
              style={{ aspectRatio: (() => { const [w, h] = getOverlayDesignCanvas(project.settings?.resolution); return `${w} / ${h}` })() }}
            >
              <PreviewPlayer
                project={project}
                currentTime={currentTime}
                onTimeUpdate={setCurrentTime}
                selectedOverlayId={primarySelectedId ?? undefined}
                onOverlayChange={handleOverlayChange}
                compileOverlay={adapter.compileOverlay}
                clearOverlayCache={adapter.clearOverlayCache}
                watchFile={adapter.watchFile}
                fileUrl={adapter.fileUrl}
                resolveCaptionTemplate={adapter.resolveCaptionTemplate}
              />
            </div>
          ) : (
            <p className="text-[var(--editor-text)]/60 text-sm">No clips</p>
          )}
        </div>

        {/* Track controls bar — info + split + ripple + render */}
        <div className="shrink-0 flex items-center justify-end gap-1.5 px-3 py-1 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <button
            onClick={() => setShowControls(true)}
            title="Editor controls & shortcuts"
            aria-label="Editor controls & shortcuts"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] mr-auto"
          >
            <Info size={12} />
          </button>
          <button
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo (Cmd/Ctrl+Z)"
            aria-label="Undo"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Undo2 size={12} />
          </button>
          <button
            onClick={() => handleSplit()}
            title="Split at playhead (S) — selected item or all clips"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="6" y1="0" x2="6" y2="12" />
              <polyline points="3,3 6,6 9,3" />
              <polyline points="3,9 6,6 9,9" />
            </svg>
          </button>
          <button
            onClick={handleRippleToggle}
            title={rippleMode ? 'Ripple mode on — edits close the gap' : 'Ripple mode off — edits leave a gap'}
            aria-pressed={rippleMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
              rippleMode
                ? 'text-teal-400 bg-teal-400/15 hover:bg-teal-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Magnet size={12} />
          </button>
          <button
            onClick={() => setCropMode(m => !m)}
            disabled={!cropTarget}
            title={
              !cropTarget
                ? 'Select a video clip to crop its source'
                : cropMode ? 'Exit source crop' : 'Crop source — non-destructively crop the selected clip'
            }
            aria-pressed={cropMode}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              cropMode
                ? 'text-amber-400 bg-amber-400/15 hover:bg-amber-400/25'
                : 'text-[var(--editor-text)]/60 bg-transparent hover:text-[var(--editor-text)]'
            }`}
          >
            <Crop size={12} />
          </button>
          {/* Default placement. A host that sets onProvideRenderTrigger renders
              Render in its own chrome instead, so the toolbar button is hidden. */}
          {!onProvideRenderTrigger && (
            <button
              onClick={openRender}
              className="text-xs px-2.5 py-1 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] hover:opacity-90 transition-colors"
            >
              Render →
            </button>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--editor-border)] bg-[var(--editor-surface)]">
          <Timeline
            project={project}
            currentTime={currentTime}
            onTimeUpdate={setCurrentTime}
            onProjectChange={handleProjectChange}
            onCaptionEdit={(p) => { onProjectChange(p as P); save(p as P) }}
            onOverlayEdit={(p) => { onProjectChange(p as P); save(p as P) }}
            selectedIds={selectedIds}
            onSelectIds={setSelectedIds}
            onSplit={handleSplit}
            onCut={handleCut}
            onInspectClip={(id) => setInspecting({ kind: 'clip', id })}
            onInspectAudio={(id) => setInspecting({ kind: 'audio', id })}
            onSaveProject={(p) => adapter.saveProject(p.id, p as P)}
            rippleMode={rippleMode}
            getWaveformChunks={getWaveformChunks}
            resolveFilePath={resolveFilePath}
            regenEnabled={regenEnabled}
            isClipQueued={isClipQueued}
            renderSubcutRegen={renderSubcutRegen}
            onRegenerateCaptions={adapter.generateCaptions ? () => setRegenCaptionsOpen(true) : undefined}
          />
        </div>
      </div>

      {/* Assets — dedicated separate column to the LEFT of the version rail
          (assetsPlacement: 'right', two distinct columns). The Montaj-local OS
          layout uses 'sidebar' instead (stacked into the version rail below).
          The host's panel manages its own scroll. */}
      {assetsPlacement === 'right' && slots?.assetsPanel && (
        <div className="w-72 shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden">
          {slots.assetsPanel}
        </div>
      )}

      {/* Right rail — version history + run history slot, and (in 'sidebar'
          placement) the assets panel stacked beneath them in the SAME column.
          This is the historical Montaj-local OS layout: versions on top, assets
          right below, one column — not a separate assets column. */}
      {(adapter.listVersionHistory || slots?.runHistory ||
        (assetsPlacement === 'sidebar' && slots?.assetsPanel)) && (
        <div className={`${assetsPlacement === 'sidebar' ? 'w-56' : 'w-48'} shrink-0 border-l border-[var(--editor-border)] bg-[var(--editor-surface)] flex flex-col overflow-hidden`}>
          {adapter.listVersionHistory && (
            <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />
          )}
          {/* Host injects the Montaj-flavored "Previous runs" snapshot list here.
              RunSnapshot / project.history are host-only types — the package never
              reads them. When absent nothing is rendered. */}
          {slots?.runHistory}
          {/* Assets stacked below versions/runs (assetsPlacement: 'sidebar'). The
              host's panel manages its own scroll; flex-1 lets it take the
              remaining rail height. A top border separates it from the runs. */}
          {assetsPlacement === 'sidebar' && slots?.assetsPanel && (
            <div className="flex-1 min-h-0 overflow-hidden border-t border-[var(--editor-border)] flex flex-col">
              {slots.assetsPanel}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Project media / assets — full-width region stacked BELOW the editor
          (assetsPlacement: 'bottom'). Preferred by width-constrained hosts (Hub).
          The host's panel manages its own scroll. */}
      {assetsPlacement === 'bottom' && slots?.assetsPanel && (
        <div className="shrink-0 border-t border-[var(--editor-border)] w-full flex flex-col max-h-[45%] overflow-hidden">
          {slots.assetsPanel}
        </div>
      )}

      {/* Source-crop modal — drag-to-pan, aspect presets, zoom. Commits
          sourceCrop (+ source dims) to the selected tracks[0] video on Apply. */}
      {cropMode && cropTarget && (
        <VideoSourceCropModal
          item={cropTarget}
          // Prefer the conformed per-window cache (short, starts at the clip's
          // first frame → loads instantly and shows a representative frame).
          // Falls back to the bg-removed proxy, then the raw source.
          resolveSrc={(it) => adapter.fileUrl(it.nobg_preview_src ?? it.normalizedSrc ?? it.src ?? '')}
          onApply={(next) => handleOverlayChange(cropTarget.id, {
            sourceCrop: {
              x: Math.min(1, Math.max(0, next.x)),
              y: Math.min(1, Math.max(0, next.y)),
              w: Math.min(1, Math.max(0, next.w)),
              h: Math.min(1, Math.max(0, next.h)),
            },
          })}
          onSrcDimsLoaded={(dims) => {
            if (cropTarget.sourceWidth && cropTarget.sourceHeight) return
            handleOverlayChange(cropTarget.id, { sourceWidth: dims.width, sourceHeight: dims.height })
          }}
          onClose={() => setCropMode(false)}
        />
      )}

      {/* Controls & shortcuts reference */}
      {showControls && (
        <ControlsInfoModal
          title="Editor controls"
          sections={VIDEO_CONTROLS}
          onClose={() => setShowControls(false)}
        />
      )}

      {/* Render modal — adapter.render stream + host export controls */}
      {renderOpen && (
        <RenderModal
          projectId={project.id}
          adapter={adapter}
          exportActions={slots?.exportActions}
          progressView={renderProgressView}
          onClose={() => setRenderOpen(false)}
          onCancel={() => setRenderOpen(false)}
        />
      )}

      {/* Caption regen modal — adapter.generateCaptions stream. On done we patch
          project.captions via onProjectChange only. We deliberately do NOT call
          save(): montaj persists the regenerated captions server-side and the
          SSE subscribe frame reconciles, so a saveProject here would double-write. */}
      {regenCaptionsOpen && adapter.generateCaptions && (
        <CaptionRegenModal
          adapter={adapter}
          projectId={project.id}
          onClose={() => setRegenCaptionsOpen(false)}
          onDone={(captions) => {
            const next = { ...project, captions } as P
            onProjectChange(next)
            setRegenCaptionsOpen(false)
          }}
        />
      )}

      {/* Clip / audio inspector — host-rendered via render-prop seam. */}
      {inspecting && renderClipInspector?.({
        item: inspecting,
        onClose: () => setInspecting(null),
      })}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Magnet } from 'lucide-react'
import type { Project, VideoEditorProps } from '../types'
import { applyTheme, defaultMontajTheme } from '../theme'
import { applyCutToItem, applyCutToTracks, collapseGaps, splitAtTime } from './cuts'
import Timeline from './timeline/Timeline'
import PreviewPlayer from './preview/PreviewPlayer'
import VersionPanel from './VersionPanel'
import RenderModal from './RenderModal'

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
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
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
      <div ref={containerRef} className="flex flex-col h-full bg-white dark:bg-gray-950">
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
        getWaveformChunks={getWaveformChunks}
        resolveFilePath={resolveFilePath}
        save={save}
        renderClipInspector={renderClipInspector}
        renderSubcutRegen={renderSubcutRegen}
        regenEnabled={regenEnabled}
        isClipQueued={isClipQueued}
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
  getWaveformChunks?: VideoEditorProps<P>['adapter']['getWaveformChunks']
  resolveFilePath: (path: string) => string
  save: (p: P) => void
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
  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

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
        <div className="flex-1 flex items-center justify-center bg-gray-950 overflow-hidden p-4">
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
                  absent → a minimal default. */}
              {slots?.pendingStatus ?? (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-white text-lg font-semibold">Waiting for your agent</p>
                  <p className="text-gray-400 text-sm">Nothing happens automatically — message your agent to start.</p>
                </div>
              )}
              <p className="text-gray-600 text-xs font-mono">project id: {project.id}</p>
              {canGoBack && (
                <button
                  onClick={onBackToSetup}
                  className="text-xs text-gray-600 hover:text-gray-400 transition-colors underline underline-offset-2"
                >
                  ← Back to setup
                </button>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
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
        <div className="w-48 shrink-0 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden">
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
  getWaveformChunks,
  resolveFilePath,
  save,
  renderClipInspector,
  renderSubcutRegen,
  regenEnabled,
  isClipQueued,
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
  const [renderOpen, setRenderOpen]   = useState(false)
  // The clip/audio inspector target — derived from the timeline's inspect
  // callbacks. A Montaj-agnostic { kind, id } selector, not a project entity.
  const [inspecting, setInspecting]   = useState<{ kind: 'clip' | 'audio'; id: string } | null>(null)

  const { versions, restoring, setRestoring } = useVersionHistory(adapter, project)

  const clips      = project.tracks?.[0] ?? []
  const hasContent = clips.length > 0 || (project.tracks?.slice(1).flat().length ?? 0) > 0 || (project.captions?.segments?.length ?? 0) > 0

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

  function handleOverlayChange(id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number; fit?: 'cover' | 'contain' | 'fill' }) {
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
    <div className="flex flex-1 overflow-hidden">
      {/* Main: preview + timeline */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-black overflow-hidden p-2">
          {hasContent ? (
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
          ) : (
            <p className="text-gray-600 text-sm">No clips</p>
          )}
        </div>

        {/* Track controls bar — split + ripple + render */}
        <div className="shrink-0 flex items-center justify-end gap-1.5 px-3 py-1 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
          <button
            onClick={() => handleSplit()}
            title="Split at playhead (S) — selected item or all clips"
            className="flex items-center justify-center w-5 h-5 rounded transition-colors text-gray-500 bg-transparent hover:text-gray-400"
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
                : 'text-gray-500 bg-transparent hover:text-gray-400'
            }`}
          >
            <Magnet size={12} />
          </button>
          <button
            onClick={() => setRenderOpen(true)}
            className="text-xs px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            Render →
          </button>
        </div>

        <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
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
          />
        </div>
      </div>

      {/* Right sidebar — version history + host-supplied assets panel */}
      {(adapter.listVersionHistory || slots?.assetsPanel) && (
        <div className="w-48 shrink-0 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden">
          {adapter.listVersionHistory && (
            <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />
          )}
          {slots?.assetsPanel}
        </div>
      )}

      {/* Render modal — adapter.render stream + host export controls */}
      {renderOpen && (
        <RenderModal
          projectId={project.id}
          adapter={adapter}
          exportActions={slots?.exportActions}
          onClose={() => setRenderOpen(false)}
          onCancel={() => setRenderOpen(false)}
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

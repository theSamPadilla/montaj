import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Image, HelpCircle, Magnet, Film, Music, Info, Scissors } from 'lucide-react'
import ClipInspectModal, { type InspectTarget } from '@/components/timeline/ClipInspectModal'
import PreviewPlayer from '@/components/preview/PreviewPlayer'
import ProjectHeader from '@/components/ProjectHeader'
import RerunModal from '@/components/RerunModal'
import RenderModal from '@/components/RenderModal'
import Timeline from '@/components/timeline/Timeline'
import VersionPanel from '@/components/VersionPanel'
import { ImagePreviewModal } from '@/components/storyboard/ImagePreviewModal'
import AssetsPanel from '@/components/AssetsPanel'
import { Button } from '@/components/ui/button'
import { api, fileUrl } from '@/lib/api'
import { applyCutToItem, applyCutToTracks, collapseGaps, splitAtTime } from '@/lib/cuts'
import { type Project, type ProjectVersion } from '@/lib/types/schema'

interface ReviewViewProps {
  project: Project
  onProjectChange: (p: Project) => void
}

function RegenTriggerPanel({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false)
  const queue = project.regenQueue ?? []
  if (queue.length === 0) return null

  const label = project.name || project.id
  const id = project.id ? ` (id: ${project.id})` : ''
  const msg = `I queued ${queue.length} regeneration request${queue.length === 1 ? '' : 's'} for project "${label}"${id}. Please process project.regenQueue[] per the ai-video skill Phase 7 contract.`

  async function copy() {
    try {
      await navigator.clipboard.writeText(msg)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  return (
    <div className="shrink-0 border-t border-amber-500/30 bg-amber-950/20 px-3 py-2 flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-amber-400/80 mb-1">
          {queue.length} regeneration request{queue.length === 1 ? '' : 's'} queued. Tell your agent:
        </p>
        <code className="block text-xs text-gray-300 bg-gray-950 border border-gray-800 rounded px-2 py-1.5 whitespace-pre-wrap break-words font-mono">
          {msg}
        </code>
      </div>
      <button
        onClick={copy}
        className={`shrink-0 text-xs px-2 py-1.5 rounded border transition-colors mt-4 ${
          copied
            ? 'border-green-700 bg-green-900/40 text-green-300'
            : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white'
        }`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export default function ReviewView({ project, onProjectChange }: ReviewViewProps) {
  const [currentTime, setCurrentTime]         = useState(0)
  const [saving, setSaving]                   = useState(false)
  const [dirty, setDirty]                     = useState(false)
  const [canUndo, setCanUndo]                 = useState(false)
  const historyRef = useRef<Project[]>([])
  // Multi-select: all currently-selected timeline item ids (visual items + audio
  // tracks). Single-select consumers (canvas preview, cut/split that operates on
  // "the" selected item) use selectedIds[0] as the primary.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const primarySelectedId = selectedIds[0] ?? null
  const [versions, setVersions]           = useState<ProjectVersion[]>([])
  const [restoring, setRestoring]         = useState<string | null>(null)
  const [rerunOpen, setRerunOpen]         = useState(false)
  const [showHelp, setShowHelp]           = useState(false)
  const [renderOpen, setRenderOpen]       = useState(false)
  const [rippleMode, setRippleMode]       = useState(false)
  const [inspecting, setInspecting] = useState<InspectTarget | null>(null)
  const [refPreview, setRefPreview]       = useState<{ src: string; alt: string } | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listVersions(project.id).then(setVersions).catch(() => {})
  }, [project.id, project.status])

  // Repair caption segments where words text has diverged from edited text.
  // This happens when text was edited before the word-regeneration fix was deployed.
  useEffect(() => {
    const captions = project.captions
    if (!captions?.segments?.length) return
    let dirty = false
    const repairedSegments = captions.segments.map(seg => {
      const wordsText = (seg.words ?? []).map((w: { word: string }) => w.word).join(' ')
      if (wordsText.trim().toLowerCase() === seg.text.trim().toLowerCase()) return seg
      dirty = true
      const newWords = seg.text.split(/\s+/).filter(Boolean)
      const segDur = seg.end - seg.start
      const wordDur = segDur / (newWords.length || 1)
      return {
        ...seg,
        words: newWords.map((w, i) => ({
          word: w,
          start: seg.start + i * wordDur,
          end: seg.start + (i + 1) * wordDur,
        })),
      }
    })
    if (!dirty) return
    const repaired = { ...project, captions: { ...captions, segments: repairedSegments } }
    onProjectChange(repaired)
    api.saveProject(repaired.id, repaired).catch(console.error)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const clips      = project.tracks?.[0] ?? []
  const hasContent = clips.length > 0 || (project.tracks?.slice(1).flat().length ?? 0) > 0 || (project.captions?.segments?.length ?? 0) > 0

  function pushHistory(prev: Project) {
    historyRef.current = [...historyRef.current.slice(-49), prev]
    setCanUndo(true)
  }

  function handleProjectChange(p: Project) {
    pushHistory(project)
    onProjectChange(p)
    setDirty(true)
  }

  function handleUndo() {
    const hist = historyRef.current
    if (!hist.length) return
    const prev = hist[hist.length - 1]
    historyRef.current = hist.slice(0, -1)
    setCanUndo(hist.length > 1)
    onProjectChange(prev)
    api.saveProject(prev.id, prev).catch(console.error)
    setDirty(true)
  }

  function handleCut(cut: { start: number; end: number }) {
    pushHistory(project)
    let updated = primarySelectedId
      ? applyCutToItem(project, primarySelectedId, cut)
      : applyCutToTracks(project, cut)
    if (rippleMode) updated = collapseGaps(updated)
    onProjectChange(updated)
    api.saveProject(updated.id, updated).catch(console.error)
    setSelectedIds([])
    setDirty(true)
  }

  function handleOverlayChange(id: string, changes: { offsetX?: number; offsetY?: number; scale?: number; rotation?: number }) {
    pushHistory(project)
    const updated = {
      ...project,
      tracks: (project.tracks ?? []).map(track =>
        track.map(item => item.id !== id ? item : { ...item, ...changes })
      ),
    }
    onProjectChange(updated)
    api.saveProject(updated.id, updated).catch(console.error)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await api.saveProject(project.id, project)
      setDirty(false)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }


  function handleSplit(at?: number) {
    const updated = splitAtTime(project, at ?? currentTime, primarySelectedId ?? null)
    if (updated === project) return
    pushHistory(project)
    onProjectChange(updated)
    api.saveProject(updated.id, updated).catch(console.error)
    setDirty(true)
  }

  function handleRippleToggle() {
    const next = !rippleMode
    setRippleMode(next)
    if (next) {
      const collapsed = collapseGaps(project)
      if (collapsed !== project) {
        pushHistory(project)
        onProjectChange(collapsed)
        api.saveProject(collapsed.id, collapsed).catch(console.error)
        setDirty(true)
      }
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); handleSplit() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); handleUndo() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, currentTime, primarySelectedId, canUndo])

  function handleRerunComplete(updated: Project) {
    onProjectChange(updated)
    setRerunOpen(false)
  }

  async function handleRender() {
    setSaving(true)
    try {
      const final = { ...project, status: 'final' as const }
      await api.saveProject(project.id, final)
      onProjectChange(final)
      setRenderOpen(true)
    } catch (e) {
      alert(`Failed to save project: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleRestoreVersion(hash: string) {
    setRestoring(hash)
    try {
      const restored = await api.restoreVersion(project.id, hash)
      onProjectChange(restored)
      setVersions(vs => vs) // keep list — status re-fetch will update
    } catch (e) {
      console.error(e)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <ProjectHeader
        project={project}
        onProjectChange={onProjectChange}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={handleUndo} disabled={!canUndo} title="Undo">
              ↩ Undo
            </Button>
{dirty && (
              <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
            {project.projectType === 'ai_video' && (
              <Button variant="ghost" size="sm" onClick={async () => {
                const updated = { ...project, status: 'storyboard_ready' as const }
                await api.saveProject(project.id, updated)
                onProjectChange(updated)
              }}>
                ← Storyboard
              </Button>
            )}
            {project.status !== 'pending' && (
              <Button variant="outline" size="sm" onClick={() => setRerunOpen(true)}>
                Re-run
              </Button>
            )}
            <Button size="sm" onClick={handleRender} disabled={project.status === 'pending'}>
              Render →
            </Button>
          </>
        }
      />

      {/* Body */}
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
              />
            ) : (
              <p className="text-gray-600 text-sm">No clips</p>
            )}
          </div>

          {/* Track controls bar */}
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
            {showHelp && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowHelp(false)} />
                <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden ${project.projectType === 'ai_video' ? 'w-[720px]' : 'w-[560px]'}`}>
                  <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">Editor reference</span>
                    <button onClick={() => setShowHelp(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"><X size={13} /></button>
                  </div>
                  <div className="p-5 grid grid-cols-2 gap-x-8 gap-y-5 text-[12px]">
                    <div className="flex flex-col gap-2">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Playback</p>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Space</span><span className="text-gray-600 dark:text-gray-400">play / pause</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">← →</span><span className="text-gray-600 dark:text-gray-400">scrub one frame</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Shift ← →</span><span className="text-gray-600 dark:text-gray-400">scrub 1 second</span></div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Markers &amp; cuts</p>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Enter</span><span className="text-gray-600 dark:text-gray-400">place marker</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">double-click</span><span className="text-gray-600 dark:text-gray-400">place marker on track</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Split</span><span className="text-gray-600 dark:text-gray-400">one marker — selected or all</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Cut</span><span className="text-gray-600 dark:text-gray-400">two markers — selected or all</span></div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Clips (all tracks)</p>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">click</span><span className="text-gray-600 dark:text-gray-400">select</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">shift+click</span><span className="text-gray-600 dark:text-gray-400">add to selection (multi-select)</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">drag</span><span className="text-gray-600 dark:text-gray-400">move / change track</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">drag edge</span><span className="text-gray-600 dark:text-gray-400">trim in / out point</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">S</span><span className="text-gray-600 dark:text-gray-400">split at playhead</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">Delete</span><span className="text-gray-600 dark:text-gray-400">remove selected</span></div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-gray-400 whitespace-nowrap"><Magnet size={11} /> ripple toggle</span>
                        <span className="text-gray-600 dark:text-gray-400">close gap on edits</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Canvas (preview)</p>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">drag</span><span className="text-gray-600 dark:text-gray-400">move position</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">drag corner</span><span className="text-gray-600 dark:text-gray-400">resize</span></div>
                      <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">drag ○ handle</span><span className="text-gray-600 dark:text-gray-400">rotate (snaps at 90°)</span></div>
                    </div>
                    <div className="flex flex-col gap-2 col-span-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Captions</p>
                      <div className="flex gap-12">
                        <div className="flex justify-between gap-4 flex-1"><span className="text-gray-400 font-mono whitespace-nowrap">click caption</span><span className="text-gray-600 dark:text-gray-400">edit inline</span></div>
                        <div className="flex justify-between gap-4 flex-1"><span className="text-gray-400 font-mono whitespace-nowrap">Expand ↑</span><span className="text-gray-600 dark:text-gray-400">transcript editor</span></div>
                      </div>
                    </div>
                    {project.projectType === 'ai_video' && (<>
                      <div className="flex flex-col gap-2 col-span-2 border-t border-gray-100 dark:border-gray-800 pt-4">
                        <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">AI video — regeneration</p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap flex items-center gap-1">select clip → <Info size={10} /></span><span className="text-gray-600 dark:text-gray-400">inspect details</span></div>
                        <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">double-click clip</span><span className="text-gray-600 dark:text-gray-400">inspect details</span></div>
                        <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap">inspect → Regenerate</span><span className="text-gray-600 dark:text-gray-400">queue full regen</span></div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex justify-between gap-4"><span className="text-gray-400 font-mono whitespace-nowrap flex items-center gap-1">select clip → <Scissors size={10} /></span><span className="text-gray-600 dark:text-gray-400">subcut regen a range</span></div>
                        <div className="flex justify-between gap-4"><span className="text-gray-400 whitespace-nowrap">right panel</span><span className="text-gray-600 dark:text-gray-400">image &amp; style refs</span></div>
                      </div>
                    </>)}
                  </div>
                </div>
              </>
            )}
            <button
              onClick={() => setShowHelp(v => !v)}
              className={`transition-colors ${showHelp ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}
              title="Keyboard shortcuts"
            >
              <HelpCircle size={13} />
            </button>
          </div>

          {/* Regen queue trigger panel */}
          <RegenTriggerPanel project={project} />

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
            <Timeline
              project={project}
              currentTime={currentTime}
              onTimeUpdate={setCurrentTime}
              onProjectChange={handleProjectChange}
              onCaptionEdit={(p) => { onProjectChange(p); api.saveProject(p.id, p).catch(console.error) }}
              onOverlayEdit={(p) => { onProjectChange(p); api.saveProject(p.id, p).catch(console.error) }}
              selectedIds={selectedIds}
              onSelectIds={setSelectedIds}
              onSplit={handleSplit}
              onCut={handleCut}
              onInspectClip={(id) => setInspecting({ kind: 'clip', id })}
              onInspectAudio={(id) => setInspecting({ kind: 'audio', id })}
              onSaveProject={(p) => api.saveProject(p.id, p)}
              rippleMode={rippleMode}
            />
          </div>
        </div>

        {/* Right sidebar — versions + assets */}
        <div className="w-48 shrink-0 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden">

          {/* Version history */}
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />

          {/* Image refs (AI video projects) */}
          {project.projectType === 'ai_video' && (project.storyboard?.imageRefs ?? []).length > 0 && (
            <div className="border-b border-gray-200 dark:border-gray-800">
              <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Image refs</span>
              </div>
              <div className="p-2 grid grid-cols-2 gap-2">
                {(project.storyboard?.imageRefs ?? []).map(ref => {
                  const thumb = ref.refImages?.[0]
                  return (
                    <div
                      key={ref.id}
                      className={`rounded border border-gray-700 overflow-hidden bg-gray-800${thumb ? ' cursor-pointer hover:border-gray-500 transition-colors' : ''}`}
                      onClick={() => thumb && setRefPreview({ src: thumb, alt: ref.anchor || ref.label })}
                      title={ref.label}
                    >
                      <div className="w-full aspect-square flex items-center justify-center">
                        {thumb ? (
                          <img src={fileUrl(thumb)} alt={ref.label} className="w-full h-full object-cover" />
                        ) : (
                          <Image size={16} className="text-gray-600" />
                        )}
                      </div>
                      <div className="px-1.5 py-1 border-t border-gray-700/50">
                        <span className="text-[9px] text-gray-500 truncate block">{ref.label}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Style refs (AI video projects) */}
          {project.projectType === 'ai_video' && (project.storyboard?.styleRefs ?? []).length > 0 && (
            <div className="border-b border-gray-200 dark:border-gray-800">
              <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Style refs</span>
              </div>
              <div className="p-2 grid grid-cols-2 gap-2">
                {(project.storyboard?.styleRefs ?? []).map(ref => {
                  const isImage = ref.kind === 'image'
                  const Icon = ref.kind === 'video' ? Film : ref.kind === 'audio' ? Music : Image
                  return (
                    <div
                      key={ref.id}
                      className={`rounded border border-gray-700 overflow-hidden bg-gray-800${isImage ? ' cursor-pointer hover:border-gray-500 transition-colors' : ''}`}
                      onClick={() => isImage && setRefPreview({ src: ref.path, alt: ref.label || ref.path.split('/').pop() || '' })}
                      title={ref.label || ref.path.split('/').pop()}
                    >
                      <div className="w-full aspect-square flex items-center justify-center">
                        {isImage ? (
                          <img src={fileUrl(ref.path)} alt={ref.label} className="w-full h-full object-cover" />
                        ) : (
                          <Icon size={18} className="text-gray-500" />
                        )}
                      </div>
                      <div className="px-1.5 py-1 border-t border-gray-700/50">
                        <span className="text-[9px] text-gray-500 truncate block">{ref.label || ref.path.split('/').pop()}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

        <AssetsPanel
          assets={project.assets ?? []}
          projectId={project.id}
          onChange={async next => {
            const updated = { ...project, assets: next }
            onProjectChange(updated)
            await api.saveProject(project.id, updated)
            setDirty(false)
          }}
        />

        </div> {/* end right sidebar */}
      </div>

      {rerunOpen && (
        <RerunModal
          project={project}
          onClose={() => setRerunOpen(false)}
          onRerun={handleRerunComplete}
        />
      )}

      {renderOpen && (
        <RenderModal
          projectId={project.id}
          // Post-render close (Done / Close / Escape after completion or error):
          // navigate to project root so the user can see the finished output
          // alongside their other projects.
          onClose={() => { setRenderOpen(false); navigate('/') }}
          // Mid-render cancel: just dismiss the modal — the user wants to keep
          // editing, not get yanked away from the project they were working on.
          onCancel={() => setRenderOpen(false)}
        />
      )}

      {refPreview && (
        <ImagePreviewModal src={refPreview.src} alt={refPreview.alt} onClose={() => setRefPreview(null)} />
      )}
      {/* Clip / audio inspect modal */}
      {inspecting && <ClipInspectModal
        project={project}
        target={inspecting}
        onClose={() => setInspecting(null)}
        onProjectChange={onProjectChange}
        onSave={(p) => api.saveProject(p.id, p)}
      />}
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Image, Plus, HelpCircle, Copy } from 'lucide-react'
import PreviewPlayer from '@/components/PreviewPlayer'
import ProjectHeader from '@/components/ProjectHeader'
import RerunModal from '@/components/RerunModal'
import RenderModal from '@/components/RenderModal'
import Timeline from '@/components/Timeline'
import VersionPanel from '@/components/VersionPanel'
import { Button } from '@/components/ui/button'
import { api, fileUrl } from '@/lib/api'
import { applyCutToItem, applyCutToTracks } from '@/lib/cuts'
import { type Asset, type Project, type ProjectVersion } from '@/lib/project'

interface ReviewViewProps {
  project: Project
  onProjectChange: (p: Project) => void
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}


export default function ReviewView({ project, onProjectChange }: ReviewViewProps) {
  const [currentTime, setCurrentTime]         = useState(0)
  const [saving, setSaving]                   = useState(false)
  const [dirty, setDirty]                     = useState(false)
  const [canUndo, setCanUndo]                 = useState(false)
  const historyRef = useRef<Project[]>([])
  const [pickingAssets, setPickingAssets]     = useState(false)
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId]       = useState<string | null>(null)
  const [versions, setVersions]           = useState<ProjectVersion[]>([])
  const [restoring, setRestoring]         = useState<string | null>(null)
  const [rerunOpen, setRerunOpen]         = useState(false)
  const [showHelp, setShowHelp]           = useState(false)
  const [renderOpen, setRenderOpen]       = useState(false)
  const [previewAsset, setPreviewAsset]   = useState<Asset | null>(null)
  const [pathCopied, setPathCopied]       = useState(false)
  const [applyingCuts, setApplyingCuts]   = useState(false)
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
  const hasContent = clips.length > 0 || (project.tracks?.slice(1).flat().length ?? 0) > 0
  const assets     = project.assets ?? []

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
    const targetId = selectedClipId ?? selectedOverlayId
    const updated = targetId
      ? applyCutToItem(project, targetId, cut)
      : applyCutToTracks(project, cut)
    onProjectChange(updated)
    api.saveProject(updated.id, updated).catch(console.error)
    // The selected item's ID no longer exists after a collapse cut (split into new fragments).
    // Clear both selections so the UI doesn't reference a stale ID.
    setSelectedClipId(null)
    setSelectedOverlayId(null)
    setDirty(true)
  }

  function handleOverlayChange(id: string, changes: { offsetX?: number; offsetY?: number; scale?: number }) {
    pushHistory(project)
    const primaryTrack = project.tracks?.[0] ?? []
    const overlayTs = project.tracks?.slice(1) ?? []
    const updated = {
      ...project,
      tracks: [primaryTrack, ...overlayTs.map(track =>
        track.map(item => item.id !== id ? item : { ...item, ...changes })
      )],
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

  async function handleApplyCuts() {
    setApplyingCuts(true)
    try {
      pushHistory(project)
      const primaryClips = project.tracks?.[0] ?? []
      const updatedClips = [...primaryClips]

      for (let i = 0; i < primaryClips.length; i++) {
        const clip = primaryClips[i]
        if (!clip.src) continue
        const dotIdx = clip.src.lastIndexOf('.')
        const base = dotIdx !== -1 ? clip.src.slice(0, dotIdx) : clip.src
        const outPath = `${base}_${clip.id}_cut.mp4`
        const result = await api.runStep<{ path: string; type: string }>('materialize_cut', {
          input: clip.src,
          inpoint: clip.inPoint ?? 0,
          outpoint: clip.outPoint ?? ((clip.inPoint ?? 0) + (clip.end - clip.start)),
          out: outPath,
        })
        const duration = clip.end - clip.start
        updatedClips[i] = {
          ...clip,
          src: result.path,
          inPoint: 0,
          outPoint: duration,
          sourceDuration: duration,
        }
      }

      const updated = {
        ...project,
        tracks: [updatedClips, ...(project.tracks?.slice(1) ?? [])],
      }
      onProjectChange(updated)
      await api.saveProject(updated.id, updated)
      setDirty(false)
    } catch (e) {
      alert(`Apply Cuts failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplyingCuts(false)
    }
  }

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

  async function handleAddAssets() {
    setPickingAssets(true)
    try {
      const { paths } = await api.pickFiles()
      if (!paths.length) return
      const existing = new Set(assets.map(a => a.src))
      const newAssets: Asset[] = paths
        .filter(p => !existing.has(p))
        .map((p, i) => ({
          id: `asset-${Date.now()}-${i}`,
          src: p,
          type: 'image' as const,
          name: basename(p),
        }))
      if (!newAssets.length) return
      const updated = { ...project, assets: [...assets, ...newAssets] }
      onProjectChange(updated)
      setDirty(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) console.error(msg)
    } finally {
      setPickingAssets(false)
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

  function handleRemoveAsset(id: string) {
    const updated = { ...project, assets: assets.filter(a => a.id !== id) }
    onProjectChange(updated)
    setDirty(true)
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
            {(project.tracks?.[0] ?? []).some(c => (c.inPoint ?? 0) > 0 || (c.outPoint !== undefined && c.outPoint < (c.sourceDuration ?? Infinity))) && (
              <Button variant="outline" size="sm" onClick={handleApplyCuts} disabled={applyingCuts}>
                {applyingCuts ? 'Encoding…' : 'Apply Cuts'}
              </Button>
            )}
            {dirty && (
              <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
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
                selectedOverlayId={selectedOverlayId ?? undefined}
                onOverlayChange={handleOverlayChange}
              />
            ) : (
              <p className="text-gray-600 text-sm">No clips</p>
            )}
          </div>

          <div className="shrink-0 border-t border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-950">
            <Timeline
              project={project}
              currentTime={currentTime}
              onTimeUpdate={setCurrentTime}
              onProjectChange={handleProjectChange}
              onCaptionEdit={(p) => { onProjectChange(p); api.saveProject(p.id, p).catch(console.error) }}
              onOverlayEdit={(p) => { onProjectChange(p); api.saveProject(p.id, p).catch(console.error) }}
              selectedOverlayId={selectedOverlayId ?? undefined}
              onSelectOverlay={(id) => { setSelectedOverlayId(id); setSelectedClipId(null) }}
              onCut={handleCut}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
            />
          </div>
        </div>

        {/* Right sidebar — versions + assets */}
        <div className="w-48 shrink-0 border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden">

          {/* Version history */}
          <VersionPanel versions={versions} restoring={restoring} onRestore={handleRestoreVersion} />

        {/* Assets */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Assets</span>
            <button
              onClick={handleAddAssets}
              disabled={pickingAssets}
              className="text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              title="Add assets"
            >
              <Plus size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
            {assets.length === 0 && (
              <p className="text-xs text-gray-600 text-center mt-4 px-2 leading-relaxed">
                No assets yet.<br />Add images the agent can use as overlays.
              </p>
            )}
            {assets.map(asset => (
              <div
                key={asset.id}
                className="group relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
              >
                <div
                  className="w-full aspect-video bg-gray-800 relative flex items-center justify-center cursor-pointer overflow-hidden"
                  onClick={() => { setPreviewAsset(asset); setPathCopied(false) }}
                >
                  <Image size={16} className="text-gray-600 absolute" />
                  <img
                    src={fileUrl(asset.src)}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                </div>
                <div className="px-2 py-1 flex items-center gap-1">
                  <Image size={10} className="shrink-0 text-gray-500" />
                  <span className="text-xs text-gray-400 truncate flex-1">
                    {asset.name ?? basename(asset.src)}
                  </span>
                </div>
                <button
                  onClick={() => handleRemoveAsset(asset.id)}
                  className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Help button */}
        <div className="shrink-0 flex justify-end px-2 py-2 border-t border-gray-200 dark:border-gray-800">
          {showHelp && (
            <div className="fixed bottom-12 right-4 w-96 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 text-xs text-gray-500 dark:text-gray-400 font-mono shadow-2xl z-50">
              <p className="text-gray-700 dark:text-gray-300 font-sans font-medium mb-3 text-[11px] uppercase tracking-wide">Editor shortcuts</p>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between gap-4"><span className="text-gray-500">Space</span><span>play / pause</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">← →</span><span>scrub one frame</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Enter</span><span>place marker</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">double-click timeline</span><span>place markers</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Cut button</span><span>split clip at markers</span></div>
                <div className="border-t border-gray-200 dark:border-gray-800 my-1" />
                <div className="flex justify-between gap-4"><span className="text-gray-500">drag overlay</span><span>move position</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">drag corner</span><span>resize overlay</span></div>
                <div className="border-t border-gray-200 dark:border-gray-800 my-1" />
                <div className="flex justify-between gap-4"><span className="text-gray-500">click caption</span><span>edit inline</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-500">Expand ↑</span><span>open transcript editor</span></div>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowHelp(v => !v)}
            className={`transition-colors ${showHelp ? 'text-gray-300' : 'text-gray-600 hover:text-gray-400'}`}
            title="Keyboard shortcuts"
          >
            <HelpCircle size={14} />
          </button>
        </div>
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
          onClose={() => { setRenderOpen(false); navigate('/') }}
        />
      )}

      {previewAsset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setPreviewAsset(null)}
        >
          <div
            className="relative flex flex-col bg-gray-900 border border-gray-700 rounded-xl overflow-hidden max-w-3xl w-full mx-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewAsset(null)}
              className="absolute top-2 right-2 p-1 rounded bg-black/60 text-gray-400 hover:text-white transition-colors z-10"
            >
              <X size={14} />
            </button>
            <img
              src={fileUrl(previewAsset.src)}
              alt={previewAsset.name ?? basename(previewAsset.src)}
              className="w-full object-contain max-h-[70vh]"
            />
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-800">
              <code className="text-xs text-gray-400 font-mono truncate flex-1">{previewAsset.src}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(previewAsset.src)
                  setPathCopied(true)
                  setTimeout(() => setPathCopied(false), 1500)
                }}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors shrink-0"
              >
                <Copy size={12} />
                {pathCopied ? 'Copied!' : 'Copy path'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

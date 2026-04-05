import { useEffect, useCallback, useRef, useState } from 'react'
import type { Project, OverlayItem } from '@/lib/project'
import { getOverlayItems } from '@/lib/project'
import { compileOverlay, clearOverlayCache, type OverlayFactory } from '@/lib/overlay-eval'
import { api, type GlobalOverlay, type Profile } from '@/lib/api'

// ---------------------------------------------------------------------------
// Hook — compile overlay and re-compile on SSE file-change events
// ---------------------------------------------------------------------------

function useOverlayPreview(jsxPath: string | undefined) {
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const compile = useCallback(async (path: string) => {
    try {
      clearOverlayCache(path)
      const f = await compileOverlay(path)
      setFactory(() => f)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    if (!jsxPath) { setFactory(null); setError(null); return }
    compile(jsxPath)
    const es = new EventSource(`/api/files/stream?path=${encodeURIComponent(jsxPath)}`)
    es.onmessage = () => compile(jsxPath)
    return () => es.close()
  }, [jsxPath, compile])

  return { factory, error }
}

// ---------------------------------------------------------------------------
// Preview canvas — overlay rendered at 1080×1920, scaled to fit
// ---------------------------------------------------------------------------

const NATIVE_W = 1080
const NATIVE_H = 1920

const PREVIEW_IMAGES = [
  '/preview/preview.jpg',
  '/preview/preview2.jpg',
  '/preview/preview3.jpg',
  '/preview/preview4.jpg',
  '/preview/preview5.jpg',
  '/preview/preview6.jpg',
  '/preview/preview7.jpg',
  '/preview/preview8.jpg',
]
const RANDOM_PREVIEW = PREVIEW_IMAGES[Math.floor(Math.random() * PREVIEW_IMAGES.length)]

// Proxy any string prop values that are absolute local file paths so the
// browser can load them through /api/files instead of failing with a 404.
function proxyProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [
      k,
      typeof v === 'string' && /^\/(Users|home|private|tmp|var)\//.test(v)
        ? `/api/files?path=${encodeURIComponent(v)}`
        : v,
    ]),
  )
}

// Preview fills the available panel height. Parent must be a flex column/row
// with a defined height — the preview uses it all, computing width from 9:16.
function OverlayPreview({
  factory,
  fps = 30,
  duration = 90,
  props = {},
  height = 560,
}: {
  factory: OverlayFactory | null
  fps?: number
  duration?: number
  props?: Record<string, unknown>
  height?: number
}) {
  const previewH = height
  const previewW = Math.round(previewH * 9 / 16)
  const scale    = previewW / NATIVE_W

  const [frame, setFrame]   = useState(0)
  const [playing, setPlaying] = useState(true)
  const rafRef    = useRef<number>(0)
  const originRef = useRef<number | null>(null)
  const pausedAt  = useRef<number>(0)

  useEffect(() => {
    originRef.current = null
    setFrame(0)
  }, [factory])

  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(rafRef.current)
      return
    }
    function tick(ts: number) {
      if (originRef.current === null) originRef.current = ts - (pausedAt.current / fps) * 1000
      const elapsed = (ts - originRef.current) / 1000  // seconds
      const f = Math.floor(elapsed * fps) % duration
      setFrame(f)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, fps, duration])

  const resolvedProps = proxyProps(props)
  let element: React.ReactElement | null = null
  if (factory) {
    try { element = factory(frame, fps, duration, resolvedProps) } catch { /* ignore */ }
  }

  return (
    <div
      style={{
        width: previewW,
        height: previewH,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 12,
        flexShrink: 0,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      {/* background */}
      <div
        style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${RANDOM_PREVIEW})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      {/* overlay, scaled from native resolution */}
      {element && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0,
            width: NATIVE_W, height: NATIVE_H,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            pointerEvents: 'none',
          }}
        >
          {element}
        </div>
      )}
      {!factory && (
        <div
          style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          className="text-sm text-white/60"
        >
          Loading…
        </div>
      )}
      {/* Play/pause + frame counter */}
      <div
        style={{ position: 'absolute', bottom: 10, right: 10, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
          {frame}
        </span>
        <button
          onClick={() => {
            if (playing) pausedAt.current = frame
            else originRef.current = null
            setPlaying(p => !p)
          }}
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 6,
            color: '#fff',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Global overlay detail panel
// ---------------------------------------------------------------------------

function GlobalOverlayDetail({ overlay }: { overlay: GlobalOverlay }) {
  const { factory, error } = useOverlayPreview(overlay.jsxPath)

  const defaultProps = Object.fromEntries(
    overlay.props
      .filter(p => p.default !== undefined)
      .map(p => [p.name, p.default]),
  )

  return (
    <div className="flex flex-col h-full overflow-hidden items-center px-8 pt-8 pb-6 gap-6">
      <div className="w-full text-center">
        <div className="flex items-baseline justify-center gap-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{overlay.name}</h2>
          <span className="text-[11px] text-gray-600 font-mono">{overlay.jsxPath.split('/').pop()}</span>
        </div>
        {overlay.description && <p className="text-sm text-gray-500 mt-0.5">{overlay.description}</p>}
        {error && <div className="mt-2 text-xs text-red-400 font-mono">{error}</div>}
      </div>
      <OverlayPreview factory={factory} props={defaultProps} height={Math.min(720, window.innerHeight - 160)} />
      <p className="text-xs text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5">
        Size and position can be adjusted in the Editor
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project overlay item detail panel
// ---------------------------------------------------------------------------

function OverlayItemDetail({ item }: { item: OverlayItem }) {
  const jsxPath = item.src ?? undefined
  const { factory, error } = useOverlayPreview(jsxPath)

  const itemProps = (item.props ?? {}) as Record<string, unknown>

  return (
    <div className="flex flex-col h-full overflow-hidden items-center px-8 pt-8 pb-6 gap-6">
      <div className="w-full text-center">
        <div className="flex items-baseline justify-center gap-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{overlayDisplayName(item.src, item.type)}</h2>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{item.start}s – {item.end}s</p>
        {error && <div className="mt-2 text-xs text-red-400 font-mono">{error}</div>}
      </div>
      {jsxPath
        ? <OverlayPreview factory={factory} props={itemProps} height={Math.min(680, window.innerHeight - 160)} />
        : <div className="text-sm text-gray-600">No JSX source — nothing to preview</div>
      }
      {jsxPath && (
        <p className="text-xs text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5">
          Size and position can be adjusted in the Editor
        </p>
      )}
    </div>
  )
}

function overlayDisplayName(src: string | undefined, fallback: string): string {
  if (!src) return fallback
  const base = src.split('/').pop() ?? fallback
  return base
    .replace(/\.jsx$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Project overlay list
// ---------------------------------------------------------------------------

function ProjectOverlayList({ project }: { project: Project }) {
  const items = getOverlayItems(project)
  const [selected, setSelected] = useState<OverlayItem | null>(null)

  if (items.length === 0) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{project.name ?? project.id}</h2>
        <p className="text-sm text-gray-500">No overlays in this project.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-52 border-r border-gray-200 dark:border-gray-800 overflow-y-auto shrink-0">
        <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-200 dark:border-gray-800 truncate">
          {project.name ?? project.id}
        </div>
        {items.map(item => (
          <button
            key={item.id}
            onClick={() => setSelected(item)}
            className={`w-full text-left px-3 py-2 text-sm transition-colors ${
              selected?.id === item.id
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <div className="font-medium truncate">{overlayDisplayName(item.src, item.type)}</div>
          </button>
        ))}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        {selected ? (
          <OverlayItemDetail item={selected} />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">
            Select an overlay to preview
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function OverlaysPage() {
  const [globalOverlays, setGlobalOverlays] = useState<GlobalOverlay[]>([])
  const [profiles, setProfiles]             = useState<Profile[]>([])
  const [profileOverlays, setProfileOverlays] = useState<Record<string, GlobalOverlay[]>>({})
  const [projects, setProjects]             = useState<Project[]>([])
  const [selection, setSelection] = useState<
    | { kind: 'global'; overlay: GlobalOverlay }
    | { kind: 'profile'; overlay: GlobalOverlay }
    | { kind: 'project'; project: Project }
    | null
  >(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName]   = useState('')
  const newGroupRef = useRef<HTMLInputElement>(null)

  const refreshOverlays = useCallback(() => {
    api.listGlobalOverlays().then(setGlobalOverlays).catch(() => {})
  }, [])

  useEffect(() => {
    refreshOverlays()
    api.listProjects().then(setProjects).catch(() => {})
    api.listProfiles().then(profs => {
      setProfiles(profs)
      profs.forEach(p => {
        api.listProfileOverlays(p.name)
          .then(ovs => setProfileOverlays(prev => ({ ...prev, [p.name]: ovs })))
          .catch(() => {})
      })
    }).catch(() => {})
  }, [refreshOverlays])

  useEffect(() => {
    if (creatingGroup) newGroupRef.current?.focus()
  }, [creatingGroup])

  async function submitNewGroup() {
    const name = newGroupName.trim()
    if (!name) { setCreatingGroup(false); setNewGroupName(''); return }
    try {
      await api.createOverlayGroup(name)
      refreshOverlays()
    } catch { /* ignore — dir may already exist */ }
    setCreatingGroup(false)
    setNewGroupName('')
  }

  const overlayCount = (p: Project) => getOverlayItems(p).length

  // Split global overlays into ungrouped + grouped sections
  // Items with empty:true are group sentinels (folder exists but has no overlays yet)
  const ungrouped = globalOverlays.filter(ov => !ov.group && !ov.empty)
  const groups = globalOverlays
    .filter(ov => ov.group)
    .reduce<Record<string, GlobalOverlay[]>>((acc, ov) => {
      const g = ov.group!
      if (!acc[g]) acc[g] = []
      if (!ov.empty) acc[g].push(ov)
      return acc
    }, {})
  // Also ensure empty-sentinel groups appear even with no overlay children
  globalOverlays.filter(ov => ov.empty && ov.group).forEach(ov => {
    if (!groups[ov.group!]) groups[ov.group!] = []
  })
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))

  function OverlayButton({ ov, onSelect, isSelected }: { ov: GlobalOverlay; onSelect?: (ov: GlobalOverlay) => void; isSelected?: boolean }) {
    const active = isSelected ?? (selection?.kind === 'global' && selection.overlay.jsxPath === ov.jsxPath)
    const handleSelect = onSelect ?? ((ov: GlobalOverlay) => setSelection({ kind: 'global', overlay: ov }))
    return (
      <button
        onClick={() => handleSelect(ov)}
        className={`w-full text-left px-3 py-2 text-sm transition-colors ${
          active ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900 hover:text-gray-900 dark:hover:text-white'
        }`}
      >
        <div className="font-medium truncate">{ov.name}</div>
        {ov.description && <div className="text-xs text-gray-600 truncate">{ov.description}</div>}
      </button>
    )
  }

  return (
    <div className="flex h-full overflow-hidden bg-white dark:bg-gray-950 text-gray-900 dark:text-white">
      {/* Left nav */}
      <div className="w-52 flex flex-col border-r border-gray-200 dark:border-gray-800 overflow-y-auto shrink-0">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Library</span>
          <button
            onClick={() => setCreatingGroup(true)}
            title="New folder"
            className="text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 transition-colors text-base leading-none"
          >
            +
          </button>
        </div>

        {creatingGroup && (
          <div className="px-3 pb-2">
            <input
              ref={newGroupRef}
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitNewGroup()
                if (e.key === 'Escape') { setCreatingGroup(false); setNewGroupName('') }
              }}
              onBlur={submitNewGroup}
              placeholder="Folder name…"
              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-600 outline-none focus:border-gray-400 dark:focus:border-gray-500"
            />
          </div>
        )}

        {globalOverlays.length === 0 ? (
          <div className="px-3 pb-3 text-xs text-gray-600">
            No overlays in<br />~/.montaj/overlays/
          </div>
        ) : (
          <>
            {ungrouped.map(ov => <OverlayButton key={ov.jsxPath} ov={ov} />)}
            {sortedGroups.map(([groupName, overlays]) => (
              <div key={groupName}>
                <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
                  {groupName}
                </div>
                {overlays.length === 0
                  ? <div className="px-3 pb-2 text-[11px] text-gray-700 italic">Empty</div>
                  : overlays.map(ov => <OverlayButton key={ov.jsxPath} ov={ov} />)
                }
              </div>
            ))}
          </>
        )}

        {profiles.some(p => (profileOverlays[p.name] ?? []).length > 0) && (
          <>
            <div className="px-3 pt-3 pb-1 mt-1 text-xs font-semibold text-gray-500 uppercase tracking-wide border-t border-gray-200 dark:border-gray-800">
              Profiles
            </div>
            {profiles.map(p => {
              const ovs = profileOverlays[p.name] ?? []
              if (ovs.length === 0) return null
              return (
                <div key={p.name}>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
                    {p.display_name ?? p.name}
                  </div>
                  {ovs.filter(ov => !ov.group && !ov.empty).map(ov => (
                    <OverlayButton key={ov.jsxPath} ov={ov} onSelect={ov => setSelection({ kind: 'profile', overlay: ov })} isSelected={selection?.kind === 'profile' && 'overlay' in selection && selection.overlay.jsxPath === ov.jsxPath} />
                  ))}
                  {Object.entries(
                    ovs.filter(ov => ov.group).reduce<Record<string, GlobalOverlay[]>>((acc, ov) => {
                      const g = ov.group!
                      if (!acc[g]) acc[g] = []
                      if (!ov.empty) acc[g].push(ov)
                      return acc
                    }, {})
                  ).map(([groupName, groupOvs]) => (
                    <div key={groupName}>
                      <div className="px-3 pt-2 pb-1 text-[11px] text-gray-700 uppercase tracking-wide pl-5">{groupName}</div>
                      {groupOvs.map(ov => (
                        <OverlayButton key={ov.jsxPath} ov={ov} onSelect={ov => setSelection({ kind: 'profile', overlay: ov })} isSelected={selection?.kind === 'profile' && 'overlay' in selection && selection.overlay.jsxPath === ov.jsxPath} />
                      ))}
                    </div>
                  ))}
                </div>
              )
            })}
          </>
        )}

        <div className="px-3 pt-3 pb-1 mt-1 text-xs font-semibold text-gray-500 uppercase tracking-wide border-t border-gray-200 dark:border-gray-800">
          Projects
        </div>

        {projects.map(p => {
          const count = overlayCount(p)
          return (
            <button
              key={p.id}
              onClick={() => setSelection({ kind: 'project', project: p })}
              className={`text-left px-3 py-2 text-sm flex items-center justify-between gap-2 transition-colors ${
                selection?.kind === 'project' && selection.project.id === p.id
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <span className="truncate">{p.name ?? p.id}</span>
              {count > 0 && (
                <span className="shrink-0 text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full px-1.5 py-0.5 leading-none">
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Right panel */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {!selection && (
          <div className="h-full flex items-center justify-center text-gray-600 text-sm">
            Select an overlay or project
          </div>
        )}
        {(selection?.kind === 'global' || selection?.kind === 'profile') && (
          <GlobalOverlayDetail overlay={selection.overlay} />
        )}
        {selection?.kind === 'project' && (
          <ProjectOverlayList project={selection.project} />
        )}
      </div>
    </div>
  )
}

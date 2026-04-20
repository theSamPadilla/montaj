import { useState } from 'react'
import type { ProjectVersion } from '@/lib/types/schema'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function parseVersion(v: ProjectVersion): { run: number; label: string } {
  const m = v.message.match(/run (\d+) — (.+)/)
  return m ? { run: parseInt(m[1]), label: m[2] } : { run: 0, label: v.message }
}

function dedupeVersions(versions: ProjectVersion[]): ProjectVersion[] {
  const nonInit = versions.filter(v => parseVersion(v).run > 0)
  const byRun = new Map<number, ProjectVersion>()
  for (const v of nonInit) {
    const { run, label } = parseVersion(v)
    const existing = byRun.get(run)
    const isDefault = label === 'draft' || label === 'final' || label === 'pending'
    if (!existing) { byRun.set(run, v); continue }
    const { label: existingLabel } = parseVersion(existing)
    const existingIsDefault = existingLabel === 'draft' || existingLabel === 'final' || existingLabel === 'pending'
    if (existingIsDefault && !isDefault) byRun.set(run, v)
  }
  return [...byRun.values()].sort((a, b) => parseVersion(b).run - parseVersion(a).run)
}

interface VersionPanelProps {
  versions: ProjectVersion[]
  restoring: string | null
  onRestore: (hash: string) => void
}

export default function VersionPanel({ versions, restoring, onRestore }: VersionPanelProps) {
  const [open, setOpen] = useState(true)
  const deduped = dedupeVersions(versions)

  return (
    <div className="shrink-0 border-b border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden" style={{ maxHeight: open ? 224 : 0, transition: 'max-height 0.15s ease' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors w-full text-left"
      >
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Versions</span>
        <span className="text-gray-600 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      <div className="overflow-y-auto p-2 flex flex-col gap-1.5">
        {deduped.length === 0 ? (
          <p className="text-xs text-gray-600 text-center mt-2 px-1 leading-relaxed">No saved versions yet.</p>
        ) : deduped.map(v => {
          const { run, label } = parseVersion(v)
          const isDefault = label === 'draft' || label === 'final' || label === 'pending'
          return (
            <div key={v.hash} className="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-2 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-500 dark:text-gray-600 shrink-0">Run {run}</span>
                {isDefault ? (
                  <span className="text-[10px] text-gray-500 capitalize">{label}</span>
                ) : (
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate capitalize" title={label}>{label}</span>
                )}
              </div>
              <span className="text-[10px] text-gray-600">{formatTime(v.timestamp)}</span>
              <button
                onClick={() => onRestore(v.hash)}
                disabled={restoring === v.hash}
                className="text-[10px] text-blue-500 hover:text-blue-400 text-left transition-colors disabled:opacity-40"
              >
                {restoring === v.hash ? 'Restoring…' : 'Restore →'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

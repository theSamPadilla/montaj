import { useState } from 'react'
import type { VersionEntry } from '../types'

// VersionPanel reads only the editor-relevant slice of a version — hash,
// message, timestamp — which is exactly `VersionEntry`. Aliased to the panel's
// original `ProjectVersion` name so the ported parse/dedup logic is untouched.
type ProjectVersion = VersionEntry

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
    // The collapse is on the LIST, never on the whole panel. Collapsing used to
    // set `max-height: 0` on this outer element, which took the header button
    // with it — the panel vanished and there was nothing left to click to bring
    // it back, so collapsing it once hid version history for the rest of the
    // session.
    <div className="shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--editor-border)] hover:bg-[var(--editor-surface)] transition-colors w-full text-left"
      >
        <span className="text-xs font-medium text-[var(--editor-text)]/60 uppercase tracking-wide">
          Versions
          {deduped.length > 0 && (
            <span className="ml-1.5 text-[var(--editor-text)]/40 normal-case tracking-normal">{deduped.length}</span>
          )}
        </span>
        <span className="text-[var(--editor-text)]/50 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      {/* Padding lives on the INNER box: on the collapsing element itself it
          survives `max-height: 0` and leaves a stray 16px strip under the
          header. */}
      <div
        className="overflow-y-auto"
        style={{ maxHeight: open ? 224 : 0, transition: 'max-height 0.15s ease' }}
      >
      <div className="p-2 flex flex-col gap-1.5">
        {deduped.length === 0 ? (
          <p className="text-xs text-[var(--editor-text)]/55 text-center mt-2 px-1 leading-relaxed">No saved versions yet.</p>
        ) : deduped.map(v => {
          const { run, label } = parseVersion(v)
          const isDefault = label === 'draft' || label === 'final' || label === 'pending'
          return (
            <div key={v.hash} className="rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] p-2 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--editor-text)]/50 shrink-0">Run {run}</span>
                {isDefault ? (
                  <span className="text-[10px] text-[var(--editor-text)]/60 capitalize">{label}</span>
                ) : (
                  <span className="text-xs font-medium text-[var(--editor-text)] truncate capitalize" title={label}>{label}</span>
                )}
              </div>
              <span className="text-[10px] text-[var(--editor-text)]/55">{formatTime(v.timestamp)}</span>
              <button
                onClick={() => onRestore(v.hash)}
                disabled={restoring === v.hash}
                className="text-[10px] text-[var(--editor-accent)] hover:opacity-80 text-left transition-colors disabled:opacity-40"
              >
                {restoring === v.hash ? 'Restoring…' : 'Restore →'}
              </button>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

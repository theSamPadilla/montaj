import { useState } from 'react'
import { Save } from 'lucide-react'
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

const KNOWN_LABELS: Record<string, string> = {
  draft: 'Draft',
  final: 'Final',
  pending: 'Pending',
  export: 'Exported',
  'autosave before restore': 'Auto-save before restore',
}

/** Turns a raw parsed label into what the operator sees. Known backend labels
 *  get a human-readable name; an empty label (no message) reads as "Untitled
 *  save" rather than blank; anything else is an operator-typed name and is
 *  shown verbatim, unmangled apart from surrounding whitespace. Returns the
 *  TRIMMED name, not the raw one: the save path already trims what it stores
 *  (`nameInput.trim()` below), so stray padding here only ever comes from a
 *  hand-edited commit message, and rendering it would just misalign the row. */
export function humanizeLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed === '') return 'Untitled save'
  const known = KNOWN_LABELS[trimmed.toLowerCase()]
  return known ?? trimmed
}

function timestampMs(v: ProjectVersion): number {
  const ms = Date.parse(v.timestamp)
  return Number.isNaN(ms) ? 0 : ms
}

/** Every saved version gets its own row — no collapsing by backend "run".
 *  Only the run-0 init baseline is filtered out. Sorted newest first by
 *  timestamp; the sort is stable so same-timestamp entries keep their input
 *  order, and it never mutates the caller's array. */
export function listVersions(versions: ProjectVersion[]): ProjectVersion[] {
  const nonInit = versions.filter(v => parseVersion(v).run > 0)
  return [...nonInit].sort((a, b) => timestampMs(b) - timestampMs(a))
}

interface VersionPanelProps {
  versions: ProjectVersion[]
  restoring: string | null
  onRestore: (hash: string) => void
  /** Saves the current project state as a new named version. Absent when the
   *  host adapter doesn't support it — the Save affordance disables itself
   *  rather than disappearing, so the panel's layout doesn't jump. */
  onSaveVersion?: (name?: string) => void
  saving?: boolean
  /** Opens the visual A/B compare view seeded on this version's hash. Absent
   *  when the host adapter has no `versionFrameUrl` — the Compare button then
   *  just doesn't render, matching Restore/Save's degrade-gracefully pattern. */
  onCompareVersion?: (hash: string) => void
}

export default function VersionPanel({ versions, restoring, onRestore, onSaveVersion, saving, onCompareVersion }: VersionPanelProps) {
  const [nameInput, setNameInput] = useState('')
  const rows = listVersions(versions)

  function handleSaveClick() {
    onSaveVersion?.(nameInput.trim() || undefined)
    setNameInput('')
  }

  return (
    <div className="flex-1 min-h-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden">
      {/* No collapse control: Versions has its own tab now, so the whole panel
          IS the list. The count sits on the right as an explicit "N versions"
          label so it reads as a quantity rather than part of the title. */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--editor-border)]">
        <span className="text-xs font-medium text-[var(--editor-text)]/60 uppercase tracking-wide">Versions</span>
        {rows.length > 0 && (
          <span className="text-[10px] text-[var(--editor-text)] opacity-50">
            {rows.length} {rows.length === 1 ? 'version' : 'versions'}
          </span>
        )}
      </div>

      {/* Save affordance — always visible (not gated on `open`) so saving a
          version doesn't require expanding the list first. Disabled rather
          than hidden when the host has no `onSaveVersion`, matching the
          Restore buttons' pattern of degrading gracefully. */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-[var(--editor-border)]">
        <input
          type="text"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          placeholder="Name (optional)"
          disabled={saving || !onSaveVersion}
          className="min-w-0 flex-1 h-8 text-[11px] bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded-md px-2 text-[var(--editor-text)] placeholder:text-[var(--editor-text)]/40 focus:outline-none focus:border-[var(--editor-accent)] disabled:opacity-40"
        />
        <button
          onClick={handleSaveClick}
          disabled={saving || !onSaveVersion}
          className="shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--editor-accent)] text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:hover:opacity-40"
        >
          <Save size={13} />
          {saving ? 'Saving…' : 'Save version'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-2 flex flex-col gap-1.5">
        {rows.length === 0 ? (
          <p className="text-xs text-[var(--editor-text)] opacity-55 text-center mt-2 px-1 leading-relaxed">No saved versions yet.</p>
        ) : rows.map(v => {
          const { label } = parseVersion(v)
          const name = humanizeLabel(label)
          return (
            <div key={v.hash} className="rounded-md border border-[var(--editor-border)] bg-[var(--editor-surface)] p-2.5 flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-[var(--editor-text)] truncate" title={name}>{name}</span>
                <span className="text-[10px] text-[var(--editor-text)] opacity-55">{formatTime(v.timestamp)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onRestore(v.hash)}
                  disabled={restoring === v.hash}
                  className="flex items-center h-6 px-2 rounded border border-indigo-500/50 text-[10px] font-medium text-indigo-300 hover:bg-indigo-500/10 transition-colors disabled:opacity-40"
                >
                  {restoring === v.hash ? 'Restoring…' : 'Restore →'}
                </button>
                {onCompareVersion && (
                  <button
                    onClick={() => onCompareVersion(v.hash)}
                    className="flex items-center h-6 px-2 rounded border border-[var(--editor-border)] text-[10px] font-medium text-[var(--editor-text)] opacity-70 hover:opacity-100 transition-opacity"
                  >
                    Compare
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}

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
  const [open, setOpen] = useState(true)
  const [nameInput, setNameInput] = useState('')
  const rows = listVersions(versions)

  function handleSaveClick() {
    onSaveVersion?.(nameInput.trim() || undefined)
    setNameInput('')
  }

  return (
    // The collapse is on the LIST, never on the whole panel. Collapsing used to
    // set `max-height: 0` on this outer element, which took the header button
    // with it — the panel vanished and there was nothing left to click to bring
    // it back, so collapsing it once hid version history for the rest of the
    // session.
    <div className="flex-1 min-h-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--editor-border)] hover:bg-[var(--editor-surface)] transition-colors w-full text-left"
      >
        <span className="text-xs font-medium text-[var(--editor-text)]/60 uppercase tracking-wide">
          Versions
          {rows.length > 0 && (
            <span className="ml-1.5 text-[var(--editor-text)]/40 normal-case tracking-normal">{rows.length}</span>
          )}
        </span>
        <span className="text-[var(--editor-text)]/50 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>

      {/* Save affordance — always visible (not gated on `open`) so saving a
          version doesn't require expanding the list first. Disabled rather
          than hidden when the host has no `onSaveVersion`, matching the
          Restore buttons' pattern of degrading gracefully. */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-[var(--editor-border)]">
        <input
          type="text"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
          placeholder="Name (optional)"
          disabled={saving || !onSaveVersion}
          className="min-w-0 flex-1 text-[11px] bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded px-1.5 py-1 text-[var(--editor-text)] placeholder:text-[var(--editor-text)]/40 focus:outline-none focus:border-[var(--editor-accent)] disabled:opacity-40"
        />
        <button
          onClick={handleSaveClick}
          disabled={saving || !onSaveVersion}
          className="shrink-0 text-[10px] font-medium px-2 py-1 rounded bg-[var(--editor-accent)]/15 text-[var(--editor-accent)] hover:bg-[var(--editor-accent)]/25 transition-colors disabled:opacity-40 disabled:hover:bg-[var(--editor-accent)]/15"
        >
          {saving ? 'Saving…' : 'Save version'}
        </button>
      </div>

      {/* Padding lives on the INNER box: on the collapsing element itself it
          survives `max-height: 0` and leaves a stray 16px strip under the
          header. The collapse stays on the LIST, never on the whole panel —
          see the module-level note above the header button. */}
      <div className={open ? 'flex-1 min-h-0 overflow-y-auto' : 'h-0 overflow-hidden'}>
      <div className="p-2 flex flex-col gap-1.5">
        {rows.length === 0 ? (
          <p className="text-xs text-[var(--editor-text)]/55 text-center mt-2 px-1 leading-relaxed">No saved versions yet.</p>
        ) : rows.map(v => {
          const { label } = parseVersion(v)
          const name = humanizeLabel(label)
          return (
            <div key={v.hash} className="rounded border border-[var(--editor-border)] bg-[var(--editor-surface)] p-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-[var(--editor-text)] truncate" title={name}>{name}</span>
              <span className="text-[10px] text-[var(--editor-text)]/55">{formatTime(v.timestamp)}</span>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => onRestore(v.hash)}
                  disabled={restoring === v.hash}
                  className="text-[10px] text-[var(--editor-accent)] hover:opacity-80 text-left transition-colors disabled:opacity-40"
                >
                  {restoring === v.hash ? 'Restoring…' : 'Restore →'}
                </button>
                {onCompareVersion && (
                  <button
                    onClick={() => onCompareVersion(v.hash)}
                    className="text-[10px] text-[var(--editor-text)]/45 hover:text-[var(--editor-text)]/75 text-left transition-colors"
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

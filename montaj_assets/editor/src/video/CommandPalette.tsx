import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import { parseTimecode } from './timecode'

export interface PaletteCommand {
  id: string
  label: string
  keyHint?: string[]
  run: () => void
}

export interface CommandPaletteProps {
  commands: PaletteCommand[]
  /** Opens straight into the "go to time" input instead of the filtered list
   *  — the time readout's click target uses this. */
  initialMode?: 'list' | 'goto'
  /** Parsed timecode → `clock.set`-style seek. */
  onGoToTime: (seconds: number) => void
  onClose: () => void
}

/**
 * Cmd/Ctrl+K command palette. Styled after `TranscriptModal` (portal to
 * `document.body`, dark centered panel, backdrop-click-to-close) so it reads
 * as part of the same modal family.
 *
 * List mode: type to filter, arrow keys to move the highlight, Enter runs
 * the highlighted command, Escape closes. Goto mode: a single timecode input
 * (`mm:ss` / `hh:mm:ss` / bare seconds), Enter seeks and closes, Escape
 * returns to the list (or closes, if opened directly into goto mode).
 */
export default function CommandPalette({ commands, initialMode = 'list', onGoToTime, onClose }: CommandPaletteProps) {
  const [mode, setMode] = useState<'list' | 'goto'>(initialMode)
  const [query, setQuery] = useState('')
  const [gotoValue, setGotoValue] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [gotoError, setGotoError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [mode])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    setHighlight(0)
  }, [filtered.length, query])

  function runHighlighted() {
    const cmd = filtered[highlight]
    if (!cmd) return
    cmd.run()
    onClose()
  }

  function submitGoto() {
    const seconds = parseTimecode(gotoValue)
    if (seconds === null) { setGotoError(true); return }
    onGoToTime(seconds)
    onClose()
  }

  function handleListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); runHighlighted(); return }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
  }

  function handleGotoKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submitGoto(); return }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Opened directly (time-readout click) → close outright. Opened from
      // the list's "Go to time..." entry → fall back to the list.
      if (initialMode === 'goto') { onClose(); return }
      setMode('list')
      setGotoValue('')
      setGotoError(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg flex flex-col bg-gray-950 border border-gray-800 rounded-lg shadow-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'goto' ? (
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-400">Go to time</span>
            <input
              ref={inputRef}
              type="text"
              value={gotoValue}
              onChange={(e) => { setGotoValue(e.target.value); setGotoError(false) }}
              onKeyDown={handleGotoKeyDown}
              placeholder="mm:ss, hh:mm:ss, or seconds"
              className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-600 outline-none border border-gray-800 rounded px-2 py-1.5"
            />
            {gotoError && <span className="text-xs text-red-400">Couldn&rsquo;t parse that timecode</span>}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
              <Search size={14} className="text-gray-500 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleListKeyDown}
                placeholder="Type a command…"
                className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-600 outline-none"
              />
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {filtered.length === 0 && (
                <div className="px-4 py-3 text-xs text-gray-600">No matching commands</div>
              )}
              {filtered.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => { cmd.run(); onClose() }}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors ${
                    i === highlight ? 'bg-white/10 text-white' : 'text-gray-300'
                  }`}
                >
                  <span>{cmd.label}</span>
                  {cmd.keyHint && cmd.keyHint.length > 0 && (
                    <span className="flex items-center gap-1 shrink-0">
                      {cmd.keyHint.map((k, j) => (
                        <kbd key={j} className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-gray-700 text-gray-400">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

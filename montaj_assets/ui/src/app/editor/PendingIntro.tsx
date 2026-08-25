import { useEffect, useState } from 'react'
import { Clapperboard } from 'lucide-react'
import { api } from '@/lib/api'
import { trackItems, type Project } from '@/lib/types/schema'

// Host-owned content for VideoEditor's `pendingStatus` slot. EditorPage now
// supplies this slot unconditionally (see EditorPage.tsx's videoSlots), which
// means the package's own default "Message your agent to start" card never
// renders anymore — so this component reproduces that card itself (idle
// state) alongside the live agent-progress card (agent-working state), and
// adds the one thing neither of those had: a door out of the pending gate
// that lets the user skip the agent and start editing by hand.
interface Props {
  project: Project
  logMessage?: string | null
  onStartManual: () => void
  starting?: boolean
}

export default function PendingIntro({ project, logMessage, onStartManual, starting }: Props) {
  const [skillPath, setSkillPath] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.getInfo().then(info => setSkillPath(info.root_skill_path)).catch(() => {})
  }, [])

  // Empty until the skill path resolves. Both readers sit inside the
  // `{skillPath && ...}` guard below, so this never renders; keeping it
  // conditional means a future refactor can't ship "@null" to the clipboard.
  const command = skillPath
    ? `There is a new project pending: "${project.name ?? project.id}". Please see @${skillPath} and start. Talk to me if you run into questions.`
    : ''

  return (
    <>
      {logMessage ? (
        <>
          <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm">
            <span className="text-white font-medium">
              {(trackItems(project)[0] ?? []).length} clip(s)
            </span>
            {' queued. Agent is working:'}
          </p>
          <p className="text-blue-400 text-xs font-mono bg-gray-900 rounded px-3 py-1.5 w-full text-left truncate">
            → {logMessage}
          </p>
        </>
      ) : (
        <>
          {/* Hardcoded light-on-dark for the same reason as the manual-start
              block below: the pending surface's container is bg-black in BOTH
              themes, so `--editor-text` (near-black under the light theme)
              renders these invisible. gray-100/gray-400 are what the dark
              theme's token resolved to anyway, so dark mode is unchanged. */}
          <div className="flex flex-col items-center gap-2">
            <p className="text-gray-100 text-lg font-semibold">Message your agent to start</p>
            <p className="text-gray-400 text-sm">Nothing will happen automatically. Copy this and send it to your agent.</p>
          </div>
          {skillPath && (
            <div className="w-full rounded-xl border-2 border-[var(--editor-accent)]/50 bg-[var(--editor-surface)] p-5 flex flex-col gap-3 text-left shadow-lg shadow-[var(--editor-accent)]/10">
              <p className="text-[var(--editor-accent)] text-xs font-bold uppercase tracking-widest">Send this to your agent</p>
              {/* Deliberately hardcoded dark chrome, not `--editor-*` tokens: this is
                  the literal text the user copies and pastes to their coding agent,
                  styled as terminal/code chrome. The background MUST stay the opaque
                  #070a10 (not bg-black/60): a translucent black composites to only
                  ~#666 over a light theme's surface, which drops the copyable text
                  below AA contrast. #070a10 is what rgba(0,0,0,0.6) composited to
                  over the dark theme's surface, so dark mode is unchanged and light
                  mode is now readable. Ported verbatim from the package's own
                  default card (montaj_assets/editor/src/video/VideoEditor.tsx). */}
              <div className="flex items-start justify-between bg-[#070a10] border border-transparent rounded-lg px-3 py-3 font-mono gap-3">
                <span className="text-gray-100 text-[12px] leading-relaxed break-all">
                  {command}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(command)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                    copied ? 'bg-green-700 text-green-200' : 'bg-white/10 text-gray-100 hover:bg-white/20 hover:text-white'
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
      {/* This surface's container is bg-black in both themes (VideoEditor.tsx's
          pending surface), so these greys are deliberately hardcoded rather
          than `--editor-text`-relative — under the light theme that token is
          near-black and would be invisible on a black background. */}
      <div className="flex flex-col items-center gap-2">
        <p className="text-xs text-gray-400">Prefer to build it yourself?</p>
        <button
          onClick={onStartManual}
          disabled={starting}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Clapperboard size={15} />
          {starting ? 'Opening editor...' : 'Start editing manually'}
        </button>
        <p className="text-[11px] text-gray-500">
          Opens the full editor with your footage in the media bin and an empty timeline.
        </p>
      </div>
    </>
  )
}

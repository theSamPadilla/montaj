import MobileProjectHeader from '@/components/MobileProjectHeader'
import type { Project } from '@/lib/types/schema'

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
  /** Latest agent log line streamed via SSE. */
  logMessage?: string | null
  /** Optional override of the desktop-nudge copy. */
  message?: string
}

export default function MobileEditNotice({ project, onProjectChange, logMessage, message }: Props) {
  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <MobileProjectHeader project={project} onProjectChange={onProjectChange} />

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full flex flex-col gap-4">
          {/* Progress block */}
          <div className="flex flex-col gap-2 items-center text-center">
            {logMessage ? (
              <div className="w-full rounded-md bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-3 py-2">
                <p className="text-[11px] font-mono text-blue-600 dark:text-blue-400 text-left break-all">
                  → {logMessage}
                </p>
              </div>
            ) : project.status === 'pending' ? (
              <p className="text-xs text-gray-500 italic">Waiting for the agent to start…</p>
            ) : null}
          </div>

          {/* Desktop nudge */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-800 flex flex-col gap-2 text-center">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Open on desktop to continue</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              {message ?? `This project needs a larger screen for editing. Once it’s ready, you can render from your phone.`}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

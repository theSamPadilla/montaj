import { useState, type ReactNode } from 'react'

export interface MediaPanelProps {
  /** "Footage" or "B-Roll" — the label for the first tab (host decides which). */
  footageLabel: string
  /** The `<FootagePanel/>` node built by the caller. */
  footage: ReactNode
  /** The existing assets composite (AssetsPanel + ProfileAssetsPanel) built by the caller. */
  assets: ReactNode
  /**
   * Optional third tab body — the `<AudioPanel/>` node built by the caller for
   * any project that carries audio: the tracks placed on the timeline, plus the
   * b-roll voiceover cards when the project has them. Absent only for a project
   * with no audio at all, and when absent the tab is not rendered so those
   * projects keep the original two tabs.
   */
  audio?: ReactNode
  /**
   * Label for the optional third tab. Defaults to "Broll Audio" — the label
   * b-roll projects have always shown, kept as the default so their UX does not
   * churn. Non-b-roll callers pass "Audio".
   */
  audioLabel?: string
}

type TabKey = 'footage' | 'audio' | 'assets'

/**
 * Dumb tabbed shell for the left media column: a tab strip (`footageLabel` |
 * [`audioLabel`] | "Assets") over whichever tab body is active. Owns only the
 * tab selection — the caller builds and wires the tab contents (EditorPage).
 * The audio tab only appears when the caller passes an `audio` node. The tab
 * count is always 2 or 3, never 4 — the audio tab is one generalized tab, not a
 * per-project family of them.
 */
export default function MediaPanel({
  footageLabel,
  footage,
  assets,
  audio,
  audioLabel = 'Broll Audio',
}: MediaPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('footage')

  // Guard against the audio tab being active while its node is absent (it is
  // gated per-project at the caller, so this only matters if a project loses
  // all its audio mid-session): fall back to the footage body.
  const body =
    activeTab === 'assets'
      ? assets
      : activeTab === 'audio' && audio
        ? audio
        : footage

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-gray-800">
        <TabButton label={footageLabel} active={activeTab === 'footage'} onClick={() => setActiveTab('footage')} />
        {audio && (
          <TabButton label={audioLabel} active={activeTab === 'audio'} onClick={() => setActiveTab('audio')} />
        )}
        <TabButton label="Assets" active={activeTab === 'assets'} onClick={() => setActiveTab('assets')} />
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {body}
      </div>
    </div>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium uppercase tracking-wide border-b-2 -mb-px transition-colors ${
        active
          ? 'border-blue-500 text-gray-900 dark:text-white'
          : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  )
}

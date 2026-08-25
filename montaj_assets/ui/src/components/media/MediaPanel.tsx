import { useState, type ReactNode } from 'react'

export interface MediaPanelProps {
  /** "Footage" or "B-Roll" — the label for the first tab (host decides which). */
  footageLabel: string
  /** The `<FootagePanel/>` node built by the caller. */
  footage: ReactNode
  /** The existing assets composite (AssetsPanel + ProfileAssetsPanel) built by the caller. */
  assets: ReactNode
  /**
   * Optional third tab body — the `<BrollAudioPanel/>` node built by the caller
   * for b-roll projects (the submitted voiceover footage + assembled/cleaned
   * audio). Absent for every other project shape, and when absent the tab is
   * not rendered at all so those projects keep the original two tabs.
   */
  brollAudio?: ReactNode
  /** Label for the optional third tab. Defaults to "Broll Audio". */
  brollAudioLabel?: string
}

type TabKey = 'footage' | 'brollAudio' | 'assets'

/**
 * Dumb tabbed shell for the left media column: a tab strip (`footageLabel` |
 * ["Broll Audio"] | "Assets") over whichever tab body is active. Owns only the
 * tab selection — the caller builds and wires the tab contents (EditorPage).
 * The "Broll Audio" tab only appears when the caller passes a `brollAudio` node.
 */
export default function MediaPanel({
  footageLabel,
  footage,
  assets,
  brollAudio,
  brollAudioLabel = 'Broll Audio',
}: MediaPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('footage')

  // Guard against the brollAudio tab being active while its node is absent (it
  // is gated per-project at the caller, so this only matters if a project loses
  // its voiceover mid-session): fall back to the footage body.
  const body =
    activeTab === 'assets'
      ? assets
      : activeTab === 'brollAudio' && brollAudio
        ? brollAudio
        : footage

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-gray-800">
        <TabButton label={footageLabel} active={activeTab === 'footage'} onClick={() => setActiveTab('footage')} />
        {brollAudio && (
          <TabButton label={brollAudioLabel} active={activeTab === 'brollAudio'} onClick={() => setActiveTab('brollAudio')} />
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

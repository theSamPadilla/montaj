import { useState, type ReactNode } from 'react'

export interface MediaPanelProps {
  /** "Footage" or "B-Roll" — the label for the first tab (host decides which). */
  footageLabel: string
  /** The `<FootagePanel/>` node built by the caller. */
  footage: ReactNode
  /** The existing assets composite (AssetsPanel + ProfileAssetsPanel) built by the caller. */
  assets: ReactNode
}

type TabKey = 'footage' | 'assets'

/**
 * Dumb tabbed shell for the left media column: a tab strip (`footageLabel` |
 * "Assets") over whichever tab body is active. Owns only the tab selection —
 * the caller builds and wires the tab contents (EditorPage).
 */
export default function MediaPanel({ footageLabel, footage, assets }: MediaPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('footage')

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-gray-800">
        <TabButton label={footageLabel} active={activeTab === 'footage'} onClick={() => setActiveTab('footage')} />
        <TabButton label="Assets" active={activeTab === 'assets'} onClick={() => setActiveTab('assets')} />
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {activeTab === 'footage' ? footage : assets}
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

import { Link, useLocation } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'

const TABS = [
  { path: '/',          label: 'Editor' },
  { path: '/workflows', label: 'Flows' },     // shortened
  { path: '/overlays',  label: 'Overlays' },
  { path: '/profiles',  label: 'Profiles' },
]

interface Props {
  dark: boolean
  onToggleDark: () => void
}

export default function MobileTopNav({ dark, onToggleDark }: Props) {
  const { pathname } = useLocation()

  function isActive(path: string) {
    if (path === '/') return pathname === '/' || pathname.startsWith('/projects')
    return pathname.startsWith(path)
  }

  return (
    <header className="flex items-center gap-2 px-2 h-10 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shrink-0">
      <Link to="/" className="flex items-center gap-1 shrink-0">
        <img src="/montaj-logo.png" alt="Montaj" className="w-5 h-5 rounded" />
      </Link>
      <nav className="flex gap-0.5 flex-1 overflow-x-auto">
        {TABS.map(({ path, label }) => (
          <Link
            key={path}
            to={path}
            className={`px-2 py-1 rounded text-xs whitespace-nowrap transition-colors ${
              isActive(path)
                ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <button
        onClick={onToggleDark}
        className="p-2 rounded text-gray-400 dark:hover:text-gray-200 shrink-0"
        aria-label="Toggle theme"
      >
        {dark ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    </header>
  )
}

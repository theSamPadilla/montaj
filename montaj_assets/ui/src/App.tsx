import { Suspense, useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import { useIsMobile } from '@/lib/useIsMobile'
import MobileTopNav from '@/components/MobileTopNav'
import ProxyActivityIndicator from '@/components/ProxyActivityIndicator'
import CaptionActivityIndicator from '@/components/CaptionActivityIndicator'
import { CaptionJobProvider } from '@/app/editor/captionJob'

function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-2 shrink-0">
      <img src="/montaj-logo.png" alt="Montaj" className="w-6 h-6 rounded" />
      <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.02em' }}
            className="text-gray-900 dark:text-white">
        Monta<span style={{
          background: 'linear-gradient(135deg, #f97316, #eab308)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>j</span>
      </span>
    </Link>
  )
}

const TABS = [
  { path: '/',          label: 'Editor' },
  { path: '/workflows', label: 'Workflows' },
  { path: '/overlays',  label: 'Overlays' },
  { path: '/profiles',  label: 'Profiles' },
]

export default function App() {
  const { pathname } = useLocation()

  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  const isMobile = useIsMobile()

  function isActive(path: string) {
    if (path === '/') return pathname === '/' || pathname.startsWith('/projects')
    return pathname.startsWith(path)
  }

  return (
    // Mounted here (the app root), above the route below, so a running
    // caption job survives navigating away from the editor and back — the
    // provider's state lives for as long as this tree does, not for as long
    // as EditorPage happens to be mounted. See captionJob.tsx's header
    // comment for why the job itself is owned up here.
    <CaptionJobProvider>
      <div className="flex flex-col h-screen overflow-hidden">
        {isMobile ? (
          <MobileTopNav dark={dark} onToggleDark={() => setDark(d => !d)} />
        ) : (
          <header className="relative flex items-center gap-6 px-4 h-11 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shrink-0">
            <Wordmark />
            <nav className="flex gap-0.5 flex-1">
              {TABS.map(({ path, label }) => (
                <Link
                  key={path}
                  to={path}
                  className={`px-3 py-1 rounded text-sm transition-colors ${
                    isActive(path)
                      ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-white dark:hover:bg-gray-800'
                  }`}
                >
                  {label}
                </Link>
              ))}
            </nav>
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3 pointer-events-none">
              <ProxyActivityIndicator />
              <CaptionActivityIndicator />
            </div>
            <button
              onClick={() => setDark(d => !d)}
              className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-colors"
              aria-label="Toggle theme"
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </header>
        )}

        <main className="flex-1 overflow-hidden">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </CaptionJobProvider>
  )
}

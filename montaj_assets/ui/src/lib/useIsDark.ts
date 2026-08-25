import { useEffect, useState } from 'react'

// App.tsx toggles the `dark` class on <html> for the host's light/dark mode.
// This hook mirrors that flag into React state so consumers (e.g. EditorPage
// choosing which editor theme to hand the package) re-render on toggle.
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      // setState bails out on an identical value, so no need to dedupe here.
      setIsDark(root.classList.contains('dark'))
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

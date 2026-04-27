import { useMemo } from 'react'
import { Link } from 'react-router-dom'

const PREVIEWS = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `/preview/preview${n === 1 ? '' : n}.jpg`)

const MESSAGES = [
  "The agent went looking for this page and never came back.",
  "Even whisper.cpp couldn't transcribe what happened here.",
  "This page was trimmed out in post.",
  "The workflow ran. Nothing was found. The agent said 'looks good.'",
  "404 cuts/min. No useful footage.",
  "This page failed the filler removal step.",
  "select_takes reviewed this URL and rejected all takes.",
  "The render engine rendered this page at 0fps.",
  "Silence detected. Trimmed.",
  "This route was a bad take. We moved on.",
]


export default function NotFound() {
  const message = useMemo(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)], [])
  const image   = useMemo(() => PREVIEWS[Math.floor(Math.random() * PREVIEWS.length)], [])

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
      <img src={image} alt="" className="w-full max-w-sm rounded" />
      <div className="flex flex-col gap-2">
        <p className="text-4xl font-bold text-gray-200 dark:text-gray-700">404</p>
        <p className="text-gray-500 dark:text-gray-400 text-sm max-w-xs">{message}</p>
      </div>
      <Link to="/" className="text-sm text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
        ← Back to projects
      </Link>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { ChevronLeft, Copy, RefreshCw } from 'lucide-react'
import { api, fileUrl, type GlobalOverlay } from '@/lib/api'
import type { Profile } from '@/lib/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function ColorSwatch({ hex }: { hex: string }) {
  return (
    <div
      className="w-7 h-7 rounded border border-black/10 dark:border-white/10 shrink-0"
      style={{ background: hex }}
      title={hex}
    />
  )
}

// ---------------------------------------------------------------------------
// Profile list card
// ---------------------------------------------------------------------------

function ProfileCard({ profile, onClick }: { profile: Profile; onClick: () => void }) {
  const colors = profile.stats?.dominant_colors ?? []
  const sources = profile.sources ?? []

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-white">{profile.display_name ?? profile.name}</p>
          {profile.display_name && (
            <p className="text-xs text-gray-400 mt-0.5">@{profile.name}</p>
          )}
          <div className="flex gap-2 mt-1.5 flex-wrap">
            {sources.map((s, i) => (
              <span
                key={i}
                className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
              >
                {s.type}{s.video_count ? ` · ${s.video_count}v` : ''}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-1 shrink-0 mt-0.5">
          {colors.slice(0, 5).map((c, i) => (
            <ColorSwatch key={i} hex={c} />
          ))}
        </div>
      </div>

      {profile.stats && (
        <div className="flex gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
          {profile.stats.avg_duration != null && (
            <span>{profile.stats.avg_duration}s avg</span>
          )}
          {profile.stats.avg_cuts_per_min != null && (
            <span>{profile.stats.avg_cuts_per_min} cuts/min</span>
          )}
          {profile.stats.avg_wpm != null && (
            <span>{profile.stats.avg_wpm} WPM</span>
          )}
          {profile.stats.videos_analyzed != null && (
            <span className="ml-auto">{profile.stats.videos_analyzed} videos</span>
          )}
        </div>
      )}

      {profile.style_meta?.style_summary && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">{profile.style_meta.style_summary}</p>
      )}
      <p className="text-xs text-gray-400 mt-2">Updated {fmtDate(profile.updated)}</p>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Profile detail view
// ---------------------------------------------------------------------------

function ProfileDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab]         = useState<'style' | 'frames' | 'overlays'>('style')
  const [profileOverlays, setProfileOverlays] = useState<GlobalOverlay[]>([])
  const [copied, setCopied]   = useState(false)

  useEffect(() => {
    setLoading(true)
    api.getProfile(name)
      .then(setProfile)
      .catch(console.error)
      .finally(() => setLoading(false))
    api.listProfileOverlays(name).then(setProfileOverlays).catch(() => {})
  }, [name])

  if (loading) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-6 transition-colors">
          <ChevronLeft size={15} /> All profiles
        </button>
        <p className="text-gray-400 text-sm">Loading…</p>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-6 transition-colors">
          <ChevronLeft size={15} /> All profiles
        </button>
        <p className="text-gray-400 text-sm">Profile not found.</p>
      </div>
    )
  }

  const mergedColors  = profile.color_palette?.merged ?? profile.stats?.dominant_colors ?? []
  const currentColors = profile.color_palette?.current ?? []
  const inspiredColors = profile.color_palette?.inspired ?? []

  const profilePath = profile.style_profile_path ?? `~/.montaj/profiles/${profile.name}/style_profile.md`

  function copyPath() {
    navigator.clipboard.writeText(profilePath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto overflow-y-auto h-full">
      {/* Header */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-6 transition-colors">
        <ChevronLeft size={15} /> All profiles
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            {profile.display_name ?? profile.name}
          </h1>
          {profile.display_name && (
            <p className="text-sm text-gray-400 mt-0.5">@{profile.name}</p>
          )}
          {profile.style_meta?.links && (
            <p className="text-xs text-gray-400 mt-0.5">{profile.style_meta.links}</p>
          )}
          <p className="text-xs text-gray-400 mt-1">
            Updated {fmtDate(profile.updated)}
            {profile.stats?.videos_analyzed ? ` · ${profile.stats.videos_analyzed} videos analyzed` : ''}
          </p>
          {profile.style_meta?.content_overview && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 max-w-lg">{profile.style_meta.content_overview}</p>
          )}
        </div>

        {/* Update hint */}
        <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 shrink-0">
          <RefreshCw size={12} />
          <span>Use the style-profile skill to update</span>
        </div>
      </div>

      {/* Stats row */}
      {profile.stats && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Avg duration', value: profile.stats.avg_duration != null ? `${profile.stats.avg_duration}s` : null },
            { label: 'Cut frequency', value: profile.stats.avg_cuts_per_min != null ? `${profile.stats.avg_cuts_per_min}/min` : null },
            { label: 'Speech rate', value: profile.stats.avg_wpm != null ? `${profile.stats.avg_wpm} WPM` : null },
            { label: 'Speech density', value: profile.stats.avg_speech_ratio != null ? `${Math.round(profile.stats.avg_speech_ratio * 100)}%` : null },
          ].filter(s => s.value).map(s => (
            <div key={s.label} className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-400 mb-1">{s.label}</p>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Color palette */}
      {mergedColors.length > 0 && (
        <div className="mb-6">
          <p className="text-xs text-gray-400 mb-2 uppercase tracking-wide">Color palette</p>
          <div className="flex flex-col gap-2">
            {currentColors.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-16 shrink-0">Current</span>
                <div className="flex gap-1.5">
                  {currentColors.map((c, i) => <ColorSwatch key={i} hex={c} />)}
                </div>
              </div>
            )}
            {inspiredColors.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-16 shrink-0">Inspired</span>
                <div className="flex gap-1.5">
                  {inspiredColors.map((c, i) => <ColorSwatch key={i} hex={c} />)}
                </div>
              </div>
            )}
            {currentColors.length === 0 && inspiredColors.length === 0 && (
              <div className="flex gap-1.5">
                {mergedColors.map((c, i) => <ColorSwatch key={i} hex={c} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Document tabs */}
      {(profile.style_doc || (profile.sample_frames ?? []).length > 0 || profileOverlays.length > 0) && (
        <div>
          <div className="flex gap-0.5 mb-4">
            {profile.style_doc && (
              <button
                onClick={() => setTab('style')}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${tab === 'style' ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'}`}
              >
                Style Profile
              </button>
            )}
            {(profile.sample_frames ?? []).length > 0 && (
              <button
                onClick={() => setTab('frames')}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${tab === 'frames' ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'}`}
              >
                Sample Frames
              </button>
            )}
            <button
              onClick={() => setTab('overlays')}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${tab === 'overlays' ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'}`}
            >
              Overlays {profileOverlays.filter(o => !o.empty).length > 0 && <span className="ml-1 text-xs text-gray-400">({profileOverlays.filter(o => !o.empty).length})</span>}
            </button>
          </div>

          {tab === 'style' && profile.style_doc && (
            <pre className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-96">
              {profile.style_doc}
            </pre>
          )}

          {tab === 'frames' && (
            <div className="grid grid-cols-2 gap-3">
              {(profile.sample_frames ?? []).map((path, i) => (
                <img
                  key={i}
                  src={fileUrl(path)}
                  alt={`Sample frame ${i + 1}`}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-800 object-cover"
                />
              ))}
            </div>
          )}

          {tab === 'overlays' && (
            profileOverlays.filter(o => !o.empty).length === 0 ? (
              <div className="text-sm text-gray-500 py-4">
                No overlays yet. Add <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">.jsx</code> files to{' '}
                <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">~/.montaj/profiles/{name}/overlays/</code>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {profileOverlays.filter(o => !o.empty).map(ov => (
                  <div
                    key={ov.jsxPath}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {ov.group ? <span className="text-gray-400 font-normal">{ov.group} / </span> : null}
                        {ov.name}
                      </p>
                      {ov.description && <p className="text-xs text-gray-500 mt-0.5">{ov.description}</p>}
                      <p className="text-xs text-gray-400 font-mono mt-0.5 truncate">{ov.jsxPath.split('/').pop()}</p>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* Profile path */}
      <div className="mt-6 p-3 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
        <p className="text-xs text-gray-400 mb-2">Send this path to your agent to apply this style profile</p>
        <div className="flex items-center justify-between gap-3">
          <code className="text-xs text-gray-600 dark:text-gray-300 font-mono">{profilePath}</code>
          <button
            onClick={copyPath}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors shrink-0"
          >
            <Copy size={12} />
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center">
      <p className="text-gray-500 mb-2">No profiles yet.</p>
      <p className="text-sm text-gray-400 max-w-sm mx-auto">
        Run the <strong className="text-gray-600 dark:text-gray-300">style-profile</strong> skill
        to create your first creator profile. It'll guide you through analyzing your content and
        capturing your editorial style.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProfilesPage() {
  const [profiles, setProfiles]       = useState<Profile[]>([])
  const [loading, setLoading]         = useState(true)
  const [selected, setSelected]       = useState<string | null>(null)
  const [skillPath, setSkillPath]     = useState<string | null>(null)
  const [copied, setCopied]           = useState(false)

  useEffect(() => {
    api.listProfiles()
      .then(setProfiles)
      .catch(console.error)
      .finally(() => setLoading(false))
    api.getInfo()
      .then(info => setSkillPath(info.style_profile_skill_path))
      .catch(() => {})
  }, [])

  function copyPrompt() {
    if (!skillPath) return
    navigator.clipboard.writeText(`Please see @${skillPath} and help me create a style profile. Talk to me if you run into questions.`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (selected) {
    return <ProfileDetail name={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="p-6 max-w-3xl mx-auto overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Profiles</h1>
      </div>

      {loading && <p className="text-gray-400 text-sm">Loading…</p>}

      {!loading && profiles.length === 0 && <EmptyState />}

      <div className="flex flex-col gap-2">
        {profiles.map(p => (
          <ProfileCard key={p.name} profile={p} onClick={() => setSelected(p.name)} />
        ))}
      </div>

      {skillPath && (
        <div className="mt-6 rounded-xl border-2 border-white/20 bg-gray-900 p-4 flex flex-col gap-3">
          <p className="text-white text-xs font-semibold uppercase tracking-wider">Send this to your agent</p>
          <div className="flex items-start justify-between bg-black/60 rounded-lg px-3 py-3 font-mono gap-3">
            <span className="text-gray-200 text-[12px] leading-relaxed break-all">
              Please see @{skillPath} and help me create a style profile. Talk to me if you run into questions.
            </span>
            <button
              onClick={copyPrompt}
              className={`shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                copied
                  ? 'bg-green-700 text-green-200'
                  : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
              }`}
            >
              {copied ? '✓ Copied' : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

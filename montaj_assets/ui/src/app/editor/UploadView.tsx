import type { ReactNode } from 'react'
import { Sparkles, Layers, Music, Clapperboard, Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { LoadingModal } from '@/components/ui/loading-modal'
import { ASPECT_RATIOS } from '@/lib/types/kling'
import { CAROUSEL_ASPECTS, type CarouselAspect } from '@/lib/types/carousel'
import type { ProjectType } from '@/lib/types/project'
import { ClipUploadFields } from '@/components/upload/ClipUploadFields'
import { LyricsUploadFields } from '@/components/upload/LyricsUploadFields'
import { AIVideoUploadFields } from '@/components/upload/AIVideoUploadFields'
import BrollUploadFields from '@/components/upload/BrollUploadFields'
import AssetsPanel from '@/components/AssetsPanel'
import { useUploadForm } from '@/lib/useUploadForm'
import { AspectRatioIcon, CarouselAspectIcon } from '@/app/editor/uploadConstants'

// Design language borrowed from the editor: Space Grotesk headings, indigo
// accent, uppercase field labels, indigo focus rings. Shared class constants
// keep the three intake layouts (ai_video / carousel / default) consistent.
const HEADING_FONT = { fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.02em' } as const

const FIELD =
  'h-9 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder-gray-400 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500'

const FIELD_LABEL = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500'

const RUN_BUTTON = 'w-full bg-indigo-600 hover:bg-indigo-700 focus-visible:ring-indigo-500'

const TYPE_META: Record<ProjectType, { icon: ReactNode; eyebrow: string }> = {
  ai_video:    { icon: <Sparkles size={17} />,     eyebrow: 'AI Video' },
  carousel:    { icon: <Layers size={17} />,       eyebrow: 'Carousel' },
  music_video: { icon: <Music size={17} />,        eyebrow: 'Lyrics Video' },
  broll:       { icon: <Clapperboard size={17} />, eyebrow: 'B-roll' },
  editing:     { icon: <Film size={17} />,         eyebrow: 'Video Edit' },
}

/** Intake header: an indigo icon chip, the project-type eyebrow, and the
 *  workflow-specific description. Shared by all three intake layouts. */
function IntakeHeader({ projectType, description }: { projectType: ProjectType; description: string }) {
  const meta = TYPE_META[projectType] ?? TYPE_META.editing
  return (
    <div className="flex items-start gap-3.5">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 text-indigo-500 ring-1 ring-indigo-500/20 dark:text-indigo-400">
        {meta.icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-500 dark:text-indigo-400">
          {meta.eyebrow}
        </p>
        <h2 className="text-xl font-bold leading-tight text-gray-900 dark:text-white" style={HEADING_FONT}>
          New project
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </div>
  )
}

/** Name + optional profile row, shared by all three layouts. */
function NameProfileRow({
  name, setName, profile, setProfile, profiles,
}: {
  name: string
  setName: (v: string) => void
  profile: string
  setProfile: (v: string) => void
  profiles: { name: string; style_meta?: { username?: string } }[]
}) {
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Project name (optional)"
        className={`${FIELD} flex-1`}
      />
      {profiles.length > 0 && (
        <select
          value={profile}
          onChange={e => setProfile(e.target.value)}
          className={`${FIELD} px-2 text-gray-700 dark:text-gray-300`}
        >
          <option value="">No profile</option>
          {profiles.map(p => (
            <option key={p.name} value={p.name}>
              {p.style_meta?.username ?? p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

export default function UploadView() {
  const {
    name, setName, prompt, setPrompt, workflow, setWorkflow, profile, setProfile,
    workflows, profiles, clipData, setClipData, aiVideoData, setAiVideoData,
    lyricsData, setLyricsData, carouselAssets, setCarouselAssets,
    aiVideoAssets, setAiVideoAssets, voiceover, setVoiceover,
    carouselAspect, setCarouselAspect, aspectRatio, setAspectRatio,
    targetDuration, setTargetDuration, error, setError, runError, running,
    projectType, loadingTitle, loadingMessage, loadingSlowHint,
    promptPlaceholder, headerDescription, submitLabel, handleRun,
  } = useUploadForm()

  // --- AI Video: single-column centered layout ---
  if (projectType === 'ai_video') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6 md:p-8 flex flex-col gap-6">
          <IntakeHeader projectType={projectType} description={headerDescription} />

          <NameProfileRow name={name} setName={setName} profile={profile} setProfile={setProfile} profiles={profiles} />

          {/* Prompt */}
          <div>
            <p className={FIELD_LABEL}>Prompt</p>
            <Textarea
              className="min-h-[120px] resize-none focus:ring-indigo-500"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
            />
          </div>

          {/* Aspect ratio + Duration row */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <p className={FIELD_LABEL}>Aspect ratio</p>
              <div className="flex gap-1.5">
                {ASPECT_RATIOS.map(r => (
                  <button
                    key={r}
                    onClick={() => setAspectRatio(r)}
                    className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                      aspectRatio === r
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600'
                    }`}
                  >
                    <AspectRatioIcon ratio={r} className={aspectRatio === r ? 'text-indigo-500 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'} />
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-36">
              <p className={FIELD_LABEL}>Duration (optional)</p>
              <input
                type="number"
                step="1"
                min="1"
                value={targetDuration ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setTargetDuration(v ? parseInt(v, 10) : null)
                }}
                placeholder="seconds"
                className={`${FIELD} w-full`}
              />
            </div>
          </div>

          {/* Image + Style references */}
          <AIVideoUploadFields data={aiVideoData} onChange={setAiVideoData} onError={setError} />

          {/* Assets — extra images the agent can pull in (logos, graphics, etc). */}
          <div>
            <p className={FIELD_LABEL}>Assets</p>
            <div className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 h-48 overflow-hidden flex flex-col">
              <AssetsPanel
                assets={aiVideoAssets}
                onChange={async next => { setAiVideoAssets(next) }}
                profileName={profile || undefined}
              />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {runError && <p className="text-xs text-red-400">{runError}</p>}

          {/* Workflow (typically only one ai_video workflow, but keep selectable) */}
          {workflows.length > 1 && (
            <div>
              <p className={FIELD_LABEL}>Workflow</p>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className={`${FIELD} w-full px-2`}
              >
                {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className={RUN_BUTTON}
          >
            {submitLabel}
          </Button>
        </div>
        <LoadingModal
          open={running}
          title={loadingTitle}
          message={loadingMessage}
          slowHint={loadingSlowHint}
        />
      </div>
    )
  }

  // --- Carousel: single-column centered layout ---
  if (projectType === 'carousel') {
    const aspectLabels: Record<CarouselAspect, string> = {
      square:   'Square (1:1)',
      portrait: 'Portrait (4:5)',
      vertical: 'Vertical (9:16)',
    }
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6 md:p-8 flex flex-col gap-6">
          <IntakeHeader projectType={projectType} description={headerDescription} />

          <NameProfileRow name={name} setName={setName} profile={profile} setProfile={setProfile} profiles={profiles} />

          {/* Prompt */}
          <div>
            <p className={FIELD_LABEL}>Prompt</p>
            <Textarea
              className="min-h-[120px] resize-none focus:ring-indigo-500"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
            />
          </div>

          {/* Aspect ratio picker */}
          <div>
            <p className={FIELD_LABEL}>Aspect ratio</p>
            <div className="flex gap-2">
              {CAROUSEL_ASPECTS.map(a => (
                <button
                  key={a}
                  onClick={() => setCarouselAspect(a)}
                  className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
                    carouselAspect === a
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                      : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600'
                  }`}
                >
                  <CarouselAspectIcon
                    aspect={a}
                    className={carouselAspect === a ? 'text-indigo-500 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'}
                  />
                  {aspectLabels[a]}
                </button>
              ))}
            </div>
          </div>

          {/* Assets — reference images the agent can use as backgrounds or pull from. */}
          <div>
            <p className={FIELD_LABEL}>Assets</p>
            <div className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 h-48 overflow-hidden flex flex-col">
              <AssetsPanel
                assets={carouselAssets}
                onChange={async next => { setCarouselAssets(next) }}
                profileName={profile || undefined}
              />
            </div>
          </div>

          {/* Workflow (only shown when more than one carousel workflow exists) */}
          {workflows.length > 1 && (
            <div>
              <p className={FIELD_LABEL}>Workflow</p>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className={`${FIELD} w-full px-2`}
              >
                {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}

          {runError && <p className="text-xs text-red-400">{runError}</p>}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className={RUN_BUTTON}
          >
            {submitLabel}
          </Button>
        </div>
        <LoadingModal
          open={running}
          title={loadingTitle}
          message={loadingMessage}
          slowHint={loadingSlowHint}
        />
      </div>
    )
  }

  // --- Default two-column layout (editing, music_video, broll) ---
  return (
    <div className="flex h-full">
      {/* Left column */}
      <div className="flex-1 overflow-y-auto p-6 md:p-8 border-r border-gray-200 dark:border-gray-800 flex flex-col gap-6">
        <IntakeHeader projectType={projectType} description={headerDescription} />

        <NameProfileRow name={name} setName={setName} profile={profile} setProfile={setProfile} profiles={profiles} />

        {projectType === 'music_video' ? (
          <LyricsUploadFields data={lyricsData} onChange={setLyricsData} onError={setError} />
        ) : projectType === 'broll' ? (
          <BrollUploadFields
            clips={clipData.clips} setClips={clips => setClipData({ ...clipData, clips })}
            assets={clipData.assets} setAssets={assets => setClipData({ ...clipData, assets })}
            voiceover={voiceover} setVoiceover={setVoiceover}
            onError={setError}
          />
        ) : (
          <ClipUploadFields data={clipData} onChange={setClipData} onError={setError} profileName={profile || undefined} />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Right column: prompt + workflow + run */}
      <div className="w-80 flex flex-col p-6 md:p-8 gap-4">
        <div>
          <p className={FIELD_LABEL}>Prompt</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">Describe what you want the agent to do.</p>
        </div>

        <Textarea
          className="flex-1 resize-none focus:ring-indigo-500"
          placeholder={promptPlaceholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
        />

        <div className="flex flex-col gap-3">
          <div>
            <p className={FIELD_LABEL}>Workflow</p>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className={`${FIELD} w-full px-2`}
            >
              {workflows.length > 0
                ? workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)
                : <option value="clean_cut">clean_cut</option>}
            </select>
          </div>

          {runError && <p className="text-xs text-red-400">{runError}</p>}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className={RUN_BUTTON}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
      <LoadingModal
        open={running}
        title={loadingTitle}
        message={loadingMessage}
        slowHint={loadingSlowHint}
      />
    </div>
  )
}

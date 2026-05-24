import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { LoadingModal } from '@/components/ui/loading-modal'
import { ASPECT_RATIOS } from '@/lib/types/kling'
import { CAROUSEL_ASPECTS, type CarouselAspect } from '@/lib/types/carousel'
import { ClipUploadFields } from '@/components/upload/ClipUploadFields'
import { LyricsUploadFields } from '@/components/upload/LyricsUploadFields'
import { AIVideoUploadFields } from '@/components/upload/AIVideoUploadFields'
import AssetsPanel from '@/components/AssetsPanel'
import { useUploadForm } from '@/lib/useUploadForm'
import { AspectRatioIcon, CarouselAspectIcon } from '@/app/editor/uploadConstants'

export default function UploadView() {
  const {
    name, setName, prompt, setPrompt, workflow, setWorkflow, profile, setProfile,
    workflows, profiles, clipData, setClipData, aiVideoData, setAiVideoData,
    lyricsData, setLyricsData, carouselAssets, setCarouselAssets,
    carouselAspect, setCarouselAspect, aspectRatio, setAspectRatio,
    targetDuration, setTargetDuration, error, setError, runError, running,
    projectType, loadingTitle, loadingMessage, loadingSlowHint,
    promptPlaceholder, headerDescription, submitLabel, handleRun,
  } = useUploadForm()

  // --- AI Video: single-column centered layout ---
  if (projectType === 'ai_video') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
            <p className="text-sm text-gray-500">{headerDescription}</p>
          </div>

          {/* Name + Profile + Workflow */}
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Project name (optional)"
              className="flex-1 h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {profiles.length > 0 && (
              <select
                value={profile}
                onChange={e => setProfile(e.target.value)}
                className="h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          {/* Prompt */}
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Prompt</p>
            <Textarea
              className="min-h-[120px] resize-none"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
            />
          </div>

          {/* Aspect ratio + Duration row */}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <p className="text-xs text-gray-500 mb-1.5">Aspect ratio</p>
              <div className="flex gap-1">
                {ASPECT_RATIOS.map(r => (
                  <button
                    key={r}
                    onClick={() => setAspectRatio(r)}
                    className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm transition-colors ${
                      aspectRatio === r
                        ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600'
                    }`}
                  >
                    <AspectRatioIcon ratio={r} className={aspectRatio === r ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'} />
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-36">
              <p className="text-xs text-gray-500 mb-1.5">Duration (optional)</p>
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
                className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Image + Style references */}
          <AIVideoUploadFields data={aiVideoData} onChange={setAiVideoData} onError={setError} />

          {error && <p className="text-xs text-red-400">{error}</p>}
          {runError && <p className="text-xs text-red-400">{runError}</p>}

          {/* Workflow (typically only one ai_video workflow, but keep selectable) */}
          {workflows.length > 1 && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className="w-full"
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
        <div className="max-w-2xl mx-auto p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
            <p className="text-sm text-gray-500">{headerDescription}</p>
          </div>

          {/* Name + Profile */}
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Project name (optional)"
              className="flex-1 h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {profiles.length > 0 && (
              <select
                value={profile}
                onChange={e => setProfile(e.target.value)}
                className="h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          {/* Prompt */}
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Prompt</p>
            <Textarea
              className="min-h-[120px] resize-none"
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
            />
          </div>

          {/* Aspect ratio picker */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Aspect ratio</p>
            <div className="flex gap-2">
              {CAROUSEL_ASPECTS.map(a => (
                <button
                  key={a}
                  onClick={() => setCarouselAspect(a)}
                  className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm transition-colors ${
                    carouselAspect === a
                      ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                      : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-600'
                  }`}
                >
                  <CarouselAspectIcon
                    aspect={a}
                    className={carouselAspect === a ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'}
                  />
                  {aspectLabels[a]}
                </button>
              ))}
            </div>
          </div>

          {/* Assets — reference images the agent can use as backgrounds or pull from. */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Assets</p>
            <div className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 h-48 overflow-hidden flex flex-col">
              <AssetsPanel
                assets={carouselAssets}
                onChange={async next => { setCarouselAssets(next) }}
              />
            </div>
          </div>

          {/* Workflow (only shown when more than one carousel workflow exists) */}
          {workflows.length > 1 && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
              <select
                value={workflow}
                onChange={(e) => setWorkflow(e.target.value)}
                className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </div>
          )}

          {runError && <p className="text-xs text-red-400">{runError}</p>}

          <Button
            onClick={handleRun}
            disabled={running || !prompt.trim()}
            className="w-full"
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

  // --- Default two-column layout (editing, music_video) ---
  return (
    <div className="flex h-full">
      {/* Left column */}
      <div className="flex-1 overflow-y-auto p-6 border-r border-gray-200 dark:border-gray-800 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">New project</h2>
          <p className="text-sm text-gray-500">{headerDescription}</p>
        </div>

        {/* Name + Profile */}
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Project name (optional)"
            className="flex-1 h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {profiles.length > 0 && (
            <select
              value={profile}
              onChange={e => setProfile(e.target.value)}
              className="h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

        {projectType === 'music_video' ? (
          <LyricsUploadFields data={lyricsData} onChange={setLyricsData} onError={setError} />
        ) : (
          <ClipUploadFields data={clipData} onChange={setClipData} onError={setError} />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Right column: prompt + workflow + run */}
      <div className="w-80 flex flex-col p-6 gap-4">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Prompt</p>
          <p className="text-xs text-gray-500">Describe what you want the agent to do.</p>
        </div>

        <Textarea
          className="flex-1 resize-none"
          placeholder={promptPlaceholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun() }}
        />

        <div className="flex flex-col gap-2">
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              className="w-full h-9 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            className="w-full"
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

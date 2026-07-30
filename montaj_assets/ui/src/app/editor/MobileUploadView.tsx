import { useNavigate } from 'react-router-dom'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { LoadingModal } from '@/components/ui/loading-modal'
import { ASPECT_RATIOS } from '@/lib/types/kling'
import { CAROUSEL_ASPECTS } from '@/lib/types/carousel'
import AssetsPanel from '@/components/AssetsPanel'
import { AIVideoUploadFields } from '@/components/upload/AIVideoUploadFields'
import { ClipUploadFields } from '@/components/upload/ClipUploadFields'
import { LyricsUploadFields } from '@/components/upload/LyricsUploadFields'
import BrollUploadFields from '@/components/upload/BrollUploadFields'
import { AspectRatioIcon, CarouselAspectIcon } from '@/app/editor/uploadConstants'
import { useUploadForm } from '@/lib/useUploadForm'

export default function MobileUploadView() {
  const navigate = useNavigate()
  const form = useUploadForm()
  const {
    name, setName, prompt, setPrompt, workflow, setWorkflow, profile, setProfile,
    workflows, profiles, clipData, setClipData, aiVideoData, setAiVideoData,
    lyricsData, setLyricsData, carouselAssets, setCarouselAssets,
    aiVideoAssets, setAiVideoAssets, voiceover, setVoiceover,
    carouselAspect, setCarouselAspect, aspectRatio, setAspectRatio,
    targetDuration, setTargetDuration, error, setError, runError, running,
    projectType, loadingTitle, loadingMessage, loadingSlowHint,
    promptPlaceholder, headerDescription, submitLabel, handleRun,
  } = form

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-gray-950">
      <div className="max-w-md mx-auto p-4 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/')} className="p-2 -ml-2 text-gray-500" aria-label="Back">
            &larr;
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">New project</h2>
            <p className="text-xs text-gray-500 truncate">{headerDescription}</p>
          </div>
        </div>

        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Project name (optional)"
          className="w-full h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm"
        />

        {profiles.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Profile</p>
            <select
              value={profile}
              onChange={e => setProfile(e.target.value)}
              className="w-full h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm"
            >
              <option value="">No profile</option>
              {profiles.map(p => (
                <option key={p.name} value={p.name}>
                  {p.style_meta?.username ?? p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Prompt</p>
          <Textarea
            className="min-h-[120px] resize-none"
            placeholder={promptPlaceholder}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
        </div>

        {/* Type-specific fields */}
        {projectType === 'ai_video' && (
          <>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Aspect ratio</p>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map(r => (
                  <button
                    key={r}
                    onClick={() => setAspectRatio(r)}
                    className={`flex items-center gap-1.5 h-10 px-3 rounded-md border text-sm ${
                      aspectRatio === r
                        ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    <AspectRatioIcon ratio={r} />
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Duration (optional, seconds)</p>
              <input
                type="number"
                step="1"
                min="1"
                value={targetDuration ?? ''}
                onChange={e => setTargetDuration(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm"
              />
            </div>
            <AIVideoUploadFields data={aiVideoData} onChange={setAiVideoData} onError={setError} />
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Assets</p>
              <div className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 h-48 overflow-hidden flex flex-col">
                <AssetsPanel
                  assets={aiVideoAssets}
                  onChange={async next => setAiVideoAssets(next)}
                  profileName={profile || undefined}
                />
              </div>
            </div>
          </>
        )}

        {projectType === 'carousel' && (
          <>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Aspect ratio</p>
              <div className="flex flex-wrap gap-1.5">
                {CAROUSEL_ASPECTS.map(a => (
                  <button
                    key={a}
                    onClick={() => setCarouselAspect(a)}
                    className={`flex items-center gap-1.5 h-10 px-3 rounded-md border text-sm ${
                      carouselAspect === a
                        ? 'border-blue-500 bg-blue-500/10 text-blue-500'
                        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    <CarouselAspectIcon aspect={a} />
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Assets</p>
              <div className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 h-48 overflow-hidden flex flex-col">
                <AssetsPanel
                  assets={carouselAssets}
                  onChange={async next => setCarouselAssets(next)}
                  profileName={profile || undefined}
                />
              </div>
            </div>
          </>
        )}

        {projectType === 'music_video' && (
          <LyricsUploadFields data={lyricsData} onChange={setLyricsData} onError={setError} />
        )}

        {projectType === 'editing' && (
          <ClipUploadFields data={clipData} onChange={setClipData} onError={setError} profileName={profile || undefined} />
        )}

        {projectType === 'broll' && (
          <BrollUploadFields
            clips={clipData.clips} setClips={clips => setClipData({ ...clipData, clips })}
            assets={clipData.assets} setAssets={assets => setClipData({ ...clipData, assets })}
            voiceover={voiceover} setVoiceover={setVoiceover}
            onError={setError}
          />
        )}

        {workflows.length > 1 && (
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Workflow</p>
            <select
              value={workflow}
              onChange={e => setWorkflow(e.target.value)}
              className="w-full h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm"
            >
              {workflows.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {runError && <p className="text-xs text-red-400">{runError}</p>}

        <Button onClick={handleRun} disabled={running || !prompt.trim()} className="w-full h-11 text-base">
          {submitLabel}
        </Button>
      </div>

      <LoadingModal open={running} title={loadingTitle} message={loadingMessage} slowHint={loadingSlowHint} />
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MobileProjectHeader from '@/components/MobileProjectHeader'
import { SlideCanvas } from '@bycrux/editor'
import MobileCarouselRenderModal from '@/components/MobileCarouselRenderModal'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

const MOBILE_SLIDE_WIDTH = 320

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
}

export default function MobileCarouselPreview({ project, onProjectChange }: Props) {
  const [renderOpen, setRenderOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()

  const slides = project.slides ?? []
  const [w, h] = project.settings.resolution
  const scale = MOBILE_SLIDE_WIDTH / w

  async function handleRender() {
    setSaving(true)
    try {
      const final = { ...project, status: 'final' as const }
      await api.saveProject(project.id, final)
      onProjectChange(final)
      setRenderOpen(true)
    } catch (e) {
      alert(`Failed to save project: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950">
      <MobileProjectHeader project={project} onProjectChange={onProjectChange} />

      <div className="shrink-0 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50">
        <p className="text-xs text-amber-800 dark:text-amber-300 text-center">
          Open on desktop to edit slides. You can render from here.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {slides.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-12">No slides yet</div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            {slides.map((slide, i) => (
              <div key={slide.id} className="flex flex-col items-center gap-1">
                <SlideCanvas slide={slide} width={w} height={h} interactive={false} scale={scale} />
                <p className="text-xs text-gray-500">Slide {i + 1}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 p-3 border-t border-gray-200 dark:border-gray-800">
        <Button onClick={handleRender} disabled={saving || slides.length === 0 || project.status === 'pending'} className="w-full h-11 text-base">
          {saving ? 'Saving…' : project.status === 'pending' ? 'Project still processing…' : 'Render →'}
        </Button>
      </div>

      {renderOpen && (
        <MobileCarouselRenderModal
          projectId={project.id}
          slidesCount={slides.length}
          resolution={project.settings.resolution}
          onClose={() => { setRenderOpen(false); navigate('/') }}
          onCancel={() => setRenderOpen(false)}
        />
      )}
    </div>
  )
}

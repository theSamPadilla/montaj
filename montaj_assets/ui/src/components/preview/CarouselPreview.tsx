import type { Project } from '@/lib/types/schema'
import { SlideCanvas } from '@bycrux/editor'

interface Props {
  project: Project
}

export default function CarouselPreview({ project }: Props) {
  const slides = project.slides ?? []
  const [w, h] = project.settings.resolution
  const targetWidth = 240
  const scale = targetWidth / w

  return (
    <div className="grid grid-cols-3 gap-3 p-4 overflow-y-auto">
      {slides.map((slide, i) => (
        <div key={slide.id} className="flex flex-col items-center">
          <SlideCanvas
            slide={slide}
            width={w}
            height={h}
            interactive={false}
            scale={scale}
          />
          <div className="text-xs text-gray-500 mt-1">Slide {i + 1}</div>
        </div>
      ))}
      {slides.length === 0 && (
        <div className="col-span-3 text-center text-gray-600 text-sm py-8">
          No slides yet
        </div>
      )}
    </div>
  )
}

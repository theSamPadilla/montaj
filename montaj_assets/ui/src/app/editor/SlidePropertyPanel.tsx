import { useEffect, useState } from 'react'
import { api, type GlobalOverlay, type GlobalOverlayProp } from '@/lib/api'
import type { Project, Slide, CarouselElement, OverlayElement } from '@/lib/types/schema'
import { Button } from '@/components/ui/button'

function parseNumber(v: string): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface Props {
  project: Project
  slide?: Slide
  element?: CarouselElement
  onSlideChange: (patch: Partial<Slide>) => void
  onElementChange: (patch: Partial<CarouselElement>) => void
  onDeleteSlide: (id: string) => void
  onDuplicateSlide: (id: string) => void
  onDeleteElement: (slideId: string, elementId: string) => void
  onDuplicateElement: (slideId: string, elementId: string) => void
  onReorderElement: (slideId: string, elementId: string, direction: 'forward' | 'backward') => void
}

function numInput(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts?: { min?: number; max?: number; step?: number }
) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="number"
        value={value}
        min={opts?.min}
        max={opts?.max}
        step={opts?.step ?? 1}
        onChange={e => {
          const parsed = parseNumber(e.target.value)
          if (parsed !== null) onChange(parsed)
        }}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-gray-500 w-full"
      />
    </label>
  )
}

function PropEditor({
  prop,
  value,
  onChange,
}: {
  prop: GlobalOverlayProp
  value: unknown
  onChange: (v: unknown) => void
}) {
  const { name, type, description } = prop

  if (type === 'bool') {
    return (
      <label className="flex items-center gap-2 cursor-pointer" title={description}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={e => onChange(e.target.checked)}
          className="accent-blue-500"
        />
        <span className="text-xs text-gray-300">{name}</span>
      </label>
    )
  }

  if (type === 'color') {
    return (
      <label className="flex flex-col gap-0.5" title={description}>
        <span className="text-xs text-gray-500">{name}</span>
        <input
          type="color"
          value={String(value ?? '#000000')}
          onChange={e => onChange(e.target.value)}
          className="w-full h-7 bg-gray-800 border border-gray-700 rounded cursor-pointer"
        />
      </label>
    )
  }

  if (type === 'int' || type === 'float') {
    return (
      <label className="flex flex-col gap-0.5" title={description}>
        <span className="text-xs text-gray-500">{name}</span>
        <input
          type="number"
          value={Number(value ?? 0)}
          step={type === 'float' ? 0.1 : 1}
          onChange={e => {
            const parsed = parseNumber(e.target.value)
            if (parsed !== null) onChange(parsed)
          }}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-gray-500 w-full"
        />
      </label>
    )
  }

  // string fallback
  return (
    <label className="flex flex-col gap-0.5" title={description}>
      <span className="text-xs text-gray-500">{name}</span>
      <input
        type="text"
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-gray-500 w-full"
      />
    </label>
  )
}

export default function SlidePropertyPanel({
  project,
  slide,
  element,
  onSlideChange,
  onElementChange,
  onDeleteSlide,
  onDuplicateSlide,
  onDeleteElement,
  onDuplicateElement,
  onReorderElement,
}: Props) {
  // Map of jsxPath → GlobalOverlay for overlay prop schemas
  const [overlaySchemas, setOverlaySchemas] = useState<Map<string, GlobalOverlay>>(new Map())
  const [schemasLoading, setSchemasLoading] = useState(false)

  useEffect(() => {
    setSchemasLoading(true)
    const promises: Promise<GlobalOverlay[]>[] = [api.listGlobalOverlays()]
    if (project.profile) {
      promises.push(api.listProfileOverlays(project.profile))
    }
    Promise.all(promises)
      .then(results => {
        const map = new Map<string, GlobalOverlay>()
        for (const list of results) {
          for (const o of list) {
            map.set(o.jsxPath, o)
          }
        }
        setOverlaySchemas(map)
      })
      .catch(() => {})
      .finally(() => setSchemasLoading(false))
  }, [project.profile])

  if (!slide) {
    return (
      <div className="w-80 flex-shrink-0 flex items-center justify-center text-gray-600 text-xs p-4">
        Select a slide
      </div>
    )
  }

  const overlayEl = element?.type === 'overlay' ? (element as OverlayElement) : null
  const overlaySchema = overlayEl ? overlaySchemas.get(overlayEl.overlay.template) : null

  return (
    <div className="w-80 flex-shrink-0 border-l border-gray-800 flex flex-col overflow-y-auto bg-gray-950">
      {/* Slide header */}
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Slide</div>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">Background color</span>
            <input
              type="color"
              value={slide.base_color || '#ffffff'}
              onChange={e => onSlideChange({ base_color: e.target.value })}
              className="w-full h-7 bg-gray-800 border border-gray-700 rounded cursor-pointer"
            />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => onDuplicateSlide(slide.id)}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs text-red-400 hover:text-red-300"
              onClick={() => onDeleteSlide(slide.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Element section */}
      {element && (
        <div className="px-4 py-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {element.type === 'image' ? 'Image' : 'Overlay'}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => onReorderElement(slide.id, element.id, 'forward')}
                className="text-xs text-gray-500 hover:text-white px-1"
                title="Bring forward"
              >
                ↑
              </button>
              <button
                onClick={() => onReorderElement(slide.id, element.id, 'backward')}
                className="text-xs text-gray-500 hover:text-white px-1"
                title="Send backward"
              >
                ↓
              </button>
            </div>
          </div>

          {/* Transform */}
          <div className="grid grid-cols-2 gap-2">
            {numInput('X', element.x, v => onElementChange({ x: v }))}
            {numInput('Y', element.y, v => onElementChange({ y: v }))}
            {numInput('W', element.w, v => onElementChange({ w: v }), { min: 1 })}
            {numInput('H', element.h, v => onElementChange({ h: v }), { min: 1 })}
            {numInput('Rotation', element.rotation, v => onElementChange({ rotation: v }), { min: -360, max: 360 })}
          </div>

          {/* Image-specific */}
          {element.type === 'image' && (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-gray-500">Source</span>
              <span className="text-xs text-gray-300 truncate" title={element.src}>
                {element.src.split('/').pop() || element.src}
              </span>
            </div>
          )}

          {/* Overlay-specific */}
          {overlayEl && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {numInput('Frame', overlayEl.frame, v => onElementChange({ frame: v }), { min: 0 })}
              </div>

              {schemasLoading && (
                <div className="text-xs text-gray-500">Loading overlay props…</div>
              )}

              {!schemasLoading && overlaySchema && overlaySchema.props.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-gray-500 font-medium">Props</span>
                  {overlaySchema.props.map(prop => (
                    <PropEditor
                      key={prop.name}
                      prop={prop}
                      value={overlayEl.overlay.props[prop.name]}
                      onChange={v => {
                        onElementChange({
                          overlay: {
                            ...overlayEl.overlay,
                            props: { ...overlayEl.overlay.props, [prop.name]: v },
                          },
                        } as Partial<CarouselElement>)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Element actions */}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => onDuplicateElement(slide.id, element.id)}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs text-red-400 hover:text-red-300"
              onClick={() => onDeleteElement(slide.id, element.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

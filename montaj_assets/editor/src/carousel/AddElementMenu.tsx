import { useEffect, useRef, useState } from 'react'
import type { Project, CarouselElement, OverlayElement, EditorAdapter } from '../types'
import { Button } from '../ui'
import OverlayPicker from './OverlayPicker'
import { newImageElement } from './newImage'

interface Props {
  project: Project
  selectedSlideId: string | null
  adapter: EditorAdapter<Project>
  onAddElement: (slideId: string, element: CarouselElement) => void
  /** Editor theme mode — light/dark. Threaded to `OverlayPicker`, and used
   *  locally for the upload/text/generate error hues (red-400 is sub-AA on
   *  the light side panel). Absent -> dark, matching every existing
   *  caller. */
  mode?: 'light' | 'dark'
  /** Told when the overlay picker opens and when it closes (closing includes
   *  this menu unmounting with it open), so the editor can hold its keys. */
  onOverlayPickerOpenChange?: (open: boolean) => void
}

export default function AddElementMenu({ project, selectedSlideId, adapter, onAddElement, mode = 'dark', onOverlayPickerOpenChange }: Props) {
  const [showPrompt, setShowPrompt] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [showOverlayPicker, setShowOverlayPicker] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [addingText, setAddingText] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)

  const disabled = selectedSlideId === null

  useEffect(() => {
    if (!showOverlayPicker || !onOverlayPickerOpenChange) return
    onOverlayPickerOpenChange(true)
    return () => onOverlayPickerOpenChange(false)
  }, [showOverlayPicker, onOverlayPickerOpenChange])

  // Add a static-text overlay at parity with mission-control's "add text".
  // Resolves the host's default text overlay via the adapter (the package does
  // not know the host's overlay naming) and seeds the standard text contract
  // props from its declared defaults.
  async function handleAddText() {
    if (!selectedSlideId || !adapter.getDefaultTextOverlay) return
    setAddingText(true)
    setTextError(null)
    try {
      const tpl = await adapter.getDefaultTextOverlay()
      if (!tpl) throw new Error('static-text overlay template not found')
      const props: Record<string, unknown> = Object.fromEntries(
        tpl.props.filter(p => p.default !== undefined).map(p => [p.name, p.default]),
      )
      if (typeof props.text !== 'string') props.text = 'Your text here'
      const [fullW, fullH] = project.settings.resolution
      const elementW = Math.round(fullW * 0.7)
      const elementH = Math.round(fullH * 0.18)
      const element: OverlayElement = {
        id: crypto.randomUUID(),
        type: 'overlay',
        overlay: { template: tpl.jsxPath, props },
        frame: 0,
        x: Math.round(fullW / 2 - elementW / 2),
        y: Math.round(fullH / 2 - elementH / 2),
        w: elementW,
        h: elementH,
        rotation: 0,
      }
      onAddElement(selectedSlideId, element)
    } catch (e) {
      setTextError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingText(false)
    }
  }

  async function handleGenerate() {
    if (!selectedSlideId || !prompt.trim() || !adapter.generateImage) return
    setGenerating(true)
    setGenError(null)
    try {
      const result = await adapter.generateImage(prompt.trim(), project.id)
      // Shaped like the generated image, centred on the slide.
      const element = await newImageElement(adapter, project.settings.resolution, result.path)
      onAddElement(selectedSlideId, element)
      setShowPrompt(false)
      setPrompt('')
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !selectedSlideId) return
    setUploadError(null)
    try {
      // Shared upload (no projectId) — matches the pre-extraction carousel
      // behavior. The adapter stores it in a shared location, not project-local.
      // 'picker' says it was chosen in a file picker (the host's provenance only).
      const uploadedPath = await adapter.uploadFile(file, undefined, 'picker')
      // Shaped like the uploaded image, centred on the slide.
      const element = await newImageElement(adapter, project.settings.resolution, uploadedPath)
      onAddElement(selectedSlideId, element)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      // Reset so the same file can be re-picked
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {adapter.generateImage && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => { setShowPrompt(p => !p); setGenError(null) }}
            className="text-xs w-full justify-center whitespace-nowrap"
          >
            + AI Image
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="text-xs w-full justify-center whitespace-nowrap"
        >
          + Upload Image
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />
        {adapter.getDefaultTextOverlay && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || addingText}
            onClick={handleAddText}
            className="text-xs w-full justify-center whitespace-nowrap"
          >
            {addingText ? 'Adding…' : '+ Text'}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setShowOverlayPicker(true)}
          className="text-xs w-full justify-center whitespace-nowrap"
        >
          + Overlay
        </Button>
      </div>
      {uploadError && <div className={`text-xs ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{uploadError}</div>}
      {textError && <div className={`text-xs ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{textError}</div>}

      {showPrompt && !disabled && (
        <div className="flex flex-col gap-2 p-3 bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-lg">
          <textarea
            className="w-full bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded px-2 py-1.5 text-xs text-[var(--editor-text)] placeholder-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] resize-none focus:outline-none focus:border-[var(--editor-accent)]"
            rows={3}
            aria-label="Describe the image to generate"
            placeholder="Describe the image to generate…"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            disabled={generating}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate() }}
          />
          {genError && <div className={`text-xs ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{genError}</div>}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleGenerate} disabled={generating || !prompt.trim()} className="text-xs">
              {generating ? 'Generating…' : 'Generate'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setShowPrompt(false); setGenError(null) }} disabled={generating} className="text-xs">
              Cancel
            </Button>
          </div>
        </div>
      )}

      <OverlayPicker
        open={showOverlayPicker}
        onClose={() => setShowOverlayPicker(false)}
        project={project}
        adapter={adapter}
        onPick={element => {
          if (selectedSlideId) onAddElement(selectedSlideId, element)
        }}
        mode={mode}
      />
    </div>
  )
}

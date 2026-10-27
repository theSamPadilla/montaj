import { memo, type ComponentProps, type DragEvent, type RefObject } from 'react'
import type { EditorAdapter, OverlayFactory, Project, Slide, SlidePin, SlidePinDisplay } from '../types'
import SlideCanvas, { type InlineTextSession, type SlideCanvasCropControl, type TextRangeInfo } from './SlideCanvas'
import { NoteArmLayer, NotePinLayer } from './NoteLayers'
import type { StackSlideMode } from './StackedSlides'

// §587 M2 / decision 4: one slide of the rail layout's stack, memoised. Every
// prop is a plain value or stays the same object while its slide is unchanged
// (the reducer keeps unchanged slides, the editor passes constant empties to
// the slides that are not active), and the editor's handlers come through one
// stable ref, read at call time. So an edit on one slide renders that slide
// alone, not every canvas in the stack.

type CanvasProps = ComponentProps<typeof SlideCanvas>
type Req<K extends keyof CanvasProps> = NonNullable<CanvasProps[K]>

/** The editor's handlers, current as of its last render. */
export interface RailSlideHandlers {
  activateSlide: (slideId: string) => void
  applyCrop: () => void
  setSelectedElementId: (elementId: string | null) => void
  toggleSelect: (elementId: string) => void
  selectBand: (elementIds: string[]) => void
  moveElement: Req<'moveElement'>
  resizeElement: Req<'resizeElement'>
  rotateElement: Req<'rotateElement'>
  commit: Req<'commit'>
  updateOverlayProp: Req<'updateOverlayProp'>
  updateOverlayProps: Req<'updateOverlayProps'>
  textRange: (range: TextRangeInfo | null) => void
  updateImageCrop: Req<'updateImageCrop'>
  exitCrop: () => void
  enterCrop: (elementId: string, slideId?: string | null) => void
  unlockElement: (elementId: string) => void
  dragOver: (e: DragEvent<HTMLDivElement>, slideId: string) => void
  drop: (e: DragEvent<HTMLDivElement>, slideId: string) => void
  contextMenu: (slideId: string, info: Parameters<Req<'onContextMenu'>>[0]) => void
  placeArmedNote: (point?: { x: number; y: number }) => void
}

export interface RailSlideProps {
  slide: Slide
  width: number
  height: number
  scale: number
  margin: number
  mode: StackSlideMode
  active: boolean
  /** The active slide's selection; the others get the same empty values every render. */
  selectedElementId: string | null
  selectedElementIds: string[]
  cropElementId: string | null
  pins: Array<SlidePin & { x: number; y: number }> | undefined
  pinDisplay: SlidePinDisplay
  onPinClick: ((id: string) => void) | undefined
  armed: boolean
  hiddenElementIds: string[] | undefined
  resolveImageSrc: EditorAdapter<Project>['resolveImageSrc']
  compileOverlay: (template: string) => Promise<OverlayFactory>
  watchFile: EditorAdapter<Project>['watchFile']
  handlers: RefObject<RailSlideHandlers>
  cropControlRef: RefObject<SlideCanvasCropControl | null>
  /** The open inline text edit, shared by the stack (only the active slide edits). */
  textEditRef: { current: InlineTextSession | null }
  armLayerRef: RefObject<HTMLDivElement | null>
}

function RailSlide({
  slide, width, height, scale, margin, mode, active, selectedElementId, selectedElementIds, cropElementId,
  pins, pinDisplay, onPinClick, armed, hiddenElementIds, resolveImageSrc, compileOverlay, watchFile,
  handlers, cropControlRef, textEditRef, armLayerRef,
}: RailSlideProps) {
  const id = slide.id
  const h = () => handlers.current!
  const live = mode === 'live'
  const activate = () => h().activateSlide(id)

  if (mode === 'placeholder') {
    // Far from the view: the slide's colour at its size, so the stack keeps its
    // length and a scroll lands where it would. A click picks it, as on a thumbnail.
    return (
      <div className="ring-1 ring-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]" onClick={activate}>
        <div data-slide-placeholder="" style={{ width: width * scale, height: height * scale, backgroundColor: slide.base_color || '#ffffff' }} />
      </div>
    )
  }

  return (
    <div
      className="ring-1 ring-[color-mix(in_srgb,var(--editor-text)_10%,transparent)]"
      // A slide drawn as its thumbnail is picked by a click.
      onClick={live ? undefined : activate}
    >
      <SlideCanvas
        slide={slide}
        slideId={id}
        width={width}
        height={height}
        interactive={live}
        selectedElementId={selectedElementId}
        selectedElementIds={selectedElementIds}
        onSelect={active
          ? (elId) => { if (cropElementId && elId !== cropElementId) h().applyCrop(); h().setSelectedElementId(elId) }
          : (elId) => { activate(); if (elId) h().setSelectedElementId(elId) }}
        onToggleSelect={active ? (elId) => h().toggleSelect(elId) : (elId) => { activate(); h().toggleSelect(elId) }}
        onSelectMany={active ? (ids) => h().selectBand(ids) : (ids) => { activate(); h().selectBand(ids) }}
        scale={scale}
        pickList
        resolveImageSrc={resolveImageSrc}
        compileOverlay={compileOverlay}
        watchFile={watchFile}
        moveElement={(...a) => h().moveElement(...a)}
        resizeElement={(...a) => h().resizeElement(...a)}
        rotateElement={(...a) => h().rotateElement(...a)}
        commit={() => h().commit()}
        updateOverlayProp={(...a) => h().updateOverlayProp(...a)}
        updateOverlayProps={(...a) => h().updateOverlayProps(...a)}
        textEditRef={textEditRef}
        onTextRange={(range) => h().textRange(range)}
        updateImageCrop={(...a) => h().updateImageCrop(...a)}
        // Crop mode is the active slide's alone.
        cropElementId={cropElementId}
        onExitCrop={active ? () => h().exitCrop() : undefined}
        onEnterCrop={active ? (elId) => h().enterCrop(elId) : (elId) => { activate(); h().enterCrop(elId, id) }}
        onUnlock={(elId) => h().unlockElement(elId)}
        cropControlRef={active ? cropControlRef : undefined}
        hiddenElementIds={hiddenElementIds}
        onDragEnter={(e) => h().dragOver(e, id)}
        onDragOver={(e) => h().dragOver(e, id)}
        onDrop={(e) => h().drop(e, id)}
        margin={margin}
        onContextMenu={live ? (info) => h().contextMenu(id, info) : undefined}
      >
        {pins && <NotePinLayer pins={pins} pinDisplay={pinDisplay} onPinClick={onPinClick} />}
        {armed && <NoteArmLayer layerRef={armLayerRef} onPlace={(point) => h().placeArmedNote(point)} />}
      </SlideCanvas>
    </div>
  )
}

export default memo(RailSlide)

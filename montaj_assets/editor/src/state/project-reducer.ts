/**
 * editor-core / state / project-reducer — pure reducer over a carousel Project.
 *
 * Ported faithfully from mission-control's
 * `src/app/admin/projects/hooks/project-reducer.ts`, adapted to import the
 * canonical Project/Slide/CarouselElement/ImageElement/OverlayElement types
 * from editor-core (which re-exports Montaj's `lib/types/schema.ts`) rather
 * than from a hand-mirrored `montaj.ts`.
 *
 * All action types and snapshot semantics are preserved. The reducer is pure —
 * it never touches transport; persistence is the hook's job via the adapter.
 */
import type {
  Project,
  Slide,
  ImageElement,
  CarouselElement,
} from '../types'
import { deepEqual } from './deep-equal'

// The reducer/Action are generic over the host's concrete project type `P`,
// constrained to the editor-facing `Project` (= EditorProject) slice. A host can
// pass its full project (e.g. Montaj's `Project` with pipeline fields) and get
// the same concrete type back: every reducer branch spreads `state`, so host-
// only fields round-trip at both the type level and at runtime. The editor only
// ever reads/writes the editor-facing fields.

// Status values from the editor-facing schema. Duplicated as a value here so
// the hook can gate edits without importing the host's project types directly.
export type ProjectStatus = Project['status']

/** How `reorderElement` moves an element in the stacking order (index 0 is the
 *  back, the last index the front): one step, or all the way. */
export type ReorderDirection = 'forward' | 'backward' | 'front' | 'back'

// ---------------------------------------------------------------------------
// Action discriminated union
// ---------------------------------------------------------------------------

export type Action<P extends Project = Project> =
  | { type: 'sse'; project: P }
  | { type: 'updateOverlayProp'; slideId: string; elementId: string; key: string; value: string | number }
  | { type: 'setStatus'; status: ProjectStatus }
  | { type: 'setName'; name: string }
  | { type: 'rollback'; snapshot: P }
  | { type: 'moveElement'; slideId: string; elementId: string; x: number; y: number }
  | { type: 'resizeElement'; slideId: string; elementId: string; x: number; y: number; w: number; h: number }
  | { type: 'rotateElement'; slideId: string; elementId: string; rotation: number }
  | { type: 'addElement'; slideId: string; element: CarouselElement }
  | { type: 'removeElement'; slideId: string; elementId: string }
  | { type: 'updateImageCrop'; slideId: string; elementId: string; crop: ImageElement['crop'] }
  // A new source in the same box (§556 M5): sets `src` and `crop` (absent when
  // `crop` is undefined), drops `mediaId`; x, y, w, h and rotation stay.
  | { type: 'replaceImage'; slideId: string; elementId: string; src: string; crop: ImageElement['crop'] }
  // Slide-level structural actions. Added for the Montaj-native editor, which —
  // unlike mission-control's element-only inspector — owns full slide CRUD.
  | { type: 'addSlide'; slide: Slide; afterSlideId?: string }
  | { type: 'removeSlide'; slideId: string }
  | { type: 'duplicateSlide'; slideId: string; newSlide: Slide }
  | { type: 'reorderSlides'; fromIndex: number; toIndex: number }
  | { type: 'updateSlide'; slideId: string; patch: Partial<Slide> }
  // One slide's elements edited as a whole (§556 review): `edit` is given the
  // elements the state holds WHEN THE ACTION IS APPLIED, so a write built from
  // an older view (a key read the render before it, an upload that took time)
  // cannot drop an element that arrived since. The same array back changes nothing.
  | { type: 'editElements'; slideId: string; edit: (elements: CarouselElement[]) => CarouselElement[] }
  // Every slide edited as a whole (§587 M5: "change this colour on every slide"
  // is one mutation, so one undo step). Same rule as `editElements`: `edit` is
  // given the slides the state holds when applied; the same array back changes nothing.
  | { type: 'editSlides'; edit: (slides: Slide[]) => Slide[] }
  // Element structural actions the editor needs beyond add/remove.
  | { type: 'duplicateElement'; slideId: string; elementId: string; newElement: CarouselElement }
  | { type: 'reorderElement'; slideId: string; elementId: string; direction: ReorderDirection }
  | { type: 'setOverlayFrame'; slideId: string; elementId: string; frame: number }
  // The user's own notes (PL70). Replaces `project.notes` wholesale; `null` is
  // the explicit clear serve needs. Never edit-gated (see use-project-state).
  | { type: 'setNotes'; notes: P['notes'] }

// ---------------------------------------------------------------------------
// SSE merge helpers
// ---------------------------------------------------------------------------

// Structural equality (`./deep-equal`) decides whether to reuse a previous
// reference in the SSE merge.

function mergeElement(prev: CarouselElement, next: CarouselElement): CarouselElement {
  return deepEqual(prev, next) ? prev : next
}

function mergeSlide(prev: Slide, next: Slide): Slide {
  if (deepEqual(prev, next)) return prev
  const prevElsById = new Map(prev.elements.map((e) => [e.id, e]))
  let elementsChanged = next.elements.length !== prev.elements.length
  const mergedElements = next.elements.map((nextEl, i): CarouselElement => {
    const prevEl = prevElsById.get(nextEl.id)
    if (!prevEl) { elementsChanged = true; return nextEl }
    const merged = mergeElement(prevEl, nextEl)
    if (merged !== prev.elements[i]) elementsChanged = true
    return merged
  })
  return {
    ...next,
    elements: elementsChanged ? mergedElements : prev.elements,
  }
}

function mergeProject<P extends Project>(prev: P, next: P): P {
  if (prev === next || deepEqual(prev, next)) return prev
  const prevSlides = prev.slides ?? []
  const nextSlides = next.slides ?? []
  const prevSlidesById = new Map(prevSlides.map((s) => [s.id, s]))
  let slidesChanged = nextSlides.length !== prevSlides.length
  const mergedSlides = nextSlides.map((nextSlide, i): Slide => {
    const prevSlide = prevSlidesById.get(nextSlide.id)
    if (!prevSlide) { slidesChanged = true; return nextSlide }
    const merged = mergeSlide(prevSlide, nextSlide)
    if (merged !== prevSlides[i]) slidesChanged = true
    return merged
  })
  return {
    ...next,
    slides: slidesChanged ? mergedSlides : prevSlides,
  }
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function projectReducer<P extends Project>(state: P, action: Action<P>): P {
  switch (action.type) {
    case 'sse':
      return mergeProject(state, action.project)

    case 'updateOverlayProp': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          if (el.type !== 'overlay') return el
          return {
            ...el,
            overlay: {
              ...el.overlay,
              props: {
                ...el.overlay.props,
                [action.key]: action.value,
              },
            },
          }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'setStatus':
      return { ...state, status: action.status }

    case 'setName':
      return { ...state, name: action.name }

    case 'rollback':
      return action.snapshot

    case 'moveElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          return { ...el, x: action.x, y: action.y }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'resizeElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          return { ...el, x: action.x, y: action.y, w: action.w, h: action.h }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'rotateElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          return { ...el, rotation: action.rotation }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'addElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        return { ...slide, elements: [...slide.elements, action.element] }
      })
      return { ...state, slides }
    }

    case 'removeElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        return { ...slide, elements: slide.elements.filter((el) => el.id !== action.elementId) }
      })
      return { ...state, slides }
    }

    case 'updateImageCrop': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          if (el.type !== 'image') return el
          return { ...el, crop: action.crop }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'replaceImage': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          if (el.type !== 'image') return el
          // The old crop and `mediaId` described the old file: neither is kept.
          const { crop: _crop, mediaId: _mediaId, ...kept } = el
          return action.crop
            ? { ...kept, src: action.src, crop: action.crop }
            : { ...kept, src: action.src }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'addSlide': {
      const slides = [...(state.slides ?? [])]
      if (action.afterSlideId) {
        const idx = slides.findIndex((s) => s.id === action.afterSlideId)
        if (idx >= 0) slides.splice(idx + 1, 0, action.slide)
        else slides.push(action.slide)
      } else {
        slides.push(action.slide)
      }
      return { ...state, slides }
    }

    case 'removeSlide': {
      const slides = (state.slides ?? []).filter((s) => s.id !== action.slideId)
      return { ...state, slides }
    }

    case 'duplicateSlide': {
      const slides = [...(state.slides ?? [])]
      const idx = slides.findIndex((s) => s.id === action.slideId)
      if (idx < 0) return state
      slides.splice(idx + 1, 0, action.newSlide)
      return { ...state, slides }
    }

    case 'reorderSlides': {
      const slides = [...(state.slides ?? [])]
      if (
        action.fromIndex < 0 || action.fromIndex >= slides.length ||
        action.toIndex < 0 || action.toIndex >= slides.length
      ) {
        return state
      }
      const [moved] = slides.splice(action.fromIndex, 1)
      slides.splice(action.toIndex, 0, moved)
      return { ...state, slides }
    }

    case 'updateSlide': {
      const slides = (state.slides ?? []).map((slide): Slide =>
        slide.id === action.slideId ? { ...slide, ...action.patch } : slide,
      )
      return { ...state, slides }
    }

    case 'editElements': {
      const slide = (state.slides ?? []).find((s) => s.id === action.slideId)
      if (!slide) return state
      const elements = action.edit(slide.elements)
      if (elements === slide.elements) return state
      const slides = (state.slides ?? []).map((s): Slide => (s.id === action.slideId ? { ...s, elements } : s))
      return { ...state, slides }
    }

    case 'editSlides': {
      const current = state.slides ?? []
      const slides = action.edit(current)
      if (slides === current) return state
      return { ...state, slides }
    }

    case 'duplicateElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const idx = slide.elements.findIndex((el) => el.id === action.elementId)
        if (idx < 0) return slide
        const elements = [
          ...slide.elements.slice(0, idx + 1),
          action.newElement,
          ...slide.elements.slice(idx + 1),
        ]
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'reorderElement': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = [...slide.elements]
        const idx = elements.findIndex((el) => el.id === action.elementId)
        if (idx < 0) return slide
        if (action.direction === 'front' || action.direction === 'back') {
          // All the way: to the end or the start, the others keeping their order.
          const to = action.direction === 'front' ? elements.length - 1 : 0
          if (idx === to) return slide
          const [moved] = elements.splice(idx, 1)
          elements.splice(to, 0, moved)
          return { ...slide, elements }
        }
        const swapIdx = action.direction === 'forward' ? idx + 1 : idx - 1
        if (swapIdx < 0 || swapIdx >= elements.length) return slide
        ;[elements[idx], elements[swapIdx]] = [elements[swapIdx], elements[idx]]
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'setOverlayFrame': {
      const slides = (state.slides ?? []).map((slide): Slide => {
        if (slide.id !== action.slideId) return slide
        const elements = slide.elements.map((el): CarouselElement => {
          if (el.id !== action.elementId) return el
          if (el.type !== 'overlay') return el
          return { ...el, frame: action.frame }
        })
        return { ...slide, elements }
      })
      return { ...state, slides }
    }

    case 'setNotes':
      return { ...state, notes: action.notes }
  }
}

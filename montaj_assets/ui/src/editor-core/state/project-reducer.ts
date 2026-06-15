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

// Status values from Montaj's canonical schema. Duplicated as a value here so
// the hook can gate edits without importing project.ts directly.
export type ProjectStatus = Project['status']

// ---------------------------------------------------------------------------
// Action discriminated union
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'sse'; project: Project }
  | { type: 'updateOverlayProp'; slideId: string; elementId: string; key: string; value: string }
  | { type: 'setStatus'; status: ProjectStatus }
  | { type: 'setName'; name: string }
  | { type: 'rollback'; snapshot: Project }
  | { type: 'moveElement'; slideId: string; elementId: string; x: number; y: number }
  | { type: 'resizeElement'; slideId: string; elementId: string; x: number; y: number; w: number; h: number }
  | { type: 'rotateElement'; slideId: string; elementId: string; rotation: number }
  | { type: 'addElement'; slideId: string; element: CarouselElement }
  | { type: 'removeElement'; slideId: string; elementId: string }
  | { type: 'updateImageCrop'; slideId: string; elementId: string; crop: ImageElement['crop'] }
  // Slide-level structural actions. Added for the Montaj-native editor, which —
  // unlike mission-control's element-only inspector — owns full slide CRUD.
  | { type: 'addSlide'; slide: Slide; afterSlideId?: string }
  | { type: 'removeSlide'; slideId: string }
  | { type: 'duplicateSlide'; slideId: string; newSlide: Slide }
  | { type: 'reorderSlides'; fromIndex: number; toIndex: number }
  | { type: 'updateSlide'; slideId: string; patch: Partial<Slide> }
  // Element structural actions the editor needs beyond add/remove.
  | { type: 'duplicateElement'; slideId: string; elementId: string; newElement: CarouselElement }
  | { type: 'reorderElement'; slideId: string; elementId: string; direction: 'forward' | 'backward' }
  | { type: 'setOverlayFrame'; slideId: string; elementId: string; frame: number }

// ---------------------------------------------------------------------------
// SSE merge helpers
// ---------------------------------------------------------------------------

// Structural equality. Used to decide whether to reuse a previous reference
// in the SSE merge. Tree shape (project.json) is small, no cycles, no
// special types — a recursive walk is fine and short-circuits early on mismatch.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  // Compare objects treating `undefined`-valued properties as absent. Required
  // because the reducer writes `{...el, crop: undefined}` to clear a field,
  // but the SSE echo round-trip serialises through Montaj's `json.dumps`,
  // which drops undefined-valued keys. Without this normalisation, the
  // identity short-circuit in mergeProject silently misses on every echo
  // following an image resize.
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set<string>()
  for (const k of Object.keys(ao)) if (ao[k] !== undefined) keys.add(k)
  for (const k of Object.keys(bo)) if (bo[k] !== undefined) keys.add(k)
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

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

function mergeProject(prev: Project, next: Project): Project {
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

export function projectReducer(state: Project, action: Action): Project {
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
  }
}

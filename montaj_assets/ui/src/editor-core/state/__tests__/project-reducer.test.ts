import { describe, it, expect } from 'vitest'
import { projectReducer } from '../project-reducer'
import { createMutationQueue } from '../mutation-queue'
import type { Project, Slide, CarouselElement, OverlayElement, ImageElement } from '../../types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
//
// Ported from mission-control's project-reducer.test.ts. The fixture is
// adapted to Montaj's canonical `Project` shape (schema.ts) — which requires
// `version` and `assets` in addition to MC's subset. The carousel slide /
// element shapes are identical, so the body of every assertion is unchanged.

function makeProject(overrides: Partial<Project> = {}): Project {
  const slides: Slide[] = [
    {
      id: 'slide-0',
      base_color: '#ffffff',
      elements: [
        {
          id: 'el-0-0',
          type: 'image',
          src: 'https://example.com/img0.png',
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          rotation: 0,
        },
        {
          id: 'el-0-1',
          type: 'overlay',
          overlay: { template: 'tpl-a', props: { text: 'hello', color: 'red' } },
          frame: 0,
          x: 10,
          y: 10,
          w: 80,
          h: 40,
          rotation: 0,
        },
      ] as CarouselElement[],
    },
    {
      id: 'slide-1',
      base_color: '#000000',
      elements: [
        {
          id: 'el-1-0',
          type: 'overlay',
          overlay: { template: 'tpl-b', props: { text: 'world', size: '24px' } },
          frame: 1,
          x: 0,
          y: 0,
          w: 200,
          h: 50,
          rotation: 45,
        },
        {
          id: 'el-1-1',
          type: 'image',
          src: 'https://example.com/img1.png',
          x: 5,
          y: 5,
          w: 50,
          h: 50,
          rotation: 10,
        },
      ] as CarouselElement[],
    },
  ]

  return {
    version: '1',
    id: 'proj-1',
    name: 'Test Project',
    workflow: 'carousel',
    status: 'pending',
    editingPrompt: 'make it pop',
    settings: { resolution: [1080, 1080] },
    assets: [],
    slides,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectReducer', () => {
  it('1. SSE applies the new project data', () => {
    const prev = makeProject()
    const next = makeProject({ id: 'proj-2', name: 'Replaced', status: 'draft' })

    const result = projectReducer(prev, { type: 'sse', project: next })

    // Scalar fields reflect `next`. Identity is no longer guaranteed —
    // the reducer now runs a reference-preserving structural merge, so the
    // returned object may be a new wrapper that reuses unchanged sub-refs.
    expect(result.id).toBe('proj-2')
    expect(result.name).toBe('Replaced')
    expect(result.status).toBe('draft')
  })

  it('2. updateOverlayProp patches the right path', () => {
    const prev = makeProject()

    // Target: slide[1].element[0] (el-1-0, the overlay), prop "text"
    const result = projectReducer(prev, {
      type: 'updateOverlayProp',
      slideId: 'slide-1',
      elementId: 'el-1-0',
      key: 'text',
      value: 'updated',
    })

    // New top-level ref
    expect(result).not.toBe(prev)

    const prevSlide1 = prev.slides![1]
    const resultSlide1 = result.slides![1]

    // New slide ref for the changed slide
    expect(resultSlide1).not.toBe(prevSlide1)

    // New element ref
    const prevEl = prevSlide1.elements[0] as OverlayElement
    const resultEl = resultSlide1.elements[0] as OverlayElement
    expect(resultEl).not.toBe(prevEl)

    // Prop updated
    expect(resultEl.overlay.props['text']).toBe('updated')

    // Other props on the same overlay untouched
    expect(resultEl.overlay.props['size']).toBe('24px')

    // Sibling element in slide-1 untouched (same ref)
    expect(resultSlide1.elements[1]).toBe(prevSlide1.elements[1])

    // slide-0 untouched (same ref)
    expect(result.slides![0]).toBe(prev.slides![0])
  })

  it('4. setStatus updates only status', () => {
    const prev = makeProject()
    const result = projectReducer(prev, { type: 'setStatus', status: 'final' })

    expect(result).not.toBe(prev)
    expect(result.status).toBe('final')

    // Everything else unchanged
    expect(result.id).toBe(prev.id)
    expect(result.name).toBe(prev.name)
    expect(result.slides).toBe(prev.slides)
    expect(result.settings).toBe(prev.settings)
  })

  it('5. rollback restores the snapshot', () => {
    const current = makeProject({ status: 'draft' })
    const snapshot = makeProject({ id: 'snap-proj', status: 'storyboard_ready' })

    const result = projectReducer(current, { type: 'rollback', snapshot })

    expect(result).toBe(snapshot)
  })
})

describe('createMutationQueue', () => {
  it('6. enqueue runs N ops in submission order', async () => {
    const queue = createMutationQueue()
    const startOrder: number[] = []

    // Op i resolves after (30 - i*10)ms so they would naturally finish in reverse order.
    // We track when each fn STARTS, not when it finishes.
    const promises = [0, 1, 2].map((i) =>
      queue.enqueue(async () => {
        startOrder.push(i)
        await new Promise<void>((r) => setTimeout(r, 30 - i * 10))
        return i
      }),
    )

    await Promise.all(promises)

    expect(startOrder).toEqual([0, 1, 2])
  })

  it('7. rejection on op K does not break op K+1', async () => {
    const queue = createMutationQueue()
    const secondCalled: boolean[] = []

    const err = new Error('op-0 failed')

    const p0 = queue.enqueue(async () => {
      throw err
    })

    const p1 = queue.enqueue(async () => {
      secondCalled.push(true)
      return 42
    })

    // p0 should reject with err
    await expect(p0).rejects.toBe(err)

    // p1 should resolve to 42
    const result = await p1
    expect(result).toBe(42)

    // Second fn was actually called
    expect(secondCalled).toEqual([true])
  })

  it('isPending reflects in-flight ops; onceDrained fires on busy → idle', async () => {
    const queue = createMutationQueue()
    expect(queue.isPending()).toBe(false)

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const op = queue.enqueue(() => gate)
    expect(queue.isPending()).toBe(true)

    let drained = false
    queue.onceDrained(() => { drained = true })
    // Still busy — callback must not have fired yet.
    expect(drained).toBe(false)

    release()
    await op
    // Give the queued decrement microtask a chance to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(queue.isPending()).toBe(false)
    expect(drained).toBe(true)
  })

  it('onceDrained on an idle queue fires on the next microtask', async () => {
    const queue = createMutationQueue()
    let drained = false
    queue.onceDrained(() => { drained = true })
    expect(drained).toBe(false) // not synchronous
    await Promise.resolve()
    expect(drained).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Image crop tests
// ---------------------------------------------------------------------------

describe('updateImageCrop', () => {
  const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }

  it('8. sets a crop on the targeted image element', () => {
    const prev = makeProject()
    const result = projectReducer(prev, {
      type: 'updateImageCrop',
      slideId: 'slide-0',
      elementId: 'el-0-0',
      crop: CROP,
    })

    expect(result).not.toBe(prev)

    const resultEl = result.slides![0].elements[0] as ImageElement
    expect(resultEl.crop).toEqual(CROP)

    // Other geometry fields untouched
    expect(resultEl.src).toBe('https://example.com/img0.png')
    expect(resultEl.x).toBe(0)
    expect(resultEl.y).toBe(0)
    expect(resultEl.w).toBe(100)
    expect(resultEl.h).toBe(100)

    // Sibling element in same slide untouched (same ref)
    expect(result.slides![0].elements[1]).toBe(prev.slides![0].elements[1])

    // Other slide untouched (same ref)
    expect(result.slides![1]).toBe(prev.slides![1])
  })

  it('9. crop: undefined clears an existing crop', () => {
    // Build a project with an existing crop on el-0-0
    const withCrop = makeProject()
    const afterSet = projectReducer(withCrop, {
      type: 'updateImageCrop',
      slideId: 'slide-0',
      elementId: 'el-0-0',
      crop: CROP,
    })
    expect((afterSet.slides![0].elements[0] as ImageElement).crop).toEqual(CROP)

    // Now clear it
    const afterClear = projectReducer(afterSet, {
      type: 'updateImageCrop',
      slideId: 'slide-0',
      elementId: 'el-0-0',
      crop: undefined,
    })

    const resultEl = afterClear.slides![0].elements[0] as ImageElement
    expect(resultEl.crop).toBeUndefined()
  })

  it('10. updateImageCrop is a no-op when target element is an overlay', () => {
    const prev = makeProject()
    // el-0-1 is an overlay element
    const result = projectReducer(prev, {
      type: 'updateImageCrop',
      slideId: 'slide-0',
      elementId: 'el-0-1',
      crop: CROP,
    })

    // The targeted overlay element is returned as-is (same ref)
    expect(result.slides![0].elements[1]).toBe(prev.slides![0].elements[1])

    // No crop field on the overlay element
    const overlayEl = result.slides![0].elements[1] as OverlayElement
    expect((overlayEl as unknown as { crop?: unknown }).crop).toBeUndefined()
  })
})

describe('resizeElement preserves crop on images', () => {
  it('12. resizeElement preserves any existing crop on an image element', () => {
    const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }

    const withCrop = projectReducer(makeProject(), {
      type: 'updateImageCrop',
      slideId: 'slide-0',
      elementId: 'el-0-0',
      crop: CROP,
    })
    expect((withCrop.slides![0].elements[0] as ImageElement).crop).toEqual(CROP)

    const result = projectReducer(withCrop, {
      type: 'resizeElement',
      slideId: 'slide-0',
      elementId: 'el-0-0',
      x: 5,
      y: 5,
      w: 200,
      h: 150,
    })

    const resultEl = result.slides![0].elements[0] as ImageElement
    expect(resultEl.x).toBe(5)
    expect(resultEl.y).toBe(5)
    expect(resultEl.w).toBe(200)
    expect(resultEl.h).toBe(150)
    expect(resultEl.crop).toEqual(CROP)
  })

  it('13. resizeElement does not alter overlay elements unexpectedly', () => {
    const prev = makeProject()

    // Resize the overlay element el-0-1
    const result = projectReducer(prev, {
      type: 'resizeElement',
      slideId: 'slide-0',
      elementId: 'el-0-1',
      x: 20,
      y: 20,
      w: 60,
      h: 30,
    })

    const resultEl = result.slides![0].elements[1] as OverlayElement
    expect(resultEl.type).toBe('overlay')
    expect(resultEl.x).toBe(20)
    expect(resultEl.y).toBe(20)
    expect(resultEl.w).toBe(60)
    expect(resultEl.h).toBe(30)

    // overlay-specific fields untouched
    expect(resultEl.overlay).toEqual(prev.slides![0].elements[1].type === 'overlay'
      ? (prev.slides![0].elements[1] as OverlayElement).overlay
      : undefined)

    // No spurious crop field introduced
    expect((resultEl as unknown as { crop?: unknown }).crop).toBeUndefined()
  })
})

describe('sse merge — reference preservation', () => {
  it('returns the same project reference when next is structurally identical', () => {
    const a = makeProject()
    const b = JSON.parse(JSON.stringify(a)) as Project
    const result = projectReducer(a, { type: 'sse', project: b })
    expect(result).toBe(a) // identity, not deep-equal
  })

  it('preserves unchanged slide refs when one slide changes', () => {
    const a = makeProject()
    const b = JSON.parse(JSON.stringify(a)) as Project
    b.slides![1].base_color = '#ff00ff'
    const result = projectReducer(a, { type: 'sse', project: b })
    expect(result).not.toBe(a)
    expect(result.slides![0]).toBe(a.slides![0])
    expect(result.slides![1]).not.toBe(a.slides![1])
    expect(result.slides![1].base_color).toBe('#ff00ff')
  })

  it('preserves unchanged element refs when one element changes', () => {
    const a = makeProject()
    const b = JSON.parse(JSON.stringify(a)) as Project
    b.slides![0].elements[0] = { ...b.slides![0].elements[0], x: 999 }
    const result = projectReducer(a, { type: 'sse', project: b })
    expect(result.slides![0].elements[0]).not.toBe(a.slides![0].elements[0])
    expect(result.slides![0].elements[1]).toBe(a.slides![0].elements[1])
    expect(result.slides![1]).toBe(a.slides![1])
  })

  it('preserves all slide refs when slides are reordered with same ids', () => {
    // This test catches a by-index merge regression: if a future implementation
    // matches slides positionally, slide-0 and slide-1 swap, deepEqual fails
    // on both positions, and both slides get fresh refs. With by-id matching,
    // both refs are preserved (the slides themselves didn't change, only their
    // order in the array).
    const a = makeProject()
    const b = JSON.parse(JSON.stringify(a)) as Project
    const [s0, s1] = b.slides!
    b.slides = [s1, s0]
    const result = projectReducer(a, { type: 'sse', project: b })
    // slides array itself must be a new ref (different order)
    expect(result.slides).not.toBe(a.slides)
    // individual slide refs must be the originals (only their position moved)
    expect(result.slides![0]).toBe(a.slides![1])
    expect(result.slides![1]).toBe(a.slides![0])
  })

  it('handles slide list length change', () => {
    const a = makeProject()
    const b = JSON.parse(JSON.stringify(a)) as Project
    b.slides!.push({ id: 'slide-new', base_color: '#abcdef', elements: [] } as Slide)
    const result = projectReducer(a, { type: 'sse', project: b })
    expect(result.slides).toHaveLength(a.slides!.length + 1)
    expect(result.slides![0]).toBe(a.slides![0])
    expect(result.slides![1]).toBe(a.slides![1])
  })

  it('preserves slides array ref when only top-level scalar changes', () => {
    const a = makeProject({ status: 'draft' })
    const b = JSON.parse(JSON.stringify(a)) as Project
    b.status = 'final'
    const result = projectReducer(a, { type: 'sse', project: b })
    expect(result.status).toBe('final')
    expect(result.slides).toBe(a.slides)
  })

  it('treats {field: undefined} as structurally equal to {} (json round-trip)', () => {
    // After clearing a field (e.g. resizeElement writes `{...el, crop: undefined}`),
    // the local state has the key present with undefined. JSON serialization on
    // the server drops undefined-valued keys, so the SSE echo arrives with the
    // key absent. These must compare equal so the identity short-circuit fires
    // on PUT echoes — otherwise every image resize triggers a re-render storm.
    const a = makeProject()
    // Locally, simulate a cleared crop: explicit `crop: undefined` on the image.
    const aWithUndefined = {
      ...a,
      slides: a.slides!.map((s, i) => i === 0
        ? { ...s, elements: s.elements.map((el, j) => j === 0 ? { ...el, crop: undefined } : el) }
        : s,
      ),
    }
    // SSE echo: the same project after JSON round-trip — undefined keys dropped.
    const echoed = JSON.parse(JSON.stringify(aWithUndefined)) as Project
    const result = projectReducer(aWithUndefined, { type: 'sse', project: echoed })
    expect(result).toBe(aWithUndefined)
  })
})

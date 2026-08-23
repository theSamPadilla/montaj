/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import src from '../VideoEditor.tsx?raw'

/**
 * Source-level, same rationale as VideoEditor.context.test.tsx: VideoEditor
 * mounts the whole editor (engine, canvas timeline, workers) and is not
 * cheaply renderable in jsdom, so the closure logic here can't be exercised
 * through a real double-click. The three things that DO need a live DOM or a
 * plain function call — "a canvas double-click calls onEditCaption(id)", "a
 * changed editFocusId nonce scrolls/focuses the sidebar row", and "the nonce
 * actually climbs off the previous request, not a fixed value" — are already
 * covered where they live: TimelineCanvas.pointer.test.tsx, CaptionListPanel's
 * own `editFocusId` tests, and CaptionListPanel.test.tsx's `nextEditFocus`
 * suite (the increment is a pure exported function specifically so that last
 * one can be proven behaviourally instead of by matching source text, which
 * only pins formatting and would miss a wrong-operator bug). What's unique to
 * VideoEditor, and only lives here, is the bridge between them: that
 * `handleEditCaption` actually calls both `handleSelectCaption` and
 * `nextEditFocus` rather than reimplementing either inline.
 */
describe('VideoEditor caption edit-focus bridge (Phase 6)', () => {
  it('imports nextEditFocus from CaptionListPanel — the same shared helper the composition check below points at', () => {
    expect(src).toMatch(/import CaptionListPanel, \{[^}]*nextEditFocus[^}]*\} from '\.\/CaptionListPanel'/)
  })

  it('holds editFocusId as its own state, shaped { id, nonce } | null', () => {
    expect(src).toMatch(/const \[editFocusId, setEditFocusId\] = useState<CaptionEditFocusRequest \| null>\(null\)/)
  })

  it('handleEditCaption both selects the caption and requests a focus', () => {
    const fn = src.match(/const handleEditCaption = useCallback\(\([\s\S]*?\}, \[handleSelectCaption\]\)/)?.[0] ?? ''
    expect(fn).not.toBe('')
    expect(fn).toMatch(/handleSelectCaption\(id\)/)
    expect(fn).toMatch(/setEditFocusId/)
  })

  // A composition check, not a match on the increment's arithmetic — that
  // arithmetic is unit-tested behaviourally in CaptionListPanel.test.tsx's
  // `nextEditFocus` suite (`?? 0` vs `?? 1`, `+ 1` present or dropped, etc).
  // What this can honestly prove from source text alone is that
  // `handleEditCaption` actually CALLS the shared helper rather than
  // reimplementing the increment inline — a reformat of `nextEditFocus`'s
  // body won't break this the way matching its expression verbatim would.
  it('derives the next focus request via the shared nextEditFocus helper, not an inline reimplementation', () => {
    const fn = src.match(/const handleEditCaption = useCallback\(\([\s\S]*?\}, \[handleSelectCaption\]\)/)?.[0] ?? ''
    expect(fn).toMatch(/setEditFocusId\(prev => nextEditFocus\(prev, id\)\)/)
    expect(fn).not.toMatch(/prev\?\.nonce/)
  })

  it('threads onEditCaption into Timeline and editFocusId into the sidebar CaptionListPanel', () => {
    expect(src).toMatch(/onEditCaption=\{handleEditCaption\}/)
    expect(src).toMatch(/editFocusId=\{editFocusId\}/)
  })
})

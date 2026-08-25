import { describe, it, expect } from 'vitest'
import { EASING_NAMES } from '@bycrux/timeline-core'
import type {
  Keyframe as CoreKeyframe,
  KeyframeTrack as CoreKeyframeTrack,
  EasingName as CoreEasingName,
  KeyframeProp as CoreKeyframeProp,
} from '@bycrux/timeline-core'
import type {
  Keyframe as EditorKeyframe,
  KeyframeTrack as EditorKeyframeTrack,
  EasingName as EditorEasingName,
  KeyframeProp as EditorKeyframeProp,
} from '../schema'

// schema.ts re-declares Keyframe/KeyframeTrack/EasingName/KeyframeProp
// instead of importing them — schema.ts is deliberately import-free (see its
// module header). The duplication is intentional but must stay structurally
// identical to the canonical definitions in @bycrux/timeline-core
// (src/curves.js, declared in its index.d.ts), which is where geometryAt/
// sampleTrack actually interpret these shapes for BOTH the preview and the
// render. This file is a compile-time tripwire: if either side's shape
// drifts, one of the assignments below fails to type-check — and thus fails
// `tsc`/the vitest build — long before it becomes a silent runtime bug.
//
// Mirrors montaj_assets/ui/src/lib/types/__tests__/schema-assignability.test.ts,
// extended to prove MUTUAL assignability (both directions) since neither side
// here is a superset of the other — they're meant to be the same shape twice.
function mutuallyAssignable<A, B>(_forward: (a: A) => B, _backward: (b: B) => A) {}

describe('editor schema Keyframe types <-> @bycrux/timeline-core Keyframe types', () => {
  it('EasingName is mutually assignable', () => {
    mutuallyAssignable<CoreEasingName, EditorEasingName>((a) => a, (b) => b)
  })

  it('KeyframeProp is mutually assignable', () => {
    mutuallyAssignable<CoreKeyframeProp, EditorKeyframeProp>((a) => a, (b) => b)
  })

  it('Keyframe is mutually assignable', () => {
    mutuallyAssignable<CoreKeyframe, EditorKeyframe>((a) => a, (b) => b)

    const sample: EditorKeyframe = { t: 0, value: 1, easing: 'ease-in-out' }
    const asCore: CoreKeyframe = sample
    const asEditor: EditorKeyframe = asCore
    expect(asEditor.t).toBe(0)
  })

  it('KeyframeTrack is mutually assignable', () => {
    mutuallyAssignable<CoreKeyframeTrack, EditorKeyframeTrack>((a) => a, (b) => b)

    const sample: EditorKeyframeTrack = { prop: 'scale', points: [{ t: 0, value: 1 }] }
    const asCore: CoreKeyframeTrack = sample
    const asEditor: EditorKeyframeTrack = asCore
    expect(asEditor.prop).toBe('scale')
  })
})

// The assignability checks above are type-level ONLY, so they fire under
// `tsc --noEmit` but NOT under `vitest run` — vitest's transform strips types
// without checking them, and the editor's `npm test` is `vitest run` with no
// typecheck step. That leaves the likeliest real drift unguarded in the command
// people actually run: someone adds an easing preset to timeline-core's
// curves.js and forgets schema.ts's `EasingName` union.
//
// This block closes that at runtime. EASING_NAMES is a real exported VALUE, so
// comparing it against the union's members catches the drift under vitest, and
// the exhaustiveness map makes the reverse direction (a member added to the
// union but not to the list below) a compile error.
describe('EasingName stays in sync with timeline-core at RUNTIME', () => {
  // Adding a member to EditorEasingName without adding it here fails to compile:
  // the Record must cover every member of the union exactly.
  const EXHAUSTIVE: Record<EditorEasingName, true> = {
    linear: true,
    ease: true,
    'ease-in': true,
    'ease-out': true,
    'ease-in-out': true,
    hold: true,
  }
  const DECLARED = Object.keys(EXHAUSTIVE) as EditorEasingName[]

  it('schema.ts declares exactly the easings timeline-core implements', () => {
    expect([...DECLARED].sort()).toEqual([...EASING_NAMES].sort())
  })

  it('every name timeline-core exports is assignable to the editor union', () => {
    for (const name of EASING_NAMES) {
      const asEditor: EditorEasingName = name
      expect(DECLARED).toContain(asEditor)
    }
  })
})

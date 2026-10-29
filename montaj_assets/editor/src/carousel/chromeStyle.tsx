import type { CSSProperties } from 'react'

// How the selection chrome draws (outline, handles, rotate knob), shared by an
// element's chrome, a group's and the crop window's, so they read alike on a
// busy photo: a 2px outline, 10px square handles with a white 2px edge and a
// soft shadow. The drawn handle is small; its press target reaches past it.

export const OUTLINE = '2px'
export const HANDLE_SIZE = 10
export const ROTATE_OFFSET = 22
export const ROTATE_KNOB = 16
/** How far a handle's press target reaches past its drawn square. */
export const HIT_PAD = 5

const SHADOW = '0 1px 3px rgba(0,0,0,0.45)'

/** The drawn square of a resize handle (position and size are the caller's). */
export const HANDLE_LOOK: CSSProperties = {
  background: 'var(--editor-selection)',
  border: '2px solid #fff',
  borderRadius: 2,
  boxShadow: SHADOW,
  boxSizing: 'border-box',
}

/** The rotate knob's drawn disc. */
export const KNOB_LOOK: CSSProperties = {
  background: 'var(--editor-selection)',
  border: '2px solid #fff',
  borderRadius: '50%',
  boxShadow: SHADOW,
  boxSizing: 'border-box',
}

/** An invisible press target that reaches `HIT_PAD` past its parent; presses bubble to the parent. */
export function HitPad() {
  return <span data-chrome-hit="" style={{ position: 'absolute', inset: -HIT_PAD, background: 'transparent' }} />
}

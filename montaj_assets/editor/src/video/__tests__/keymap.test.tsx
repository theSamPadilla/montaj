import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import {
  useKeymap,
  matchesKey,
  matchesUndo,
  matchesRedo,
  matchesModKey,
  matchesPlainKey,
  matchesDelete,
  matchesShiftDelete,
  isTypingTarget,
  type KeyBinding,
} from '../keymap'

afterEach(() => cleanup())

function Harness({ bindings, modalOpen }: { bindings: KeyBinding[]; modalOpen?: boolean }) {
  useKeymap(bindings, { modalOpen })
  return (
    <div>
      <input data-testid="input" />
      <textarea data-testid="textarea" />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div data-testid="editable" contentEditable suppressContentEditableWarning>text</div>
      <div data-testid="plain">plain</div>
    </div>
  )
}

describe('useKeymap — the shared base guard', () => {
  it('fires on a plain target', () => {
    const action = vi.fn()
    const { getByTestId } = render(<Harness bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), action }]} />)
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('never fires while an INPUT is the target', () => {
    const action = vi.fn()
    const { getByTestId } = render(<Harness bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), action }]} />)
    fireEvent.keyDown(getByTestId('input'), { key: 's' })
    expect(action).not.toHaveBeenCalled()
  })

  it('never fires while a TEXTAREA is the target', () => {
    const action = vi.fn()
    const { getByTestId } = render(<Harness bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), action }]} />)
    fireEvent.keyDown(getByTestId('textarea'), { key: 's' })
    expect(action).not.toHaveBeenCalled()
  })

  it('never fires while a contentEditable host is the target', () => {
    const action = vi.fn()
    const { getByTestId } = render(<Harness bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), action }]} />)
    const editable = getByTestId('editable')
    // jsdom doesn't implement `isContentEditable` (it's always `undefined`,
    // even with the `contenteditable` attribute set) — force it so this
    // exercises the same guard real browsers hit. See keymap.ts's
    // `isTypingTarget` doc comment.
    Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true })
    fireEvent.keyDown(editable, { key: 's' })
    expect(action).not.toHaveBeenCalled()
  })

  it('never fires while modalOpen is true, even on a plain target', () => {
    const action = vi.fn()
    const { getByTestId } = render(
      <Harness modalOpen bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), action }]} />,
    )
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).not.toHaveBeenCalled()
  })

  it('resumes firing once modalOpen goes back to false', () => {
    const action = vi.fn()
    const bindings = [{ id: 'a', description: 'A', matches: matchesKey('s'), action }]
    const { getByTestId, rerender } = render(<Harness modalOpen bindings={bindings} />)
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).not.toHaveBeenCalled()
    rerender(<Harness modalOpen={false} bindings={bindings} />)
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('is always ignored for Space — the playback hooks own it, never the keymap', () => {
    // A deliberately over-broad matcher (would match ANY key) to prove Space
    // is rejected structurally, before any binding is even consulted.
    const action = vi.fn()
    const { getByTestId } = render(
      <Harness bindings={[{ id: 'catch-all', description: 'catch-all', matches: () => true, action }]} />,
    )
    fireEvent.keyDown(getByTestId('plain'), { key: ' ', code: 'Space' })
    expect(action).not.toHaveBeenCalled()
    // Sanity: the same catch-all binding DOES fire for an unrelated key,
    // proving Space specifically (not everything) is what's rejected.
    fireEvent.keyDown(getByTestId('plain'), { key: 'x' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('per-binding guard() gates the action independently of the base guard', () => {
    const action = vi.fn()
    let allowed = false
    const { getByTestId } = render(
      <Harness bindings={[{ id: 'a', description: 'A', matches: matchesKey('s'), guard: () => allowed, action }]} />,
    )
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).not.toHaveBeenCalled()
    allowed = true
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('evaluates bindings in order and stops at the first match', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { getByTestId } = render(
      <Harness
        bindings={[
          { id: 'first', description: 'first', matches: matchesKey('s'), action: first },
          { id: 'second', description: 'second', matches: matchesKey('s'), action: second },
        ]}
      />,
    )
    fireEvent.keyDown(getByTestId('plain'), { key: 's' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})

describe('isTypingTarget', () => {
  it('is true for INPUT/TEXTAREA/contentEditable, false otherwise', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    // jsdom doesn't implement `isContentEditable` — force it (see the guard
    // test above for the same workaround, with the full explanation).
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true })
    const plain = document.createElement('div')
    Object.defineProperty(plain, 'isContentEditable', { value: false, configurable: true })
    for (const [el, expected] of [[input, true], [textarea, true], [editable, true], [plain, false]] as const) {
      const ev = { target: el } as unknown as KeyboardEvent
      expect(isTypingTarget(ev)).toBe(expected)
    }
  })
})

describe('combo matchers', () => {
  it('matchesUndo requires mod+z without shift; matchesRedo requires mod+shift+z or mod+y', () => {
    expect(matchesUndo({ metaKey: true, key: 'z', shiftKey: false } as KeyboardEvent)).toBe(true)
    expect(matchesUndo({ metaKey: true, key: 'z', shiftKey: true } as KeyboardEvent)).toBe(false)
    expect(matchesUndo({ metaKey: false, key: 'z', shiftKey: false } as KeyboardEvent)).toBe(false)

    expect(matchesRedo({ metaKey: true, key: 'z', shiftKey: true } as KeyboardEvent)).toBe(true)
    expect(matchesRedo({ metaKey: true, key: 'y', shiftKey: false } as KeyboardEvent)).toBe(true)
    expect(matchesRedo({ metaKey: true, key: 'z', shiftKey: false } as KeyboardEvent)).toBe(false)
  })

  it('matchesDelete excludes Shift; matchesShiftDelete requires it', () => {
    expect(matchesDelete({ key: 'Delete', shiftKey: false } as KeyboardEvent)).toBe(true)
    expect(matchesDelete({ key: 'Delete', shiftKey: true } as KeyboardEvent)).toBe(false)
    expect(matchesShiftDelete({ key: 'Backspace', shiftKey: true } as KeyboardEvent)).toBe(true)
    expect(matchesShiftDelete({ key: 'Backspace', shiftKey: false } as KeyboardEvent)).toBe(false)
  })

  it('matchesPlainKey excludes mod/alt combos; matchesModKey requires mod', () => {
    expect(matchesPlainKey('l')({ key: 'l', metaKey: false, ctrlKey: false, altKey: false } as KeyboardEvent)).toBe(true)
    expect(matchesPlainKey('l')({ key: 'l', metaKey: true, ctrlKey: false, altKey: false } as KeyboardEvent)).toBe(false)
    expect(matchesModKey('k')({ key: 'k', metaKey: true, ctrlKey: false } as KeyboardEvent)).toBe(true)
    expect(matchesModKey('k')({ key: 'k', metaKey: false, ctrlKey: false } as KeyboardEvent)).toBe(false)
  })
})

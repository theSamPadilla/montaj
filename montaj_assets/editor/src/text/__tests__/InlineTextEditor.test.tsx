// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, fireEvent } from '@testing-library/react'
import { InlineTextEditor } from '../InlineTextEditor'

const DEFAULT_RECT = { left: 10, top: 20, width: 100, height: 30 }
const DEFAULT_STYLE: Partial<CSSStyleDeclaration> = { fontSize: '16px' }

function renderEditor(overrides: {
  initialValue?: string
  rect?: typeof DEFAULT_RECT
  styleSnapshot?: Partial<CSSStyleDeclaration>
  onCommit?: ReturnType<typeof vi.fn>
  onCancel?: ReturnType<typeof vi.fn>
  onChange?: ReturnType<typeof vi.fn>
} = {}) {
  const onCommit = overrides.onCommit ?? vi.fn()
  const onCancel = overrides.onCancel ?? vi.fn()
  const onChange = overrides.onChange ?? vi.fn()

  const { container } = render(
    <InlineTextEditor
      initialValue={overrides.initialValue ?? 'hello'}
      rect={overrides.rect ?? DEFAULT_RECT}
      styleSnapshot={overrides.styleSnapshot ?? DEFAULT_STYLE}
      onCommit={onCommit}
      onCancel={onCancel}
      onChange={onChange}
    />,
  )

  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  return { textarea, onCommit, onCancel, onChange }
}

describe('InlineTextEditor', () => {
  it('1. renders with initialValue prefilled', () => {
    const { textarea } = renderEditor({ initialValue: 'prefilled text' })
    expect(textarea.value).toBe('prefilled text')
  })

  it('2. mounts focused', () => {
    const { textarea } = renderEditor()
    expect(textarea).toHaveFocus()
  })

  it('3. selects all text on mount', () => {
    const { textarea } = renderEditor({ initialValue: 'select me' })
    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe('select me'.length)
  })

  it('4. typing fires onChange with the new value', () => {
    const onChange = vi.fn()
    const { textarea } = renderEditor({ onChange })
    fireEvent.change(textarea, { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('5. blur calls onCommit with the current value', () => {
    const onCommit = vi.fn()
    const { textarea } = renderEditor({ onCommit })
    fireEvent.change(textarea, { target: { value: 'updated' } })
    fireEvent.blur(textarea)
    expect(onCommit).toHaveBeenCalledWith('updated')
  })

  it('6. Enter (no shift) calls onCommit and calls preventDefault', () => {
    const onCommit = vi.fn()
    const { textarea } = renderEditor({ onCommit, initialValue: 'hello' })

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    textarea.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalled()
  })

  it('7. Shift+Enter does NOT call onCommit', () => {
    const onCommit = vi.fn()
    const { textarea } = renderEditor({ onCommit })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('8. Cmd/Ctrl+Enter calls onCommit', () => {
    const onCommit = vi.fn()
    const { textarea } = renderEditor({ onCommit })

    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('9. Escape calls onCancel and calls preventDefault', () => {
    const onCancel = vi.fn()
    const onCommit = vi.fn()
    const { textarea } = renderEditor({ onCancel, onCommit })

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    textarea.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onCancel).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('10. pointer events do not bubble to parent', () => {
    const parentPointerDown = vi.fn()
    const parentPointerMove = vi.fn()
    const parentClick = vi.fn()

    const { container } = render(
      <div
        onPointerDown={parentPointerDown}
        onPointerMove={parentPointerMove}
        onClick={parentClick}
      >
        <InlineTextEditor
          initialValue="test"
          rect={DEFAULT_RECT}
          styleSnapshot={DEFAULT_STYLE}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
          onChange={vi.fn()}
        />
      </div>,
    )

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.pointerDown(textarea)
    fireEvent.pointerMove(textarea)
    fireEvent.click(textarea)

    expect(parentPointerDown).not.toHaveBeenCalled()
    expect(parentPointerMove).not.toHaveBeenCalled()
    expect(parentClick).not.toHaveBeenCalled()
  })
})

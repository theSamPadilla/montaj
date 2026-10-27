// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, fireEvent } from '@testing-library/react'
import { InlineTextEditor } from '../InlineTextEditor'

const DEFAULT_RECT = { left: 10, top: 20, width: 100, height: 30 }
const DEFAULT_STYLE: Partial<CSSStyleDeclaration> = { fontSize: '16px' }

function renderEditor(overrides: Partial<React.ComponentProps<typeof InlineTextEditor>> = {}) {
  const onCommit = overrides.onCommit ?? vi.fn()
  const onCancel = overrides.onCancel ?? vi.fn()
  const onChange = overrides.onChange ?? vi.fn()

  const { container } = render(
    <InlineTextEditor
      initialValue="hello"
      rect={DEFAULT_RECT}
      styleSnapshot={DEFAULT_STYLE}
      {...overrides}
      onCommit={onCommit}
      onCancel={onCancel}
      onChange={onChange}
    />,
  )

  const editor = container.querySelector('[contenteditable]') as HTMLDivElement
  return { editor, onCommit, onCancel, onChange }
}

/** What the browser does when the person types the editor's text to `value`: the DOM changes, then `input`. */
function type(editor: HTMLElement, value: string) {
  const span = editor.querySelector('span')
  if (span) span.textContent = value
  else editor.insertBefore(document.createTextNode(value), editor.firstChild)
  const sel = window.getSelection()!
  const r = document.createRange()
  r.selectNodeContents(editor.querySelector('span') ?? editor)
  r.collapse(false)
  sel.removeAllRanges()
  sel.addRange(r)
  fireEvent.input(editor)
}

/** Selects [start, end) of the editor's single run. */
function selectRange(editor: HTMLElement, start: number, end: number) {
  const text = editor.querySelector('span')!.firstChild!
  const r = document.createRange()
  r.setStart(text, start)
  r.setEnd(text, end)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('InlineTextEditor', () => {
  it('1. renders with initialValue prefilled', () => {
    const { editor } = renderEditor({ initialValue: 'prefilled text' })
    expect(editor.textContent).toBe('prefilled text')
  })

  it('2. mounts focused', () => {
    const { editor } = renderEditor()
    expect(editor).toHaveFocus()
  })

  it('3. selects all text on mount', () => {
    renderEditor({ initialValue: 'select me' })
    expect(window.getSelection()!.toString()).toBe('select me')
  })

  it('4. typing fires onChange with the new value', () => {
    const onChange = vi.fn()
    const { editor } = renderEditor({ onChange })
    type(editor, 'abc')
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('5. blur calls onCommit with the current value', () => {
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCommit })
    type(editor, 'updated')
    fireEvent.blur(editor)
    expect(onCommit).toHaveBeenCalledWith('updated', [{ t: 'updated' }], expect.anything())
  })

  it('6. Enter (no shift) calls onCommit and calls preventDefault', () => {
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCommit, initialValue: 'hello' })
    type(editor, 'hello!')

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalled()
  })

  it('7. Shift+Enter does NOT call onCommit', () => {
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCommit })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each([['metaKey'], ['ctrlKey']])('8. Cmd/Ctrl+Enter (%s) calls onCommit', (mod) => {
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCommit })
    type(editor, 'changed')
    fireEvent.keyDown(editor, { key: 'Enter', [mod]: true })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('9. Escape commits the typed text and calls preventDefault', () => {
    const onCancel = vi.fn()
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCancel, onCommit })
    type(editor, 'typed')

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    editor.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toBe('typed')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('9b. Escape then the blur that follows writes once', () => {
    const onCommit = vi.fn()
    const { editor } = renderEditor({ onCommit })
    type(editor, 'typed')
    fireEvent.keyDown(editor, { key: 'Escape' })
    fireEvent.blur(editor)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Escape', (t: HTMLElement) => fireEvent.keyDown(t, { key: 'Escape' })],
    ['Enter', (t: HTMLElement) => fireEvent.keyDown(t, { key: 'Enter' })],
    ['blur', (t: HTMLElement) => fireEvent.blur(t)],
  ])('9c. %s with unchanged text writes nothing and closes the editor', (_name, act) => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const { editor } = renderEditor({ onCommit, onCancel })
    act(editor)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('9d. Shift+Enter puts a newline in the text and closes nothing', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const onChange = vi.fn()
    const { editor } = renderEditor({ onCommit, onCancel, onChange })
    const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    editor.dispatchEvent(ev)
    // The whole text was selected on mount: the newline replaces it.
    expect(onChange).toHaveBeenLastCalledWith('\n')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('9e. a paste goes in as plain text, in the style around it', () => {
    const onChange = vi.fn()
    const { editor } = renderEditor({ initialValue: 'ab', initialRuns: [{ t: 'ab', c: '#ff0000' }], onChange })
    selectRange(editor, 1, 1)
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    ev.clipboardData = { getData: (t: string) => (t === 'text/plain' ? 'X\r\nY' : '<b>X</b>') }
    editor.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith('aX\nYb')
    expect(editor.querySelectorAll('span')).toHaveLength(1)
    expect(editor.querySelector('span')!.style.color).toBe('rgb(255, 0, 0)')
  })

  it('9f. Cmd+B with a range selected bolds it and writes, the edit staying open', () => {
    const onWrite = vi.fn()
    const onCommit = vi.fn()
    const onRangeStyle = vi.fn()
    const { editor } = renderEditor({ initialValue: 'hello', styled: true, onWrite, onCommit, onRangeStyle })
    selectRange(editor, 0, 2)
    expect(onRangeStyle).toHaveBeenLastCalledWith(expect.objectContaining({ bold: false }))
    fireEvent.keyDown(editor, { key: 'b', metaKey: true })
    expect(onWrite).toHaveBeenCalledWith('hello', [{ t: 'he', b: 1 }, { t: 'llo' }], expect.anything())
    expect(onRangeStyle).toHaveBeenLastCalledWith(expect.objectContaining({ bold: true }))
    expect(onCommit).not.toHaveBeenCalled()
    // Nothing changed since that write: closing writes nothing more.
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('9g. a blur into a control that keeps the edit (a style button, the colour panel) does not close it', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const { editor } = renderEditor({ onCommit, onCancel })
    const keep = document.createElement('button')
    keep.setAttribute('data-keep-text-edit', '')
    document.body.appendChild(keep)
    keep.focus()
    expect(document.activeElement).toBe(keep)
    expect(editor.isConnected).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    // A press anywhere else then ends it.
    fireEvent.pointerDown(document.body)
    expect(onCancel).toHaveBeenCalledTimes(1)
    keep.remove()
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

    const editor = container.querySelector('[contenteditable]') as HTMLElement
    fireEvent.pointerDown(editor)
    fireEvent.pointerMove(editor)
    fireEvent.click(editor)

    expect(parentPointerDown).not.toHaveBeenCalled()
    expect(parentPointerMove).not.toHaveBeenCalled()
    expect(parentClick).not.toHaveBeenCalled()
  })
})

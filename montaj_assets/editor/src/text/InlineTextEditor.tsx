import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type InlineTextEditorProps = {
  initialValue: string
  rect: { left: number; top: number; width: number; height: number }
  styleSnapshot: Partial<CSSStyleDeclaration>
  onCommit: (value: string) => void
  onCancel: () => void
  onChange: (value: string) => void
}

export function InlineTextEditor({
  initialValue,
  rect,
  styleSnapshot,
  onCommit,
  onCancel,
  onChange,
}: InlineTextEditorProps): React.ReactElement {
  const [value, setValue] = useState(initialValue)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Set once the editor has handed its result back, so the blur that follows an
  // Enter or Esc (the editor unmounting) does not write a second time.
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(rect.height, el.scrollHeight)}px`
  }, [value, rect.height])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setValue(next)
    onChange(next)
  }

  // Commit when the text changed, otherwise just close: an unchanged edit
  // must not record an empty undo step.
  function settle() {
    if (settled.current) return
    settled.current = true
    if (value === initialValue) onCancel()
    else onCommit(value)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      // Esc keeps what was typed, exactly like a click away.
      e.preventDefault()
      settle()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Let the newline insert naturally.
        return
      }
      // Bare Enter (without Shift) commits the text.
      e.preventDefault()
      settle()
    }
  }

  function stopProp(e: React.SyntheticEvent) {
    e.stopPropagation()
  }

  return (
    <textarea
      ref={ref}
      aria-label="Edit text"
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={settle}
      onPointerDown={stopProp}
      onPointerMove={stopProp}
      onClick={stopProp}
      style={{
        ...(styleSnapshot as React.CSSProperties),
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        background: 'transparent',
        outline: 'none',
        padding: '0',
        border: 'none',
        resize: 'none',
        overflow: 'hidden',
        boxSizing: 'content-box',
        zIndex: 25,
        pointerEvents: 'auto',
      }}
    />
  )
}

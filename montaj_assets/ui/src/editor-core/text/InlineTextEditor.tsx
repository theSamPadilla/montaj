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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Let the newline insert naturally.
        return
      }
      // Bare Enter (without Shift) commits the text.
      e.preventDefault()
      onCommit(value)
    }
  }

  function stopProp(e: React.SyntheticEvent) {
    e.stopPropagation()
  }

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={() => onCommit(value)}
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

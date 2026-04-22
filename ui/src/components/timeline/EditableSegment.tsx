import { useRef, type KeyboardEvent } from 'react'
import type { CaptionSegment } from '@/lib/types/schema'

export function EditableSegment({ seg, onEdit }: { seg: CaptionSegment; onEdit: (text: string) => void }) {
  const spanRef = useRef<HTMLSpanElement>(null)

  function handleBlur() {
    const text = spanRef.current?.textContent?.trim() ?? ''
    if (!text) { if (spanRef.current) spanRef.current.textContent = seg.text; return }
    if (text !== seg.text) onEdit(text)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
    if (e.key === 'Enter') { e.preventDefault(); spanRef.current?.blur() }
    if (e.key === 'Escape') { if (spanRef.current) spanRef.current.textContent = seg.text; spanRef.current?.blur() }
  }

  return (
    <span
      ref={spanRef}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="cursor-text rounded px-0.5 hover:bg-white/5 focus:bg-white/10 focus:outline-none focus:ring-1 focus:ring-purple-500/40"
    >
      {seg.text}
    </span>
  )
}

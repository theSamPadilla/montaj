import { useRef, useState } from 'react'

/**
 * Drag a slide onto another to move it there: the classic slide rail's and the
 * grid view's (§587) one way to reorder. Each drop calls `onReorder` once (one
 * undo step); a drop on its own place does nothing.
 */
export function useSlideReorderDrag(onReorder: (fromIdx: number, toIdx: number) => void) {
  const dragIdx = useRef<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  function handleDragStart(idx: number) {
    dragIdx.current = idx
  }
  function handleDragOver(e: React.DragEvent, idx: number) {
    // Only a slide being reordered is ours to take. A Media card or a file
    // crossing it is left alone, and lights nothing up: no dragend would clear it.
    if (dragIdx.current === null) return
    e.preventDefault()
    setDragOverIdx(idx)
  }
  function handleDrop(toIdx: number) {
    if (dragIdx.current !== null && dragIdx.current !== toIdx) {
      onReorder(dragIdx.current, toIdx)
    }
    dragIdx.current = null
    setDragOverIdx(null)
  }
  function handleDragEnd() {
    dragIdx.current = null
    setDragOverIdx(null)
  }

  return { dragOverIdx, handleDragStart, handleDragOver, handleDrop, handleDragEnd }
}

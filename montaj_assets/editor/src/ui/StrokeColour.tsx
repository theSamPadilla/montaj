import { useEffect, useState } from 'react'
import { SwatchInput } from './SwatchInput'

// The one stroke colour control: a shape's or line's stroke (the toolbar's
// Stroke popover) and a text pill's border. In the rail layout it opens the
// same colour panel as Fill (alpha included); elsewhere it is the native picker.
//
// `onPreview` shows a pick live; `onCommit` writes it once (one undo step);
// `onCancel` gives a preview up. A host that has no live preview omits
// `onPreview` and writes on commit alone.

export interface StrokeColourProps {
  /** The colour now: `#rrggbb` or `#rrggbbaa`. */
  value: string
  onPreview?: (v: string) => void
  onCommit: (v: string) => void
  onCancel?: () => void
  ariaLabel?: string
  /** The element prop the panel colours (default `stroke`). */
  prop?: string
}

export function StrokeColour({ value, onPreview, onCommit, onCancel, ariaLabel = 'Stroke color', prop = 'stroke' }: StrokeColourProps) {
  const [shown, setShown] = useState(value)
  useEffect(() => setShown(value), [value])
  return (
    <SwatchInput
      value={shown}
      onChange={(v) => { setShown(v); onPreview?.(v) }}
      onCommit={onCommit}
      onCancel={() => { setShown(value); onCancel?.() }}
      ariaLabel={ariaLabel}
      title={ariaLabel}
      showValue={false}
      size="sm"
      alpha
      prop={prop}
    />
  )
}

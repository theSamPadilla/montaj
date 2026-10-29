import { useEffect, useState } from 'react'
import type { OverlayElement } from '../types'
import { hasContainerProps, readPropAsString } from '../overlays/contract'
import { NumberField, SwatchInput, Switch } from '../ui'
import { supportsRuns } from './runs'

// The text box's container: padding, corner radius, border, letter spacing and
// hug. Shown for the shipped static-text (which draws them) and for an overlay
// that already carries any of the props; a custom overlay that declares none
// gets nothing. Values are written as strings, like every other text prop.

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i
const DEFAULT_BORDER = '#000000'

const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]'

/** Whether the container controls show for this overlay. */
export function supportsContainer(element: OverlayElement): boolean {
  return supportsRuns(element) || hasContainerProps(element)
}

const FIELDS = [
  { key: 'padX', name: 'Padding X', prefix: 'X', unit: 'px', step: 1, min: 0 },
  { key: 'padY', name: 'Padding Y', prefix: 'Y', unit: 'px', step: 1, min: 0 },
  { key: 'radius', name: 'Radius', prefix: 'R', unit: 'px', step: 1, min: 0 },
  { key: 'borderWidth', name: 'Border width', prefix: 'B', unit: 'px', step: 1, min: 0 },
  { key: 'letterSpacing', name: 'Letter spacing', prefix: 'L', unit: 'em', step: 0.01 },
] as const

export interface TextContainerControlsProps {
  slideId: string
  element: OverlayElement
  updateOverlayProp: (slideId: string, elementId: string, key: string, value: string) => Promise<unknown>
  mode?: 'light' | 'dark'
}

export function TextContainerControls({ slideId, element, updateOverlayProp, mode = 'dark' }: TextContainerControlsProps) {
  const rawBorder = readPropAsString(element, 'borderColor')
  const savedBorder = HEX.test(rawBorder) ? rawBorder : DEFAULT_BORDER
  const [border, setBorder] = useState(savedBorder)
  useEffect(() => setBorder(savedBorder), [element.id, savedBorder])

  if (!supportsContainer(element)) return null

  const write = (key: string, value: string) => void updateOverlayProp(slideId, element.id, key, value)

  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabelClass}>Container</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {FIELDS.map((f) => (
          <NumberField
            key={f.key}
            name={f.name}
            value={readPropAsString(element, f.key)}
            placeholder="0"
            prefix={f.prefix}
            unit={f.unit}
            step={f.step}
            min={'min' in f ? f.min : undefined}
            onPreview={() => {}}
            onCommit={(n) => write(f.key, String(n))}
            className="w-12"
          />
        ))}
        <SwatchInput
          value={border}
          onChange={setBorder}
          onCommit={(v) => write('borderColor', v)}
          ariaLabel="Border color"
          title="Border color"
          showValue={false}
          size="sm"
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--editor-text)]">Hug text</span>
        <Switch
          checked={readPropAsString(element, 'hug') === 'true'}
          onCheckedChange={(on) => write('hug', on ? 'true' : '')}
          aria-label="Hug text"
          mode={mode}
        />
      </div>
    </div>
  )
}

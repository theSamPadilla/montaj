import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Shrink } from 'lucide-react'
import type { OverlayElement } from '../types'
import { readPropAsString } from '../overlays/contract'
import { cn, Slider, SwatchInput, Switch } from '../ui'

// One-click text effects and fit for a text overlay whose template declares
// them (static-text: `effect`, `effectColor`, `effectStrength`, `fit`). The
// template draws the effect and does the fitting, in the editor preview and in
// the render alike; this panel only writes the props.

export const TEXT_EFFECTS = ['none', 'shadow', 'outline', 'glow'] as const
export type TextEffect = (typeof TEXT_EFFECTS)[number]

const LABELS: Record<TextEffect, string> = { none: 'None', shadow: 'Shadow', outline: 'Outline', glow: 'Glow' }

// The tiles' own look, a hint of each effect (the template draws the real one).
const TILE_STYLE: Record<TextEffect, CSSProperties> = {
  none: {},
  shadow: { textShadow: '0 2px 5px rgba(0, 0, 0, 0.85)' },
  outline: { WebkitTextStroke: '3px #000000', paintOrder: 'stroke fill' },
  glow: { textShadow: '0 0 7px var(--editor-accent), 0 0 2px var(--editor-accent)' },
}

const HEX = /^#[0-9a-f]{6}$/i
const DEFAULT_EFFECT_COLOR = '#000000'

const fieldLabelClass = 'text-[11px] uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]'

/** Whether the overlay's template takes the effect props (the Effect row shows only then). */
export function supportsEffects(element: OverlayElement): boolean {
  return element.overlay.props.effect !== undefined && element.overlay.props.effect !== null
}

/** Whether the overlay's template takes `fit` (the Fit switch shows only then). */
export function supportsFit(element: OverlayElement): boolean {
  return element.overlay.props.fit !== undefined && element.overlay.props.fit !== null
}

export function readEffect(element: OverlayElement): TextEffect {
  const v = readPropAsString(element, 'effect')
  return (TEXT_EFFECTS as readonly string[]).includes(v) ? (v as TextEffect) : 'none'
}

/** A preset's starting color: a glow takes the text's own color, a shadow or an outline black. */
export function presetColor(effect: TextEffect, textColor: string): string {
  if (effect === 'glow') return HEX.test(textColor) ? textColor : '#ffffff'
  return DEFAULT_EFFECT_COLOR
}

function readStrength(element: OverlayElement): number {
  const n = parseFloat(readPropAsString(element, 'effectStrength'))
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 100) : 60
}

export interface TextEffectControlsProps {
  slideId: string
  element: OverlayElement
  updateOverlayProp: (slideId: string, elementId: string, key: string, value: string) => Promise<void>
  mode?: 'light' | 'dark'
}

export function TextEffectControls({ slideId, element, updateOverlayProp, mode = 'dark' }: TextEffectControlsProps) {
  const hasEffects = supportsEffects(element)
  const hasFit = supportsFit(element)
  const effect = readEffect(element)
  const savedStrength = readStrength(element)
  const rawColor = readPropAsString(element, 'effectColor')
  const savedColor = HEX.test(rawColor) ? rawColor : DEFAULT_EFFECT_COLOR

  // The slider and the swatch preview locally and write once, on release / close.
  const [strength, setStrength] = useState(savedStrength)
  const [color, setColor] = useState(savedColor)
  useEffect(() => setStrength(savedStrength), [element.id, savedStrength])
  useEffect(() => setColor(savedColor), [element.id, savedColor])

  if (!hasEffects && !hasFit) return null

  const write = (key: string, value: string) => void updateOverlayProp(slideId, element.id, key, value)

  const pick = (next: TextEffect) => {
    if (next === effect) return
    write('effect', next)
    if (next !== 'none') write('effectColor', presetColor(next, readPropAsString(element, 'color')))
  }

  return (
    <div className="flex flex-col gap-4">
      {hasEffects && (
        <div className="flex flex-col gap-2">
          <span className={fieldLabelClass}>Effect</span>
          <div role="radiogroup" aria-label="Text effect" className="grid grid-cols-4 gap-1.5">
            {TEXT_EFFECTS.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={effect === name}
                aria-label={LABELS[name]}
                onClick={() => pick(name)}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md border px-1 py-2 transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]',
                  'bg-[color-mix(in_srgb,var(--editor-text)_8%,var(--editor-surface))]',
                  effect === name
                    ? 'border-[var(--editor-accent)] ring-1 ring-[var(--editor-accent)]'
                    : 'border-[var(--editor-border)] hover:border-[var(--editor-accent)]',
                )}
              >
                <span aria-hidden="true" className="text-lg font-extrabold leading-none text-white" style={TILE_STYLE[name]}>
                  Aa
                </span>
                <span className="text-[11px] text-[color-mix(in_srgb,var(--editor-text)_70%,transparent)]">{LABELS[name]}</span>
              </button>
            ))}
          </div>
          {effect !== 'none' && (
            <div className="flex items-center gap-2">
              <SwatchInput
                value={color}
                onChange={setColor}
                onCommit={(v) => write('effectColor', v)}
                ariaLabel="Effect color"
                showValue={false}
                size="sm"
              />
              <Slider
                value={strength}
                min={0}
                max={100}
                step={1}
                onChange={setStrength}
                onCommit={(v) => write('effectStrength', String(v))}
                aria-label="Effect strength"
                className="min-w-0 flex-1"
              />
              <span className="w-9 text-right text-xs tabular-nums text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)]">
                {strength}%
              </span>
            </div>
          )}
        </div>
      )}
      {hasFit && (
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm text-[var(--editor-text)]">
            <Shrink className="h-3.5 w-3.5 text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)]" aria-hidden="true" />
            Fit to box
          </span>
          <Switch
            checked={readPropAsString(element, 'fit') === 'true'}
            onCheckedChange={(on) => write('fit', on ? 'true' : 'false')}
            aria-label="Fit text to the box"
            mode={mode}
          />
        </div>
      )}
    </div>
  )
}

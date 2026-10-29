import type { OverlayElement } from '../types'

// The 9-prop editable-text contract. Single source of truth on the FE for
// which prop keys the floating text toolbar knows how to write. Mirrors
// hub/backend/src/modules/mcp/overlay-contract.ts REQUIRED_PROPS.
export const STANDARD_TEXT_PROPS: ReadonlySet<string> = new Set([
  'text', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
  'color', 'textAlign', 'textTransform', 'bgColor',
])

/**
 * Returns the subset of STANDARD_TEXT_PROPS present (non-null) on the
 * element. Toolbar controls render only when their target prop is in this set.
 *
 * Forgiving on value type: numeric values (e.g. `fontSize: 64`) count as
 * present. The toolbar reads them via String(value) and writes back as
 * strings — fixing the round-trip silently rather than blocking the operator
 * with a "this overlay isn't editable" message. Per the resolved product
 * question, this prefers UX over strictness; non-string values on contract
 * props are still flagged upstream by hub.write_overlay's validator.
 */
export function getSupportedProps(element: OverlayElement): Set<string> {
  const props = element.overlay.props
  const supported = new Set<string>()
  for (const key of STANDARD_TEXT_PROPS) {
    const value = props[key]
    if (value !== undefined && value !== null) supported.add(key)
  }
  return supported
}

/**
 * Read a contract prop's current value as a string, coercing numbers. Used
 * by the toolbar's read paths so the displayed control value matches what's
 * on the element regardless of its stored type.
 */
export function readPropAsString(element: OverlayElement, key: string): string {
  const value = element.overlay.props[key]
  if (value === undefined || value === null) return ''
  return String(value)
}

// Optional container props a text overlay may declare (static-text: padding,
// radius, border, letter spacing, hug). Kept apart from STANDARD_TEXT_PROPS,
// which is the required 9-prop contract; the container controls gate on these.
export const CONTAINER_TEXT_PROPS: ReadonlySet<string> = new Set([
  'padX', 'padY', 'radius', 'borderWidth', 'borderColor', 'letterSpacing', 'hug',
])

/** Whether the element already carries any optional container prop. */
export function hasContainerProps(element: OverlayElement): boolean {
  const props = element.overlay.props
  for (const key of CONTAINER_TEXT_PROPS) {
    if (props[key] !== undefined && props[key] !== null) return true
  }
  return false
}

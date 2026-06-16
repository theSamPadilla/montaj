/**
 * editor-core / theme — the default theme for the editor running inside Montaj,
 * plus the `applyTheme` helper that projects an `EditorTheme` onto an element as
 * CSS custom properties.
 *
 * ── CSS variable naming convention ───────────────────────────────────────────
 * Every token is written as a custom property prefixed `--editor-`:
 *   colors   →  --editor-bg, --editor-surface, --editor-accent,
 *               --editor-text, --editor-border, --editor-selection
 *   fonts    →  --editor-font-sans, --editor-font-serif, --editor-font-display
 *   radii    →  --editor-radius-{sm|md|lg}
 *   spacing  →  --editor-space-{n}   (n = scale step)
 *
 * Optional tokens (serif/display fonts) are only written when present, so a
 * host can detect their absence via an empty `getPropertyValue`. Editor styles
 * reference these vars exclusively, which is what lets a host re-theme the same
 * component without forking its CSS.
 */
import type { EditorTheme } from './types'

/**
 * Montaj's default editor theme. Values mirror Montaj's existing Tailwind /
 * `index.css` palette, which is dark-first:
 *   background  gray-900  (#111827, matches `surface.DEFAULT`)
 *   surface     gray-800  (#1f2937, matches `surface.raised`)
 *   border      gray-700  (#374151, matches `surface.overlay`)
 *   text        gray-100  (#f3f4f6, matches `html.dark` text)
 *   accent      indigo-500 (#6366f1) — Montaj's interactive accent
 *   selection   indigo-400 (#818cf8) — element-selection highlight
 *   font        Inter (the configured `fontFamily.sans`)
 */
export const defaultMontajTheme: EditorTheme = {
  colors: {
    background: '#111827',
    surface: '#1f2937',
    accent: '#6366f1',
    text: '#f3f4f6',
    border: '#374151',
    selection: '#818cf8',
  },
  fonts: {
    sans: "'Inter', system-ui, -apple-system, sans-serif",
  },
  radii: {
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
  },
  spacing: {
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    6: '1.5rem',
    8: '2rem',
  },
}

/**
 * Write `theme`'s tokens onto `el` as CSS custom properties following the
 * convention documented at the top of this file. Idempotent — calling it again
 * with a different theme overwrites the previously-set vars.
 */
export function applyTheme(el: HTMLElement, theme: EditorTheme): void {
  const { style } = el

  // Colors
  style.setProperty('--editor-bg', theme.colors.background)
  style.setProperty('--editor-surface', theme.colors.surface)
  style.setProperty('--editor-accent', theme.colors.accent)
  style.setProperty('--editor-text', theme.colors.text)
  style.setProperty('--editor-border', theme.colors.border)
  style.setProperty('--editor-selection', theme.colors.selection)

  // Fonts — sans is required; serif/display are written only when present.
  style.setProperty('--editor-font-sans', theme.fonts.sans)
  if (theme.fonts.serif !== undefined) {
    style.setProperty('--editor-font-serif', theme.fonts.serif)
  }
  if (theme.fonts.display !== undefined) {
    style.setProperty('--editor-font-display', theme.fonts.display)
  }

  // Radii
  style.setProperty('--editor-radius-sm', theme.radii.sm)
  style.setProperty('--editor-radius-md', theme.radii.md)
  style.setProperty('--editor-radius-lg', theme.radii.lg)

  // Spacing scale — one var per step.
  for (const [step, value] of Object.entries(theme.spacing)) {
    style.setProperty(`--editor-space-${step}`, value)
  }
}

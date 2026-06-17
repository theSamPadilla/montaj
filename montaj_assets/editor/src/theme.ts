/**
 * editor-core / theme — the default theme for the editor running inside Montaj,
 * plus the `applyTheme` helper that projects an `EditorTheme` onto an element as
 * CSS custom properties.
 *
 * ── CSS variable naming convention ───────────────────────────────────────────
 * Every token is written as a custom property prefixed `--editor-`:
 *   colors   →  --editor-bg, --editor-surface, --editor-accent,
 *               --editor-accent-foreground, --editor-text, --editor-border,
 *               --editor-selection
 *   fonts    →  --editor-font-sans, --editor-font-serif, --editor-font-display
 *   radii    →  --editor-radius-{sm|md|lg}
 *   spacing  →  --editor-space-{n}   (n = scale step)
 *
 * Optional tokens (serif/display fonts) are only written when present, so a
 * host can detect their absence via an empty `getPropertyValue`. The carousel
 * editor chrome (shell, panels, toolbars, buttons, selection handles)
 * references these vars via Tailwind arbitrary values (`bg-[var(--editor-bg)]`,
 * etc.) and inline styles — so passing a host theme actually re-skins the
 * editor, rather than only setting CSS vars nothing reads.
 */
import type { EditorTheme } from './types'

/**
 * Montaj's default editor theme. Values are chosen to preserve the look the
 * chrome rendered before it was var-driven, which used three distinct grays:
 *   background  gray-950  (#030712) — the editor shell (`bg-gray-950`)
 *   surface     gray-900  (#111827) — raised panels/inputs/buttons (the
 *                          dominant of the former gray-900/gray-800 surfaces)
 *   border      gray-800  (#1f2937) — the dominant hairline (former
 *                          gray-800/700 borders)
 *   text        gray-100  (#f3f4f6) — primary text
 *   accent      indigo-500 (#6366f1) — Montaj's interactive accent (Render
 *                          button, focus rings, accent borders)
 *   accentForeground white (#ffffff) — readable on the indigo accent
 *   selection   indigo-400 (#818cf8) — element-selection outline/handles
 *                          (the former hardcoded #3b82f6 blue)
 *   font        Inter (the configured `fontFamily.sans`)
 *
 * Collapsing the former 3-gray surface/border set into bg/surface/border keeps
 * Montaj's chrome visually stable; muted text is rendered as `text` at reduced
 * opacity by the chrome rather than as a separate token.
 */
export const defaultMontajTheme: EditorTheme = {
  colors: {
    background: '#030712',
    surface: '#111827',
    accent: '#6366f1',
    accentForeground: '#ffffff',
    text: '#f3f4f6',
    border: '#1f2937',
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
  // Accent-foreground falls back to `text` so it's never empty (e.g. a host
  // theme that omits it still gets a readable foreground for accent controls).
  style.setProperty('--editor-accent-foreground', theme.colors.accentForeground ?? theme.colors.text)
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

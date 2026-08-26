/**
 * editor-core / theme — the default theme for the editor running inside Montaj,
 * plus the `applyTheme` helper that projects an `EditorTheme` onto an element as
 * CSS custom properties.
 *
 * ── CSS variable naming convention ───────────────────────────────────────────
 * Every token is written as a custom property prefixed `--editor-`:
 *   colors   →  --editor-bg, --editor-surface, --editor-accent,
 *               --editor-accent-foreground, --editor-accent-text, --editor-text,
 *               --editor-border, --editor-selection
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
 * Montaj's light editor theme — the counterpart to `defaultMontajTheme` for
 * hosts that toggle to light mode. Values are chosen to mirror the dark
 * palette's relationships rather than its literal colors:
 *   background  gray-100  (#f3f4f6) — the editor shell
 *   surface     white     (#ffffff) — raised panels/inputs/buttons, brighter
 *                          than the shell (the dark theme's surface is
 *                          lighter than its bg too, just inverted in sense)
 *   border      gray-200  (#e5e7eb) — the hairline
 *   text        gray-900  (#111827) — primary text
 *   accent      indigo-500 (#6366f1) — unchanged from the dark theme; Montaj's
 *                          interactive accent reads fine on either ground
 *   accentForeground white (#ffffff) — unchanged; readable on the indigo accent
 *   selection   indigo-500 (#6366f1) — deliberately darker than the dark
 *                          theme's indigo-400 (#818cf8) so the selection
 *                          outline has enough contrast against a light ground
 *   font        Inter (identical to the dark theme)
 *
 * fonts/radii/spacing are identical to `defaultMontajTheme` — only the color
 * ramp changes between modes.
 */
export const lightMontajTheme: EditorTheme = {
  colors: {
    background: '#f3f4f6',
    surface: '#ffffff',
    accent: '#6366f1',
    accentForeground: '#ffffff',
    text: '#111827',
    border: '#e5e7eb',
    selection: '#6366f1',
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
 * Relative-luminance test on `theme.colors.background`, used to classify a
 * theme as light or dark. Exists because the canvas timeline and
 * `VideoEditor` render onto an HTML canvas — they can't rely on CSS to pick
 * their palette, so they need a cheap, direct way to ask "is this theme
 * light?" without the `EditorTheme` type growing timeline-specific color
 * tokens (background/grid/playhead/etc.) that only those two consumers care
 * about. Parses 3- and 6-digit `#rgb`/`#rrggbb` hex; an unparseable or
 * unrecognized color string falls back to `false` (dark), since dark has
 * always been the default here and must never silently regress.
 */
export function isLightTheme(theme: EditorTheme): boolean {
  const hex = theme.colors.background.trim()
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex)
  if (!match) return false

  const digits = match[1]
  const expand = (c: string): number => parseInt(c + c, 16)

  let r: number
  let g: number
  let b: number
  if (digits.length === 3) {
    r = expand(digits[0])
    g = expand(digits[1])
    b = expand(digits[2])
  } else {
    r = parseInt(digits.slice(0, 2), 16)
    g = parseInt(digits.slice(2, 4), 16)
    b = parseInt(digits.slice(4, 6), 16)
  }

  // Standard relative-luminance weighting (ITU-R BT.601-ish perceptual
  // weights); thresholded at the midpoint of the 0-255 range.
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b
  return luminance > 127.5
}

/**
 * Write `theme`'s tokens onto `el` as CSS custom properties following the
 * convention documented at the top of this file. Idempotent — calling it again
 * with a different theme overwrites the previously-set vars.
 */
export function applyTheme(el: HTMLElement, theme: EditorTheme): void {
  // Write the vars onto the editor container AND :root. The container is the
  // primary target (scopes the theme to the editor); mirroring to
  // document.documentElement lets components that portal OUTSIDE the container —
  // RenderModal renders to document.body so a transformed/filtered host ancestor
  // can't break its `fixed` overlay — still resolve `var(--editor-*)`. Without
  // this, those var()-based backgrounds fall back to transparent. Harmless: the
  // vars are all `--editor-*` prefixed and unused outside editor components.
  writeThemeVars(el.style, theme)
  if (typeof document !== 'undefined') {
    writeThemeVars(document.documentElement.style, theme)
  }
}

function writeThemeVars(style: CSSStyleDeclaration, theme: EditorTheme): void {
  // Colors
  style.setProperty('--editor-bg', theme.colors.background)
  style.setProperty('--editor-surface', theme.colors.surface)
  style.setProperty('--editor-accent', theme.colors.accent)
  // Accent-foreground falls back to `text` so it's never empty (e.g. a host
  // theme that omits it still gets a readable foreground for accent controls).
  style.setProperty('--editor-accent-foreground', theme.colors.accentForeground ?? theme.colors.text)
  // Accent as small TEXT. In LIGHT mode the indigo-500 accent falls just under
  // the 4.5:1 AA floor as ~10px text on the light ground (~4.06:1), so accent
  // text nudges to indigo-600 (#4f46e5) there. Dark mode (and any host theme)
  // keeps the accent unchanged. Fills, borders, rings and buttons keep
  // `--editor-accent`; ONLY small accent text should read this token.
  style.setProperty('--editor-accent-text', isLightTheme(theme) ? '#4f46e5' : theme.colors.accent)
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

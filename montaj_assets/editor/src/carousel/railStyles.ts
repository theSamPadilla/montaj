// The carousel editor's look (§587 R5b): Montaj's own type, colours, radii and
// controls, as class strings the carousel's surfaces share. Carousel-only: the
// editor's `ui/*` primitives also draw the video editor and keep their defaults.
//
// Every colour comes from the theme vars, so a host theme still re-skins it.
// With Montaj's light theme (ink #1c1c1e on paper #ffffff, card #f6f6f7,
// hairline #e2e2e5) the mixes below land on the app's own greys:
//   muted  64% ink on paper = #6e6e6f (the app's #6e6e73)
//   faint  41% ink on paper = #a2a2a3 (the app's #a1a1a6)
// They mix with the surface, not with transparent, so the grey is solid and
// reads the same on the rail's card ground as on paper.
//
// Plain `hover:` and `disabled:` only: the package builds under the host's
// Tailwind and its own, and neither knows the other's custom variants.

/** Muted text and icons at rest. */
export const railMuted = 'text-[color-mix(in_srgb,var(--editor-text)_64%,var(--editor-surface))]'
/** The quiet label grey: placeholders, units, a grip. */
export const railFaint = 'text-[color-mix(in_srgb,var(--editor-text)_41%,var(--editor-surface))]'
export const railFaintPlaceholder = 'placeholder:text-[color-mix(in_srgb,var(--editor-text)_41%,var(--editor-surface))]'
/** Primary text. */
export const railInk = 'text-[var(--editor-text)]'
/** The hover wash under a row or a quiet control. */
export const railHoverBg = 'hover:bg-[color-mix(in_srgb,var(--editor-text)_4%,transparent)]'
/** A selected row, a pressed tool: a light brand tint, never an outline. */
export const railSelectedBg = 'bg-[color-mix(in_srgb,var(--editor-accent)_10%,transparent)]'
export const railOnBg = 'bg-[color-mix(in_srgb,var(--editor-accent)_12%,transparent)]'

export const railFocus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--editor-accent)]'
const disabled = 'disabled:cursor-not-allowed disabled:opacity-40'

// ── Type ────────────────────────────────────────────────────────────────────

/** A panel's title (Text, Graphics, AI image, Colour, Notes). */
export const railTitle = 'text-[15px] font-extrabold tracking-[-0.02em] text-[var(--editor-text)]'
/** A section or field label: Montaj's eyebrow. */
export const railEyebrow = `text-[11px] font-semibold uppercase tracking-wider ${railMuted}`
/** Secondary copy under a title. */
export const railNote = `text-xs ${railMuted}`

// ── Controls ────────────────────────────────────────────────────────────────

/** An icon-only tool, 32px square with 10px corners: muted, ink on hover. */
export const railIconBtn = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors ${railMuted} hover:bg-[color-mix(in_srgb,var(--editor-text)_4%,transparent)] hover:text-[var(--editor-text)] ${disabled} ${railFocus}`
/** The same tool where a row only has 28px. */
export const railIconBtnSm = `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] transition-colors ${railMuted} hover:bg-[color-mix(in_srgb,var(--editor-text)_4%,transparent)] hover:text-[var(--editor-text)] ${disabled} ${railFocus}`
/** A labelled tool (Edit, Position, Crop): 32px, 10px corners, 13px at 600. */
export const railToolBtn = `inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold whitespace-nowrap transition-colors ${railMuted} hover:bg-[color-mix(in_srgb,var(--editor-text)_4%,transparent)] hover:text-[var(--editor-text)] ${disabled} ${railFocus}`
/** A tool that is on: the brand tint and ink. Merge it in with `cn`, after the tool's class. */
export const railToolOn = `${railOnBg} text-[var(--editor-text)]`

/** A bordered tool in a row of them (align, layer order): paper, a hairline, 10px corners. Add the height and width. */
export const railOutlineTool = `flex items-center justify-center rounded-[10px] border border-[var(--editor-border)] bg-[var(--editor-surface)] transition-colors ${railMuted} hover:border-[var(--editor-text)] hover:text-[var(--editor-text)] disabled:hover:border-[var(--editor-border)] ${disabled} ${railFocus}`

/** The one forward action in a panel: a 40px brand pill. */
export const railPrimaryBtn = `inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold whitespace-nowrap bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] transition-colors hover:opacity-90 ${disabled} ${railFocus} focus-visible:ring-offset-2`
/** An alternative action: a 32px paper pill with a hairline. */
export const railSecondaryBtn = `inline-flex h-8 items-center justify-center gap-1.5 rounded-full border-[1.5px] border-[var(--editor-border)] bg-[var(--editor-surface)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--editor-text)] transition-colors hover:border-[var(--editor-text)] ${disabled} ${railFocus} focus-visible:ring-offset-2`
/** A quiet text action (the bottom bar's Fit and Slides): a 32px ghost pill. */
export const railGhostBtn = `inline-flex h-8 items-center justify-center rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors ${railMuted} hover:bg-[color-mix(in_srgb,var(--editor-text)_4%,transparent)] hover:text-[var(--editor-text)] ${disabled} ${railFocus}`

/** A text field: the editor's 32px field with Montaj's 10px corners and brand ring. */
export const railField = `w-full rounded-[10px] border border-[var(--editor-border)] bg-[var(--editor-surface)] px-3 text-sm text-[var(--editor-text)] ${railFaintPlaceholder} focus:outline-none focus:ring-2 focus:ring-[var(--editor-accent)] disabled:opacity-40`
/** Laid over `inspectorInputClass` (through `cn`) where the carousel uses the shared field. */
export const railFieldShape = 'rounded-[10px] focus:border-[var(--editor-border)] focus:ring-2 disabled:opacity-40'

/** A field whose text did not resolve: a danger ring (the host's `--editor-danger`, red by default). */
export const railInvalid = 'ring-2 ring-[color-mix(in_srgb,var(--editor-danger,#dc2626)_60%,transparent)]'

/** A keyboard shortcut chip. */
export const railKeycap = 'inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-b-2 border-[var(--editor-border)] bg-[var(--editor-surface)] px-[7px] font-mono text-[11px] font-semibold text-[var(--editor-text)]'

/** A tile in a panel's grid (a graphic, a shape). */
export const railTile = `rounded-2xl border border-[var(--editor-border)] bg-[var(--editor-surface)] transition-colors hover:border-[var(--editor-accent)] disabled:opacity-40 ${railFocus}`

// ── Menus ───────────────────────────────────────────────────────────────────

export const railMenu = 'rounded-lg border border-[var(--editor-border)] bg-[var(--editor-surface)] py-1 shadow-lg'
export const railMenuItem = `w-full flex items-center justify-between gap-4 px-3 py-2 text-left text-sm text-[var(--editor-text)] ${railHoverBg}`

// ── Colour and font pickers ─────────────────────────────────────────────────

/** A colour swatch: 10px corners, a hairline, no shadow. Add the size. */
export const railSwatch = `rounded-[10px] border border-[var(--editor-border)] ${disabled} ${railFocus}`
/** The "Use brand default" row: a highlighted first row in the selected-row tint, no bar. */
export const railBrandRow = `flex items-center rounded-xl text-sm font-semibold ${railInk} ${railSelectedBg} hover:bg-[color-mix(in_srgb,var(--editor-accent)_16%,transparent)] ${disabled} ${railFocus}`

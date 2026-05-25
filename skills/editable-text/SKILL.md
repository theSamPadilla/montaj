---
name: editable-text
description: "Author carousel text overlays whose font/size/color/etc. the operator can edit from the editor toolbar. Load when authoring text overlays inside a carousel project."
---

# Editable Text

Carousel text overlays must accept a fixed set of editor-facing props so the floating toolbar (bold / italic / case / align / font-size / font-family / color) works uniformly. This skill spells out the 9-prop contract.

## When this applies

This skill applies to carousel projects only. It covers text overlays — specifically, overlays whose default-exported function destructures a prop named `text`. Non-text overlays (logos, decorative shapes, image-based overlays, stylized brand marks where the text is the design and should not be operator-restyleable) are exempt and follow `skills/write-overlay/SKILL.md` instead.

## The contract

A carousel editable-text overlay is any JSX file under `<project_dir>/overlays/*.jsx` that displays text the operator should be able to restyle from the editor toolbar.

Such an overlay MUST:

1. Have an `export default function …` declaration (named or anonymous fine; arrow `export default (props) => …` is **not** allowed — destructuring with defaults is required).
2. Destructure all 9 props with string defaults in the function signature:
   ```jsx
   export default function MyHeadline({
     text          = 'Your headline',
     fontSize      = '64',
     fontFamily    = 'system-ui, -apple-system, sans-serif',
     fontWeight    = '700',
     fontStyle     = 'normal',
     color         = '#111111',
     textAlign     = 'center',
     textTransform = 'none',
     bgColor       = 'transparent',
   }) {
     // …
   }
   ```
3. Apply those props via inline `style` on the text element. Specifically:
   - `text` is the rendered string.
   - `fontSize` is coerced to a number with NaN-fallback (per `static-text.jsx`).
   - `fontFamily`, `fontWeight`, `fontStyle`, `color`, `textAlign`, `textTransform` go straight into `style`.
   - `bgColor` controls the overlay's backdrop (set via `style.background` on the outer wrapper; `'transparent'` is the no-backdrop case).
4. Not animate. Carousel slides are still images. No `frame`, `fps`, `interpolate`, or `spring`.

## Affordances

### Defaults are yours.

The 9 props are the *editable surface*; the *values* of the defaults are the aesthetic. The agent picks the font, size, weight, color, and alignment per slot. Hook headline wants Inter bold 64px? Body copy wants Merriweather 28px regular? Eyebrow wants Space Mono uppercase 20px? Encode all of that in the defaults. The operator can deviate; the agent's choice is the starting point.

### Additional props are unbounded.

The 9 props are a floor, not a ceiling. The agent may add any other props (gradients, accents, icon refs, subtitle blocks, animation timing for non-text-style features, etc.). The contract only says these 9 must be present and applied; nothing limits what else the overlay accepts.

## Worked examples

**Hook headline** — large, bold, sans, centered:

```jsx
// overlays/hook.jsx — slide 1 hook headline.
export default function Hook({
  text          = 'The 3 ingredients that actually work',
  fontSize      = '72',
  fontFamily    = '"Inter", system-ui, sans-serif',
  fontWeight    = '800',
  fontStyle     = 'normal',
  color         = '#0a0a0a',
  textAlign     = 'center',
  textTransform = 'none',
  bgColor       = 'transparent',
}) {
  const sizeNum  = Number(fontSize)
  const safeSize = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 72
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: bgColor, padding: '8% 10%', boxSizing: 'border-box',
    }}>
      <p style={{
        margin: 0, color, fontFamily, fontWeight, fontStyle,
        fontSize: safeSize, textAlign, textTransform,
        lineHeight: 1.1, letterSpacing: '-0.02em',
        width: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      }}>{text}</p>
    </div>
  )
}
```

**Body copy** — readable serif, left-aligned, on a card background:

```jsx
// overlays/body.jsx — middle-slide body block.
export default function Body({
  text          = 'Niacinamide brightens. Retinol turns over cells. SPF protects what you have.',
  fontSize      = '28',
  fontFamily    = '"Merriweather", Georgia, serif',
  fontWeight    = '400',
  fontStyle     = 'normal',
  color         = '#222222',
  textAlign     = 'left',
  textTransform = 'none',
  bgColor       = '#f5f0e8',
}) {
  const sizeNum  = Number(fontSize)
  const safeSize = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 28
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'flex-start',
      background: bgColor, padding: '8% 9%', boxSizing: 'border-box',
    }}>
      <p style={{
        margin: 0, color, fontFamily, fontWeight, fontStyle,
        fontSize: safeSize, textAlign, textTransform,
        lineHeight: 1.45, letterSpacing: '0',
        width: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      }}>{text}</p>
    </div>
  )
}
```

**Eyebrow / kicker** — small, uppercase, tracked, with optional accent. This example also accepts `accentColor` beyond the 9-prop contract, illustrating the "additional props are unbounded" affordance:

```jsx
// overlays/eyebrow.jsx — section label / kicker. Accepts an extra accentColor
// prop beyond the 9-prop contract; that's fine — additional props are allowed.
export default function Eyebrow({
  text          = 'Step 02',
  fontSize      = '20',
  fontFamily    = '"Space Mono", ui-monospace, monospace',
  fontWeight    = '500',
  fontStyle     = 'normal',
  color         = '#0a0a0a',
  textAlign     = 'center',
  textTransform = 'uppercase',
  bgColor       = 'transparent',
  accentColor   = '#ff5630',
}) {
  const sizeNum  = Number(fontSize)
  const safeSize = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 20
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: bgColor, padding: '4% 6%', boxSizing: 'border-box',
    }}>
      <span style={{ display: 'inline-block', width: 32, height: 2, background: accentColor, marginRight: 12 }} />
      <p style={{
        margin: 0, color, fontFamily, fontWeight, fontStyle,
        fontSize: safeSize, textAlign, textTransform,
        letterSpacing: '0.18em',
      }}>{text}</p>
    </div>
  )
}
```

## Don't do this

The overlay below renders correctly today, but the editor toolbar's bold, italic, font-size, and color buttons all no-op on it. It hardcodes styles directly, uses `copy` instead of `text`, and has no destructured defaults — none of the 9 contract props are present.

```jsx
// DON'T — hardcoded styles, `copy` instead of `text`, no destructured defaults.
// The editor toolbar's bold/italic/font-size/color buttons all no-op on this.
export default function Headline({ copy }) {
  return (
    <div style={{
      fontFamily: 'Inter, system-ui',
      fontWeight: 900,
      fontSize:   72,
      color:      '#111',
    }}>{copy}</div>
  )
}
```

Rewrite to the contract.

## Canonical reference

`montaj_assets/render/templates/overlays/static-text/static-text.jsx` is the canonical conformant implementation. If anything in this skill is unclear, read it.

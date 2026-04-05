---
name: write-overlay
description: "Write a custom JSX overlay component and add it to the project's overlay track."
---

# Write Overlay

An overlay is a React component rendered frame-by-frame by Puppeteer, composited over the footage at a specific timestamp. All overlays are custom JSX — there are no built-in templates.

---

## Execution context

Custom overlay JSX runs in a sandboxed evaluator. All identifiers below are injected as globals:

| Identifier | Type | Description |
|------------|------|-------------|
| `frame` | number | Current frame number (0 → duration-1). Drives all animation. |
| `fps` | number | Output frame rate |
| `duration` | number | Total frames this overlay is visible for |
| `props` | object | The `props` object from the project.json item |
| `interpolate` | function | Map a frame number to any output value |
| `spring` | function | Physics-based easing (0 → 1) |
| `Ph` | object | All [Phosphor Icons](https://phosphoricons.com) — e.g. `Ph.House`, `Ph.ArrowRight` |
| `FaIcon` | component | `FontAwesomeIcon` renderer — use with `FaSolid` / `FaBrands` icon objects |
| `FaSolid` | object | All [FA Free Solid](https://fontawesome.com/icons?s=solid) icon objects — e.g. `FaSolid.faHouse` |
| `FaBrands` | object | All [FA Free Brands](https://fontawesome.com/icons?s=brands) icons — e.g. `FaBrands.faGithub` |

**No imports.** All `import` statements are stripped before evaluation. Do not import anything — use the globals above instead.

### Top-level vs component-body

**All calls to `interpolate`, `spring`, and any read of `frame`, `fps`, `duration`, or `props` must be inside the component function body.** The module's top-level code runs before the render shim sets up these globals — calling them outside a function will throw `interpolate is not defined` and crash the entire render.

```jsx
// WRONG — crashes at render time
const opacity = interpolate(frame, [0, 10], [0, 1])
export default function Hook() { ... }

// CORRECT — inside the component, runs each frame
export default function Hook() {
  const opacity = interpolate(frame, [0, 10], [0, 1])
  return <div style={{ opacity }}>...</div>
}
```

Pure helper functions that receive their values as arguments are fine at the top level, as long as they don't call globals at definition time:

```jsx
// Fine — interpolate is only called when the function is invoked (inside the component)
const itemStyle = (show) => ({
  opacity: show,
  transform: `translateY(${interpolate(show, [0, 1], [20, 0])}px)`,
})

export default function List() {
  const show = spring({ frame, fps, stiffness: 300, damping: 24 })
  return <div style={itemStyle(show)}>...</div>
}
```

---

## Writing the JSX

```jsx
// overlays/hook.jsx

const progress = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' })
const slideY   = interpolate(frame, [0, 12], [30, 0], { extrapolateRight: 'clamp' })

export default function Hook() {
  return (
    <div style={{
      position: 'absolute', bottom: 120, left: 0, right: 0,
      display: 'flex', justifyContent: 'center',
      opacity: progress,
      transform: `translateY(${slideY}px)`,
    }}>
      <div style={{
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(8px)',
        borderRadius: 12, padding: '10px 22px',
        fontFamily: 'Inter, sans-serif', fontSize: 28, fontWeight: 700,
        color: '#fff', letterSpacing: '-0.3px',
      }}>
        {props.text}
      </div>
    </div>
  )
}
```

### Rules

- **Default export only** — the evaluator imports the default export
- **No hooks** — `useState`, `useEffect`, etc. are not supported in the overlay component itself. The render shim drives re-renders by calling `flushSync` externally each frame; the component must be a pure function of its props/globals.
- **Frame-driven** — all animation must derive from `frame`. No `setTimeout`, `setInterval`, CSS `animation`, or `transition`.
- **Transparent background (default)** — overlays render with a transparent background by default. Do not set `background` on the root element; it will obscure whatever is beneath it.
- **Opaque overlays** — when `"opaque": true` is set on the item in project.json, the root element's CSS controls the entire frame. You may freely set `background`, gradients, images, or any CSS on the root. Use this for full-frame covers, title cards, and canvas sections.
- **Absolute positioning** — the component fills the full video frame (`1080×1920` CSS pixels regardless of output resolution). Place elements with `position: absolute`.
- **No side effects** — no API calls, no filesystem access, no global state mutations.
- **`backdropFilter` caution** — `backdrop-filter: blur(...)` causes Chrome to create a separate GPU compositor layer that can be cached and replayed as a stale frame during rendering. Avoid putting `backdrop-filter` on any element whose children animate — the blur container will flash or freeze. See the track-splitting guidance below.

---

## Splitting background from content across tracks

The most reliable way to use frosted-glass / blurred card backgrounds is to **put the background on a separate, lower track** and the animated content on a higher track. The render pipeline composites tracks in order, so the content renders on top.

**Why this works:** A background card with `backdrop-filter` is essentially static — it fades in, then stays put. When Chrome's headless compositor caches the GPU layer for it, the cache is *correct* (the layer genuinely hasn't changed). The content overlay on the higher track has no `backdrop-filter`, so there's no caching issue and animations render cleanly every frame.

**When to split:**

| Background behavior | Animated content | Verdict |
|---------------------|-----------------|---------|
| Static or simple fade only | Any — text, icons, logos staggering in | **Split** |
| Shakes, bounces, or translates together with content | Content must move with the background | **Keep together** (no backdrop-filter, use solid `background` instead) |

**How to split in project.json:**

```json
{
  "tracks": [
    [],
    [
      {
        "id": "ov-card-bg",
        "type": "overlay",
        "src": "/path/overlays/card-bg.jsx",
        "start": 2.0,
        "end": 6.0
      }
    ],
    [
      {
        "id": "ov-card-content",
        "type": "overlay",
        "src": "/path/overlays/card-content.jsx",
        "start": 2.0,
        "end": 6.0
      }
    ]
  ]
}
```

**Background component — no animated children:**

```jsx
// overlays/card-bg.jsx
// Just a frosted card that fades in. No children that animate opacity.
const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' })

export default function CardBg() {
  return (
    <div style={{ position: 'absolute', bottom: 340, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity }}>
      <div style={{
        background: 'rgba(0,0,0,0.84)',
        backdropFilter: 'blur(24px)',
        borderRadius: 36,
        padding: '44px 72px',
        border: '1px solid rgba(255,255,255,0.10)',
        minWidth: 560,
        minHeight: 200,
      }} />
    </div>
  )
}
```

**Content component — no backdrop-filter:**

```jsx
// overlays/card-content.jsx
// Animated items rendered on top of the background card.
const s1 = spring({ frame: Math.max(0, frame - 4), fps, stiffness: 300, damping: 24 })

export default function CardContent() {
  return (
    <div style={{ position: 'absolute', bottom: 340, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
      <div style={{ padding: '44px 72px', minWidth: 560 }}>
        <div style={{ opacity: Math.min(1, s1 * 2.5), transform: `translateX(${interpolate(s1, [0, 1], [-24, 0])}px)` }}>
          <Ph.CheckCircle size={52} weight="fill" color="#34d399" />
        </div>
      </div>
    </div>
  )
}
```

**When you can't split** (background and content animate together as one unit — e.g., a card that shakes on impact), skip `backdrop-filter` entirely and use a solid or semi-transparent `background` instead:

```jsx
// Instead of backdropFilter: 'blur(24px)'
background: 'rgba(10,10,10,0.88)'  // solid dark — visually similar, no GPU layer caching
```

---

## Utilities

### `interpolate(frame, inputRange, outputRange, options?)`

Maps a frame number to any output value. Clamps at both ends by default.

```jsx
// Fade in over frames 0–15
const opacity = interpolate(frame, [0, 15], [0, 1])

// Fade in then out
const fadeIn  = interpolate(frame, [0, 15], [0, 1])
const fadeOut = interpolate(frame, [duration - 15, duration], [1, 0])
const opacity = Math.min(fadeIn, fadeOut)

// Slide in from left
const x = interpolate(frame, [0, 20], [-200, 0], { extrapolateRight: 'clamp' })
```

Options: `extrapolate`, `extrapolateLeft`, `extrapolateRight` — each `'clamp'` (default) or `'extend'`.

### `spring({ frame, fps, mass?, stiffness?, damping?, initialVelocity? })`

Returns a 0 → 1 value following spring physics. Overshoots and settles naturally.

```jsx
const scale = spring({ frame, fps, stiffness: 120, damping: 14 })
// transform: `scale(${scale})`
```

Defaults: `mass: 1`, `stiffness: 100`, `damping: 10`.

---

## Icons

Use icons instead of emojis unless the prompt explicitly asks for emojis. Icons scale cleanly, render crisply at any resolution, and look intentional.

### Phosphor Icons — `Ph`

Browse at [phosphoricons.com](https://phosphoricons.com). Over 9000 icons, six weights: `regular` (default), `bold`, `fill`, `duotone`, `light`, `thin`.

```jsx
// Basic usage
<Ph.House size={48} color="white" />

// With weight
<Ph.ArrowRight size={32} color="#a78bfa" weight="bold" />
<Ph.Star size={40} color="#fbbf24" weight="fill" />

// In a card row
<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
  <Ph.CheckCircle size={36} color="#34d399" weight="fill" />
  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 24, color: 'white' }}>Feature unlocked</span>
</div>
```

### Font Awesome — `FaIcon` + `FaSolid` / `FaBrands`

`FaIcon` is the renderer. `FaSolid` has general-purpose icons; `FaBrands` has logos (GitHub, YouTube, X, etc.).

```jsx
// Solid icon
<FaIcon icon={FaSolid.faCode} style={{ fontSize: 48, color: 'white' }} />

// Brand logo
<FaIcon icon={FaBrands.faGithub} style={{ fontSize: 48, color: 'white' }} />

// Sized via style
<FaIcon icon={FaSolid.faBolt} style={{ fontSize: 36, color: '#fbbf24' }} />
```

### Which library to use

- **Phosphor** — preferred for most overlays. Cleaner API, consistent stroke weight, large set.
- **Font Awesome Brands** — when you need a specific brand logo (GitHub, YouTube, X/Twitter, TikTok, etc.)
- **Font Awesome Solid** — for any icon Phosphor doesn't cover.

---

## Custom fonts (Google Fonts)

System fonts (`Inter`, `Impact`, `Georgia`, `Arial`, etc.) are always available and preferred for performance. To use a Google Font, declare it on the overlay item in `project.json` with a `googleFonts` array:

```json
{
  "id": "ov-hook",
  "type": "overlay",
  "src": "/path/to/overlays/hook.jsx",
  "start": 0.0,
  "end": 5.0,
  "googleFonts": ["Anton", "Playfair+Display:ital@1"]
}
```

The render engine injects the font stylesheet into the page `<head>` before any component code runs, so the font is fully loaded at frame 0.

**Do not use `@import url(...)` inside the JSX.** A dynamically-injected `@import` fires after the page loads — the font fetch is still in flight when the next overlay's page initialises, breaking its `window.__setFrame` setup. Always declare fonts in `googleFonts` instead, and reference the family name directly in styles:

```jsx
// In your JSX — just use the family name, no @import
fontFamily: '"Anton", Impact, sans-serif'
fontFamily: '"Playfair Display", Georgia, serif'
```

**Format:** `FamilyName` for regular, `FamilyName:ital@1` for italic, `FamilyName:wght@700` for a specific weight. Each family is a separate array entry.

**System font fallbacks for common Google Fonts:**

| Google Font | System fallback |
|-------------|----------------|
| Anton | Impact |
| Playfair Display | Georgia |
| Oswald | Arial Narrow |
| Roboto / Inter | system-ui, sans-serif |

If visual fidelity isn't critical, the system fallback avoids the network fetch entirely.

---

## project.json item shape

Place overlay items in `tracks[1+]` in `project.json`. Each item must have `type: "overlay"` and a `src` path pointing to the JSX file. All custom data goes inside `props`.

```json
{
  "tracks": [
    [],
    [
      {
        "id": "ov-hook",
        "type": "overlay",
        "src": "/abs/path/to/project/overlays/hook.jsx",
        "start": 0.0,
        "end": 3.0,
        "props": {
          "text": "She built an AI employee"
        }
      },
      {
        "id": "ov-logo",
        "type": "overlay",
        "src": "/abs/path/to/project/overlays/logo.jsx",
        "start": 0.0,
        "end": 999.0,
        "props": {
          "logoSrc": "/abs/path/to/project/assets/logo.png"
        }
      }
    ]
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier within the track |
| `type` | yes | Always `"overlay"` for JSX overlays |
| `src` | yes | Absolute path to the JSX file |
| `start` | yes | Start time in output video (seconds) |
| `end` | yes | End time in output video (seconds) |
| `props` | no | Arbitrary data passed through to the component as the `props` global |
| `googleFonts` | no | Google Font families to load before render (e.g. `["Anton", "Playfair+Display:ital@1"]`). See Custom fonts section. |

**Use absolute paths for `src`.** Relative paths are resolved from `project.json` location, but absolute paths are unambiguous.

---

## Using assets

Assets (logos, images) are declared in `project.assets`. Reference them by passing their `src` path in `props`, then use it in the component:

```json
{
  "id": "ov-logo",
  "type": "overlay",
  "src": "/path/to/overlays/logo.jsx",
  "start": 0.0,
  "end": 30.0,
  "props": { "src": "/path/to/assets/logo.png" }
}
```

```jsx
// overlays/logo.jsx
const opacity = interpolate(frame, [0, 6], [0, 1])

export default function Logo() {
  return (
    <img
      src={props.src}
      style={{
        position: 'absolute', top: 40, right: 40,
        width: 80, opacity,
      }}
    />
  )
}
```

In the browser preview, `/abs/path/...` asset paths are automatically rewritten to `/api/files?path=...` by the UI — the component receives the rewritten URL.

---

## Live preview in the Overlays tab

The Montaj UI has an **Overlays** tab that gives a real-time animated preview of every overlay in the project — no render needed.

- Open the **Overlays** tab and select a project from the left panel to see its overlay list
- Select any overlay item to see it playing over the preview image at full animation fidelity
- **Live reload** — the preview automatically recompiles and restarts whenever you save a `.jsx` file; latency is typically under a second
- Use the **⏸ / ▶** button in the bottom-right of the preview to pause on a specific frame
- Asset paths passed via `props` (e.g. `logoSrc`, `src`) are proxied automatically — images and logos resolve correctly in the preview even though they are absolute local paths

Use this tab to validate motion, timing, and asset rendering before committing to a full render.

---

## Writing multiple overlays in parallel

When a workflow calls for several overlays, write them concurrently — each JSX file is independent.

1. Identify all overlays needed from the editing prompt and transcript
2. Write each JSX file (parallelisable)
3. Add all items to the overlay track in a single `project.json` update

Common overlay set for a social reel:
- Opening hook (0–3s) — text statement that earns the watch
- Lower third (first speech moment) — speaker handle or title
- CTA (final 3s) — follow / subscribe / link

---

## Authoring guidelines

- **Use icons, not emojis** — use `Ph.*` or `FaIcon` for visual symbols. Emojis render inconsistently across platforms and look low-effort. Only use emojis if the prompt explicitly asks for them.
- **Tie to transcript** — use word timings from the transcript to sync text appearance with speech
- **Short text** — 2–6 words for lower-thirds, one punchy line for hooks
- **Don't overlap** — avoid two overlays occupying the same screen region at the same time
- **Style to the prompt** — match font weight, color, and motion to the tone of the edit (e.g. punchy TikTok vs polished tutorial)
- **Opening hook** — almost always appropriate for social content; fires in the first 0–3s
- **Persist after writing** — update `project.json` via `PUT /api/projects/{id}` (HTTP mode) or write directly to `project.json` (headless mode)

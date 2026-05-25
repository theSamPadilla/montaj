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
| `THREE` | namespace | All [Three.js](https://threejs.org) primitives — `THREE.Vector3`, `THREE.MathUtils`, etc. Only reach for it when you genuinely need 3D — see "3D / Three.js" section. |
| `Canvas` | component | [@react-three/fiber](https://r3f.docs.pmnd.rs) Canvas. **Always pass `frameloop="never"`** and mount a `useThreeFrame()` child — see "3D / Three.js" section. |
| `useThreeFrame` | hook | Bridges r3f to Montaj's frame-stepped renderer. Mount exactly once inside any `<Canvas>`. |

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

The default aesthetic is **plain bold text directly on video** — no card, no background, just a text shadow for legibility. Big text (96–160px) that covers the footage, including the speaker's face if needed.

```jsx
// overlays/hook.jsx — plain text on video, no background

export default function Hook() {
  const progress = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' })
  const slideY   = interpolate(frame, [0, 10], [40, 0], { extrapolateRight: 'clamp' })

  return (
    <div style={{
      position: 'absolute', bottom: 180, left: 48, right: 48,
      opacity: progress,
      transform: `translateY(${slideY}px)`,
    }}>
      <div style={{
        fontFamily: 'Anton, Impact, sans-serif', fontSize: 120, fontWeight: 900,
        color: '#fff', lineHeight: 1.05, letterSpacing: '-1px',
        textShadow: '0 2px 24px rgba(0,0,0,0.9), 0 0 60px rgba(0,0,0,0.5)',
        textTransform: 'uppercase',
      }}>
        {props.text}
      </div>
    </div>
  )
}
```

Only add a card or background when the prompt explicitly asks, or when a specific overlay type genuinely requires it (e.g. a logo lockup, an opaque title card). When you do need a background, prefer a solid semi-transparent color over `backdropFilter: blur()` — see the track-splitting section below.

### Rules

- **Default export only** — the evaluator imports the default export
- **No hooks** — `useState`, `useEffect`, etc. are not supported in the overlay component itself. The render shim drives re-renders by calling `flushSync` externally each frame; the component must be a pure function of its props/globals.
- **Frame-driven** — all animation must derive from `frame`. No `setTimeout`, `setInterval`, CSS `animation`, or `transition`.
- **Transparent background (default)** — overlays render with a transparent background by default. Do not set `background` on the root element; it will obscure whatever is beneath it.
- **Opaque overlays** — when `"opaque": true` is set on the item in project.json, the root element's CSS controls the entire frame. You may freely set `background`, gradients, images, or any CSS on the root. Use this for full-frame covers, title cards, and animation sections.
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

The render host's system fonts are always available and preferred for performance — they avoid the network fetch entirely. On macOS render hosts (today's default) you can rely on `Helvetica`, `Arial`, `Georgia`, `Times`, `Courier`, `Impact`, and the `system-ui` / `-apple-system` generic stacks. `Inter` is **not** a macOS system font — use a Google Font declaration for it.

To use a Google Font, declare it on the overlay item in `project.json` with a `googleFonts` array:

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

## 3D / Three.js (react-three-fiber)

Overlay JSX can use Three.js for real 3D content via [@react-three/fiber](https://r3f.docs.pmnd.rs). Reach for it when you need depth, particles, shader effects, 3D text, or geometry that can't be faked in 2D. **Do not use it for things 2D HTML can do** — rotations, fades, slides, gradients are all cheaper and simpler in CSS.

**Preview behavior — RAF-driven, not frame-stepped.** Three.js overlays render in both the live UI preview and the final rendered MP4. The two paths share globals and library versions via the `montaj-overlay-runtime` package, so what you see in the editor matches the render output visually. One difference to be aware of: in preview the 3D content animates via r3f's own `requestAnimationFrame` loop (the preview-context `Canvas` wrapper overrides `frameloop="never"` → `"always"` automatically), so motion is smooth but not perfectly frame-accurate to the scrubbed video position. In render, `frameloop="never"` is honored and the shim drives `gl.render()` synchronously each frame.

### Two non-negotiable rules

1. **`<Canvas frameloop="never">`.** The default r3f Canvas runs its own `requestAnimationFrame` loop, which is incompatible with Montaj's frame-stepped renderer — Puppeteer would screenshot arbitrary moments. `frameloop="never"` disables r3f's loop and lets the render shim drive each frame synchronously.
2. **Mount `useThreeFrame()` exactly once inside the Canvas.** This hook registers the synchronous render trigger the shim calls every frame. Without it, Three never draws.

Convention: put a tiny `<FrameBridge />` child component at the top of the Canvas that calls `useThreeFrame()` and returns `null`.

### Drive everything from `frame`, never `useFrame`

r3f's `useFrame` hook is tied to the internal animation loop we've disabled. **It does not work.** Compute transforms inline from the `frame` global, the same way 2D overlays do:

```jsx
export default function ThreeCube() {
  const t      = frame / fps
  const rotX   = t * Math.PI         // half-turn per second
  const rotY   = t * Math.PI * 0.7
  const pulse  = 1 + 0.08 * Math.sin(t * 4)

  return (
    <Canvas
      frameloop="never"
      style={{ position: 'absolute', inset: 0 }}
      camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
    >
      <FrameBridge />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={1.2} />
      <mesh rotation={[rotX, rotY, 0]} scale={[pulse, pulse, pulse]}>
        <boxGeometry args={[1.6, 1.6, 1.6]} />
        <meshStandardMaterial color="#3b82f6" metalness={0.3} roughness={0.35} />
      </mesh>
    </Canvas>
  )
}

function FrameBridge() {
  useThreeFrame()
  return null
}
```

### No async assets

Textures, GLTFs, and any other resource that r3f loads via Suspense will **not** load in time for frame 0 — the renderer doesn't wait for Suspense the way it waits for `document.fonts.ready`. Stick to:

- Primitive geometries: `<boxGeometry>`, `<sphereGeometry>`, `<planeGeometry>`, `<cylinderGeometry>`, `<torusGeometry>`, `<icosahedronGeometry>`, etc.
- `<meshStandardMaterial>` / `<meshBasicMaterial>` with `color` (no `map`, `normalMap`, etc.)
- Lights: `<ambientLight>`, `<directionalLight>`, `<pointLight>`, `<spotLight>`
- Math helpers from the `THREE` global (`THREE.MathUtils.lerp`, `THREE.Vector3`, etc.)

If you need a texture, render it on a 2D HTML overlay layered above the Canvas track instead.

### Canvas placement and compositing

`<Canvas>` fills its parent. Two patterns work:

**Full-frame Canvas** — apply `style={{ position: 'absolute', inset: 0 }}` directly to `<Canvas>` so it covers the whole 1080×1920 design canvas. Use when 3D content should occupy the entire frame or be anchored relative to the camera (e.g. a particle field).

**Positioned Canvas** — wrap `<Canvas>` in a `position: absolute` div with explicit `top`/`left`/`right`/`height` (or `bottom`), and set `style={{ width: '100%', height: '100%' }}` on the Canvas itself. Use when 3D content should sit in a specific region — e.g. a 3D logo lockup in the lower-third while a font overlay sits up top.

```jsx
<div style={{ position: 'absolute', top: 1100, left: 0, right: 0, height: 500 }}>
  <Canvas frameloop="never" style={{ width: '100%', height: '100%' }} ...>
    <FrameBridge />
    ...
  </Canvas>
</div>
```

Make sure `gl={{ alpha: true }}` is set — the Canvas DOM element defaults to opaque, which would paint a black or white box over the underlying footage. With `alpha: true` + the renderer's default transparent page background, only the drawn 3D geometry shows up; the rest passes through to whatever is beneath.

For text labels alongside 3D content, render them as a 2D HTML overlay on a separate track rather than as 3D text inside the Canvas. HTML text is sharper, cheaper, and supports the existing Google Fonts pipeline.

### Worked reference

A known-good minimal overlay lives at `tests/fixtures/overlays/three-cube.jsx` — it's the same file the render smoke test (`tests/test_render_three.py`) uses. Copy from it when starting a new 3D overlay; everything in it is checked end-to-end by CI.

### Bundle weight

Three.js + r3f add ~250 KB to an overlay segment's bundle after esbuild tree-shakes. Overlays that don't use `<Canvas>` pay zero cost. Don't reach for Three "just in case" — use it only when the result genuinely needs 3D.

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
- **Go large — for video.** On 1080×1920 video overlays carrying a short, glanceable hook (3–6 words) over moving footage, 96px is the floor, not the ceiling. 120–160px for hooks. Text should feel oversized; if it looks a little too big, it's probably right. This rule is calibrated to video viewing — a thumb-stop on TikTok/Reels. **Do NOT apply this rule to carousels, story panels, or other static formats** where the text is being *read* rather than *glanced at*, and where headlines run longer than a punchy hook. For carousels see `skills/carousel/SKILL.md` §6 (Typography). For other static formats, default to ~32–48px body, ~52–80px headline, and size down further as line length grows.
- **No backgrounds by default** — plain text on video with `textShadow` for legibility is the house style. No dark cards, no frosted glass, no semi-transparent boxes unless the prompt asks. A well-placed `textShadow` works on any footage.
- **Cover the face if needed** — text position and size take priority. Don't shrink or reposition to avoid the speaker.
- **Tie to transcript** — use word timings from the transcript to sync text appearance with speech. An overlay that appears exactly when the speaker says the word it displays lands much harder.
- **Match the energy of the speech** — fast, punchy delivery: 4–6 frame entrances. Slower delivery: 10–15 frame fades or slides.
- **Short text** — 2–6 words for lower-thirds, 4–8 for hooks. Short + large beats long + small.
- **One accent color max** — white text with one colored word or icon. Multi-color text reads as noise.
- **Avoid the bottom ~350px** — captions render here, and platform UI (TikTok progress bar, Instagram controls) sits in this zone. Use `bottom: 350` or higher, or anchor from the top instead.
- **Avoid the right ~200px** — TikTok/Instagram action buttons (like, comment, share) occupy the right edge. Keep text and icons within `right: 200` or use `left`-anchored layout.
- **Don't overlap** — avoid two overlays occupying the same screen region at the same time
- **Style to the prompt** — match font weight, color, and motion to the tone of the edit
- **Opening hook** — almost always appropriate for social content; fires in the first 0–3s
- **Persist after writing** — update `project.json` via `PUT /api/projects/{id}` (HTTP mode) or write directly to `project.json` (headless mode)

# Overlay Schema

> Defines the contract for overlay components — both how they are written (JSX) and how they are referenced in project.json.

---

## What an overlay is

A React component rendered frame-by-frame by the render engine into a transparent video segment, then composited over the footage at a specific timestamp.

All animation is driven by the `frame` prop. No timers, no `useEffect`, no CSS transitions. Same frame in = same frame out. Deterministic.

---

## JSX contract

Every overlay component must follow this interface:

```jsx
export default function MyOverlay({ frame, fps, duration, ...props }) {
  // frame    — current frame number (0 → duration-1)
  // fps      — frames per second of the output video
  // duration — total frames this overlay is visible for
  // ...props — spread of the props object from the project.json item

  const opacity = interpolate(frame, [0, 10], [0, 1])

  return (
    <div style={{ opacity }}>
      {props.text}
    </div>
  )
}
```

**No imports.** Custom overlay JSX is executed in a sandboxed context where all `import` statements are stripped before evaluation. `interpolate` and `spring` are injected as globals — do not import them. Do not import anything else; those imports will be silently dropped at runtime.

### Required props

| Prop | Type | Description |
|------|------|-------------|
| `frame` | number | Current frame number. Drives all animation. |
| `fps` | number | Output frame rate |
| `duration` | number | Total frames this overlay is visible |

### Rules

- **Default export only** — render engine imports the default export
- **Transparent background** — by default, overlays render as transparent WebM and composite over whatever is beneath them (footage or other overlay tracks). To make an overlay opaque, set `"opaque": true` on the item in project.json. When opaque, the JSX root element's background — solid color, gradient, pattern, animated background, any CSS — fills the frame fully and covers everything beneath it.
- **Frame-driven** — all animation must derive from `frame`. No `setTimeout`, no `setInterval`, no CSS `animation` or `transition`
- **No side effects** — no API calls, no filesystem access, no global state mutations
- **Fixed dimensions** — component fills the full video frame. Use absolute positioning for placement within it

### Utilities

Both are available as globals — no import needed.

**`interpolate(frame, inputRange, outputRange)`**
Maps a frame number to any output value. Clamps by default.

```jsx
// Fade in over frames 0–15, hold, fade out over last 15 frames
const fadeIn  = interpolate(frame, [0, 15], [0, 1])
const fadeOut = interpolate(frame, [duration - 15, duration], [1, 0])
const opacity = Math.min(fadeIn, fadeOut)

// Slide in from -100px to 0 over first 20 frames
const x = interpolate(frame, [0, 20], [-100, 0])
```

**`spring({ frame, fps, mass, stiffness, damping })`**
Returns a 0→1 value following spring physics. Overshoots and settles naturally.

```jsx
const scale = spring({ frame, fps, stiffness: 120, damping: 14 })
// transform: `scale(${scale})`
```

---

## project.json item shape

How the agent references an overlay in `tracks[1+]`.

All overlays are agent-written JSX. There are no built-in overlay templates.

```json
{
  "id": "countdown",
  "type": "overlay",
  "src": "./overlays/countdown.jsx",
  "start": 0.0,
  "end": 3.0,
  "props": {
    "from": 3,
    "color": "#ffffff"
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `type` | string | yes | `"overlay"` for custom JSX, `"image"` for static images, `"video"` for video clips |
| `src` | string | yes | Path to JSX file, relative to project.json |
| `start` | number | yes | Start time in output video (seconds) |
| `end` | number | yes | End time in output video (seconds) |
| `props` | object | no | Arbitrary props passed through to the component |
| `offsetX` | number | no | Horizontal position offset as a percentage of the frame width. Set by the UI when the user drags the overlay. Default: `0` |
| `offsetY` | number | no | Vertical position offset as a percentage of the frame height. Set by the UI when the user drags the overlay. Default: `0` |
| `scale` | number | no | Size multiplier applied from the center. Set by the UI when the user resizes the overlay. Default: `1` |
| `opaque` | boolean | no | When `true`, render engine skips alpha — JSX root CSS controls the full frame background. Use for full-frame covers and canvas sections. |

---

## How the render engine loads an overlay

```
1. Read item from project.json overlays track
2. Load src path relative to project.json location
3. Calculate duration = (end - start) * fps
4. Launch Puppeteer, inject component into page
5. For frame in 0..duration:
   - set window.__frame = frame
   - screenshot → PNG with alpha
6. ffmpeg: encode PNG sequence → transparent WebM segment
7. ffmpeg: overlay segment onto footage at start timestamp
```

---

## Writing a custom overlay

See `skills/write-overlay/SKILL.md` for authoring guidelines, utility reference, and multi-overlay parallelism patterns.

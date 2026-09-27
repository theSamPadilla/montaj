# Motion language reference

Companion to `SKILL.md`. That file tells you how to get an overlay on screen; this one tells you how to make it move like someone designed it.

**Provenance.** Every technique here was rendered through `steps/render/sample_overlay.py` against the real sandbox and read back as pixels before being written down — the sandbox strips imports, forbids hooks, and forbids CSS `animation`/`transition`, so plenty of standard web motion technique does not survive contact with it. Anything marked *(design rule)* is judgement rather than something a render proved. The measurements in "Why this file exists" come from ffmpeg scene-detection and frame-delta analysis of two real videos. If you extend this file, keep that distinction: an invented technique presented as verified is worse than no technique.

---

## Why this file exists

A Montaj promo (26.9s) measured against a professionally-directed 15s motion reel, both sampled at 30fps:

| | Montaj promo | reference reel |
|---|---|---|
| Motion energy (mean abs luma delta) | 2.320 | 8.958 (**3.9×**) |
| Still frames | **44.5%** | 15.0% |
| Cuts | 3 (one per ~9s) | 11 (one per 1.4s) |

Nearly half our video was a still image, and what motion it had was a quarter as energetic. That is the gap, and it is not a renderer limitation — it is that the only motion vocabulary we ever documented was `interpolate` and `spring`.

---

## The two facts that explain flat motion

### 1. `interpolate` is strictly linear. There is no easing option.

Verified against `montaj_assets/overlay-runtime/helpers.js`:

```js
interpolate(5, [0, 10], [0, 1])   // → 0.5 exactly. A straight ramp.
```

Its full signature is `interpolate(frame, inputRange, outputRange, { extrapolate })` — `extrapolate` is `'clamp'` (default) or `'extend'`, and that is the entire options object. Nothing in it bends the curve.

So every `interpolate` call you write moves at a constant speed, starts instantly at full speed, and stops dead. Real objects do neither. **This is the single biggest reason our animation reads cheap**, and the fix is the easing catalog below.

### 2. `extrapolateRight` is not a real option

`SKILL.md` uses `{ extrapolateRight: 'clamp' }` in its examples. That key does not exist in the implementation — it is destructured away and silently ignored:

```js
interpolate(100, [0, 10], [0, 1], { extrapolate: 'extend' })       // → 10  (the real option)
interpolate(100, [0, 10], [0, 1], { extrapolateRight: 'extend' })  // → 1   (ignored, clamped)
```

It has never caused a visible bug because the default is already `'clamp'`, so the examples got the right answer for the wrong reason. Use `extrapolate`. If you see `extrapolateRight` in existing overlays, it is dead weight, not behaviour.

---

## Easing

`interpolate` gives you a linear `t`. Ease it *before* you map it to a value. These are pure functions of `t ∈ [0,1]` — safe at module top level, since they touch no globals.

```jsx
// --- the ones you will actually use ---
const easeOutCubic  = t => 1 - Math.pow(1 - t, 3)          // default for anything entering
const easeOutQuint  = t => 1 - Math.pow(1 - t, 5)          // sharper arrival, very "designed"
const easeOutExpo   = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)  // fastest arrival, near-instant settle
const easeInOutCubic= t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2  // moves that start AND stop
const easeInCubic   = t => t * t * t                        // only for things LEAVING frame

// --- character ---
const easeOutBack   = t => { const c1 = 1.70158, c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }  // overshoots ~10%, settles back
const easeOutElastic= t => { const c4 = (2 * Math.PI) / 3
  return t === 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10*t) * Math.sin((t*10 - 0.75) * c4) + 1 }

// --- anticipation: pull back before moving forward ---
const anticipate = t => t < 0.3
  ? -0.12 * Math.sin((t / 0.3) * Math.PI)      // dip backwards
  : easeOutCubic((t - 0.3) / 0.7)              // then go
```

Used:

```jsx
const raw = interpolate(frame, [0, 18], [0, 1])       // linear 0 → 1
const e   = easeOutQuint(raw)                          // now it has a shape
const y   = interpolate(e, [0, 1], [120, 0])           // map the EASED value
```

**Pick by intent** *(design rule)*:

| Intent | Use |
|---|---|
| Anything entering frame | `easeOutCubic`, or `easeOutQuint` for more snap |
| A hit that must feel violent | `easeOutExpo` over 6–10 frames |
| A move between two on-screen positions | `easeInOutCubic` |
| Something leaving frame | `easeInCubic` — it should accelerate away |
| A card/badge landing with personality | `easeOutBack` |
| A heavy object, a big number | `spring({ stiffness: 150, damping: 18 })` |
| A deliberate, telegraphed move | `anticipate` |

**Never** use linear for anything an eye tracks. Linear is correct only for genuinely mechanical motion: a scrolling background pattern, a rotating gradient, a ticking timecode.

---

## Duration, in frames, at the project's fps

Canvas projects now init at **60fps** (`project/init.py`). Read `fps` from the global; never hardcode 30 or you will author everything at half speed.

*(Design rule.)* Entrances want to be fast. At 60fps:

| Move | Frames @60 | Wall clock |
|---|---|---|
| A snap / hit | 6–10 | 100–167ms |
| A standard entrance | 14–20 | 233–333ms |
| A large element, or a move that carries weight | 24–32 | 400–533ms |
| Anything slower than this | — | reads as sluggish, not elegant |

Write durations as `Math.round(fps * seconds)` so they survive an fps change:

```jsx
const ENTER = Math.round(fps * 0.28)   // 17 frames at 60, 8 at 30
const t = easeOutQuint(interpolate(frame, [0, ENTER], [0, 1]))
```

---

## Directional motion blur — VERIFIED

CSS `filter: blur()` is isotropic and looks wrong on a moving object: it softens across the motion *and* perpendicular to it. Real motion blur smears along the motion vector only.

An inline SVG `feGaussianBlur` with an **asymmetric `stdDeviation`** gives true directional blur, and `filter: url(#id)` on an HTML element works in the Puppeteer renderer. Rendered and confirmed: vertical edges stay crisp while the horizontal axis smears.

Three candidates were rendered side by side. `stdDeviation="14 0"` produced true one-axis blur; stacked ghost copies produced a hard-edged echo (a different, cheaper-looking effect — useful deliberately, not as blur); plain `blur(7px)` was visibly wrong.

**Drive it from actual velocity, never from a constant.** Velocity is the distance the element moved since the previous frame, which you get by evaluating your own position function twice:

```jsx
// Pure helper — takes everything it needs as arguments, so it is safe at top level.
const posY = (f, fps) => {
  const t = easeOutQuint(interpolate(f, [0, 20], [0, 1]))
  return interpolate(t, [0, 1], [140, 0])
}

export default function Title() {
  const y  = posY(frame, fps)
  const v  = Math.abs(y - posY(frame - 1, fps))    // px per frame
  const sd = Math.min(12, v * 0.28)                // CAP IT — past ~12 it turns to soup

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <filter id="mb" x="-50%" y="-80%" width="200%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={`0 ${sd.toFixed(2)}`} />
          </filter>
        </defs>
      </svg>
      <div style={{
        transform: `translateY(${y.toFixed(2)}px)`,
        filter: v > 0.6 ? 'url(#mb)' : 'none',   // drop the filter once it has settled
      }}>TITLE</div>
    </div>
  )
}
```

Rules that came out of rendering it:

- `stdDeviation` is `"x y"`. Blur along the axis of travel only — `"0 12"` for vertical motion, `"12 0"` for horizontal.
- **Cap it.** Above ~12 the element stops being legible. `Math.min(12, v * 0.28)` was the value that read correctly.
- **Switch the filter off when velocity is low** (`v > 0.6` gate). A settled element under a live filter is softer than an unfiltered one, so text never quite looks sharp.
- Give the `<filter>` generous `x`/`y`/`width`/`height` (the `-50% / 200%` pattern) or the blur is clipped at the element's box and you get a hard cut edge.
- One `<filter>` per independently-moving element — they need different `stdDeviation` values. Generate them with `.map()` over your elements and give each a unique `id`.

---

## Per-character stagger — VERIFIED

The single highest-value-per-line technique. Split the text, offset each character's animation by a few frames, and give each its own velocity-derived blur. Rendered and confirmed: settled characters crisp, in-flight characters smeared on one axis, exactly the look of a professional type build.

```jsx
const WORD = 'MOTION'
const STAGGER = 3     // frames between characters — 2–4 at 60fps

const charY = (i, f, fps) => {
  const s = spring({ frame: Math.max(0, f - i * STAGGER), fps, stiffness: 190, damping: 21 })
  return interpolate(s, [0, 1], [140, 0])
}

export default function Build() {
  const chars = WORD.split('')
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex',
                  alignItems: 'center', justifyContent: 'center' }}>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          {chars.map((_, i) => {
            const v = Math.abs(charY(i, frame, fps) - charY(i, frame - 1, fps))
            return (
              <filter key={i} id={`mb${i}`} x="-50%" y="-80%" width="200%" height="260%">
                <feGaussianBlur in="SourceGraphic"
                                stdDeviation={`0 ${Math.min(12, v * 0.28).toFixed(2)}`} />
              </filter>
            )
          })}
        </defs>
      </svg>
      {/* overflow:hidden gives the characters an edge to rise out of */}
      <div style={{ display: 'flex', overflow: 'hidden', padding: '40px 0' }}>
        {chars.map((c, i) => {
          const y = charY(i, frame, fps)
          const v = Math.abs(y - charY(i, frame - 1, fps))
          return (
            <span key={i} style={{
              fontSize: 150, fontWeight: 900, display: 'inline-block',
              transform: `translateY(${y.toFixed(2)}px)`,
              filter: v > 0.6 ? `url(#mb${i})` : 'none',
            }}>{c}</span>
          )
        })}
      </div>
    </div>
  )
}
```

`Math.max(0, f - i * STAGGER)` is load-bearing: without the clamp, `spring` gets a negative frame for characters that have not started yet.

Stagger works on anything in a series, not just characters — list rows, bars in a chart, cards in a grid, icons in a row. *(Design rule)*: for more than ~10 elements, drop `STAGGER` to 1–2 frames or the last one arrives embarrassingly late.

---

## Continuous motion — the no-dead-air rule

See `skills/animation-sections/SKILL.md` § "No dead air". Restated here because it is a *writing* rule, not a planning one:

**Every overlay must keep something moving for its whole life, not just its entrance.** `frame / duration` gives you a 0 → 1 progress across the overlay's entire span:

```jsx
const t = duration ? frame / duration : 0

const drift   = interpolate(t, [0, 1], [0, -28])          // slow parallax, never stops
const breathe = 1 + 0.012 * Math.sin(t * Math.PI * 2)     // subtle scale pulse
const hue     = interpolate(t, [0, 1], [0, 14])           // filter: `hue-rotate(${hue}deg)`
```

Counts as continuous: positional drift, parallax between layers at different rates, a number counting up, a progress arc filling, a gradient rotating, a pattern scrolling, a rule extending.

Does not count: a drop shadow, a finished blur, anything driven only by the entrance value.

**Three traps, all of which were hit in a real test render before being written down here:**

1. **Motion must be LARGE-AREA to register.** A small element moving on a big flat field is real motion that reads as stillness. The first test render had a rotating 12-ray starburst on black — genuinely animating, visually dead. Full-frame sweeping bars, a gradient rotating across the whole frame, a pattern scrolling behind everything: those carry a section. Put the continuous motion in the *background plate*, not only in the hero element.

2. **Never animate a rotationally-symmetric shape by rotating it.** The same render rotated a plain circular ring for a whole section. A rotating circle is a still circle. Give it tick marks, a gradient stroke, a gap — something that makes the rotation visible — or move it instead.

3. **A value that reaches its target early leaves a frozen tail.** A counter written `Math.min(1, t * 1.9)` finishes at 53% of the section and sits dead for the rest. Drive it across the *full* span with an eased `t`: `easeOutQuint(t) * target`. Same fast-then-settle feel, no dead tail.

**`duration` is only populated when the harness passes it.** `sample_overlay` needs `--duration <frames>` explicitly or the global is undefined and everything keyed to `frame / duration` sits frozen at 0 — which looks exactly like the bug you are trying to fix. Always guard with `duration ? … : 0`.

---

## Cutting to a grid

The `animations` workflow generates its music bed first so you have a BPM before you plan. `beat = 60 / BPM` seconds; `bar = 4 beats`.

```jsx
const BPM = props.bpm ?? 128
const beat = fps * 60 / BPM          // frames per beat — 28.1 at 128 BPM / 60fps
const bar  = beat * 4
```

Section boundaries land on bars. Accents land on beats or eighths. The reference reel's fast section cut at 0.233s intervals — eighth notes at ~128 BPM — and that regularity is most of why it reads as directed rather than assembled.

Honest limit: montaj has no beat-detection step, and Lyria honours a requested BPM approximately. This is a tempo you *impose*, not one you measure. Over 15–30s the drift is small enough that grid-cutting still reads as deliberate. Do not claim frame-accurate sync.

---

## Verify the motion, don't eyeball it

**Do not render to check this.** Rendering the project is the user's call, not a QA step for you to take — sampling is. Everything below uses `sample_overlay` (one overlay, isolated) or `sample_frame` (the composited project at a timestamp); neither encodes a video.

```bash
# One frame, with the globals the render will actually use.
python steps/render/sample_overlay.py --overlay /abs/path/to/o.jsx \
  --frame 12 --duration 120 --fps 60 --width 1080 --height 1920 --out /tmp/f.png

# A contact sheet across the move, to see the easing shape and the blur.
for f in 2 6 10 16 24 34; do
  python steps/render/sample_overlay.py --overlay /abs/path/to/o.jsx \
    --frame $f --duration 120 --fps 60 --out /tmp/s_$f.png
done
```

Pass `--fps` to match the project. `spring()` is tuned in wall-clock time, so sampling a 60fps project at the 30 default shows springs settling twice as fast as they really will.

**Once the overlay is placed in a project, two different questions — do not substitute one for the other.** Switch from `sample_overlay` (a frame number inside one isolated JSX) to `sample_frame --project <project.json> --at <seconds>` (a timestamp inside the whole composited timeline) once that distinction matters.

### Motion energy — "is anything actually moving?"

Sample two frames about 0.2–0.3s apart inside the span you're checking. If the pair looks identical, nothing in that span is moving — that's the dead-air detector, and it needs no ffmpeg pass over a rendered file:

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.00 --out /tmp/a.png
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 4.25 --out /tmp/b.png
```

For calibration, here is what this looked like measured against a real render, back when producing one for this check was still the method — ffmpeg's mean-luma-difference filter (`tblend=all_mode=difference` + `signalstats`), all sampled at `fps=30`:

| | motion energy | still frames |
|---|---|---|
| A Montaj promo (what we're moving away from) | 2.320 | 44.5% |
| A directed motion reel (what we're moving toward) | 8.958 | 15.0% |
| A section set authored to the rules in this file | 10.612 | 0.0% |

Motion energy above ~7 with still frames near zero is the target these numbers describe. The frame-pair check above answers the same question without requiring a render to exist in the first place — reach for the exact ffmpeg score only if a render happens to be on disk for some other (user-requested) reason.

### Cut rate and placement — "is it cut to the grid?"

Sample every section/cut boundary directly and check the timestamp against your bar grid (2 bars at 128 BPM = 3.75s, etc.) — no cut detector needed, since you already know where you put the cuts:

```bash
python steps/render/sample_frame.py --project /abs/path/to/project.json --at 3.75 --out /tmp/boundary.png
```

A boundary off the grid is a math error in the section plan, not a rendering question.

### Do not use scene_score to detect dead air

This was got wrong once already, so it is written down, even though it no longer describes the primary method: `scene_score` is a **cut detector** — it compares histograms to find edits. Smooth motion of similarly-coloured elements barely moves a histogram, so a section that is sweeping full-frame gradients across the screen can score as "frozen." Measured historically on a real render: the promo cut at 7.43 / 12.43 / 20.4s (three cuts in 26.9s, at no particular times) against the reference reel's 11 cuts in 15.1s with a run at 0.233s intervals, and a section that scene_score called 63.6% "frozen" had **zero** still frames and more motion energy than the reference reel. It separated the promo from the reference reel only because the reference *cuts* more often — a real difference, but a different one from the one it appeared to be measuring. If you ever do have a render on disk and reach for `scene_score`, use it for cut placement only, never for stillness — the frame-pair check above is what stillness needs, and it never required a render to begin with.

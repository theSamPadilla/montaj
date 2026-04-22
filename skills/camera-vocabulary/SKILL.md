---
name: camera-vocabulary
description: "Shot scale, camera move taxonomy, and cinematography rules for ai_video scene planning. Load when writing storyboard scenes in Phase 1."
---

# Camera Vocabulary

Camera is a **first-class decision per shot**, not a throwaway clause. Pick `camera_move` and `shot_scale` BEFORE writing the prose prompt — they shape the shot. The runtime prefixes the Kling prompt with both as `[SHOT SCALE]` and `[CAMERA MOVE]` tags so the generator actually executes them.

## Shot Scales

| Value | Framing | When to use |
|-------|---------|-------------|
| `ecu` | Extreme close-up: eyes, hands, small detail | Intimate emotion, critical object, texture |
| `cu` | Close-up: face fills frame | Dialogue, reaction, emotion |
| `mcu` | Medium close-up: chest up | Conversation, character focus |
| `medium` | Medium: waist up | Standard dialogue, action |
| `cowboy` | Cowboy: mid-thigh up | Character with environment context, walking |
| `wide` | Wide: full body + room | Establishing character in space, physical action |
| `very_wide` | Very wide: environment dominates | Location change, scale, isolation |
| `aerial` | Overhead / bird's eye | Geography, transition, grandeur |

## Camera Moves

Grouped semantically. Draw from multiple groups to create variety.

### Push / Pull
| Value | Motion | When to use |
|-------|--------|-------------|
| `push_in` | Camera moves toward subject | Building tension, drawing attention |
| `pull_out` | Camera moves away from subject | Reveal, release, ending |
| `dolly_forward` | Camera physically advances through space | Moving into a scene, entering a room |
| `dolly_back` | Camera physically retreats through space | Departing, farewell, distancing |

### Lateral
| Value | Motion | When to use |
|-------|--------|-------------|
| `tracking` | Camera follows subject laterally | Walking, running, procession |
| `arc` | Camera sweeps in a partial curve around subject | Transition, moderate emphasis |
| `orbit` | Camera circles the subject fully | Dramatic emphasis, hero moment, isolation |

### Crane / Jib
| Value | Motion | When to use |
|-------|--------|-------------|
| `crane_up` | Vertical camera rise | Opening grandeur, reveal from above |
| `crane_down` | Vertical camera descent | Arrival, landing, grounding |
| `jib` | Crane with lateral arc component | Fluid elevation change with sweep |

### Handheld
| Value | Motion | When to use |
|-------|--------|-------------|
| `handheld_drift` | Organic, slightly unstable float | Intimacy, documentary feel, unease |
| `snorri_cam` | Camera fixed to subject, world moves | Disorientation, intoxication, dream |

### Smooth
| Value | Motion | When to use |
|-------|--------|-------------|
| `gimbal_glide` | Perfectly smooth lateral/forward glide | Ethereal calm, floating through space |

### Snappy
| Value | Motion | When to use |
|-------|--------|-------------|
| `whip_pan` | Fast horizontal snap | Energy burst, surprise, comedic timing |
| `crash_zoom` | Rapid lens zoom into subject | Shock, sudden focus, impact |
| `rack_focus` | Focus shifts between foreground/background | Reveal connection, redirect attention |

### Tilt
| Value | Motion | When to use |
|-------|--------|-------------|
| `tilt_up` | Vertical rotation upward | Reveal height, awe, looking up |
| `tilt_down` | Vertical rotation downward | Reveal below, grounding, descent |
| `dutch_tilt` | Camera tilted off-axis | Tension, unease, stylized energy |

### Locked
| Value | Motion | When to use |
|-------|--------|-------------|
| `locked_wide` | No movement, wide frame | Stillness IS the statement — must have internal motion |
| `locked_close` | No movement, close frame | Portrait intensity — must have internal motion |
| `static_macro` | No movement, extreme detail | Texture, small object, time passing on surface |

### Subjective
| Value | Motion | When to use |
|-------|--------|-------------|
| `pov` | Camera IS the subject's eyes | Immersion, what they see |
| `over_shoulder` | Behind subject looking at their world | Perspective, conversation, approach |

## Rules

### 1. Motion Budget — every shot needs motion

Every shot needs motion from EITHER the subject OR the camera — never both absent.

- **Subject is still** (posing, landscape, interior, still object) → pick an **assertive** camera move: `push_in`, `pull_out`, `orbit`, `arc`, `tracking`, `handheld_drift`, `crane_up/down`, `whip_pan`, `crash_zoom`, `rack_focus`. A static subject + static camera reads as a photograph, not a video shot.
- **Subject is moving** (running, sliding, walking, fighting) → `tracking`, `locked_wide`, or `static_macro` is enough — let the subject carry the motion.
- **Both moving** → risk visual chaos. Reserve for peak energy moments only.
- **Locked moves** (`locked_wide`, `locked_close`, `static_macro`) → only when stillness IS the statement AND something else in frame is visibly moving (water rippling, smoke curling, light flickering, a figure crossing behind).

### 2. Fresh-scene rule — vary across adjacent shots

At least **2 of these 4** must change between every consecutive pair of shots:

1. Location / environment
2. Shot scale
3. Camera move
4. Palette / lighting

`ECU/crash_zoom → wide/tracking → medium/orbit` reads as deliberate cinematography.
`medium/push_in → medium/push_in → medium/push_in` reads as one confused camera operator.

**Forbidden sameness:** no two adjacent shots should share both the same shot scale AND the same camera move.

### 3. Camera pool per video

Before writing scenes, pick **4-8 camera moves** that define this video's camera grammar — its visual identity. Every shot's `camera_move` should be drawn from this pool. This prevents both monotony (all push_in) and chaos (random moves with no through-line).

Example pool for a documentary: `[push_in, pull_out, crane_up, tracking, gimbal_glide, locked_wide, tilt_up, orbit]`
Example pool for high-energy: `[whip_pan, crash_zoom, handheld_drift, tracking, dutch_tilt, arc, pov, crane_down]`

### 4. Pick camera BEFORE prompt

Write fields in this order: `shotScale` → `cameraMove` → then the `## Camera` / `## Subject` / `## Action` prompt sections. Camera choice shapes what the shot looks like — don't write the description first and try to fit a move after.

## Scene Fields

When planning scenes in Phase 1, write these structured fields on each `storyboard.scenes[i]`:

```json
{
  "id": "scene-1",
  "prompt": "...",
  "duration": 5,
  "refImages": ["ref1", "ref2"],
  "shotScale": "wide",
  "cameraMove": "tracking"
}
```

The `kling_generate` step auto-appends `[SHOT SCALE]` and `[CAMERA MOVE]` tags to the composed prompt at generation time. Do NOT write these tags in the scene prompt text.

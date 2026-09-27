---
name: camera-vocabulary
description: "Shot scale and camera move values, and the motion-budget rule, for ai_video scene planning. Load when writing storyboard scenes in Phase 1."
---

# Camera Vocabulary

Each scene carries a `shotScale` and a `cameraMove`. The runtime prefixes the Kling prompt with both as `[SHOT SCALE]` and `[CAMERA MOVE]` tags so the generator actually executes them.

## Shot Scales

| Value | Framing |
|-------|---------|
| `ecu` | Extreme close-up: eyes, hands, small detail |
| `cu` | Close-up: face fills frame |
| `mcu` | Medium close-up: chest up |
| `medium` | Medium: waist up |
| `cowboy` | Cowboy: mid-thigh up |
| `wide` | Wide: full body + room |
| `very_wide` | Very wide: environment dominates |
| `aerial` | Overhead / bird's eye |

## Camera Moves

Grouped semantically.

### Push / Pull
| Value | Motion |
|-------|--------|
| `push_in` | Camera moves toward subject |
| `pull_out` | Camera moves away from subject |
| `dolly_forward` | Camera physically advances through space |
| `dolly_back` | Camera physically retreats through space |

### Lateral
| Value | Motion |
|-------|--------|
| `tracking` | Camera follows subject laterally |
| `arc` | Camera sweeps in a partial curve around subject |
| `orbit` | Camera circles the subject fully |

### Crane / Jib
| Value | Motion |
|-------|--------|
| `crane_up` | Vertical camera rise |
| `crane_down` | Vertical camera descent |
| `jib` | Crane with lateral arc component |

### Handheld
| Value | Motion |
|-------|--------|
| `handheld_drift` | Organic, slightly unstable float |
| `snorri_cam` | Camera fixed to subject, world moves |

### Smooth
| Value | Motion |
|-------|--------|
| `gimbal_glide` | Perfectly smooth lateral/forward glide |

### Snappy
| Value | Motion |
|-------|--------|
| `whip_pan` | Fast horizontal snap |
| `crash_zoom` | Rapid lens zoom into subject |
| `rack_focus` | Focus shifts between foreground/background |

### Tilt
| Value | Motion |
|-------|--------|
| `tilt_up` | Vertical rotation upward |
| `tilt_down` | Vertical rotation downward |
| `dutch_tilt` | Camera tilted off-axis |

### Locked
| Value | Motion |
|-------|--------|
| `locked_wide` | No movement, wide frame |
| `locked_close` | No movement, close frame |
| `static_macro` | No movement, extreme detail |

### Subjective
| Value | Motion |
|-------|--------|
| `pov` | Camera IS the subject's eyes |
| `over_shoulder` | Behind subject looking at their world |

## Rules

### 1. Motion Budget — every shot needs motion

Every shot needs motion from EITHER the subject OR the camera — never both absent.

- **Subject is still** (posing, landscape, interior, still object) → pick an **assertive** camera move: `push_in`, `pull_out`, `orbit`, `arc`, `tracking`, `handheld_drift`, `crane_up/down`, `whip_pan`, `crash_zoom`, `rack_focus`. A static subject + static camera reads as a photograph, not a video shot.
- **Subject is moving** (running, sliding, walking, fighting) → `tracking`, `locked_wide`, or `static_macro` is enough — let the subject carry the motion.
- **Both moving** → risk visual chaos. Reserve for peak energy moments only.
- **Locked moves** (`locked_wide`, `locked_close`, `static_macro`) → only when stillness IS the statement AND something else in frame is visibly moving (water rippling, smoke curling, light flickering, a figure crossing behind).

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

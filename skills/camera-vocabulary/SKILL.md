---
name: camera-vocabulary
description: "Shot scale and camera move vocabulary for ai_video scene planning. Load when writing storyboard scenes in Phase 1."
---

# Camera Vocabulary

Reference for the agent when planning ai_video scenes. Pick one shot scale and one camera move per scene during Phase 1 storyboard planning.

## Shot Scales

| Value | Framing | When to use |
|-------|---------|-------------|
| `ecu` | Extreme close-up: eyes, hands, small detail | Intimate emotion, critical object |
| `cu` | Close-up: face fills frame | Dialogue, reaction, emotion |
| `mcu` | Medium close-up: head and shoulders | Conversation, character focus |
| `medium` | Medium: waist up | Standard dialogue, action |
| `medium-wide` | Medium wide: knees up | Character in context |
| `wide` | Wide: full body + environment | Establishing, physical action |
| `establishing` | Very wide: environment dominates | Opening shots, location change |
| `aerial` | Overhead / bird's eye | Scale, geography, transition |

## Camera Moves

| Value | Motion | When to use |
|-------|--------|-------------|
| `static` | No camera movement | Let the subject's motion carry the shot |
| `push-in` | Camera moves toward subject | Building tension, drawing attention |
| `pull-back` | Camera moves away from subject | Reveal, release, ending |
| `pan-left` / `pan-right` | Horizontal rotation on axis | Following motion, surveying space |
| `tilt-up` / `tilt-down` | Vertical rotation on axis | Reveal height, follow vertical motion |
| `orbit` | Camera circles the subject | Dramatic emphasis, hero moment |
| `tracking` | Camera follows subject laterally | Walking, running, chase |
| `whip-pan` | Fast horizontal snap | Comedic timing, energy burst |
| `crane-up` / `crane-down` | Vertical camera rise/descent | Opening/closing grandeur |
| `zoom-in` / `zoom-out` | Lens zoom (not camera move) | Subtle focus shift |

## Motion Budget Rule

Every shot needs motion from EITHER the subject OR the camera — never both static.

- Subject is still (posing, waiting) → use an active camera move (push-in, orbit, crane)
- Subject is moving (running, sliding) → static or tracking camera is enough
- Both moving → risk visual chaos; only for peak energy moments

## Scene Fields

When planning scenes in Phase 1, write these structured fields on each `storyboard.scenes[i]`:

```json
{
  "id": "scene-1",
  "prompt": "...",
  "duration": 5,
  "refImages": ["ref1", "ref2"],
  "shotScale": "wide",
  "cameraMove": "push-in"
}
```

The `kling_generate` step auto-appends `[SHOT SCALE]` and `[CAMERA MOVE]` tags to the composed prompt at generation time. Do NOT write these tags in the scene prompt text.

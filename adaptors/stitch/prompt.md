# Stitch Prompt Guide

Google Stitch generates UI screens from text descriptions. The Stitch adaptor wraps the output as a JSX component for montaj's render engine.

## Context

All overlays are composited over vertical short-form video (1080×1920, 9:16). The component renders on a transparent background. Puppeteer screenshots each frame — CSS transitions and animations work; JavaScript does not run.

## What to describe

Write a single sentence or short phrase. Be specific about:

- **Visual style** — dark glass, flat color, gradient, minimal, bold
- **Content** — text to display (handle, caption, CTA, stat)
- **Position** — lower third, top banner, center overlay, full-screen title
- **Animation** — slide in from left, fade up, pop, flash

## Examples

```
dark glass lower third, white @handle text, slide in from left
bold yellow full-screen title card: "You won't believe this"
minimal top banner with semi-transparent background, "LIVE" badge on left
frosted glass callout box, centered, stat "10M views" in large type
```

## What Stitch does well

- Clean modern UI components
- Mobile-first layouts
- CSS animations and transitions
- Glassmorphism, gradients, bold typography

## What to avoid

- Describing video content (Stitch generates UI, not video)
- Requesting interactivity (buttons, inputs — they won't fire in a render)
- Highly specific pixel dimensions (let Stitch lay out within the 1080×1920 container)

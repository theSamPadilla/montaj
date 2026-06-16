// Overlay design canvas — must match montaj_assets/render/render.js.
// Overlays are authored in 1080-short-edge design coordinates regardless of
// the project's output resolution; the renderer upscales to settings.resolution
// at compose time via pixelRatio. The preview mirrors that here.
export function getOverlayDesignCanvas(
  resolution: [number, number] | undefined | null,
): [number, number] {
  const [w, h] = resolution ?? [1080, 1920]
  const ratio = 1080 / Math.min(w, h)
  return [Math.round((w * ratio) / 2) * 2, Math.round((h * ratio) / 2) * 2]
}

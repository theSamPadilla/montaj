/**
 * Image tone modes: how overlay images are color-mapped into HDR renders.
 *
 * Background: HDR (HLG/PQ) projects reinterpret the overlay raster as HDR
 * signal at composite time, which lands CSS graphics (cards, captions) at full
 * signal brightness. Web images are sRGB and must be pre-converted; the tone
 * mode decides how the converted image relates to the graphics around it.
 *
 * Keep ids in sync with lib/normalize_image.py::TONE_MODES and
 * montaj_assets/render/render.js::IMAGE_TONE_MODES.
 */
export type ImageTone = 'vivid' | 'broadcast' | 'punchy' | 'raw'

export const DEFAULT_IMAGE_TONE: ImageTone = 'vivid'

export interface ImageToneInfo {
  id: ImageTone
  label: string
  /** One-line summary shown under the label. Plain English, no jargon. */
  summary: string
  /** Secondary detail for tooltips or expanded views. */
  detail: string
}

export const IMAGE_TONES: ImageToneInfo[] = [
  {
    id: 'vivid',
    label: 'Vivid',
    summary: 'True colors at full brightness, matching your cards and captions.',
    detail:
      'Faithful color conversion with image whites raised to the same level as '
      + 'overlay graphics. The default, and usually what you want.',
  },
  {
    id: 'punchy',
    label: 'Punchy',
    summary: 'The legacy contrast, with the color errors corrected.',
    detail:
      'Keeps the darker, contrasty image tone older renders had, but fixes the '
      + 'oversaturated hues. Closest to pre-3.9.3 videos without their color bug.',
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    summary: 'TV-standard brightness (BT.2408). Accurate but dimmer than your graphics.',
    detail:
      'Maps image white to the 203-nit broadcast graphics level. Technically '
      + 'correct for TV delivery; images read muted next to full-brightness cards.',
  },
  {
    id: 'raw',
    label: 'Raw',
    summary: 'No conversion. The old oversaturated look.',
    detail:
      'Images are dropped into the HDR frame unconverted, shifting hues and '
      + 'boosting saturation (yellows go orange). The pre-3.9.3 behavior.',
  },
]

/**
 * Map a frame number to an output value across one or more input/output segments.
 * Mirrors render/core/interpolate.js so overlays behave identically in preview and final render.
 * Also accepts Remotion-style extrapolateLeft/extrapolateRight for compatibility.
 */
export function interpolate(
  frame: number,
  inputRange: number[],
  outputRange: number[],
  options: {
    extrapolate?: 'clamp' | 'extend'
    extrapolateLeft?: 'clamp' | 'extend'
    extrapolateRight?: 'clamp' | 'extend'
  } = {},
): number {
  if (inputRange.length < 2 || inputRange.length !== outputRange.length) {
    throw new Error('interpolate: inputRange and outputRange must each have at least 2 values and be equal length')
  }

  let lo = 0
  for (let i = 0; i < inputRange.length - 2; i++) {
    if (frame >= inputRange[i + 1]) lo = i + 1
  }

  const inLo  = inputRange[lo]
  const inHi  = inputRange[lo + 1]
  const outLo = outputRange[lo]
  const outHi = outputRange[lo + 1]

  const atLeft  = frame < inLo
  const atRight = frame > inHi

  const extrapolate = options.extrapolate ?? 'clamp'
  const leftMode    = options.extrapolateLeft  ?? extrapolate
  const rightMode   = options.extrapolateRight ?? extrapolate

  let t = inHi === inLo ? 1 : (frame - inLo) / (inHi - inLo)

  if (atLeft  && leftMode  === 'clamp') t = 0
  if (atRight && rightMode === 'clamp') t = 1

  return outLo + t * (outHi - outLo)
}

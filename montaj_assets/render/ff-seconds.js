// ffmpeg reads a time (an -ss, -t or -to argument, or a duration option such as trim's start) as plain decimal seconds
// and refuses exponent notation: "-ss 1.4210854715202004e-14" is "Invalid duration for option ss" and the export fails.
// String() writes any |x| under 1e-6 that way, and the difference of two equal times often leaves exactly such a
// residue (an overlay baked from a render slice's start: 78.4 - 78.39999999999999, §478).
//
// ffSeconds(x) is "0" under 1e-6, so a `> 0` guard on its value drops a seek to 0 (an input -ss 0 still seeks, past
// the AAC priming, §94). Every other time is written exactly as String() writes it, digit for digit: the encode
// arguments stay byte-identical (encode-args-golden pins them) and a two-stage seek still adds up to the microseconds
// ffmpeg reads from the single -ss it replaces (it keeps six decimals and drops the rest).

/** Seconds as an ffmpeg time argument: never exponent notation (see above). */
export function ffSeconds(x) {
  const n = Number(x)
  if (Math.abs(n) < 1e-6) return '0'
  const s = String(x)
  // From 1e-6 up String() writes a number in plain decimals; a string handed in may still say "1e-3".
  return /e/i.test(s) && Number.isFinite(n) ? String(n) : s
}

// A frame-driven luminance ramp: every frame paints a distinct, uniform grey.
// Frame N is exactly N*5 in all channels, so the mean luma of each composited
// output frame identifies WHICH overlay frame was used. A held frame repeats a
// value; a dropped frame leaves a gap of 10 instead of 5.
//
// Full-frame and opaque-by-content (not by the `opaque` flag) so it still
// travels the yuva alpha path this test exists to check.
export default function CadenceRamp() {
  const v = Math.min(255, frame * 5)
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgb(${v}, ${v}, ${v})` }} />
  )
}

// The carousel reference for WordsMount: the same words at the positions
// WordsMount computes once Bebas Neue has loaded, hardcoded, so no measurement
// is involved. Measured with test/fixtures/fonts; see render-carousel.test.mjs.
export default function WordsFixed({ frame }) {
  const words = ['Cuts', 'the', 'ums.']
  const font = "160px 'Bebas Neue'"
  const xs = [60, 333, 547]
  return (
    <div id="ov" data-xs={xs.join(',')} data-frame={frame} style={{ position: 'absolute', inset: 0, background: '#223' }}>
      {words.map((w, i) => (
        <span key={i} className="w" style={{ position: 'absolute', left: xs[i], top: 200, font, color: 'white', whiteSpace: 'nowrap', lineHeight: 1, visibility: 'visible' }}>{w}</span>
      ))}
    </div>
  )
}

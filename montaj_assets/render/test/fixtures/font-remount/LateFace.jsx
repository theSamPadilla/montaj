// Frames < 10: background only. Frame >= 10: words in Oswald, a face first used
// on frame 10, measured with canvas measureText in the render body. Fonts are
// awaited once per page, so frame 10 is captured before Oswald has loaded
// unless the shim waits for that load and remounts.
export default function LateFace({ frame }) {
  const words = ['Cuts', 'the', 'ums.']
  const font = "160px 'Oswald'"
  if (frame < 10) return <div id="ov" data-xs="" data-frame={frame} style={{ position: 'absolute', inset: 0, background: '#223' }} />
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = font
  let x = 60
  const xs = []
  for (const w of words) { xs.push(x); x += ctx.measureText(w).width + 30 }
  return (
    <div id="ov" data-xs={xs.map(Math.round).join(',')} data-frame={frame} style={{ position: 'absolute', inset: 0, background: '#223' }}>
      {words.map((w, i) => (
        <span key={i} className="w" style={{ position: 'absolute', left: xs[i], top: 200, font, color: 'white', whiteSpace: 'nowrap', lineHeight: 1 }}>{w}</span>
      ))}
    </div>
  )
}

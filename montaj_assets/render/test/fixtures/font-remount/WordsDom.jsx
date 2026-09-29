// Measures each word's offsetWidth in a layout effect keyed on `frame`, so a
// re-render at the SAME frame does not re-measure. Wrong on the mount frame
// unless the shim remounts it once the font has loaded.
import { useLayoutEffect, useRef, useState } from 'react'
export default function WordsDom({ frame }) {
  const words = ['Cuts', 'the', 'ums.']
  const font = "160px 'Bebas Neue'"
  const refs = useRef([])
  const [xs, setXs] = useState(null)
  useLayoutEffect(() => {
    let x = 60
    const out = []
    refs.current.forEach(el => { out.push(x); x += el.offsetWidth + 30 })
    setXs(out)
  }, [frame])
  return (
    <div id="ov" data-xs={xs ? xs.map(Math.round).join(',') : ''} data-frame={frame} style={{ position: 'absolute', inset: 0, background: '#223' }}>
      {words.map((w, i) => (
        <span key={i} ref={el => (refs.current[i] = el)} className="w" style={{ position: 'absolute', left: xs ? xs[i] : 0, top: 200, font, color: 'white', whiteSpace: 'nowrap', lineHeight: 1, visibility: xs ? 'visible' : 'hidden' }}>{w}</span>
      ))}
    </div>
  )
}

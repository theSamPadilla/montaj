/**
 * line-chart.jsx — Multi-series line chart for carousel slides.
 *
 * SVG-rendered via Recharts. No animation. Fills its parent element box.
 *
 * Props (all values stored as strings):
 *   xLabels     — comma-separated x-axis labels (default 'Jan, Feb, Mar, Apr, May, Jun')
 *   series      — JSON-string array: [{ name, color, values: 'a, b, c, ...' }, ...]
 *   axisColor   — axis/tick/label color (default '#111111')
 *   fontFamily  — CSS font-family (default system-ui stack)
 *   fontSize    — CSS px for ticks and labels (default '16')
 *   smoothed    — 'true' (monotone curve) | 'false' (straight segments) (default 'false')
 *   strokeWidth — line stroke width in px (default '3')
 *   showGrid    — 'true' | 'false' (default 'true')
 *   showXAxis   — 'true' | 'false' (default 'true')
 *   showYAxis   — 'true' | 'false' (default 'true')
 *   showLegend  — 'true' | 'false' (default 'true')
 *   bgColor     — backdrop color or 'transparent' (default 'transparent')
 *
 * Box dimensions (boxWidth / boxHeight) are passed in by slide.jsx.
 */
export default function LineChartOverlay({
  xLabels     = 'Jan, Feb, Mar, Apr, May, Jun',
  series      = '[{"name":"Series A","color":"#3b82f6","values":"10, 24, 18, 32, 28, 40"}]',
  axisColor   = '#111111',
  fontFamily  = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontSize    = '16',
  smoothed    = 'false',
  strokeWidth = '3',
  showGrid    = 'true',
  showXAxis   = 'true',
  showYAxis   = 'true',
  showLegend  = 'true',
  bgColor     = 'transparent',
  boxWidth    = 1080,
  boxHeight   = 1080,
}) {
  const labelArr = String(xLabels).split(',').map(s => s.trim()).filter(Boolean)
  let seriesArr = []
  try {
    seriesArr = JSON.parse(series)
    if (!Array.isArray(seriesArr)) seriesArr = []
  } catch { seriesArr = [] }

  // Zip into Recharts row shape: [{ name: 'Jan', 'Series A': 10, 'Series B': 5 }, ...]
  const data = labelArr.map((label, i) => {
    const row = { name: label }
    for (const s of seriesArr) {
      const vals = String(s.values ?? '').split(',').map(v => parseFloat(v.trim()))
      const v = vals[i]
      row[s.name] = Number.isFinite(v) ? v : null
    }
    return row
  })

  const safeFontSize = parseFloat(String(fontSize))
  const fs  = Number.isFinite(safeFontSize) && safeFontSize > 0 ? safeFontSize : 16
  const sw  = Math.max(1, parseFloat(String(strokeWidth)) || 3)
  const curveType = smoothed === 'true' ? 'monotone' : 'linear'

  const pad = 0.04
  const innerW = Math.max(0, Math.round(boxWidth  * (1 - 2 * pad)))
  const innerH = Math.max(0, Math.round(boxHeight * (1 - 2 * pad)))

  return (
    <div style={{ position: 'absolute', inset: 0, background: bgColor, padding: '4%', boxSizing: 'border-box' }}>
      <LineChart width={innerW} height={innerH} data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        {showGrid === 'true' && <CartesianGrid stroke={axisColor} strokeOpacity={0.15} vertical={false} />}
        {showXAxis === 'true' && <XAxis dataKey="name" tick={{ fill: axisColor, fontFamily, fontSize: fs }} axisLine={{ stroke: axisColor }} tickLine={false} />}
        {showYAxis === 'true' && <YAxis tick={{ fill: axisColor, fontFamily, fontSize: fs }} axisLine={{ stroke: axisColor }} tickLine={false} />}
        {showLegend === 'true' && <Legend wrapperStyle={{ fontFamily, fontSize: fs, color: axisColor }} />}
        {seriesArr.map(s => (
          <Line
            key={s.name}
            type={curveType}
            dataKey={s.name}
            stroke={s.color ?? '#3b82f6'}
            strokeWidth={sw}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </div>
  )
}

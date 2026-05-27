/**
 * bar-chart.jsx — Single-series vertical bar chart for carousel slides.
 *
 * SVG-rendered via Recharts. No animation (carousel slides are static frames).
 * Fills its parent element box via inset:0.
 *
 * Props (all values stored as strings):
 *   labels      — comma-separated x-axis labels (default 'Jan, Feb, Mar, Apr')
 *   values      — comma-separated numeric values, one per label (default '10, 24, 18, 32')
 *   barColor    — bar fill color (default '#3b82f6')
 *   axisColor   — axis/tick/label color (default '#111111')
 *   fontFamily  — CSS font-family (default system-ui stack)
 *   fontSize    — CSS px for ticks and labels (default '16')
 *   showGrid    — 'true' | 'false' (default 'true')
 *   showXAxis   — 'true' | 'false' (default 'true')
 *   showYAxis   — 'true' | 'false' (default 'true')
 *   bgColor     — backdrop color or 'transparent' (default 'transparent')
 *
 * Box dimensions (boxWidth / boxHeight) are passed in by slide.jsx; they're
 * the overlay element's w/h in design-canvas pixels.
 */
export default function BarChartOverlay({
  labels      = 'Jan, Feb, Mar, Apr',
  values      = '10, 24, 18, 32',
  barColor    = '#3b82f6',
  axisColor   = '#111111',
  fontFamily  = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontSize    = '16',
  showGrid    = 'true',
  showXAxis   = 'true',
  showYAxis   = 'true',
  bgColor     = 'transparent',
  boxWidth    = 1080,
  boxHeight   = 1080,
}) {
  const labelArr = String(labels).split(',').map(s => s.trim()).filter(Boolean)
  const valueArr = String(values).split(',').map(s => parseFloat(s.trim())).map(n => Number.isFinite(n) ? n : 0)
  // Zip into Recharts shape: [{name, value}, ...]; pad/truncate so arrays line up.
  const len = Math.min(labelArr.length, valueArr.length)
  const data = Array.from({ length: len }, (_, i) => ({ name: labelArr[i], value: valueArr[i] }))

  const safeFontSize = parseFloat(String(fontSize))
  const fs = Number.isFinite(safeFontSize) && safeFontSize > 0 ? safeFontSize : 16

  // boxWidth / boxHeight come from slide.jsx (see Task 2). The overlay's parent
  // div has padding: 4% on all sides, so the chart's actual pixel size is the
  // box minus the padding. Compute explicitly to pass to <BarChart>.
  const pad = 0.04
  const innerW = Math.max(0, Math.round(boxWidth  * (1 - 2 * pad)))
  const innerH = Math.max(0, Math.round(boxHeight * (1 - 2 * pad)))

  return (
    <div style={{ position: 'absolute', inset: 0, background: bgColor, padding: '4%', boxSizing: 'border-box' }}>
      <BarChart width={innerW} height={innerH} data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        {showGrid === 'true' && <CartesianGrid stroke={axisColor} strokeOpacity={0.15} vertical={false} />}
        {showXAxis === 'true' && (
          <XAxis dataKey="name" tick={{ fill: axisColor, fontFamily, fontSize: fs }} axisLine={{ stroke: axisColor }} tickLine={false} />
        )}
        {showYAxis === 'true' && (
          <YAxis tick={{ fill: axisColor, fontFamily, fontSize: fs }} axisLine={{ stroke: axisColor }} tickLine={false} />
        )}
        <Bar dataKey="value" fill={barColor} isAnimationActive={false} />
      </BarChart>
    </div>
  )
}

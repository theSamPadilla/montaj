/**
 * pie-chart.jsx — Pie / donut chart for carousel slides.
 *
 * SVG-rendered via Recharts. No animation. Fills its parent element box.
 *
 * Props (all values stored as strings):
 *   labels       — comma-separated slice labels (default 'A, B, C, D')
 *   values       — comma-separated numeric values (default '30, 25, 20, 25')
 *   colors       — comma-separated slice colors; cycles if fewer than slices
 *                  (default '#3b82f6, #10b981, #f59e0b, #ef4444')
 *   innerRadius  — '0' for solid pie, e.g. '50%' for donut (default '0')
 *   labelColor   — slice-label color (default '#111111')
 *   fontFamily   — CSS font-family (default system-ui stack)
 *   fontSize     — CSS px for labels and legend (default '16')
 *   showLabels   — 'true' | 'false' (default 'true')
 *   showLegend   — 'true' | 'false' (default 'false')
 *   bgColor      — backdrop color or 'transparent' (default 'transparent')
 *
 * Box dimensions (boxWidth / boxHeight) are passed in by slide.jsx.
 */
export default function PieChartOverlay({
  labels      = 'A, B, C, D',
  values      = '30, 25, 20, 25',
  colors      = '#3b82f6, #10b981, #f59e0b, #ef4444',
  innerRadius = '0',
  labelColor  = '#111111',
  fontFamily  = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontSize    = '16',
  showLabels  = 'true',
  showLegend  = 'false',
  bgColor     = 'transparent',
  boxWidth    = 1080,
  boxHeight   = 1080,
}) {
  const labelArr = String(labels).split(',').map(s => s.trim()).filter(Boolean)
  const valueArr = String(values).split(',').map(s => parseFloat(s.trim())).map(n => Number.isFinite(n) ? n : 0)
  const colorArr = String(colors).split(',').map(s => s.trim()).filter(Boolean)
  const len = Math.min(labelArr.length, valueArr.length)
  const data = Array.from({ length: len }, (_, i) => ({ name: labelArr[i], value: valueArr[i] }))

  const safeFontSize = parseFloat(String(fontSize))
  const fs = Number.isFinite(safeFontSize) && safeFontSize > 0 ? safeFontSize : 16

  // innerRadius accepts a number (px) or string (%). Pass through as-is if it
  // ends in '%'; otherwise coerce to a number with default 0.
  const innerR = String(innerRadius).trim().endsWith('%')
    ? String(innerRadius).trim()
    : (parseFloat(String(innerRadius)) || 0)

  const pad = 0.04
  const innerW = Math.max(0, Math.round(boxWidth  * (1 - 2 * pad)))
  const innerH = Math.max(0, Math.round(boxHeight * (1 - 2 * pad)))

  return (
    <div style={{ position: 'absolute', inset: 0, background: bgColor, padding: '4%', boxSizing: 'border-box' }}>
      <PieChart width={innerW} height={innerH}>
        {showLegend === 'true' && <Legend wrapperStyle={{ fontFamily, fontSize: fs, color: labelColor }} />}
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius="80%"
          innerRadius={innerR}
          label={showLabels === 'true' ? { fill: labelColor, fontFamily, fontSize: fs } : false}
          isAnimationActive={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={colorArr[i % Math.max(1, colorArr.length)]} />
          ))}
        </Pie>
      </PieChart>
    </div>
  )
}

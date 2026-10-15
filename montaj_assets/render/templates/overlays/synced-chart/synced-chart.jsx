/**
 * synced-chart.jsx: a line chart that draws itself in time with the video.
 *
 * Hand-drawn SVG (no Recharts: its default animation and its async sizing are
 * blank-frame traps). A pure function of frame, fps, duration and props: no
 * hooks, no measuring, no timers. So the editor preview, the export and
 * sample_frame draw the same picture from this one file.
 *
 * Time: a point is [t, y], t in seconds from the item's start. At
 * now = frame / fps the line runs through every point with t <= now, plus a
 * straight partial segment to now, with a dot at the tip. Before the first
 * point only the axes show; after the last the whole line holds. A fractional
 * frame (motion blur) gives a tip between its neighbours'. The axes never
 * rescale while the line draws: both ranges come from all of the data.
 *
 * Data (each accepts an array or a JSON string):
 *   points      [[t, y], ...] (or [{ t, y }, ...]) for one line
 *   values      [y, ...] (or 'a, b, c') spread evenly over the item's length,
 *               for a curve with no timestamps of its own
 *   series      up to 3 lines: [{ name, color, points | values }, ...]; when
 *               given it replaces points, values and lineColor, and a legend
 *               names the lines
 * Cleaning: points are sorted by t, a non-finite one is dropped, a line keeps
 * at most 2000. One point draws as a dot; a flat line gets a padded range.
 *
 * Axes:
 *   xFrom, xTo  label the x axis in the data's own units (e.g. steps 0 to
 *               1000000) while the timing stays in seconds; without them the
 *               x labels are seconds
 *   yMin, yMax  override the y range
 *   xLabel, yLabel, title  the copy
 *
 * Look (primitives, so the editor's props panel offers a field or a picker):
 *   lineColor '#3b82f6', axisColor '#ffffff', bgColor 'transparent' (any
 *   other colour draws a rounded card), fontFamily (system stack), fontSize
 *   '24', strokeWidth '4', fill 'true' (a soft area under a single line),
 *   showValue 'true' (the tip's value, single line only), boxWidth '720',
 *   boxHeight '405' (design px; centred, then moved and sized by the item's
 *   own offsetX, offsetY and scale).
 */

const MAX_SERIES = 3
const MAX_POINTS = 2000
const SERIES_COLORS = ['#3b82f6', '#f97316', '#a3a3a3']
const DEFAULT_LENGTH_SECONDS = 10

// An array, a JSON string of one, or a comma list of numbers; else [].
function parseList(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(Number)
  }
}

const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fallback
}
const optionalNum = (v) => (v === undefined || v === null || v === '' ? null : num(v, null))
// A data value: a number, or a numeric string; null, '' and anything else are not data (Number(null) is 0).
const dataNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
const truthy = (v) => v === true || v === 'true'

function cleanPoints(raw) {
  const pts = []
  for (const p of parseList(raw)) {
    const t = dataNum(Array.isArray(p) ? p[0] : p?.t)
    const y = dataNum(Array.isArray(p) ? p[1] : p?.y)
    if (Number.isFinite(t) && Number.isFinite(y)) pts.push([t, y])
  }
  // A stable sort keeps two points at the same t in the order given.
  return pts
    .map((p, i) => [p, i])
    .sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1])
    .map(([p]) => p)
    .slice(0, MAX_POINTS)
}

function spreadValues(raw, lengthSeconds) {
  const ys = parseList(raw).map(dataNum).filter(Number.isFinite).slice(0, MAX_POINTS)
  if (ys.length === 1) return [[0, ys[0]]]
  return ys.map((y, i) => [(i / (ys.length - 1)) * lengthSeconds, y])
}

function resolveSeries({ series, points, values, lineColor }, lengthSeconds) {
  const listed = parseList(series).filter(s => s && typeof s === 'object' && !Array.isArray(s))
  const source = listed.length ? listed.slice(0, MAX_SERIES) : [{ name: '', color: lineColor, points, values }]
  return source
    .map((s, i) => {
      const hasPoints = s.points !== undefined && s.points !== null && s.points !== ''
      return {
        name: String(s.name ?? ''),
        color: String(s.color || (i === 0 && lineColor) || SERIES_COLORS[i]),
        points: hasPoints ? cleanPoints(s.points) : spreadValues(s.values, lengthSeconds),
      }
    })
    .filter(s => s.points.length > 0)
}

// Round ticks: lo, hi and the step between them, widened to whole steps.
function niceRange(lo, hi) {
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1
    lo -= pad
    hi += pad
  }
  const rough = (hi - lo) / 2
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const f = rough / mag
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step }
}

// 1250 -> '1.3k', 2000000 -> '2M', 0.825 -> '0.83'.
function fmt(n) {
  const a = Math.abs(n)
  const short = (v, unit) => `${+v.toFixed(1)}${unit}`
  if (a >= 1e9) return short(n / 1e9, 'B')
  if (a >= 1e6) return short(n / 1e6, 'M')
  if (a >= 1e4) return short(n / 1e3, 'k')
  if (a >= 100) return String(Math.round(n))
  if (a >= 10) return String(+n.toFixed(1))
  return String(+n.toFixed(2))
}

const r2 = (v) => Math.round(v * 100) / 100

// The points a line shows at `now`: those with t <= now, plus the partial
// segment's end on the way to the next one.
function revealed(points, now) {
  const out = []
  for (let i = 0; i < points.length; i++) {
    const [t, y] = points[i]
    if (t <= now) {
      out.push(points[i])
      continue
    }
    if (i > 0) {
      const [t0, y0] = points[i - 1]
      const k = t === t0 ? 1 : (now - t0) / (t - t0)
      out.push([now, y0 + (y - y0) * k])
    }
    break
  }
  return out
}

export default function SyncedChart({
  frame = 0,
  fps = 30,
  duration,
  points = '',
  values = '0, 0.12, 0.3, 0.42, 0.61, 0.7, 0.82, 0.88',
  series = '',
  xFrom = '',
  xTo = '',
  yMin = '',
  yMax = '',
  xLabel = '',
  yLabel = '',
  title = '',
  lineColor = '#3b82f6',
  axisColor = '#ffffff',
  bgColor = 'transparent',
  fontFamily = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontSize = '24',
  strokeWidth = '4',
  fill = 'true',
  showValue = 'true',
  boxWidth = '720',
  boxHeight = '405',
}) {
  const rate = num(fps, 30) > 0 ? num(fps, 30) : 30
  const frames = num(duration, 0)
  const lengthSeconds = frames > 0 ? frames / rate : DEFAULT_LENGTH_SECONDS
  const now = num(frame, 0) / rate

  const W = Math.max(120, num(boxWidth, 720))
  const H = Math.max(80, num(boxHeight, 405))
  const fs = Math.max(8, num(fontSize, 24))
  const sw = Math.max(1, num(strokeWidth, 4))

  const lines = resolveSeries({ series, points, values, lineColor }, lengthSeconds)
  const all = lines.flatMap(l => l.points)

  // Ranges from all of the data, so the axes hold still while the line draws.
  const tEnd = all.length ? Math.max(...all.map(p => p[0])) : lengthSeconds
  const tStart = all.length ? Math.min(0, ...all.map(p => p[0])) : 0
  const tSpan = tEnd > tStart ? tEnd - tStart : 1
  const ys = all.map(p => p[1])
  const yLoData = optionalNum(yMin) ?? (ys.length ? Math.min(...ys) : 0)
  const yHiData = optionalNum(yMax) ?? (ys.length ? Math.max(...ys) : 1)
  const yr = niceRange(Math.min(yLoData, yHiData), Math.max(yLoData, yHiData))
  const yTicks = [yr.lo, (yr.lo + yr.hi) / 2, yr.hi]

  // x labels: seconds, or the data's own units when xFrom/xTo are given.
  const from = optionalNum(xFrom)
  const to = optionalNum(xTo)
  const xUnits = from !== null && to !== null
  const xTickLabel = (t) => (xUnits ? fmt(from + ((t - tStart) / tSpan) * (to - from)) : `${fmt(t)}s`)

  const multi = lines.length > 1
  const pad = fs * 0.75
  const gutter = Math.max(...yTicks.map(v => fmt(v).length)) * fs * 0.62 + fs * 0.5
  const topRow = title || yLabel || multi ? fs * 1.5 : 0
  const x0 = pad + gutter
  const x1 = W - pad - fs * 0.5
  const y0 = pad + (title ? fs * 1.5 : 0) + topRow + fs * 0.5
  const y1 = H - pad - fs * 1.5 - (xLabel ? fs * 1.3 : 0)
  const px = (t) => r2(x0 + ((t - tStart) / tSpan) * (x1 - x0))
  const py = (y) => r2(y1 - ((y - yr.lo) / (yr.hi - yr.lo)) * (y1 - y0))

  const muted = { fill: axisColor, fillOpacity: 0.7 }
  const textBase = { fontFamily, fontSize: fs }
  const drawn = lines.map(l => ({ ...l, shown: revealed(l.points, now) }))
  const single = drawn.length === 1 ? drawn[0] : null
  const tip = single && single.shown.length ? single.shown[single.shown.length - 1] : null
  const valueText = tip ? fmt(tip[1]) : ''

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible', fontFamily }}>
        {bgColor && bgColor !== 'transparent' && <rect x={0} y={0} width={W} height={H} rx={fs * 0.75} fill={bgColor} />}
        {title && (
          <text x={pad} y={pad + fs} style={{ ...textBase, fontWeight: 700 }} fill={axisColor}>{title}</text>
        )}
        {yLabel && (
          <text x={pad} y={pad + (title ? fs * 1.5 : 0) + fs} style={textBase} {...muted}>{yLabel}</text>
        )}
        {multi && (
          <g>
            {drawn.map((l, i) => {
              const lx = x1 - (drawn.length - i) * fs * 6
              const ly = pad + (title ? fs * 1.5 : 0) + fs * 0.65
              return (
                <g key={`legend-${i}`}>
                  <rect x={r2(lx)} y={r2(ly - fs * 0.15)} width={fs * 0.9} height={fs * 0.3} rx={fs * 0.15} fill={l.color} />
                  <text x={r2(lx + fs * 1.2)} y={r2(ly + fs * 0.35)} style={{ ...textBase, fontSize: fs * 0.8 }} {...muted}>{l.name}</text>
                </g>
              )
            })}
          </g>
        )}
        {yTicks.map((v, i) => (
          <g key={`ytick-${i}`}>
            <line x1={x0} x2={x1} y1={py(v)} y2={py(v)} stroke={axisColor} strokeOpacity={i === 0 ? 0.6 : 0.15} strokeWidth={i === 0 ? 2 : 1} />
            <text x={r2(x0 - fs * 0.5)} y={r2(py(v) + fs * 0.35)} textAnchor="end" style={{ ...textBase, fontSize: fs * 0.8 }} {...muted}>{fmt(v)}</text>
          </g>
        ))}
        <line x1={x0} x2={x0} y1={y0} y2={y1} stroke={axisColor} strokeOpacity={0.6} strokeWidth={2} />
        <text x={x0} y={r2(y1 + fs * 1.2)} textAnchor="start" style={{ ...textBase, fontSize: fs * 0.8 }} {...muted}>{xTickLabel(tStart)}</text>
        <text x={x1} y={r2(y1 + fs * 1.2)} textAnchor="end" style={{ ...textBase, fontSize: fs * 0.8 }} {...muted}>{xTickLabel(tEnd)}</text>
        {xLabel && (
          <text x={r2((x0 + x1) / 2)} y={r2(y1 + fs * 2.5)} textAnchor="middle" style={textBase} {...muted}>{xLabel}</text>
        )}
        {single && truthy(fill) && single.shown.length > 1 && (
          <path
            d={`M ${px(single.shown[0][0])} ${y1} ${single.shown.map(([t, y]) => `L ${px(t)} ${py(y)}`).join(' ')} L ${px(single.shown[single.shown.length - 1][0])} ${y1} Z`}
            fill={single.color}
            fillOpacity={0.15}
          />
        )}
        {drawn.map((l, i) =>
          l.shown.length > 1 ? (
            <path
              key={`line-${i}`}
              d={l.shown.map(([t, y], j) => `${j ? 'L' : 'M'} ${px(t)} ${py(y)}`).join(' ')}
              fill="none"
              stroke={l.color}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null,
        )}
        {drawn.map((l, i) => {
          const end = l.shown[l.shown.length - 1]
          return end ? <circle key={`tip-${i}`} cx={px(end[0])} cy={py(end[1])} r={r2(sw * 1.6)} fill={l.color} /> : null
        })}
        {tip && truthy(showValue) && (
          <text
            x={r2(Math.min(Math.max(px(tip[0]), x0 + fs), x1 - fs))}
            y={r2(py(tip[1]) - sw * 1.6 - fs * 0.5)}
            textAnchor="middle"
            style={{ ...textBase, fontWeight: 700 }}
            fill={single.color}
          >
            {valueText}
          </text>
        )}
      </svg>
    </div>
  )
}

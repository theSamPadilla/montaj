export default function Box({ label, logo }) {
  const t = Math.min(1, frame / 30)
  return (
    <div data-box="1" style={{ position: 'absolute', left: 40, top: 40, width: 300 * t, height: 120, background: '#00b4d8', color: '#fff', font: '700 40px sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {label}{logo ? <img src={logo} alt="" style={{ height: 60 }} /> : null}
    </div>
  )
}

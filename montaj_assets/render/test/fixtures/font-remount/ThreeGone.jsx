// A Three canvas on frames < 10; on frame 10 the canvas is gone and an Oswald label appears.
export default function ThreeGone({ frame }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#223' }}>
      {frame < 10 && (
        <Canvas frameloop="never" flat style={{ position: 'absolute', inset: 0 }} camera={{ position: [0, 0, 5], fov: 50 }}
          gl={{ preserveDrawingBuffer: true, antialias: false, alpha: true }}>
          <FrameBridge />
          <mesh><planeGeometry args={[2, 2]} /><meshBasicMaterial color="#ff0000" toneMapped={false} /></mesh>
        </Canvas>
      )}
      {frame >= 10 && <span style={{ position: 'absolute', left: 60, top: 40, font: "120px 'Oswald'", color: 'white' }}>Late</span>}
    </div>
  )
}
function FrameBridge() { useThreeFrame(); return null }

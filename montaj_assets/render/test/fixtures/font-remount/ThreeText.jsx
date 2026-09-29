// A Three scene (an unlit red plane at the centre of the frame, via the injected
// Canvas and useThreeFrame globals) beside a DOM label in Bebas Neue. The label's
// font load makes the shim remount this overlay, and the remounted Canvas must
// still be drawn before the frame is captured.
export default function ThreeText() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#223' }}>
      <Canvas
        frameloop="never"
        flat
        style={{ position: 'absolute', inset: 0 }}
        camera={{ position: [0, 0, 5], fov: 50 }}
        gl={{ preserveDrawingBuffer: true, antialias: false, alpha: true }}
      >
        <FrameBridge />
        <mesh>
          <planeGeometry args={[2, 2]} />
          <meshBasicMaterial color="#ff0000" toneMapped={false} />
        </mesh>
      </Canvas>
      <span className="w" style={{ position: 'absolute', left: 60, top: 40, font: "120px 'Bebas Neue'", color: 'white', whiteSpace: 'nowrap', lineHeight: 1 }}>Label</span>
    </div>
  )
}

function FrameBridge() {
  useThreeFrame()
  return null
}

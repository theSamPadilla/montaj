// Reference overlay used by tests/test_render_three.py and as the worked
// example in skills/write-overlay/SKILL.md.
//
// Rotating cube driven entirely from the `frame` global. Demonstrates the
// non-negotiable Three.js / r3f patterns:
//   - <Canvas frameloop="never"> disables r3f's internal RAF loop
//   - A child component calls useThreeFrame() exactly once to register the
//     synchronous render trigger the shim uses
//   - All animation reads `frame` directly. NO useFrame hook.

export default function ThreeCube() {
  const t        = frame / fps                       // seconds since start
  const rotX     = t * Math.PI                       // half-turn per second
  const rotY     = t * Math.PI * 0.7
  const pulse    = 1 + 0.08 * Math.sin(t * 4)

  return (
    <Canvas
      frameloop="never"
      style={{ position: 'absolute', inset: 0 }}
      camera={{ position: [0, 0, 5], fov: 50 }}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
    >
      <FrameBridge />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 5, 5]} intensity={1.2} />
      <directionalLight position={[-3, -2, 2]} intensity={0.4} color="#88aaff" />
      <mesh rotation={[rotX, rotY, 0]} scale={[pulse, pulse, pulse]}>
        <boxGeometry args={[1.6, 1.6, 1.6]} />
        <meshStandardMaterial color="#3b82f6" metalness={0.3} roughness={0.35} />
      </mesh>
    </Canvas>
  )
}

function FrameBridge() {
  useThreeFrame()
  return null
}

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // npm 7+ does not hoist transitive deps from file: symlinked packages.
      // These packages live in overlay-runtime/node_modules (not hoisted to
      // ui/node_modules), so Rollup can't find them during the production build
      // unless we alias them explicitly. The aliases also guarantee a single
      // React instance, mirroring what dedupe does for the dev server.
      'three': path.resolve(__dirname, '../overlay-runtime/node_modules/three'),
      '@react-three/fiber': path.resolve(__dirname, '../overlay-runtime/node_modules/@react-three/fiber'),
      '@phosphor-icons/react': path.resolve(__dirname, '../overlay-runtime/node_modules/@phosphor-icons/react'),
      '@fortawesome/react-fontawesome': path.resolve(__dirname, '../overlay-runtime/node_modules/@fortawesome/react-fontawesome'),
      '@fortawesome/free-solid-svg-icons': path.resolve(__dirname, '../overlay-runtime/node_modules/@fortawesome/free-solid-svg-icons'),
      '@fortawesome/free-brands-svg-icons': path.resolve(__dirname, '../overlay-runtime/node_modules/@fortawesome/free-brands-svg-icons'),
    },
    dedupe: ['react', 'react-dom', '@react-three/fiber', 'three'],
  },
  optimizeDeps: {
    include: ['montaj-overlay-runtime'],
    // @devbycrux/editor is a file:-linked workspace package under active development —
    // serve it from source (not a pre-bundled dep) so edits to editor/src apply via
    // HMR instead of requiring a Vite .vite cache clear.
    exclude: ['@devbycrux/editor'],
  },
  server: {
    port: 5173,
    // HMR WebSocket must connect directly to Vite (not through the FastAPI proxy at 3000)
    hmr: { host: 'localhost', port: 5173 },
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})

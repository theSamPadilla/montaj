import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three') || id.includes('@react-three')) return 'three'
          if (id.includes('@xyflow')) return 'xyflow'
          // Without an explicit react bucket, Rollup's automatic chunking merges the
          // react/react-dom modules into the 'xyflow' chunk (since @xyflow/react is
          // their only other consumer here), which then forces 'xyflow' to be eagerly
          // modulepreloaded from the entry HTML — defeating the split above.
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom')) return 'vendor-react'
        },
      },
    },
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
    // @bycrux/editor is a file:-linked workspace package under active development —
    // serve it from source (not a pre-bundled dep) so edits to editor/src apply via
    // HMR instead of requiring a Vite .vite cache clear.
    exclude: ['@bycrux/editor'],
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

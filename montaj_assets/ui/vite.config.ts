import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // SP4 — harmless future-proofing for the playback engine's decode worker.
  // The engine loads its worker/worklet from inline source strings via Blob
  // URLs (decision 6), which this setting doesn't affect at all; it only
  // matters if a later task ever adds a real `new Worker(new URL(...))`
  // asset-based worker, which this SP explicitly does not do.
  worker: { format: 'es' },
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
      //
      // @bycrux/timeline-core is the same problem, one step removed: @bycrux/editor
      // (file:../editor) depends on it, and editor's sources import it by bare
      // specifier. This alias is LOAD-BEARING — do not delete it.
      //
      // In CI nothing links the package anywhere reachable. The ui job runs only
      // `npm ci` in montaj_assets/ui (.github/workflows/ci.yml), never in
      // montaj_assets/editor, so editor/node_modules is never created; and
      // ui/package-lock.json has no @bycrux/timeline-core entry, so `npm ci`
      // (which installs strictly from the lockfile) puts nothing in
      // ui/node_modules either. Editor sources resolve from their own realpath,
      // montaj_assets/editor/, and would walk up finding nothing — the build
      // fails without this line.
      //
      // It resolves WITHOUT the alias only on a dev machine that has separately
      // run `npm install` in montaj_assets/editor, which creates the symlink CI
      // never has. Testing alias removal locally therefore gives a false pass.
      // It also pins a single resolver instance across both packages, the way the
      // React aliases do, and covers ui ever importing the resolver directly.
      '@bycrux/timeline-core': path.resolve(__dirname, '../timeline-core'),
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
    // @bycrux/editor and @bycrux/timeline-core are file:-linked workspace packages
    // under active development — serve them from source (not pre-bundled deps) so
    // edits to editor/src or timeline-core/src apply via HMR instead of requiring a
    // Vite .vite cache clear. The timeline-core entry is belt-and-braces: the alias
    // above already rewrites it to a path outside node_modules, which dep
    // pre-bundling skips anyway. It matters if that alias is ever removed — then
    // Vite would discover timeline-core mid-session as a new bare import and
    // trigger a re-optimize plus a full page reload.
    exclude: ['@bycrux/editor', '@bycrux/timeline-core'],
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

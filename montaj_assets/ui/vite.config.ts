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
    alias: { '@': path.resolve(__dirname, './src') },
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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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

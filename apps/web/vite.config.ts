import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API runs as a separate Node service (apps/api). In dev we proxy /api to
// it; in production the API serves this app's dist/ from WEB_DIST.
const apiOrigin = process.env.API_ORIGIN || 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
})
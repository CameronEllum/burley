import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The Go server serves the built app from /, and the Vite dev server proxies the
// API so `npm run dev` can be used against `burley --addr 127.0.0.1:8080`.
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
})

import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

function syncGoEmbedDist(): Plugin {
  return {
    name: 'sync-go-embed-dist',
    async closeBundle() {
      const fsId = 'node:' + 'fs'
      const pathId = 'node:' + 'path'
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        existsSync(p: string): boolean
        rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void
        cpSync(src: string, dest: string, opts: { recursive?: boolean }): void
      }
      const path = (await import(/* @vite-ignore */ pathId)) as {
        resolve(...paths: string[]): string
      }
      const srcDir = path.resolve('dist')
      const dstDir = path.resolve('..', 'cmd', 'server', 'dist')
      if (!fs.existsSync(srcDir)) return
      fs.rmSync(dstDir, { recursive: true, force: true })
      fs.cpSync(srcDir, dstDir, { recursive: true })
    },
  }
}

// The Go server serves the built app from /, and the Vite dev server proxies the
// API so `npm run dev` can be used against `burley --addr 127.0.0.1:8080`.
export default defineConfig({
  plugins: [svelte(), syncGoEmbedDist()],
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

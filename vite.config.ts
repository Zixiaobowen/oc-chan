import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { rendererLicensePlugin } from './scripts/bundled-licenses'
import { performancePlugin, smokePlugin } from './scripts/performance/vite-plugin.mjs'

const instance = process.env.OC_CHAN_DEV_INSTANCE

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), rendererLicensePlugin(), ...performancePlugin(), ...smokePlugin()],
  clearScreen: false,
  build: {
    outDir: path.resolve(instance ? path.join(instance, 'frontend') : 'out/renderer'),
    emptyOutDir: true,
    target: 'safari17',
    minify: true,
    sourcemap: false
  },
  ...(instance ? { cacheDir: path.join(instance, 'vite-cache') } : {}),
  server: { host: '127.0.0.1', port: 0, strictPort: true }
})

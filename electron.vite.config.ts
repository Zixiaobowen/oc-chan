import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const developmentInstance = process.env.OC_CHAN_DEV_INSTANCE

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    ...(developmentInstance ? {
      cacheDir: path.join(developmentInstance, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true }
    } : {})
  }
})

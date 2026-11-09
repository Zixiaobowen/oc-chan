import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import base from '../../electron.vite.config.ts'
import { createFixturePlugin } from './fixture-plugin.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const filename = process.env.OC_CHAN_PERFORMANCE_CONFIG
if (!process.env.OC_CHAN_DEV_INSTANCE || process.env.OC_CHAN_HEADLESS !== '1' || !filename || statSync(filename).size > 128 * 1024) throw new Error('Performance config requires the isolated headless launcher')
const config = JSON.parse(readFileSync(filename, 'utf8'))
const prepend = (target, probe) => ({
  name: `performance-${probe}`,
  enforce: 'pre',
  transform(source, id) {
    if (id.split('?')[0] !== path.join(root, target)) return null
    if (target === 'src/main/plugins/catalog.ts') {
      const calls = source.match(/\(await import\('\.\/agents'\)\)\.createAgentsPlugin\(\)/g)
      if (calls?.length !== 1) throw new Error('Expected one lazy Agent plugin factory in the trusted collection catalog')
      const instrumented = source.replace(/\(await import\('\.\/agents'\)\)\.createAgentsPlugin\(\)/, 'createPerformanceAgentsPlugin()')
      return { code: `import { createPerformanceAgentsPlugin } from ${JSON.stringify(path.join(root, 'scripts/performance', probe))};\n${instrumented}`, map: null }
    }
    return { code: `import ${JSON.stringify(path.join(root, 'scripts/performance', probe))};\n${source}`, map: null }
  }
})
const trayControl = {
  name: 'performance-tray-control',
  transform(source, id) {
    if (id.split('?')[0] !== path.join(root, 'src/main/index.ts')) return null
    if (!config.smoke?.marketplace) {
      if ((source.match(/await marketplace\.initialize\(\)/g) ?? []).length !== 1) throw new Error('Expected one plugin marketplace initialization')
      source = source.replace('await marketplace.initialize()', 'await marketplace.initialize(); await marketplace.install("system")')
    }
    return { code: `${source}\nObject.defineProperty(globalThis, '__ocPerformanceTray', {value: {open: () => trayPanel.ensure().then(panel => panel.webContents.id), notifications: () => eventNotifications.snapshot()}});`, map: null }
  }
}
const fixtures = config.level === 'L0' ? null : createFixturePlugin({ ...config.fixture, level: config.level }, root)
export default {
  ...base,
  main: {
    ...base.main,
    plugins: [prepend('src/main/plugins/catalog.ts', 'main-probe.mjs'), trayControl, ...base.main.plugins, ...(fixtures ? [fixtures] : [])]
  },
  preload: { ...base.preload, plugins: [prepend('src/preload/index.ts', 'preload-probe.mjs'), ...base.preload.plugins] },
  renderer: { ...base.renderer, plugins: [prepend('src/renderer/src/main.tsx', 'renderer-probe.mjs'), ...base.renderer.plugins] }
}

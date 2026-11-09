import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, statSync } from 'node:fs'
import performance from '../performance/vite.config.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
if (!process.env.OC_CHAN_SMOKE_CONFIG || process.env.OC_CHAN_SMOKE_CONFIG !== process.env.OC_CHAN_PERFORMANCE_CONFIG)
  throw new Error('Smoke and performance fixtures must share one isolated configuration')
if (statSync(process.env.OC_CHAN_SMOKE_CONFIG).size > 128 * 1024) throw new Error('Smoke configuration exceeds budget')
const smoke = JSON.parse(readFileSync(process.env.OC_CHAN_SMOKE_CONFIG, 'utf8')).smoke

// Inherit the existing real collectors, fixture mapping, preload and renderer probes.
// Only the smoke build exposes control; the production entry and bridge stay unchanged.
const control = {
  name: 'occhan-smoke-control',
  enforce: 'pre',
  transform(source, id) {
    if (id.split('?')[0] !== path.join(root, 'src/main/index.ts')) return null
    if ((source.match(/const monitor: Monitor = new Monitor\(/g) ?? []).length !== 1)
      throw new Error('Smoke control requires one explicit application Monitor')
    if (smoke.marketplace) {
      if ((source.match(/new PluginMarketplace\(\{/g) ?? []).length !== 1) throw new Error('Marketplace smoke requires one application marketplace')
      source = `import { smokeMarketFetch } from ${JSON.stringify(path.join(root, 'scripts/smoke/marketplace-fetch.mjs'))};\n`
        + source.replace('new PluginMarketplace({', 'new PluginMarketplace({ fetch: smokeMarketFetch,')
    }
    return {
      code: `import { installSmokeControl } from ${JSON.stringify(path.join(root, 'scripts/smoke/main-probe.mjs'))};\n${source}\ninstallSmokeControl(monitor);`,
      map: null
    }
  }
}
export default { ...performance, main: { ...performance.main, plugins: [...performance.main.plugins, control] } }

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import performance from '../performance/vite.config.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
if (!process.env.OC_CHAN_SMOKE_CONFIG || process.env.OC_CHAN_SMOKE_CONFIG !== process.env.OC_CHAN_PERFORMANCE_CONFIG)
  throw new Error('Smoke and performance fixtures must share one isolated configuration')

// Inherit the existing real collectors, fixture mapping, preload and renderer probes.
// Only the smoke build exposes control; the production entry and bridge stay unchanged.
const control = {
  name: 'occhan-smoke-control',
  enforce: 'pre',
  transform(source, id) {
    if (id.split('?')[0] !== path.join(root, 'src/main/index.ts')) return null
    if ((source.match(/const monitor: Monitor = new Monitor\(/g) ?? []).length !== 1)
      throw new Error('Smoke control requires one explicit application Monitor')
    return {
      code: `import { installSmokeControl } from ${JSON.stringify(path.join(root, 'scripts/smoke/main-probe.mjs'))};\n${source}\ninstallSmokeControl(monitor);`,
      map: null
    }
  }
}
export default { ...performance, main: { ...performance.main, plugins: [...performance.main.plugins, control] } }

import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url))
export function performancePlugin() {
  if (process.env.OC_CHAN_PERFORMANCE !== '1') return []
  const instance = process.env.OC_CHAN_DEV_INSTANCE
  if (!instance || path.dirname(instance) !== path.join(root, '.dev-instances') || process.env.OC_CHAN_HEADLESS !== '1') throw new Error('Performance requires the isolated headless acceptance launcher')
  const probe = JSON.stringify(path.join(root, 'src/renderer/src/performance-probe.ts'))
  const replace = (source, target, replacement) => {
    if (source.split(target).length !== 2) throw new Error(`Performance hook drift: ${target}`)
    return source.replace(target, replacement)
  }
  return [{ name: 'oc-acceptance-performance', enforce: 'pre', transform(source, id) {
    const file = path.relative(root, id.split('?')[0])
    if (file === 'src/renderer/src/main.tsx') return { code: `import ${probe};\n${source}`, map: null }
    if (['src/renderer/src/App.tsx', 'src/renderer/src/TrayView.tsx'].includes(file)) {
      const match = source.match(/const \[snapshot, setSnapshot\] = useState(?:<[^>]+>)?\((?:initial|empty)\)/g)
      if (match?.length !== 1) throw new Error(`Performance snapshot hook drift: ${file}`)
      return { code: `import { usePerformanceSnapshot } from ${probe};\n` + replace(source, match[0], `${match[0]}; usePerformanceSnapshot(snapshot, setSnapshot)`), map: null }
    }
    if (file === 'src/renderer/src/desktop-api.ts') return { code: `import { performanceReceive } from ${probe};\n` + replace(source, 'receive(event.payload, value => {', 'receive(event.payload, value => { performanceReceive(key, value);'), map: null }
    return null
  } }]
}

export function smokePlugin() {
  if (process.env.OC_CHAN_SMOKE !== '1') return []
  const instance = process.env.OC_CHAN_DEV_INSTANCE
  if (!instance || path.dirname(instance) !== path.join(root, '.dev-instances') || process.env.OC_CHAN_HEADLESS !== '1') throw new Error('Smoke requires the isolated headless acceptance launcher')
  const probe = JSON.stringify(path.join(root, 'src/renderer/src/smoke-probe.ts'))
  const marker = "invoke('desktop_ack', { owner, args: { sequence: payload.sequence } }, options)"
  return [{ name: 'oc-acceptance-smoke', enforce: 'pre', transform(source, id) {
    if (path.relative(root, id.split('?')[0]) !== 'src/renderer/src/desktop-api.ts') return null
    if (source.split(marker).length !== 2) throw new Error(`Smoke ACK hook drift: ${marker}`)
    return { code: `import { smokeAcknowledge } from ${probe};\n` + source.replace(marker, `smokeAcknowledge(() => ${marker})`), map: null }
  } }]
}

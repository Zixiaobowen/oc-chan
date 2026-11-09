import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildPluginMarket } from './build-plugin-market.mjs'
import { PluginMarketplace } from '../src/main/marketplace/manager.ts'
import { Monitor } from '../src/main/monitor.ts'
import { OFFICIAL_CATALOG } from '../src/main/marketplace/validation.ts'

test('Vite独立构建的系统包完成真实采样、升级、持久恢复和卸载', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-plugin-build-'))
  const monitors = [], markets = []
  try {
    const bundled = await buildPluginMarket(path.join(root, 'bundled'))
    const upgraded = await buildPluginMarket(path.join(root, 'online'), { version: '1.1.0' })
    const payload = await readFile(bundled.packagePath)
    assert.equal(createHash('sha256').update(payload).digest('hex'), bundled.catalog.plugins[0].sha256)
    assert.equal(payload.length, bundled.catalog.plugins[0].bytes)
    const options = { directory: path.join(root, 'installed'), bundledDirectory: bundled.directory, appVersion: '0.1.0', enabled: () => true, changed() {},
      fetch: async url => new Response(String(url) === OFFICIAL_CATALOG ? JSON.stringify(upgraded.catalog) : await readFile(upgraded.packagePath)) }
    const monitor = new Monitor()
    monitors.push(monitor)
    const market = new PluginMarketplace({ ...options, monitor })
    markets.push(market)
    await market.initialize()
    assert.equal(monitor.pluginStatuses().length, 0)
    await market.install('system')
    assert.equal(monitor.state.system.data.hostname, os.hostname())
    assert.equal(monitor.state.system.data.memoryTotal, os.totalmem())
    assert.ok(monitor.state.system.data.memoryUsed > 0)
    assert.ok(monitor.state.system.data.cpuCores > 0)
    await market.check(); await market.update('system')
    assert.equal(market.snapshot().items[0].installedVersion, '1.1.0')
    assert.equal(monitor.state.system.data.hostname, os.hostname())
    await market.close(); await monitor.stop()
    const restoredMonitor = new Monitor()
    monitors.push(restoredMonitor)
    const restored = new PluginMarketplace({ ...options, monitor: restoredMonitor })
    markets.push(restored)
    await restored.initialize()
    assert.equal(restored.snapshot().items[0].installedVersion, '1.1.0')
    assert.equal(restoredMonitor.state.system.data.hostname, os.hostname())
    await restored.uninstall('system')
    assert.equal(restoredMonitor.pluginStatuses().length, 0)
    assert.equal(restoredMonitor.state.system.data, null)
    assert.deepEqual(await readdir(options.directory), [])
  } finally {
    const failures = []
    for (const market of markets) { try { await market.close() } catch (error) { failures.push(error) } }
    for (const monitor of monitors) { try { await monitor.stop() } catch (error) { failures.push(error) } }
    await rm(root, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures)
  }
})

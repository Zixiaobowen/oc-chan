import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Monitor } from '../monitor'
import type { PluginCatalog, PluginManifest } from '../../shared/marketplace'
import { PluginMarketplace } from './manager'
import { MARKET_LIMITS, OFFICIAL_CATALOG } from './validation'

const manifest: PluginManifest = { id: 'system', version: '1.0.0', apiVersion: 1, name: '系统监控', nameEn: 'System Monitor', description: '测试受控发布包', descriptionEn: 'Controlled test release', publisher: 'OC Chan', section: 'system', minAppVersion: '0.1.0', platforms: ['darwin'], permissions: ['system-metrics'] }
const sample = { collectedAt: '2026-11-09T00:00:00Z', hostname: 'test', platform: 'darwin', osVersion: '1', cpuModel: 'test', cpuCores: 1, uptimeSeconds: 1,
  cpuPercent: 25, memoryTotal: 100, memoryUsed: 50, memoryAvailable: 50, memoryApp: 20, memoryWired: 20, memoryCompressed: 10, swapUsed: 0,
  diskTotal: 100, diskUsed: 50, diskAvailable: 50, rxBytesPerSecond: null, txBytesPerSecond: null, networkInterface: null, processes: [], memoryProcesses: [], history: [], sources: [] }
function release(version = '1.0.0', collect = `return ${JSON.stringify(sample)}`, stop = '') {
  const current = { ...manifest, version }
  const code = `exports.createPlugin = sdk => ({ id:'system', section:'system', capabilities:['system-metrics'], intervalMs:60000, timeoutMs:30000, create() { return { async collect(signal) { ${collect} }, stop() { ${stop} } } } })`
  const bytes = Buffer.from(JSON.stringify({ schema: 1, manifest: current, code }))
  const catalog: PluginCatalog = { schema: 1, plugins: [{ manifest: current, package: `system-${version}.ocplugin`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] }
  return { bytes, catalog }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-market-'))
  const bundledDirectory = path.join(root, 'bundled'), directory = path.join(root, 'installed')
  await mkdir(bundledDirectory)
  const bundled = release()
  await writeFile(path.join(bundledDirectory, 'catalog.json'), JSON.stringify(bundled.catalog))
  await writeFile(path.join(bundledDirectory, bundled.catalog.plugins[0].package), bundled.bytes)
  let online = release('1.1.0')
  const fetcher: typeof fetch = async url => new Response(String(url) === OFFICIAL_CATALOG ? JSON.stringify(online.catalog) : online.bytes)
  const monitors: Monitor[] = [], markets: PluginMarketplace[] = []
  function create(fetchOverride = fetcher) {
    const monitor = new Monitor()
    const market = new PluginMarketplace({ directory, bundledDirectory, appVersion: '0.1.0', monitor, enabled: () => true, changed() {}, fetch: fetchOverride })
    monitors.push(monitor); markets.push(market)
    return { market, monitor }
  }
  return { root, directory, bundledDirectory, bundled, create, online: (value: typeof online) => { online = value },
    async close() {
      const failures: unknown[] = []
      for (const market of markets) { try { await market.close() } catch (error) { failures.push(error) } }
      for (const monitor of monitors) { try { await monitor.stop() } catch (error) { failures.push(error) } }
      await rm(root, { recursive: true, force: true })
      if (failures.length) throw new AggregateError(failures)
    } }
}

test('安装真实包、首采样、持久重启、更新与卸载后重启保持未安装', async () => {
  const f = await fixture()
  try {
    const first = f.create()
    await first.market.initialize()
    assert.equal(first.monitor.pluginStatuses().length, 0)
    assert.equal(first.market.snapshot().items[0].installedVersion, null)
    await first.market.install('system')
    assert.equal(first.monitor.state.system.data?.cpuPercent, 25)
    assert.equal(first.market.snapshot().items[0].installedVersion, '1.0.0')
    await first.market.close(); await first.monitor.stop()
    const second = f.create()
    await second.market.initialize()
    assert.equal(second.market.snapshot().items[0].installedVersion, '1.0.0')
    assert.equal(second.monitor.state.system.data?.cpuPercent, 25)
    await second.market.check()
    assert.equal(second.market.snapshot().items[0].updateAvailable, true)
    await second.market.update('system')
    assert.equal(second.market.snapshot().items[0].installedVersion, '1.1.0')
    await second.market.uninstall('system')
    assert.deepEqual(await readdir(f.directory), [])
    assert.equal(second.monitor.pluginStatuses().length, 0)
    assert.equal(second.monitor.state.system.data, null)
    await second.market.close(); await second.monitor.stop()
    const third = f.create()
    await third.market.initialize()
    assert.equal(third.market.snapshot().items[0].installedVersion, null)
    assert.equal(third.monitor.pluginStatuses().length, 0)
  } finally { await f.close() }
})

test('SHA不符和坏代码不得停止旧版本；新版本首采样失败完整回滚', async () => {
  const f = await fixture()
  try {
    const { market, monitor } = f.create()
    await market.initialize(); await market.install('system')
    const badHash = release('1.1.0')
    badHash.catalog.plugins[0].sha256 = '0'.repeat(64)
    f.online(badHash)
    await market.check()
    await assert.rejects(market.update('system'), /integrity mismatch/)
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
    f.online(release('1.2.0', 'throw new Error("activation refused")'))
    await market.check()
    await assert.rejects(market.update('system'), /activation refused/)
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'system.ocplugin'), 'utf8')).manifest.version, '1.0.0')
    assert.deepEqual(await readdir(f.directory), ['system.ocplugin'])
  } finally { await f.close() }
})

test('下载期间旧版继续运行；取消排空，重复变更立即拒绝', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url) === OFFICIAL_CATALOG) return new Response(JSON.stringify(release('1.1.0').catalog))
    started.resolve()
    const pending = Promise.withResolvers<Response>()
    const abort = () => pending.reject(new DOMException('cancelled', 'AbortError'))
    init?.signal?.addEventListener('abort', abort, { once: true })
    if (init?.signal?.aborted) abort()
    return pending.promise
  }
  try {
    const { market, monitor } = f.create(fetcher)
    await market.initialize(); await market.install('system'); await market.check()
    const updating = market.update('system')
    const rejected = assert.rejects(updating, { name: 'AbortError' })
    await started.promise
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
    await assert.rejects(market.uninstall('system'), /busy/)
    await market.cancel(); await rejected
    assert.equal(market.snapshot().operation, null)
    assert.equal(market.snapshot().error, null)
    assert.equal(market.snapshot().items[0].error, null)
    assert.deepEqual(await readdir(f.directory), ['system.ocplugin'])
  } finally { await f.close() }
})

test('close取消首轮采样、排空后移除未激活文件和runtime', async () => {
  const f = await fixture()
  const blocked = release('1.1.0', 'const pending = Promise.withResolvers(); signal.addEventListener("abort", () => pending.reject(new DOMException("cancelled", "AbortError")), { once: true }); if(signal.aborted) pending.reject(new DOMException("cancelled", "AbortError")); await pending.promise;')
  f.online(blocked)
  try {
    const { market, monitor } = f.create()
    await market.initialize(); await market.check()
    const started = Promise.withResolvers<void>()
    const register = monitor.registerPlugin.bind(monitor)
    monitor.registerPlugin = async (...args) => { const work = register(...args); started.resolve(); return work }
    const installation = market.install('system')
    const rejected = assert.rejects(installation, /cancel|abort/i)
    await started.promise
    await market.close(); await rejected
    assert.deepEqual(await readdir(f.directory), [])
    assert.equal(monitor.pluginStatuses().length, 0)
    assert.equal(market.snapshot().error, null)
  } finally { await f.close() }
})

test('目录和包超限、路径穿越、符号链接和未允许require明确拒绝', async () => {
  const f = await fixture()
  try {
    const { market } = f.create()
    await market.initialize()
    const target = path.join(f.bundledDirectory, f.bundled.catalog.plugins[0].package)
    await rm(target)
    await symlink(path.join(f.bundledDirectory, 'catalog.json'), target)
    await assert.rejects(market.install('system'))
    assert.deepEqual(await readdir(f.directory), [])
    await rm(target)
    await writeFile(target, Buffer.alloc(MARKET_LIMITS.packageBytes + 1))
    await assert.rejects(market.install('system'), /exceeds limit/)
    const bad = release('1.1.0', 'return require("node:child_process")')
    f.online(bad)
    await market.check()
    await assert.rejects(market.install('system'), /Module not allowed/)
    assert.deepEqual(await readdir(f.directory), [])
    bad.catalog.plugins[0].package = '../outside.ocplugin'
    await assert.rejects(market.check(), /Invalid package path/)
    await assert.rejects(market.install('../system'), /Invalid plugin ID/)
  } finally { await f.close() }
})

test('重启显示损坏安装，卸载后可重新安装', async () => {
  const f = await fixture()
  try {
    await mkdir(f.directory)
    await writeFile(path.join(f.directory, 'system.ocplugin'), '{broken')
    const { market, monitor } = f.create()
    await market.initialize()
    assert.ok(market.snapshot().items[0].error)
    assert.equal(market.snapshot().items[0].installed, true)
    assert.equal(market.snapshot().items[0].installedVersion, null)
    assert.equal(monitor.pluginStatuses().length, 0)
    await market.uninstall('system')
    await market.install('system')
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
  } finally { await f.close() }
})

test('卸载stop失败保留安装文件和诊断，不把插件伪报为未安装', async () => {
  const f = await fixture()
  let stopFailed = false
  try {
    f.online(release('1.1.0', `return ${JSON.stringify(sample)}`, 'throw new Error("owned resource cleanup failed")'))
    const { market, monitor } = f.create()
    await market.initialize(); await market.check(); await market.install('system')
    await assert.rejects(market.uninstall('system'), /restart the app/)
    stopFailed = true
    assert.equal(market.snapshot().items[0].installed, true)
    assert.equal(market.snapshot().items[0].installedVersion, '1.1.0')
    assert.equal(monitor.pluginStatuses().length, 1)
    assert.deepEqual(await readdir(f.directory), ['system.ocplugin'])
    await assert.rejects(market.uninstall('system'), /restart the app/)
  } finally {
    if (stopFailed) await assert.rejects(f.close(), AggregateError)
    else await f.close()
  }
})

test('取消检查保持中性状态，不伪报目录错误或检查成功', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const fetcher: typeof fetch = async (_url, init) => {
    const pending = Promise.withResolvers<Response>()
    const abort = () => pending.reject(new DOMException('cancelled', 'AbortError'))
    init?.signal?.addEventListener('abort', abort, { once: true })
    if (init?.signal?.aborted) abort()
    entered.resolve()
    return pending.promise
  }
  try {
    const { market } = f.create(fetcher)
    await market.initialize()
    const checking = market.check()
    const rejected = assert.rejects(checking, { name: 'AbortError' })
    await entered.promise
    await market.cancel(); await rejected
    assert.equal(market.snapshot().checking, false)
    assert.equal(market.snapshot().checkedAt, null)
    assert.equal(market.snapshot().catalogError, null)
    assert.equal(market.snapshot().error, null)
    assert.equal(market.snapshot().items[0].error, null)
  } finally { await f.close() }
})

test('取消下载遇到真实stream回收失败时仍报告AggregateError', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const fetcher: typeof fetch = async url => {
    if (String(url) === OFFICIAL_CATALOG) return new Response(JSON.stringify(release('1.1.0').catalog))
    return new Response(new ReadableStream<Uint8Array>({
      pull() { entered.resolve() },
      cancel() { throw new Error('response cleanup failed') }
    }))
  }
  try {
    const { market, monitor } = f.create(fetcher)
    await market.initialize(); await market.install('system'); await market.check()
    const updating = market.update('system')
    const rejected = assert.rejects(updating, AggregateError)
    await entered.promise
    await assert.rejects(market.cancel(), AggregateError)
    await rejected
    assert.match(market.snapshot().error?.message ?? '', /response cleanup failed/)
    assert.match(market.snapshot().items[0].error ?? '', /response cleanup failed/)
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
    assert.equal(monitor.state.system.data?.cpuPercent, 25)
  } finally { await f.close() }
})

test('升级失败且旧版重新注册失败时保留完整回滚诊断', async () => {
  const f = await fixture()
  try {
    const { market, monitor } = f.create()
    await market.initialize(); await market.install('system')
    f.online(release('1.1.0', 'throw new Error("new collection refused")'))
    await market.check()
    const register = monitor.registerPlugin.bind(monitor)
    let attempts = 0
    monitor.registerPlugin = async (...args) => {
      if (++attempts === 2) throw new Error('old registration refused')
      return register(...args)
    }
    await assert.rejects(market.update('system'), AggregateError)
    assert.match(market.snapshot().error?.message ?? '', /new collection refused/)
    assert.match(market.snapshot().items[0].error ?? '', /old registration refused/)
    assert.equal(market.snapshot().items[0].installedVersion, '1.0.0')
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'system.ocplugin'), 'utf8')).manifest.version, '1.0.0')
  } finally { await f.close() }
})

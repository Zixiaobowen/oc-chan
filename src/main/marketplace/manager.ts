import { lstat, rename, unlink } from 'node:fs/promises'
import semver from 'semver'
import type { Monitor } from '../monitor'
import type { MonitorSection } from '../../shared/types'
import type { MarketplaceAction, MarketplaceItem, MarketplaceSnapshot, PluginCatalogEntry, PluginManifest } from '../../shared/marketplace'
import { throwIfAborted } from '../resource-budget'
import { loadPlugin } from './loader'
import { childPath, download, fileExists, installedFiles, officialUrl, readBounded, safeDirectory, writeExclusive } from './io'
import { MARKET_LIMITS, OFFICIAL_BASE, OFFICIAL_CATALOG, pluginId, validateCatalog, validatePackage } from './validation'

export interface PluginMarketplaceOptions {
  directory: string
  bundledDirectory: string
  appVersion: string
  remoteCatalogUrl?: string
  monitor: Pick<Monitor, 'registerPlugin' | 'unregisterPlugin' | 'pluginStatuses'>
  enabled(section: MonitorSection): boolean
  changed(snapshot: MarketplaceSnapshot): void
  fetch?: typeof fetch
}
interface Available { entry: PluginCatalogEntry; source: 'bundled' | 'online' }
interface Installed { manifest: PluginManifest; bytes: number }
function message(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(message).join('; ')}`.slice(0, 4000)
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000)
}
function cancelled(error: unknown): boolean {
  return error instanceof Error && !(error instanceof AggregateError) && error.name === 'AbortError'
}

export class PluginMarketplace {
  private directory = ''
  private bundledDirectory = ''
  private readonly available = new Map<string, Available>()
  private readonly installed = new Map<string, Installed>()
  private readonly diskIds = new Set<string>()
  private readonly itemErrors = new Map<string, string>()
  private state: MarketplaceSnapshot = { items: [], checking: false, checkedAt: null, catalogError: null, operation: null, error: null }
  private active?: { controller: AbortController; work: Promise<unknown> }
  private initialized = false
  private closed = false
  private closing?: Promise<void>
  constructor(private readonly options: PluginMarketplaceOptions) {
    if (!semver.valid(options.appVersion)) throw new Error('应用版本无效 / Invalid app version')
    if (options.remoteCatalogUrl && options.remoteCatalogUrl !== OFFICIAL_CATALOG) throw new Error('仅允许固定官方目录 / Only the fixed official catalog is allowed')
  }

  snapshot(): MarketplaceSnapshot {
    const statuses = this.options.monitor.pluginStatuses()
    const ids = new Set([...this.available.keys(), ...this.diskIds, ...this.installed.keys(), ...this.itemErrors.keys()])
    const items: MarketplaceItem[] = [...ids].map(id => {
      const available = this.available.get(id), installed = this.installed.get(id)
      const manifest = available?.entry.manifest ?? installed?.manifest ?? this.damagedManifest(id)
      return { manifest, installed: this.diskIds.has(id), installedVersion: installed?.manifest.version ?? null,
        enabled: statuses.find(status => status.id === id)?.enabled ?? false,
        updateAvailable: Boolean(available && installed && semver.gt(available.entry.manifest.version, installed.manifest.version)),
        source: available?.source ?? 'installed', error: this.itemErrors.get(id) ?? null }
    })
    return structuredClone({ ...this.state, items })
  }
  private publish(): void { this.options.changed(this.snapshot()) }
  private damagedManifest(id: string): PluginManifest {
    return { id, version: '0.0.0', apiVersion: 1, name: `损坏插件 ${id}`, nameEn: `Damaged plugin ${id}`, description: '安装文件损坏，请卸载后重新安装。',
      descriptionEn: 'The installed file is damaged. Uninstall it before reinstalling.', publisher: '未知 / Unknown', section: 'system', minAppVersion: '0.0.0', platforms: ['darwin'], permissions: [] }
  }
  private async exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('插件市场已关闭 / Marketplace is closed')
    if (this.active) throw new Error('已有插件市场操作正在进行 / Marketplace is busy')
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => work(controller.signal))
    this.active = { controller, work: promise }
    try { return await promise } finally { this.active = undefined }
  }
  async initialize(): Promise<void> {
    if (this.initialized) return
    return this.exclusive(async signal => {
      this.directory = await safeDirectory(this.options.directory, true)
      this.bundledDirectory = await safeDirectory(this.options.bundledDirectory)
      try {
        const catalog = validateCatalog(await readBounded(childPath(this.bundledDirectory, 'catalog.json'), MARKET_LIMITS.catalogBytes, signal), this.options.appVersion)
        for (const entry of catalog.plugins) this.available.set(entry.manifest.id, { entry, source: 'bundled' })
      } catch (error) { if (signal.aborted) throw error; this.state.catalogError = message(error) }
      const files = await installedFiles(this.directory)
      const ids = new Set(files.map(file => file.split('.')[0]))
      if (ids.size > MARKET_LIMITS.installed) throw new Error('已安装插件数量超过限制 / Too many installed plugins')
      for (const file of files) if (!file.endsWith('.pending')) this.diskIds.add(file.split('.')[0])
      let total = 0
      for (const id of ids) {
        throwIfAborted(signal)
        const current = this.file(id), pending = `${current}.pending`, rollback = `${current}.rollback`
        try {
          let interrupted = false
          if (await fileExists(rollback)) {
            await readBounded(rollback, MARKET_LIMITS.packageBytes, signal)
            if (await fileExists(current)) { await readBounded(current, MARKET_LIMITS.packageBytes, signal); await unlink(current) }
            await rename(rollback, current)
            interrupted = true
          }
          if (await fileExists(pending)) { await readBounded(pending, MARKET_LIMITS.packageBytes, signal); await unlink(pending); interrupted = true }
          if (!(await fileExists(current))) {
            this.diskIds.delete(id)
            if (interrupted) this.itemErrors.set(id, '上次安装中断，未安装插件 / Previous installation was interrupted')
            continue
          }
          const bytes = await readBounded(current, MARKET_LIMITS.packageBytes, signal)
          total += bytes.length
          if (total > MARKET_LIMITS.installedBytes) throw new Error('已安装插件总大小超过限制 / Installed byte limit exceeded')
          const pkg = validatePackage(bytes, this.options.appVersion)
          if (pkg.manifest.id !== id) throw new Error('安装文件名与插件 ID 不符 / Installed plugin ID mismatch')
          this.installed.set(id, { manifest: pkg.manifest, bytes: bytes.length })
          await this.options.monitor.registerPlugin(loadPlugin(pkg), this.options.enabled(pkg.manifest.section), signal)
          if (interrupted) this.itemErrors.set(id, '上次更新中断，已恢复原版 / Interrupted update restored the previous version')
        } catch (error) {
          if (signal.aborted) throw error
          this.itemErrors.set(id, message(error))
        }
      }
      this.initialized = true
      this.publish()
    })
  }
  private requireReady(): void { if (!this.initialized) throw new Error('插件市场尚未初始化 / Marketplace is not initialized') }
  async check(): Promise<MarketplaceSnapshot> {
    return this.exclusive(async signal => {
      this.requireReady()
      this.state.checking = true
      this.state.catalogError = null
      this.publish()
      try {
        const catalog = validateCatalog(await download(OFFICIAL_CATALOG, MARKET_LIMITS.catalogBytes, this.options.fetch ?? fetch, signal), this.options.appVersion)
        throwIfAborted(signal)
        const ids = new Set([...this.available.keys(), ...catalog.plugins.map(entry => entry.manifest.id)])
        if (ids.size > MARKET_LIMITS.catalogEntries) throw new Error('插件目录合计超过限制 / Combined catalog exceeds limit')
        for (const entry of catalog.plugins) {
          const previous = this.available.get(entry.manifest.id)
          if (!previous || semver.gte(entry.manifest.version, previous.entry.manifest.version)) this.available.set(entry.manifest.id, { entry, source: 'online' })
        }
        this.state.checkedAt = new Date().toISOString()
        return this.snapshot()
      } catch (error) { if (!cancelled(error)) this.state.catalogError = message(error); throw error }
      finally { this.state.checking = false; this.publish() }
    }).then(() => this.snapshot())
  }
  install(id: string): Promise<MarketplaceSnapshot> { return this.mutate(id, 'install') }
  update(id: string): Promise<MarketplaceSnapshot> { return this.mutate(id, 'update') }
  uninstall(id: string): Promise<MarketplaceSnapshot> { return this.mutate(id, 'uninstall') }
  private file(id: string): string { pluginId(id); return childPath(this.directory, `${id}.ocplugin`) }
  private mutate(id: string, action: MarketplaceAction): Promise<MarketplaceSnapshot> {
    return this.exclusive(async signal => {
      this.requireReady()
      pluginId(id)
      this.state.error = null
      this.state.operation = { id, action, phase: action === 'uninstall' ? 'removing' : 'downloading', receivedBytes: 0, totalBytes: 0 }
      this.publish()
      try {
        if (action === 'uninstall') await this.remove(id, signal)
        else await this.activate(id, action, signal)
        this.itemErrors.delete(id)
      } catch (error) {
        if (!cancelled(error)) {
          if (this.available.has(id) || this.installed.has(id) || this.itemErrors.has(id)) this.itemErrors.set(id, message(error))
          this.state.error = { id, action, message: message(error) }
        }
        throw error
      } finally { this.state.operation = null; this.publish() }
      return this.snapshot()
    })
  }
  private phase(phase: 'verifying' | 'activating'): void { if (this.state.operation) this.state.operation.phase = phase; this.publish() }
  private async stop(id: string): Promise<void> {
    try { await this.options.monitor.unregisterPlugin(id) }
    catch (error) { throw new Error(`${message(error)}；插件停止失败，安装文件已保留，请重启应用 / Plugin stop failed; files retained, restart the app`, { cause: error }) }
  }
  private async activate(id: string, action: 'install' | 'update', signal: AbortSignal): Promise<void> {
    const available = this.available.get(id), old = this.installed.get(id)
    if (!available) throw new Error('官方目录没有此插件 / Plugin is absent from the official catalog')
    if (action === 'install' && (old || await fileExists(this.file(id)))) throw new Error('插件已安装或存在损坏文件，请更新或卸载 / Plugin already installed or damaged')
    if (action === 'update' && (!old || !semver.gt(available.entry.manifest.version, old.manifest.version))) throw new Error('没有可安装的更高版本 / No newer plugin version')
    if (!old && this.diskIds.size >= MARKET_LIMITS.installed) throw new Error('已安装插件数量达到限制 / Installed plugin limit reached')
    if (!old && this.options.monitor.pluginStatuses().some(status => status.id === id || status.section === available.entry.manifest.section)) throw new Error('采集插件或分区已由核心占用 / Plugin or section is already registered by the core')
    const files = await installedFiles(this.directory)
    if (files.some(file => !file.endsWith('.ocplugin'))) throw new Error('存在未完成事务，请重启后处理 / An interrupted transaction requires restart')
    if (files.length + (old ? 0 : 1) > MARKET_LIMITS.installed) throw new Error('已安装插件数量超过限制 / Installed plugin limit exceeded')
    let storedBytes = 0
    for (const file of files) {
      throwIfAborted(signal)
      const info = await lstat(childPath(this.directory, file))
      if (!info.isFile() || info.nlink !== 1 || info.size > MARKET_LIMITS.packageBytes) throw new Error('安装目录存在非普通、链接或超限插件文件 / Installed directory contains an invalid or oversized file')
      storedBytes += info.size
    }
    if (storedBytes + available.entry.bytes > MARKET_LIMITS.installedBytes) throw new Error('安装与事务暂存总大小超过限制 / Installation and staging byte limit exceeded')
    this.state.operation!.totalBytes = available.entry.bytes
    const bytes = available.source === 'online'
      ? await download(officialUrl(`${OFFICIAL_BASE}${available.entry.package}`).href, available.entry.bytes, this.options.fetch ?? fetch, signal, received => {
        this.state.operation!.receivedBytes = received; this.publish()
      })
      : await readBounded(childPath(this.bundledDirectory, available.entry.package), available.entry.bytes, signal)
    this.state.operation!.receivedBytes = bytes.length
    this.phase('verifying')
    const pkg = validatePackage(bytes, this.options.appVersion, available.entry)
    const definition = loadPlugin(pkg)
    const current = this.file(id), pending = `${current}.pending`, rollback = `${current}.rollback`
    if (await fileExists(pending) || await fileExists(rollback)) throw new Error('存在未完成事务，请重启后处理 / An interrupted transaction requires restart')
    const oldPackage = old ? validatePackage(await readBounded(current, MARKET_LIMITS.packageBytes, signal), this.options.appVersion) : undefined
    if (old && oldPackage && JSON.stringify(oldPackage.manifest) !== JSON.stringify(old.manifest)) throw new Error('已安装插件在操作前发生变化 / Installed plugin changed before update')
    let staged = false, oldRemoved = false, backedUp = false, swapped = false, attempted = false
    try {
      staged = true
      await writeExclusive(pending, bytes, signal)
      throwIfAborted(signal)
      this.phase('activating')
      if (old && this.options.monitor.pluginStatuses().some(status => status.id === id)) await this.stop(id)
      oldRemoved = Boolean(old)
      throwIfAborted(signal)
      if (old) { await rename(current, rollback); backedUp = true }
      await rename(pending, current)
      staged = false; swapped = true; attempted = true
      this.diskIds.add(id)
      await this.options.monitor.registerPlugin(definition, this.options.enabled(pkg.manifest.section), signal)
      throwIfAborted(signal)
      if (backedUp) { await unlink(rollback); backedUp = false }
      this.installed.set(id, { manifest: pkg.manifest, bytes: bytes.length })
    } catch (error) {
      const failures: unknown[] = [error]
      let canRestore = true
      if (attempted && this.options.monitor.pluginStatuses().some(status => status.id === id)) {
        try { await this.stop(id) } catch (cleanup) { failures.push(cleanup); canRestore = false }
      }
      if (canRestore) {
        try {
          if (swapped) { await unlink(current); if (!old) this.diskIds.delete(id) }
          if (backedUp) { await rename(rollback, current); backedUp = false }
          if (oldRemoved && oldPackage && !this.closed) await this.options.monitor.registerPlugin(loadPlugin(oldPackage), this.options.enabled(oldPackage.manifest.section))
        } catch (restore) { failures.push(restore) }
      } else if (swapped) {
        this.installed.set(id, { manifest: pkg.manifest, bytes: bytes.length })
      }
      if (staged && await fileExists(pending)) {
        try { await unlink(pending) } catch (cleanup) { failures.push(cleanup) }
      }
      if (failures.length === 1) throw error
      throw new AggregateError(failures, '插件操作失败且回滚或清理失败 / Plugin operation and rollback or cleanup failed')
    }
  }
  private async remove(id: string, signal: AbortSignal): Promise<void> {
    const file = this.file(id)
    if (!(await fileExists(file)) && !this.installed.has(id) && !this.itemErrors.has(id)) throw new Error('插件未安装 / Plugin is not installed')
    for (const candidate of [file, `${file}.pending`, `${file}.rollback`]) if (await fileExists(candidate)) await readBounded(candidate, MARKET_LIMITS.packageBytes, signal)
    throwIfAborted(signal)
    if (this.options.monitor.pluginStatuses().some(status => status.id === id)) await this.stop(id)
    // Once stop succeeds, deletion is the commit point and is drained even if cancellation arrives.
    for (const candidate of [`${file}.pending`, `${file}.rollback`, file]) if (await fileExists(candidate)) await unlink(candidate)
    this.installed.delete(id)
    this.diskIds.delete(id)
  }
  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    active.controller.abort()
    try { await active.work } catch (error) { if (!cancelled(error)) throw error }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.cancel()
    return this.closing
  }
}

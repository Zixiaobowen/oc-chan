import os from 'node:os'
import { statfs } from 'node:fs/promises'
import type { StatsFs } from 'node:fs'
import { NetworkReader } from './network'
import type { PluginSdk } from '../../../main/marketplace/sdk'
import type { SourceStatus } from '../../../shared/types'
import type { ProcessInfo, SystemSample, SystemSnapshot } from '../types'

export interface CpuTimes { idle: number; total: number }
export interface SystemMemory {
  total: number
  active: number
  app: number
  wired: number
  compressed: number
  available: number
  swapused: number
}

function cpuTimes(): CpuTimes {
  return os.cpus().reduce((result, cpu) => {
    result.idle += cpu.times.idle
    result.total += Object.values(cpu.times).reduce((a, b) => a + b, 0)
    return result
  }, { idle: 0, total: 0 })
}

export function parseMemory(vmOutput: string, swapOutput: string, total: number): SystemMemory {
  const pageSize = Number(vmOutput.match(/page size of (\d+) bytes/)?.[1])
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error('vm_stat 未返回有效页大小')
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('物理内存总量无效')
  const counters = new Map(Array.from(vmOutput.matchAll(/^([^:\n]+):\s+(\d+)\./gm), match => [match[1], Number(match[2])]))
  const required = ['Anonymous pages', 'Pages purgeable', 'Pages wired down', 'Pages occupied by compressor']
  for (const name of required) {
    if (!counters.has(name)) throw new Error(`vm_stat 缺少 ${name}`)
    if (!Number.isSafeInteger(counters.get(name))) throw new Error(`vm_stat 的 ${name} 计数无效`)
  }
  const app = (counters.get('Anonymous pages')! - counters.get('Pages purgeable')!) * pageSize
  const wired = counters.get('Pages wired down')! * pageSize
  const compressed = counters.get('Pages occupied by compressor')! * pageSize
  for (const [name, bytes] of [['app', app], ['wired', wired], ['compressed', compressed]] as const) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > total) throw new Error(`vm_stat 的 ${name} 内存分项超出物理内存范围`)
  }
  const active = app + wired + compressed
  const swap = swapOutput.match(/used\s*=\s*([\d.]+)([KMG])/)
  if (!swap) throw new Error('sysctl 未返回交换空间使用量')
  if (!Number.isSafeInteger(active) || active > total) throw new Error('vm_stat 返回的内存使用量超出物理内存范围')
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[swap[2]]!
  const swapused = Number(swap[1]) * multiplier
  if (!Number.isFinite(swapused) || swapused < 0) throw new Error('sysctl 返回的交换空间使用量无效')
  return { total, active, app, wired, compressed, available: total - active, swapused }
}

async function readMemory(sdk: PluginSdk, signal?: AbortSignal) {
  const { settleResourceWork, runBudgetedCommand } = sdk
  const [vm, swap] = await settleResourceWork([
    runBudgetedCommand('system-memory', '/usr/bin/vm_stat', [], { timeout: 4000, maxBuffer: 1024 * 1024 }, signal),
    runBudgetedCommand('system-memory', '/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 4000, maxBuffer: 1024 * 1024 }, signal)
  ])
  return parseMemory(vm.stdout, swap.stdout, os.totalmem())
}

export function parseProcesses(output: string): { cpu: ProcessInfo[]; memory: ProcessInfo[] } {
  const cpu: ProcessInfo[] = []
  const memory: ProcessInfo[] = []
  // Keep both rankings bounded while considering every process from the same sample.
  const insert = (ranking: ProcessInfo[], process: ProcessInfo, compare: (a: ProcessInfo, b: ProcessInfo) => number) => {
    const index = ranking.findIndex(existing => compare(process, existing) < 0)
    if (index < 0) {
      if (ranking.length < 10) ranking.push(process)
    } else {
      ranking.splice(index, 0, process)
      if (ranking.length > 10) ranking.pop()
    }
  }
  const byCpu = (a: ProcessInfo, b: ProcessInfo) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes
  const byMemory = (a: ProcessInfo, b: ProcessInfo) => b.memoryBytes - a.memoryBytes
  for (const [line] of output.matchAll(/[^\n]+/g)) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const fullName = match[4]
    const process = { pid: Number(match[1]), cpuPercent: Number(match[2]), memoryBytes: Number(match[3]) * 1024,
      name: fullName.slice(fullName.lastIndexOf('/') + 1) }
    if (!Number.isSafeInteger(process.pid) || !Number.isFinite(process.cpuPercent) || !Number.isSafeInteger(process.memoryBytes)) {
      throw new Error('ps 返回的进程指标无效')
    }
    insert(cpu, process, byCpu)
    insert(memory, process, byMemory)
  }
  return { cpu, memory }
}

async function topProcesses(sdk: PluginSdk, signal?: AbortSignal) {
  const { stdout } = await sdk.runBudgetedCommand('system-processes', '/bin/ps', ['-axo', 'pid=,pcpu=,rss=,comm='], {
    timeout: 4000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
  }, signal)
  return parseProcesses(stdout)
}

interface SystemCollectorOptions {
  cpu?: () => CpuTimes
  memory?: (signal?: AbortSignal) => Promise<SystemMemory>
  disk?: (signal?: AbortSignal) => Promise<StatsFs>
  network?: Pick<NetworkReader, 'read' | 'dispose'>
  processes?: (signal?: AbortSignal) => Promise<{ cpu: ProcessInfo[]; memory: ProcessInfo[] }>
  now?: () => number
}

export class SystemCollector {
  private previousCpu?: CpuTimes
  private readonly history: SystemSample[] = []
  private readonly controller = new AbortController()
  private readonly network: Pick<NetworkReader, 'read' | 'dispose'>

  constructor(private readonly sdk: PluginSdk, private readonly options: SystemCollectorOptions = {}) {
    this.network = options.network ?? new NetworkReader(sdk)
  }

  dispose(): void {
    this.controller.abort()
    this.previousCpu = undefined
    this.history.length = 0
    this.network.dispose()
  }

  async collect(signal?: AbortSignal): Promise<SystemSnapshot> {
    const { throwIfAborted, collectionResources, isResourceCleanupFailure, isResourceAbort, resourceSourceStatus } = this.sdk
    signal = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal
    throwIfAborted(signal)
    const results = await Promise.allSettled([
      this.options.memory ? this.options.memory(signal) : readMemory(this.sdk, signal),
      this.options.disk ? this.options.disk(signal) : collectionResources.run({ source: 'system-disk', kind: 'file', bytes: 0, signal }, () => statfs('/System/Volumes/Data')),
      this.network.read(signal),
      this.options.processes ? this.options.processes(signal) : topProcesses(this.sdk, signal)
    ])
    const failures = results.flatMap(result => result.status === 'rejected' && (isResourceCleanupFailure(result.reason) || signal.aborted && !isResourceAbort(result.reason)) ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, '系统采集关闭失败 / System collection cleanup failed')
    throwIfAborted(signal)
    const [memory, disk, network, processes] = results
    if (memory.status === 'rejected') {
      this.previousCpu = undefined
      throw new Error(`内存采集失败：${String(memory.reason)}`)
    }
    const now = (this.options.now ?? Date.now)()
    const currentCpu = (this.options.cpu ?? cpuTimes)()
    const previousCpu = this.previousCpu
    const validCounters = Number.isSafeInteger(currentCpu.total) && Number.isSafeInteger(currentCpu.idle)
      && currentCpu.total >= 0 && currentCpu.idle >= 0 && currentCpu.idle <= currentCpu.total
    const totalDelta = previousCpu ? currentCpu.total - previousCpu.total : 0
    const idleDelta = previousCpu ? currentCpu.idle - previousCpu.idle : 0
    const continuous = validCounters && previousCpu && totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta
    const cpuPercent = continuous ? 100 * (1 - idleDelta / totalDelta) : null
    this.previousCpu = validCounters ? currentCpu : undefined
    const mem = memory.value
    const sources: SourceStatus[] = [{ id: 'system', label: '系统指标', state: 'ok', detail: 'CPU 首次或计数不连续时为未知，后续按增量采样；内存使用量为活跃内存（含 wired / compressed），不含可回收缓存。进程 CPU 以单核 100% 计。' }]
    const labels = ['内存', '磁盘', '网络', '进程']
    results.forEach((result, index) => {
      if (result.status === 'rejected') sources.push({ id: `system-${index}`, label: labels[index], state: 'error', detail: String(result.reason) })
    })
    const rx = network.status === 'fulfilled' ? network.value.rxBytesPerSecond : null
    const tx = network.status === 'fulfilled' ? network.value.txBytesPerSecond : null
    if (network.status === 'fulfilled') sources.push({ id: 'network-interface', label: '网络接口', state: 'ok', detail: `默认接口 ${network.value.iface}；仅统计此接口，避免虚拟网卡重复计数。首个采样周期速率尚不可用。` })
    sources.push(resourceSourceStatus(collectionResources.snapshot()))
    this.history.push({ at: now, cpuPercent, memoryPercent: mem.total ? mem.active / mem.total * 100 : 0, rxBytesPerSecond: rx, txBytesPerSecond: tx })
    if (this.history.length > 60) this.history.shift()
    const fs = disk.status === 'fulfilled' ? disk.value : null
    return {
      collectedAt: new Date(now).toISOString(), hostname: os.hostname(), platform: os.platform(), osVersion: os.release(),
      cpuModel: os.cpus()[0]?.model ?? '未知处理器', cpuCores: os.cpus().length, uptimeSeconds: os.uptime(), cpuPercent,
      memoryTotal: mem.total, memoryUsed: mem.active, memoryAvailable: mem.available, swapUsed: mem.swapused,
      memoryApp: mem.app, memoryWired: mem.wired, memoryCompressed: mem.compressed,
      diskTotal: fs ? fs.blocks * fs.bsize : null, diskUsed: fs ? (fs.blocks - fs.bfree) * fs.bsize : null,
      diskAvailable: fs ? fs.bavail * fs.bsize : null,
      rxBytesPerSecond: rx, txBytesPerSecond: tx,
      networkInterface: network.status === 'fulfilled' ? network.value.iface : null,
      processes: processes.status === 'fulfilled' ? processes.value.cpu : [],
      memoryProcesses: processes.status === 'fulfilled' ? processes.value.memory : [], history: [...this.history], sources
    }
  }
}

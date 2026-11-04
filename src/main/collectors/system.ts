import os from 'node:os'
import { statfs } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import si from 'systeminformation'
import type { ProcessInfo, SourceStatus, SystemSample, SystemSnapshot } from '../../shared/types'

const exec = promisify(execFile)
let previousCpu = cpuTimes()
const history: SystemSample[] = []

function cpuTimes() {
  return os.cpus().reduce((result, cpu) => {
    result.idle += cpu.times.idle
    result.total += Object.values(cpu.times).reduce((a, b) => a + b, 0)
    return result
  }, { idle: 0, total: 0 })
}

export function parseMemory(vmOutput: string, swapOutput: string, total: number) {
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

async function readMemory() {
  const [vm, swap] = await Promise.all([
    exec('/usr/bin/vm_stat', [], { timeout: 4000 }),
    exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 4000 })
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

async function topProcesses() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pcpu=,rss=,comm='], {
    timeout: 4000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
  })
  return parseProcesses(stdout)
}

export async function collectSystem(): Promise<SystemSnapshot> {
  const results = await Promise.allSettled([
    readMemory(),
    statfs(process.platform === 'darwin' ? '/System/Volumes/Data' : '/'),
    si.networkInterfaceDefault().then(async (iface) => {
      if (!iface) throw new Error('没有可用的默认网络接口')
      const [stats] = await si.networkStats(iface)
      if (!stats) throw new Error(`接口 ${iface} 没有返回统计数据`)
      if (stats.rx_bytes < 0 || stats.tx_bytes < 0) throw new Error(`接口 ${iface} 计数器不可用`)
      return { iface, stats }
    }),
    topProcesses()
  ])
  const [memory, disk, network, processes] = results
  if (memory.status === 'rejected') throw new Error(`内存采集失败：${String(memory.reason)}`)
  const now = Date.now()
  const currentCpu = cpuTimes()
  const totalDelta = currentCpu.total - previousCpu.total
  const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (currentCpu.idle - previousCpu.idle) / totalDelta))) : 0
  previousCpu = currentCpu
  const mem = memory.value
  const sources: SourceStatus[] = [{ id: 'system', label: '系统指标', state: 'ok', detail: 'CPU 增量采样；内存使用量为活跃内存（含 wired / compressed），不含可回收缓存。进程 CPU 以单核 100% 计。' }]
  const labels = ['内存', '磁盘', '网络', '进程']
  results.forEach((result, index) => {
    if (result.status === 'rejected') sources.push({ id: `system-${index}`, label: labels[index], state: 'error', detail: String(result.reason) })
  })
  const stats = network.status === 'fulfilled' ? network.value.stats : null
  const rx = stats && stats.rx_sec >= 0 ? stats.rx_sec : null
  const tx = stats && stats.tx_sec >= 0 ? stats.tx_sec : null
  if (network.status === 'fulfilled') sources.push({ id: 'network-interface', label: '网络接口', state: 'ok', detail: `默认接口 ${network.value.iface}；仅统计此接口，避免虚拟网卡重复计数。首个采样周期速率尚不可用。` })
  history.push({ at: now, cpuPercent, memoryPercent: mem.total ? mem.active / mem.total * 100 : 0, rxBytesPerSecond: rx, txBytesPerSecond: tx })
  if (history.length > 60) history.shift()
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
    memoryProcesses: processes.status === 'fulfilled' ? processes.value.memory : [], history: [...history], sources
  }
}

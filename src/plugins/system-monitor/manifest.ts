import type {} from './types'
import type { PluginMetadata } from '../../shared/plugin-catalog'

export const systemMonitorManifest = {
  id: 'system', entry: 'system-monitor', section: 'system',
  distribution: 'marketplace',
  label: ['系统指标', 'System metrics'],
  description: ['采样 CPU、内存、磁盘与网络。', 'Sample CPU, memory, disk and network.'],
  page: { id: 'system', label: ['系统监控', 'System monitor'], description: ['持续采样 CPU、内存、磁盘与网络。', 'Continuous CPU, memory, disk and network sampling.'] },
  intervalMs: 2000,
  diagnostics: {
    sourceIds: ['system', 'system-0', 'system-1', 'system-2', 'system-3', 'network-interface'],
    resourceIds: ['system-memory', 'system-disk', 'system-network', 'system-processes'],
    totals: ['processes', 'memoryProcesses', 'history']
  }
} as const satisfies PluginMetadata

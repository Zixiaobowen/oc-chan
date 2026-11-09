import { systemMonitorManifest } from '../plugins/system-monitor/manifest'
import type { MonitorSection, MonitorSnapshot } from './types'

export interface PluginMetadata {
  readonly id: string
  readonly entry: string
  readonly section: MonitorSection
  readonly label: readonly [string, string]
  readonly description: readonly [string, string]
  readonly page: { readonly id: MonitorSection; readonly label: readonly [string, string]; readonly description: readonly [string, string] }
  readonly intervalMs: number
  readonly diagnostics?: { readonly sourceIds: readonly string[]; readonly resourceIds: readonly string[]; readonly totals: readonly string[] }
}

/** Metadata for reviewed monitor contributions; installation is managed separately. */
export const monitorPlugins: readonly PluginMetadata[] = Object.freeze([
  { id: 'agents', entry: 'agents', section: 'agents', label: ['Agent 运行时', 'Agent runtimes'], description: ['发现本机 Agent 与协作关系。', 'Discover local agents and collaboration.'], page: { id: 'agents', label: ['协作拓扑', 'Agent topology'], description: ['在画布中查看 Agent 父子关系，定位项目与运行状态。', 'Explore agent relationships, projects and runtime status on the canvas.'] }, intervalMs: 2000 },
  { id: 'schedules', entry: 'schedules', section: 'schedules', label: ['调度任务', 'Scheduled tasks'], description: ['读取本机调度与执行历史。', 'Read local schedules and execution history.'], page: { id: 'schedules', label: ['定时任务', 'Scheduled tasks'], description: ['本机调度清单，让周期任务与常驻服务各归其位。', 'Local schedules, with recurring tasks and persistent services separated.'] }, intervalMs: 30000 },
  { id: 'events', entry: 'events', section: 'events', label: ['事件', 'Events'], description: ['记录已确认的异常与恢复。', 'Record confirmed failures and recoveries.'], page: { id: 'events', label: ['事件', 'Events'], description: ['查看已确认的异常与恢复，回到原任务和数据来源。', 'Review confirmed failures and recoveries, then return to their tasks and sources.'] }, intervalMs: 30000 },
  systemMonitorManifest
])
const ids = new Set<string>(), sections = new Set<string>()
if (monitorPlugins.length > 16) throw new Error('Monitor plugin catalog exceeds the 16-plugin budget')
for (const plugin of monitorPlugins) {
  if (ids.has(plugin.id) || sections.has(plugin.section)) throw new Error(`Duplicate monitor plugin: ${plugin.id}/${plugin.section}`)
  ids.add(plugin.id)
  sections.add(plugin.section)
}
export const monitorSections: readonly MonitorSection[] = Object.freeze(monitorPlugins.map(plugin => plugin.section))
export function isMonitorSection(value: unknown): value is MonitorSection {
  return typeof value === 'string' && monitorSections.includes(value as MonitorSection)
}
export function createEmptySnapshot(): MonitorSnapshot {
  return Object.fromEntries(monitorSections.map(section => [section, { data: null, error: null, refreshing: false }])) as MonitorSnapshot
}

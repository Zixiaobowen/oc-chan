import { useState } from 'react'
import ArrowDown from 'kubai-icons-react/icons/arrow-down'
import ArrowUp from 'kubai-icons-react/icons/arrow-up'
import ChevronDown from 'kubai-icons-react/icons/chevron-down'
import Cpu from 'kubai-icons-react/icons/cpu'
import HardDrive from 'kubai-icons-react/icons/hard-drive'
import MemoryStick from 'kubai-icons-react/icons/memory-stick'
import Network from 'kubai-icons-react/icons/network'
import type { SystemSnapshot } from '../types'
import { bytes, Meter } from '../../../renderer/src/components'
import { Chart } from './Chart'
import { MemoryBreakdown, NetworkTraffic, ProcessRanking } from './SystemMetrics'
import { useI18n } from '../../../renderer/src/i18n'
export type SystemTrayPanel = 'cpu' | 'memory' | 'disk' | 'network'
function SystemPanel({ data, panel }: { data: SystemSnapshot; panel: SystemTrayPanel }) {
  const { t } = useI18n()
  if (panel === 'network') return <NetworkTraffic data={data} />
  if (panel === 'disk') return <>
    <Meter label={t('数据卷空间', 'Data volume space')} value={data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null} detail={t('已用空间占比', 'Used capacity')} tone="blue" />
    <dl className="tray-details">
      <div><dt>{t('已用', 'Used')}</dt><dd>{bytes(data.diskUsed)}</dd></div>
      <div><dt>{t('可用', 'Available')}</dt><dd>{bytes(data.diskAvailable)}</dd></div>
      <div><dt>{t('总容量', 'Total capacity')}</dt><dd>{bytes(data.diskTotal)}</dd></div>
    </dl>
    <p className="tray-note">{t('数据卷 /System/Volumes/Data；显示空间容量。', 'Data volume /System/Volumes/Data; storage capacity.')}</p>
  </>
  const cpu = panel === 'cpu'
  return <>
    <Meter label={cpu ? t('CPU 使用率', 'CPU usage') : t('内存使用率', 'Memory usage')} value={cpu ? data.cpuPercent : data.memoryUsed / data.memoryTotal * 100} detail={cpu ? t(`${data.cpuCores} 个逻辑核心 · 全机 100%`, `${data.cpuCores} logical cores · 100% total`) : `${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}`} tone={cpu ? 'green' : 'blue'} />
    <Chart samples={data.history} field={cpu ? 'cpuPercent' : 'memoryPercent'} label={cpu ? t('CPU 使用率', 'CPU usage') : t('内存使用率', 'Memory usage')} />
    {!cpu && <MemoryBreakdown data={data} />}
    <h2 className="tray-process-title">{cpu ? t('CPU 占用前五', 'Top five by CPU') : t('内存占用前五', 'Top five by memory')}</h2>
    {cpu && <p className="tray-note">{t('进程 CPU 按单核 100% 计', 'Process CPU: 100% per core')}</p>}
    <ProcessRanking processes={cpu ? data.processes : data.memoryProcesses} by={cpu ? 'cpu' : 'memory'} compact />
  </>
}

function MetricSummary({ data, panel, enabled }: { data: SystemSnapshot | null; panel: SystemTrayPanel; enabled: boolean }) {
  const { t } = useI18n()
  const names = { cpu: 'CPU', memory: t('内存', 'Memory'), disk: t('磁盘', 'Disk'), network: t('网络', 'Network') }
  const Icon = { cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Network }[panel]
  const percent = !data ? null : panel === 'cpu' ? data.cpuPercent : panel === 'memory' ? data.memoryUsed / data.memoryTotal * 100 : panel === 'disk' && data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null
  const detail = !enabled ? t('采集已停用 · 旧快照', 'Collection disabled · Retained snapshot') : !data ? t('等待采样', 'Waiting for samples') : panel === 'cpu' ? t(`${data.cpuCores} 个逻辑核心`, `${data.cpuCores} logical cores`) : panel === 'memory' ? `${bytes(data.memoryUsed)} / ${bytes(data.memoryTotal)}` : panel === 'disk' ? t(`${bytes(data.diskAvailable)} 可用`, `${bytes(data.diskAvailable)} available`) : data.networkInterface ?? t('接口不可用', 'Interface unavailable')
  return <><Icon trigger="none" className="tray-metric-icon" size={17} aria-hidden="true" /><span className="tray-metric-label">{names[panel]}<small>{detail}</small></span>
    {panel === 'network' ? <span className="tray-metric-rates"><span><ArrowDown trigger="none" size={12} aria-hidden="true" /><span className="sr-only">{t('接收', 'Received')}</span>{bytes(data?.rxBytesPerSecond)}/s</span><span><ArrowUp trigger="none" size={12} aria-hidden="true" /><span className="sr-only">{t('发送', 'Sent')}</span>{bytes(data?.txBytesPerSecond)}/s</span></span> : <strong className="tray-metric-value">{percent === null ? '—' : `${percent.toFixed(1)}%`}</strong>}
    <ChevronDown trigger="none" className="tray-disclosure" size={15} aria-hidden="true" />
  </>
}

export function MetricSection({ data, panel, enabled }: { data: SystemSnapshot | null; panel: SystemTrayPanel; enabled: boolean }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  return <details className="tray-metric" data-metric={panel} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><MetricSummary data={data} panel={panel} enabled={enabled} /></summary>
    {expanded && <div className="tray-metric-detail">{data ? <SystemPanel data={data} panel={panel} /> : <p className="tray-note">{enabled ? t('等待系统采样', 'Waiting for system samples') : t('采集已停用 · 尚无数据', 'Collection disabled · No data')}</p>}</div>}
  </details>
}

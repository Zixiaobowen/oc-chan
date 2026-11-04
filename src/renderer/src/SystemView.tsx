import { useState } from 'react'
import { Cpu, HardDrive, MemoryStick, Network } from 'lucide-react'
import type { SystemSnapshot } from '../../shared/types'
import { bytes, Chart, duration, Empty, Meter, NativeSelect, Sources, time } from './components'
import { MemoryBreakdown, NetworkTraffic, ProcessRanking } from './SystemMetrics'
import { useI18n } from './i18n'

export default function SystemView({ data }: { data: SystemSnapshot | null }) {
  const { language, t } = useI18n()
  const [processOrder, setProcessOrder] = useState<'cpu' | 'memory'>('cpu')
  if (!data) return <div className="panel"><Empty title={t('正在采样系统状态', 'Sampling system status')}>{t('CPU、内存、磁盘和默认网络接口。', 'CPU, memory, disk and the default network interface.')}</Empty></div>
  return <div className="system-view">
    <div className="machine-strip"><div><Cpu size={17} /><strong>{data.cpuModel}</strong><span>{t(`${data.cpuCores} 核心`, `${data.cpuCores} cores`)}</span></div><span>{t('已运行', 'Uptime')} {duration(data.uptimeSeconds, language)} · {time(data.collectedAt, language)}</span></div>
    <div className="system-grid">
      <section className="panel chart-panel">
        <div className="section-heading"><h2><Cpu size={18} />{t('CPU 使用率', 'CPU usage')}</h2><strong className="chart-value">{data.cpuPercent.toFixed(1)}<small>%</small></strong></div>
        <Chart samples={data.history} field="cpuPercent" label={t('CPU 使用率', 'CPU usage')} />
        <p className="chart-note">{t('全机使用率 · 所有逻辑核心合计 100%', 'Total usage · All logical cores combined at 100%')}</p>
      </section>
      <section className="panel chart-panel">
        <div className="section-heading"><h2><MemoryStick size={18} />{t('内存使用率', 'Memory usage')}</h2><strong className="chart-value">{(data.memoryUsed / data.memoryTotal * 100).toFixed(1)}<small>%</small></strong></div>
        <Chart samples={data.history} field="memoryPercent" label={t('内存使用率', 'Memory usage')} />
        <p className="chart-note">{t('已用', 'Used')} {bytes(data.memoryUsed)} / {bytes(data.memoryTotal)}</p>
        <MemoryBreakdown data={data} />
      </section>
    </div>
    <div className="system-grid">
      <section className="panel resource-panel">
        <h2><HardDrive size={18} />{t('磁盘空间', 'Disk space')}</h2>
        <Meter label={t('数据卷', 'Data volume')} value={data.diskTotal && data.diskUsed !== null ? data.diskUsed / data.diskTotal * 100 : null} detail={t(`${bytes(data.diskUsed)} 已用 / ${bytes(data.diskTotal)} 总容量`, `${bytes(data.diskUsed)} used / ${bytes(data.diskTotal)} total`)} tone="blue" />
        <p className="resource-detail">{t('可用空间', 'Available')} <strong>{bytes(data.diskAvailable)}</strong></p>
      </section>
      <section className="panel resource-panel"><h2><Network size={18} />{t('网络吞吐', 'Network throughput')}</h2><NetworkTraffic data={data} /></section>
    </div>
    <section className="panel">
      <div className="section-heading padded system-process-heading">
        <h2>{t('占用较高的进程', 'Top processes')}</h2>
        <label className="system-process-order"><span>{t('排序', 'Sort by')}</span><NativeSelect value={processOrder} onChange={event => setProcessOrder(event.target.value as 'cpu' | 'memory')}>
          <option value="cpu">{t('CPU · 单核 100%', 'CPU · 100% per core')}</option><option value="memory">{t('内存 · 常驻大小', 'Memory · Resident size')}</option>
        </NativeSelect></label>
      </div>
      <ProcessRanking processes={processOrder === 'cpu' ? data.processes : data.memoryProcesses} by={processOrder} />
    </section>
    <Sources sources={data.sources} compact />
  </div>
}

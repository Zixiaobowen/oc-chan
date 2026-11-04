import type { ProcessInfo, SystemSnapshot } from '../../shared/types'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { bytes } from './components'
import { useI18n } from './i18n'
import './system-metrics.css'

export function MemoryBreakdown({ data }: { data: SystemSnapshot }) {
  const { t } = useI18n()
  return <dl className="memory-breakdown">
    <div><dt>{t('应用内存', 'App memory')}</dt><dd>{bytes(data.memoryApp)}</dd></div>
    <div><dt>{t('联动内存', 'Wired memory')}</dt><dd>{bytes(data.memoryWired)}</dd></div>
    <div><dt>{t('压缩内存', 'Compressed')}</dt><dd>{bytes(data.memoryCompressed)}</dd></div>
    <div><dt>{t('交换空间', 'Swap')}</dt><dd>{bytes(data.swapUsed)}</dd></div>
  </dl>
}

export function NetworkTraffic({ data }: { data: SystemSnapshot }) {
  const { t } = useI18n()
  const samples = data.history
  const start = samples[0]?.at ?? 0
  const end = samples.at(-1)?.at ?? start
  const width = 600, height = 100
  let maximum = 1
  for (const sample of samples) maximum = Math.max(maximum, sample.rxBytesPerSecond ?? 0, sample.txBytesPerSecond ?? 0)
  function line(field: 'rxBytesPerSecond' | 'txBytesPerSecond'): string {
    let path = '', connected = false
    for (const sample of samples) {
      const value = sample[field]
      if (value === null) { connected = false; continue }
      const x = end > start ? (sample.at - start) / (end - start) * width : width
      path += `${connected ? 'L' : 'M'}${x},${height - value / maximum * height} `
      connected = true
    }
    return path
  }
  return <div className="network-traffic">
    <div className="network-values">
      <div className="network-receive"><span><ArrowDown size={15} />{t('接收', 'Received')}</span><strong>{bytes(data.rxBytesPerSecond)}<small>/s</small></strong></div>
      <div className="network-send"><span><ArrowUp size={15} />{t('发送', 'Sent')}</span><strong>{bytes(data.txBytesPerSecond)}<small>/s</small></strong></div>
    </div>
    <div className="network-history" role="img" aria-label={t(`网络收发趋势，最近 ${samples.length} 次采样；接收实线，发送虚线`, `Network traffic, last ${samples.length} samples; solid receive, dashed send`)}>
      <div className="network-scale"><span>{bytes(maximum)}/s</span><span>0</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="chart-grid" d={`M0,0 H${width} M0,${height / 2} H${width} M0,${height} H${width}`} />
        <path className="chart-line" d={line('rxBytesPerSecond')} />
        <path className="chart-line network-send-line" d={line('txBytesPerSecond')} />
      </svg>
    </div>
    <div className="chart-time"><span>{samples.length > 1 ? t(`${Math.round((end - start) / 1000)} 秒前`, `${Math.round((end - start) / 1000)} seconds ago`) : t('收集趋势中', 'Collecting trend data')}</span><span>{t('现在', 'Now')}</span></div>
    <p className="network-interface">{t('默认接口', 'Default interface')} <strong>{data.networkInterface ?? '—'}</strong> · {t('接收实线 · 发送虚线', 'Solid receive · Dashed send')}</p>
    {(data.rxBytesPerSecond === null || data.txBytesPerSecond === null) && <p className="network-unavailable">{t('速率尚不可用，等待连续采样；采集失败时见来源提示。', 'Rates unavailable; waiting for consecutive samples. Collection failures appear in source notices.')}</p>}
  </div>
}

export function ProcessRanking({ processes, by, compact = false }: { processes: ProcessInfo[]; by: 'cpu' | 'memory'; compact?: boolean }) {
  const { t } = useI18n()
  if (!processes.length) return <p className="process-unavailable">{t('进程数据不可用，请查看采集错误。', 'Process data unavailable. Check collection errors.')}</p>
  if (compact) return <ol className="tray-processes">{processes.slice(0, 5).map(process => <li key={process.pid}>
    <span title={`${process.name} · PID ${process.pid}`}>{process.name}</span>
    <strong>{by === 'cpu' ? `${process.cpuPercent.toFixed(1)}%` : bytes(process.memoryBytes)}</strong>
  </li>)}</ol>
  return <div className="table-scroll"><table className="data-table system-processes"><thead><tr>
    <th>{t('进程', 'Process')}</th><th>PID</th><th className="numeric" aria-sort={by === 'cpu' ? 'descending' : undefined}>CPU</th><th className="numeric" aria-sort={by === 'memory' ? 'descending' : undefined}>{t('内存', 'Memory')}</th>
  </tr></thead><tbody>{processes.map(process => <tr key={process.pid}>
    <td><strong title={process.name}>{process.name}</strong></td><td className="mono muted">{process.pid}</td><td className="numeric mono">{process.cpuPercent.toFixed(1)}%</td><td className="numeric mono">{bytes(process.memoryBytes)}</td>
  </tr>)}</tbody></table></div>
}

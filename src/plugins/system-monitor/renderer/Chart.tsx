import type { SystemSample } from '../types'
import { useI18n } from '../../../renderer/src/i18n'
export function Chart({ samples, field, label }: { samples: SystemSample[]; field: 'cpuPercent' | 'memoryPercent'; label: string }) {
  const { t } = useI18n()
  const width = 600, height = 125
  const start = samples[0]?.at ?? 0
  const end = samples.at(-1)?.at ?? start
  let line = '', area = '', segmentStart: number | null = null, segmentEnd = 0
  for (const sample of samples) {
    const value = sample[field]
    if (value === null) {
      if (segmentStart !== null) area += `L${segmentEnd},${height} Z `
      segmentStart = null
      continue
    }
    const x = end > start ? (sample.at - start) / (end - start) * width : width
    const y = height - Math.max(0, Math.min(100, value)) / 100 * height
    line += `${segmentStart === null ? 'M' : 'L'}${x},${y} `
    area += segmentStart === null ? `M${x},${height} L${x},${y} ` : `L${x},${y} `
    segmentStart = segmentStart ?? x
    segmentEnd = x
  }
  if (segmentStart !== null) area += `L${segmentEnd},${height} Z`
  return <div className={`chart chart-${field}`}><div className="chart-axis"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t(`${label}，最近 ${samples.length} 次采样`, `${label}, last ${samples.length} samples`)}><path d={`M0,0 H${width} M0,${height / 2} H${width} M0,${height} H${width}`} className="chart-grid" />{samples.length > 1 && <><path d={area} className="chart-area" /><path d={line} className="chart-line" /></>}</svg><div className="chart-time"><span>{samples.length > 1 ? t(`${Math.round((end - start) / 1000)} 秒前`, `${Math.round((end - start) / 1000)} seconds ago`) : t('收集趋势中', 'Collecting trend data')}</span><span>{t('现在', 'Now')}</span></div></div>
}

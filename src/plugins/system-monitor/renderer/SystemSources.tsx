import { useMemo } from 'react'
import { Sources } from '../../../renderer/src/components'
import { useI18n } from '../../../renderer/src/i18n'
import type { SourceContributionProps } from '../../../renderer/src/plugins/types'

const labels: Record<string, string> = {
  '系统指标': 'System metrics', '内存': 'Memory', '磁盘': 'Disk', '网络': 'Network', '进程': 'Processes', '网络接口': 'Network interface'
}
const description = 'CPU 首次或计数不连续时为未知，后续按增量采样；内存使用量为活跃内存（含 wired / compressed），不含可回收缓存。进程 CPU 以单核 100% 计。'
export default function SystemSources({ sources, ...props }: SourceContributionProps) {
  const { language } = useI18n()
  const translated = useMemo(() => language === 'zh-CN' ? sources : sources.map(source => ({ ...source,
    label: labels[source.label] ?? source.label,
    detail: source.detail === description
      ? 'CPU is unknown on the first sample or after counter discontinuity; subsequent samples use increments. Memory usage is active memory (including wired / compressed), excluding reclaimable cache. Process CPU is measured as 100% per core.'
      : source.id === 'network-interface' && source.state !== 'error'
        ? source.detail.replace(/^默认接口 (.*)；仅统计此接口，避免虚拟网卡重复计数。首个采样周期速率尚不可用。$/, 'Default interface $1; only this interface is counted to avoid duplicate virtual-interface traffic. Rates are unavailable during the first sampling interval.')
        : source.detail
  })), [sources, language])
  return <Sources {...props} sources={translated} />
}

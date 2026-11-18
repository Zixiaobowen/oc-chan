import './layout.css'
import { useState } from 'react'
import ArrowDown from 'kubai-icons-react/icons/arrow-down'
import ArrowUp from 'kubai-icons-react/icons/arrow-up'
import { bytes, duration, Meter, SectionHeader, time } from '../../../renderer/src/components'
import { useI18n } from '../../../renderer/src/i18n'
import type { RendererContext, RendererContribution } from '../../../renderer/src/plugins/types'
import SystemView from './SystemView'
import { MetricSection } from './TrayMetrics'
import SystemSources from './SystemSources'

// Module state belongs to this renderer window and survives page unmounts.
let rememberedProcessOrder: 'cpu' | 'memory' = 'cpu'
function Page({ snapshot, plugins, navigate }: RendererContext) {
  const [processOrder, setProcessOrder] = useState(rememberedProcessOrder)
  return <SystemView data={snapshot.system.data} enabled={plugins.system} processOrder={processOrder} onProcessOrderChange={order => { rememberedProcessOrder = order; setProcessOrder(order) }} onOpenMarketplace={() => navigate('plugins')} />
}
function Summary({ snapshot, plugins }: RendererContext) {
  const { t, language } = useI18n()
  const system = snapshot.system.data
  return <div><span>{t('开机时间', 'Uptime')}</span><strong className="uptime-number">{system ? duration(system.uptimeSeconds, language) : '—'}</strong><p>{!plugins.system ? t('采集已停用', 'Collection disabled') : system ? t(`${system.cpuCores} 核 · ${bytes(system.memoryTotal)} 内存`, `${system.cpuCores} cores · ${bytes(system.memoryTotal)} memory`) : t('等待系统采样', 'Waiting for system samples')}</p></div>
}
function Overview({ snapshot, plugins, navigate: setPage }: RendererContext) {
  const { t } = useI18n()
  const system = snapshot.system.data
  return <section className="panel health-panel"><SectionHeader title={t('资源使用', 'Resources')} action={t('详情', 'Details')} onAction={() => setPage('system')} /><Meter label="CPU" value={system?.cpuPercent ?? null} detail={system ? t(`${system.cpuCores} 个逻辑核心`, `${system.cpuCores} logical cores`) : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} /><Meter label={t('内存', 'Memory')} value={system ? system.memoryUsed / system.memoryTotal * 100 : null} detail={system ? `${bytes(system.memoryUsed)} / ${bytes(system.memoryTotal)}` : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} tone="blue" /><Meter label={t('磁盘', 'Disk')} value={system?.diskTotal ? (system.diskUsed ?? 0) / system.diskTotal * 100 : null} detail={system ? t(`${bytes(system.diskAvailable)} 可用`, `${bytes(system.diskAvailable)} available`) : plugins.system ? t('等待采样', 'Waiting for samples') : t('采集已停用', 'Collection disabled')} tone="warm" /><div className="mini-network"><span><ArrowDown trigger="none" size={14} />{bytes(system?.rxBytesPerSecond)}/s</span><span><ArrowUp trigger="none" size={14} />{bytes(system?.txBytesPerSecond)}/s</span></div></section>
}
function Footer({ snapshot, plugins }: RendererContext) {
  const { t } = useI18n()
  const system = snapshot.system.data
  return <>{system ? `${system.hostname} · Darwin ${system.osVersion}` : plugins.system ? t('正在连接本机', 'Connecting to this Mac') : t('系统采集已停用', 'System collection disabled')}</>
}
function TrayHeading({ snapshot }: RendererContext) {
  const { t } = useI18n()
  return <p title={snapshot.system.data?.hostname}>{snapshot.system.data?.hostname || t('此 Mac', 'This Mac')}</p>
}
function TrayFooter({ snapshot, plugins }: RendererContext) {
  const { t, language } = useI18n()
  return <p className="tray-sample">{t('最近系统采样', 'Last system sample')} {snapshot.system.data ? time(snapshot.system.data.collectedAt, language) : plugins.system ? t('等待采样', 'Waiting for samples') : t('尚无采样', 'No sample')}</p>
}
const contribution: RendererContribution = {
  id: 'system', section: 'system', Page, Summary, Overview, Footer, TrayHeading, TrayFooter, Source: SystemSources,
  tray: ([['cpu', ['CPU', 'CPU']], ['memory', ['内存', 'Memory']], ['disk', ['磁盘', 'Disk']], ['network', ['网络', 'Network']]] as const).map(([panel, label]) => ({
    id: panel, label, sections: ['system'], Component: ({ snapshot, plugins }) => <MetricSection data={snapshot.system.data} panel={panel} enabled={plugins.system} />
  }))
}
export default contribution

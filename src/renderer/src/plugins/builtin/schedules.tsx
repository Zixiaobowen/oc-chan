import type { RendererContext, RendererContribution } from '../types'
import { useI18n } from '../../i18n'
import { Empty, SectionHeader, Sources } from '../../components'
import { scheduleTarget } from '../../../../shared/navigation'
import SchedulesView, { ScheduleTable } from '../../SchedulesView'
function Page(context: RendererContext) { return context.schedules ? <SchedulesView {...context.schedules} /> : null }
function Summary({ snapshot, plugins, navigate: setPage }: RendererContext) {
 const { t } = useI18n()
 const scheduled = snapshot.schedules.data?.jobs.filter(job => ['calendar', 'interval'].includes(job.kind))
 const userScheduled = scheduled?.filter(job => job.scope === 'user')
 return <button onClick={() => setPage('schedules')}><span>{t('定时任务', 'Scheduled tasks')}</span><strong>{plugins.schedules ? scheduled?.length ?? '—' : '—'}<small>{t('项', 'tasks')}</small></strong><p>{!plugins.schedules ? t('采集已停用', 'Collection disabled') : userScheduled ? t(`${userScheduled.length} 项属于当前用户`, `${userScheduled.length} for the current user`) : t('正在读取任务清单', 'Loading tasks')}</p></button>
}
function OverviewAfter({ snapshot, plugins, navigate, openTarget }: RendererContext) {
 const { t } = useI18n()
 const schedules = snapshot.schedules.data
 const scheduled = schedules?.jobs.filter(job => ['calendar', 'interval'].includes(job.kind))
 const previewJobs = [...(scheduled ?? [])].sort((a, b) => Number(a.scope === 'system') - Number(b.scope === 'system')).slice(0, 4)
 return <section className="panel schedule-preview"><SectionHeader title={t('调度清单', 'Schedules')} count={scheduled?.length} action={t('全部任务', 'All tasks')} onAction={() => navigate('schedules')} />{previewJobs.length ? <ScheduleTable jobs={previewJobs} onSelect={job => openTarget(scheduleTarget(job))} /> : <Empty title={!plugins.schedules ? t('采集已停用', 'Collection disabled') : schedules ? t('未发现定时任务', 'No scheduled tasks found') : t('正在读取定时任务', 'Loading scheduled tasks')}>{t('周期任务与日历任务会显示在这里。', 'Recurring and calendar tasks appear here.')}</Empty>}</section>
}
const contribution: RendererContribution = { id: 'schedules', section: 'schedules', retainWhenDisabled: true, Page, Summary, OverviewAfter, Source: Sources }
export default contribution

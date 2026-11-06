import { useId } from 'react'
import { scheduleTarget } from '../../shared/navigation'
import { NOTIFICATION_TASK_LIMIT } from '../../shared/notifications'
import type { ScheduledJob } from '../../shared/types'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import SettingsSaveError from './SettingsSaveError'
import { NotificationStatusLine } from './NotificationSettings'
import './notification-settings.css'

export default function TaskNotificationSubscription({ job }: { job: ScheduledJob }) {
  const { snapshot: { settings }, saving, error, update } = useSettings()
  const { t } = useI18n()
  const id = useId()
  const preferences = settings.notifications
  const target = scheduleTarget(job)
  const subscribed = preferences.tasks.some(task => task.id === target.id && task.identity === target.identity)
  const supported = job.id.startsWith('hermes-job:')
  const atLimit = preferences.tasks.length >= NOTIFICATION_TASK_LIMIT
  const blocked = saving || !subscribed && (!supported || atLimit)
  return <section className="task-notification-subscription" aria-labelledby={`${id}-title`} aria-busy={saving}>
    <h3 id={`${id}-title`}>{t('任务通知', 'Task notifications')}</h3>
    <p id={`${id}-help`}>{supported
      ? t('订阅此任务的 Hermes 执行失败和投递失败事件，具体通知类型沿用设置。订阅不会打开全局通知，也不会修改或执行任务。', 'Subscribe to this task’s Hermes execution and delivery failures, using the event types selected in Settings. Subscribing does not enable global notifications, modify the task or run it.')
      : t('此来源不提供真实的逐次执行事件，不能订阅任务执行通知。cron / launchd 的配置、当前状态与退出码不等同于执行记录。', 'This source does not supply actual per-run events, so task execution notifications are unavailable. cron / launchd configurations, current states and exit codes are not execution records.')}</p>
    <button type="button" className="button secondary" aria-pressed={subscribed} aria-disabled={blocked} aria-describedby={`${id}-help`} onClick={() => {
      if (blocked) return
      void update({ notifications: { ...preferences, tasks: subscribed
        ? preferences.tasks.filter(task => task.id !== target.id || task.identity !== target.identity)
        : [...preferences.tasks, target] } })
    }}>{subscribed ? t('取消此任务订阅', 'Unsubscribe from this task') : t('订阅此任务', 'Subscribe to this task')}</button>
    {supported && <p>{t('来源订阅独立生效；如果已订阅 Hermes 事件来源，取消此任务订阅后仍可能收到来源通知。', 'Source subscriptions apply independently. If the Hermes event source is subscribed, source notifications may continue after you unsubscribe from this task.')}</p>}
    {!subscribed && atLimit && supported && <p>{t(`已达到 ${NOTIFICATION_TASK_LIMIT} 个任务的订阅上限。请在设置中移除一项后再订阅。`, `The ${NOTIFICATION_TASK_LIMIT}-task limit has been reached. Remove a subscription in Settings to add this task.`)}</p>}
    {subscribed && !preferences.enabled && <p className="notification-hint">{t('此任务已订阅，但全局通知关闭。请在设置中开启“本机通知”。', 'This task is subscribed, but global notifications are off. Enable Local notifications in Settings.')}</p>}
    {subscribed && !preferences.types.some(type => type === 'execution-failed' || type === 'delivery-failed') && <p className="notification-hint">{t('尚未选择执行失败或投递失败类型；此任务目前不会触发通知。', 'Execution and delivery failure types are not selected; this task will not currently trigger notifications.')}</p>}
    {subscribed && <NotificationStatusLine />}
    {error?.patch.notifications !== undefined && <SettingsSaveError settingLabel={t('任务通知订阅', 'Task notification subscription')} />}
  </section>
}

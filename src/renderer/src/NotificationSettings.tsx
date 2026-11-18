import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EVENT_TYPES, type LocalEventType } from '../../shared/events'
import { summarizeDiagnostic } from '../../shared/diagnostics'
import { NOTIFICATION_SOURCE_LIMIT, NOTIFICATION_TASK_LIMIT, type NotificationSettings as Preferences, type NotificationState, type NotificationTask } from '../../shared/notifications'
import type { SourceStatus } from '../../shared/types'
import { useI18n } from './i18n'
import { useSettings } from './settings'
import SettingsSaveError, { SettingsDiagnosticDetails } from './SettingsSaveError'
import './notification-settings.css'

const phaseLabels: Record<NotificationState['phase'], [string, string]> = {
  off: ['通知已关闭', 'Notifications are off'],
  'events-disabled': ['本地事件采集已关闭，通知暂停', 'Local event collection is disabled; notifications are paused'],
  starting: ['正在连接通知服务…', 'Connecting to notification service…'],
  ready: ['通知服务就绪', 'Notification service is ready'],
  quiet: ['当前处于静默时段', 'Quiet hours are active'],
  sleeping: ['系统休眠中，通知暂停', 'System sleeping; notifications are paused'],
  'permission-required': ['需要请求系统通知权限', 'System notification permission is required'],
  denied: ['系统已拒绝通知权限', 'System notification permission was denied'],
  unavailable: ['当前环境不支持通知', 'Notifications are unavailable in this environment'],
  error: ['通知服务发生错误', 'Notification service failed']
}
const permissionLabels: Record<NotificationState['permission'], [string, string]> = {
  'not-determined': ['尚未请求', 'Not requested'], denied: ['已拒绝', 'Denied'], authorized: ['已允许', 'Allowed'],
  provisional: ['临时允许', 'Provisionally allowed'], unsupported: ['不支持', 'Unsupported'], unknown: ['未知', 'Unknown']
}
const typeLabels: Record<LocalEventType, [string, string]> = {
  'execution-failed': ['执行失败（Hermes）', 'Execution failed (Hermes)'],
  'delivery-failed': ['投递失败（Hermes）', 'Delivery failed (Hermes)'],
  'source-unavailable': ['来源不可用', 'Source unavailable'],
  'source-recovered': ['来源恢复', 'Source recovered']
}
const outcomeLabels: Record<NonNullable<NotificationState['lastOutcome']>, [string, string]> = {
  sent: ['已提交系统通知', 'Submitted to the system'], summary: ['已提交合并摘要', 'Summary submitted'],
  suppressed: ['已抑制通知', 'Notification suppressed'], cancelled: ['待发通知已取消', 'Pending notification cancelled'],
  unconfirmed: ['发送结果未确认', 'Delivery outcome unconfirmed']
}

export function NotificationStatusLine() {
  const { snapshot: { notifications } } = useSettings()
  const { t } = useI18n()
  return <p className="notification-status" role="status" data-phase={notifications.phase}>{t(...phaseLabels[notifications.phase])}</p>
}

function taskLabel(task: NotificationTask): string {
  // Display an opaque local alias instead of leaking a source ID, path or identity.
  let hash = 2166136261
  for (const value of [task.id, task.identity]) {
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
    hash = Math.imul(hash ^ 0, 16777619)
  }
  return `ID · ${(hash >>> 0).toString(16).padStart(8, '0')}`
}
function timeText(minute: number): string { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` }
function timeMinute(value: string): number | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}

export default function NotificationSettings({ sources = [] }: { sources?: SourceStatus[] }) {
  const { snapshot: { settings, notifications, platform }, saving, error, update } = useSettings()
  const preferences = settings.notifications
  const { t } = useI18n()
  const [start, setStart] = useState(() => timeText(preferences.quiet.startMinute))
  const [end, setEnd] = useState(() => timeText(preferences.quiet.endMinute))
  const [timeError, setTimeError] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [openingSettings, setOpeningSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [permissionSettingsAvailability, setPermissionSettingsAvailability] = useState<'available' | 'headless' | 'unsupported' | 'unknown'>('unknown')
  const permissionPending = useRef(false)
  const mounted = useRef(true)
  const tasksRef = useRef<HTMLDivElement>(null)
  const removal = useRef<{ index: number; trigger: Element | null } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    if (!window.desktopSettings) {
      setSettingsError('Desktop settings are unavailable')
      return
    }
    void window.desktopSettings.accessibilityState().then(state => {
      if (active) setPermissionSettingsAvailability(state.availability)
    }).catch(cause => {
      if (active) setSettingsError(summarizeDiagnostic(cause, 'settings-connection', 'settings').details)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    setStart(timeText(preferences.quiet.startMinute))
    setEnd(timeText(preferences.quiet.endMinute))
    setTimeError(false)
  }, [preferences.quiet.startMinute, preferences.quiet.endMinute])
  useLayoutEffect(() => {
    const removed = removal.current
    if (!removed || saving || removed.trigger?.isConnected) return
    removal.current = null
    if (document.activeElement !== document.body) return
    const buttons = tasksRef.current?.querySelectorAll<HTMLButtonElement>('button')
    const next = buttons?.[Math.min(removed.index, buttons.length - 1)]
    ;(next ?? tasksRef.current)?.focus({ preventScroll: true })
  }, [preferences.tasks, saving])
  const save = (next: Preferences) => { if (!saving) void update({ notifications: next }) }
  const sourceOptions = new Map<string, SourceStatus | undefined>(sources.map(source => [source.id, source]))
  for (const id of preferences.sourceIds) if (!sourceOptions.has(id)) sourceOptions.set(id, undefined)
  const timeChanged = start !== timeText(preferences.quiet.startMinute) || end !== timeText(preferences.quiet.endMinute)
  const permissionDisabled = saving || requesting || openingSettings || !preferences.enabled || !settings.plugins.events || notifications.permission === 'unsupported'
  async function requestPermission() {
    if (permissionPending.current || permissionDisabled) return
    permissionPending.current = true
    setRequesting(true)
    setPermissionError(null)
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.requestNotificationPermission()
    } catch (cause) {
      if (mounted.current) setPermissionError(summarizeDiagnostic(cause, 'settings-connection', 'settings').details)
    } finally {
      permissionPending.current = false
      if (mounted.current) setRequesting(false)
    }
  }
  async function openSettings() {
    if (permissionPending.current || permissionSettingsAvailability !== 'available') return
    permissionPending.current = true
    setOpeningSettings(true)
    setSettingsError(null)
    try {
      if (!window.desktopSettings) throw new Error('Desktop settings are unavailable')
      await window.desktopSettings.openPermissionSettings('notifications')
    } catch (cause) {
      if (mounted.current) setSettingsError(summarizeDiagnostic(cause, 'settings-connection', 'settings').details)
    } finally {
      permissionPending.current = false
      if (mounted.current) setOpeningSettings(false)
    }
  }
  return <section id="setting-notifications" className="setting-row notification-settings" aria-labelledby="setting-notifications-label">
    <h2 id="setting-notifications-label">{t('本机通知', 'Local notifications')}</h2>
    <div className="setting-control">
      <div className="setting-toggle">
        <button type="button" role="switch" className="setting-switch" aria-labelledby="setting-notifications-label" aria-describedby="notification-help" aria-checked={preferences.enabled} aria-disabled={saving} onClick={() => save({ ...preferences, enabled: !preferences.enabled })}><span /></button>
        <span>{preferences.enabled ? t('已开启', 'On') : t('已关闭（默认）', 'Off (default)')}</span>
      </div>
      <p id="notification-help" className="setting-help">{t('仅通知新收集的已订阅事件；默认隐藏任务名称和私人路径。每滚动 60 秒最多 3 条通知，包含合并摘要。', 'Only newly collected, subscribed events notify you. Task names and private paths are hidden by default. At most 3 notifications per rolling 60 seconds, including summaries.')}</p>
      <NotificationStatusLine />
      {notifications.detail && <p className="notification-detail">{notifications.detail}</p>}
      <p className="setting-help">{t('系统权限：', 'System permission: ')}{t(...permissionLabels[notifications.permission])}</p>
      <div className="notification-actions">
        <button type="button" className="button secondary" aria-disabled={permissionDisabled} onClick={() => { void requestPermission() }}>{requesting ? t('正在请求…', 'Requesting…') : t('请求或重新检查权限', 'Request or recheck permission')}</button>
        <button type="button" className="button secondary" disabled={permissionSettingsAvailability !== 'available'} aria-disabled={requesting || openingSettings || permissionSettingsAvailability !== 'available'} onClick={() => { void openSettings() }}>{openingSettings ? t('正在打开…', 'Opening…') : t('打开系统通知设置', 'Open Notification settings')}</button>
      </div>
      {(platform !== 'darwin' || permissionSettingsAvailability === 'headless') && <p className="setting-help">{t('当前环境不能打开 macOS 系统通知设置。', 'This environment cannot open macOS Notification settings.')}</p>}
      {settingsError && <div className="notification-error" role="alert"><p>{t('系统设置入口不可用或打开失败。请重试，或手动打开系统设置 → 通知。', 'System Settings is unavailable or failed to open. Retry or open System Settings → Notifications manually.')}</p><SettingsDiagnosticDetails details={settingsError} /></div>}
      {(!preferences.enabled || !settings.plugins.events) && <p className="setting-help">{t('开启本地通知和事件采集后可请求权限。', 'Enable local notifications and event collection before requesting permission.')}</p>}
      {notifications.permission === 'denied' && <p className="setting-help">{t('请在 macOS「系统设置 → 通知 → OC Chan」允许通知，再重新检查权限。', 'Allow OC Chan in macOS System Settings → Notifications, then recheck permission.')}</p>}
      {permissionError && <div className="notification-error" role="alert"><p>{t('权限请求未得到确认。请使用上方按钮重试。', 'The permission request was not confirmed. Retry using the button above.')}</p><SettingsDiagnosticDetails details={permissionError} /></div>}
      {notifications.pendingCount > 0 && <p className="setting-help">{t(`待处理事件：${notifications.pendingCount}`, `Pending events: ${notifications.pendingCount}`)}</p>}
      {notifications.lastOutcome && <p className="setting-help">{t('最近结果：', 'Latest outcome: ')}{t(...outcomeLabels[notifications.lastOutcome])}</p>}
      <fieldset className="notification-group" aria-describedby="notification-types-help">
        <legend>{t('事件类型', 'Event types')}</legend>
        <div className="notification-options">{EVENT_TYPES.map(type => <label className="notification-check" key={type}>
          <input type="checkbox" checked={preferences.types.includes(type)} aria-disabled={saving} onChange={event => save({ ...preferences, types: event.target.checked ? [...preferences.types, type] : preferences.types.filter(value => value !== type) })} />
          <span>{t(...typeLabels[type])}</span>
        </label>)}</div>
        <p id="notification-types-help" className="setting-help">{t('只有 Hermes 提供真实执行和投递事件；cron / launchd 不提供逐任务执行通知。全不选时不会发送通知。', 'Only Hermes supplies actual execution and delivery events. cron / launchd do not provide per-task execution notifications. No types selected means no notifications.')}</p>
      </fieldset>
      <fieldset className="notification-group" aria-describedby="notification-sources-help">
        <legend>{t('订阅来源', 'Subscribed sources')} · {preferences.sourceIds.length}/{NOTIFICATION_SOURCE_LIMIT}</legend>
        <p id="notification-sources-help" className="setting-help">{t('来源与单个任务分别订阅，任一匹配即可。取消来源不会取消下方单独订阅的任务。', 'A source or an individual task subscription can match an event. Removing a source leaves individual task subscriptions intact.')}</p>
        <div className="notification-options">{Array.from(sourceOptions, ([id, source]) => {
          const checked = preferences.sourceIds.includes(id)
          const limit = !checked && preferences.sourceIds.length >= NOTIFICATION_SOURCE_LIMIT
          return <label className="notification-check" key={id}>
            <input type="checkbox" value={id} checked={checked} aria-disabled={saving || limit} onChange={event => { if (!limit) save({ ...preferences, sourceIds: event.target.checked ? [...preferences.sourceIds, id] : preferences.sourceIds.filter(value => value !== id) }) }} />
            <span>{source?.label ?? id}{!source && <small>{t('当前不可用 · 仍保留订阅', 'Currently unavailable · subscription retained')}</small>}{source?.state === 'disabled' && <small>{t('来源采集已停用', 'Source collection disabled')}</small>}</span>
          </label>
        })}</div>
        {!sourceOptions.size && <p className="setting-help">{t('尚无可订阅来源。采集来源出现后会列在这里。', 'No sources are available yet. Collected sources will appear here.')}</p>}
        {preferences.sourceIds.length >= NOTIFICATION_SOURCE_LIMIT && <p className="setting-help">{t('已达到来源订阅上限；取消一项后可添加。', 'Source subscription limit reached. Remove one to add another.')}</p>}
      </fieldset>
      <div className="notification-group notification-task-list" ref={tasksRef} tabIndex={-1} aria-labelledby="notification-tasks-heading">
        <h3 id="notification-tasks-heading">{t('已订阅任务', 'Subscribed tasks')} · {preferences.tasks.length}/{NOTIFICATION_TASK_LIMIT}</h3>
        <p className="setting-help">{t('在 Hermes 任务详情中订阅；此处仅显示脱敏标识，完整身份用于匹配。', 'Subscribe in a Hermes task’s details. Only redacted identifiers are shown here; matching uses the complete identity.')}</p>
        {preferences.tasks.length ? <ul>{preferences.tasks.map((task, index) => <li key={JSON.stringify([task.id, task.identity])}>
          <code>{taskLabel(task)}</code>
          <button type="button" className="button secondary" aria-label={t(`移除任务订阅 ${taskLabel(task)}`, `Remove task subscription ${taskLabel(task)}`)} aria-disabled={saving} onClick={event => {
            if (saving) return
            removal.current = { index, trigger: event.currentTarget }
            save({ ...preferences, tasks: preferences.tasks.filter(value => value.id !== task.id || value.identity !== task.identity) })
          }}>{t('移除', 'Remove')}</button>
        </li>)}</ul> : <p className="setting-help">{t('尚未单独订阅任务。', 'No individual task subscriptions.')}</p>}
        {!preferences.enabled && preferences.tasks.length > 0 && <p className="setting-help">{t('已保留任务订阅，但全局通知关闭；开启上方开关后才会通知。', 'Task subscriptions are retained, but notifications are off. Enable the switch above to receive notifications.')}</p>}
      </div>
      <fieldset className="notification-group">
        <legend>{t('静默时段', 'Quiet hours')}</legend>
        <label className="notification-check"><input type="checkbox" checked={preferences.quiet.enabled} aria-disabled={saving} onChange={event => save({ ...preferences, quiet: { ...preferences.quiet, enabled: event.target.checked } })} /><span>{t('启用静默时段', 'Enable quiet hours')}</span></label>
        <form className="notification-times" onSubmit={event => {
          event.preventDefault()
          if (saving) return
          const startMinute = timeMinute(start), endMinute = timeMinute(end)
          if (startMinute === null || endMinute === null || startMinute === endMinute) { setTimeError(true); return }
          setTimeError(false)
          save({ ...preferences, quiet: { ...preferences.quiet, startMinute, endMinute } })
        }} noValidate>
          <label>{t('开始（HH:mm）', 'Start (HH:mm)')}<input type="time" value={start} required step="60" aria-invalid={timeError} aria-describedby="notification-time-help notification-time-error" readOnly={saving} onChange={event => { setStart(event.target.value); setTimeError(false) }} /></label>
          <label>{t('结束（HH:mm）', 'End (HH:mm)')}<input type="time" value={end} required step="60" aria-invalid={timeError} aria-describedby="notification-time-help notification-time-error" readOnly={saving} onChange={event => { setEnd(event.target.value); setTimeError(false) }} /></label>
          <button type="submit" className="button secondary" aria-disabled={saving || !timeChanged} onClick={event => { if (!timeChanged) event.preventDefault() }}>{t('保存时间', 'Save times')}</button>
        </form>
        <p id="notification-time-help" className="setting-help">{t('使用本机当地时间，结束早于开始时跨午夜。时间编辑为草稿，点击“保存时间”后生效。', 'Uses local time. An end before the start spans midnight. Time edits are drafts until you select Save times.')}</p>
        <p id="notification-time-error" className="notification-error" role="alert">{timeError ? t('请输入有效的 HH:mm 时间，开始与结束不能相同。', 'Enter valid HH:mm times; start and end must differ.') : ''}</p>
      </fieldset>
      <fieldset className="notification-group">
        <legend>{t('通知隐私', 'Notification privacy')}</legend>
        <label className="notification-check"><input type="checkbox" checked={preferences.showTaskNames} aria-disabled={saving} onChange={event => save({ ...preferences, showTaskNames: event.target.checked })} /><span>{t('在通知中显示完整任务名称', 'Show full task names in notifications')}</span></label>
        <p className="setting-help">{t('仅在主动开启后显示名称；名称可能包含私人信息，并可能出现在锁定屏幕。任务正文与私人路径仍不发送。', 'Names appear only when you opt in. They may contain private information and appear on the lock screen. Task contents and private paths are still omitted.')}</p>
      </fieldset>
    </div>
    {error?.patch.notifications !== undefined && <SettingsSaveError settingLabel={t('本机通知', 'Local notifications')} />}
  </section>
}

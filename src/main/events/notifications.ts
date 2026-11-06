import { createHash } from 'node:crypto'
import type { LocalEvent } from '../../shared/events'
import { INITIAL_NOTIFICATION_STATE, type NotificationState, type NotificationSettings } from '../../shared/notifications'
import type { EventNotificationOptions, EventNotificationService, NativeNotificationAdapter, NativeNotificationMessage, NotificationBatch } from './notification-contracts'
import { readNotificationJournal, writeNotificationJournal, type NotificationJournal } from './notification-journal'
import { isResourceAbort, isResourceCleanupFailure, throwIfAborted } from '../resource-budget'

const MINUTE = 60_000
const COOLDOWN = 5 * MINUTE
const MAX_COUNT = Number.MAX_SAFE_INTEGER
const labels = {
  'zh-CN': { 'execution-failed': '任务执行失败', 'delivery-failed': '任务投递失败', 'source-unavailable': '数据来源不可用', 'source-recovered': '数据来源已恢复' },
  en: { 'execution-failed': 'Task execution failed', 'delivery-failed': 'Task delivery failed', 'source-unavailable': 'Source unavailable', 'source-recovered': 'Source recovered' }
}

export class EventNotifications implements EventNotificationService {
  private state: NotificationState = { ...INITIAL_NOTIFICATION_STATE }
  private active = false
  private sleeping = false
  private parent: AbortSignal | null = null
  private readonly parentAborted = () => { void this.stop().catch(error => this.recordFailure(error)) }
  private controller: AbortController | null = null
  private native: NativeNotificationAdapter | null = null
  private journal: NotificationJournal | null = null
  private filename: string | null = null
  private operation: Promise<void> | null = null
  private pendingRefresh = false
  private pendingPermission = false
  private pendingBatch: NotificationBatch | null = null
  private processingBatch = false
  private blocked = false
  private cleanupPending = false
  private permissionNotice: string | null = null
  private lastClock: number | null = null
  private showController: AbortController | null = null

  constructor(private readonly options: EventNotificationOptions) {}

  snapshot(): NotificationState { return { ...this.state } }

  start(signal: AbortSignal): Promise<void> {
    if (this.parent !== signal) {
      this.parent?.removeEventListener('abort', this.parentAborted)
      this.parent = signal
      signal.addEventListener('abort', this.parentAborted, { once: true })
    }
    this.active = !signal.aborted
    if (!this.active) this.controller?.abort()
    this.pendingRefresh = true
    return this.drive().catch(error => this.recordFailure(error))
  }

  refresh(): Promise<void> {
    if (!this.options.preferences().enabled) {
      this.controller?.abort()
      this.showController?.abort()
      this.update({ pendingCount: 0 })
    }
    this.pendingRefresh = true
    return this.drive().catch(error => this.recordFailure(error))
  }

  requestPermission(): Promise<void> {
    if (!this.active || !this.options.preferences().enabled) {
      this.update({ detail: this.permissionNotice ?? '请先启用事件和通知 / Enable events and notifications first' })
      return Promise.resolve()
    }
    this.pendingPermission = true
    return this.drive().catch(error => this.recordFailure(error))
  }

  committed(batch: NotificationBatch): Promise<void> {
    if (!this.active || !this.options.preferences().enabled) return Promise.resolve()
    if (this.pendingBatch || this.processingBatch) {
      this.update({ detail: '通知批次忙，未接收本批次 / Notification batch busy; batch not accepted' })
      return Promise.resolve()
    }
    if (!batch.identity || batch.identity.length > 128 || batch.events.length > 100 || batch.events.some((row, index) =>
      !Number.isSafeInteger(row.sequence) || row.sequence <= 0 || (index > 0 && row.sequence < batch.events[index - 1].sequence))) {
      this.update({ phase: 'error', detail: '通知批次无效 / Invalid notification batch' })
      return Promise.resolve()
    }
    this.pendingBatch = batch
    return this.drive().catch(error => this.recordFailure(error))
  }

  setSleeping(sleeping: boolean): void {
    if (this.sleeping === sleeping) return
    this.sleeping = sleeping
    if (sleeping) this.showController?.abort('sleep')
    if (this.active && this.journal && !this.blocked) this.availability()
  }

  stop(): Promise<void> {
    this.active = false
    this.parent?.removeEventListener('abort', this.parentAborted)
    this.parent = null
    this.controller?.abort()
    this.showController?.abort()
    this.update({ pendingCount: 0 })
    this.pendingRefresh = true
    return this.drive()
  }

  private update(patch: Partial<NotificationState>): void {
    if (Object.entries(patch).every(([key, value]) => this.state[key as keyof NotificationState] === value)) return
    this.state = { ...this.state, ...patch }
    this.options.changed()
  }

  private recordFailure(error: unknown): void {
    this.blocked = true
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : null
    if (code === 'ERR_NOTIFICATION_PERMISSION_PENDING') {
      this.permissionNotice = '系统授权请求尚未结束，可能仍有系统弹窗；应用无法保证关闭它，请先完成系统操作后再试 / System permission request is still pending; a system prompt may remain open and cannot reliably be dismissed by the app'
    } else if (code === 'OC_NOTIFICATION_PERMISSION_TIMEOUT') {
      this.permissionNotice = '系统通知权限查询或请求超时，授权状态尚未确认；请检查系统提示后再查询 / Notification permission timed out; authorization is unconfirmed, check system prompts before querying again'
    }
    const detail = code === 'OC_NOTIFICATION_CLEANUP'
      ? `通知资源清理失败 (OC_NOTIFICATION_CLEANUP) / Notification cleanup failed${this.permissionNotice ? ` · ${this.permissionNotice}` : ''}`
      : this.permissionNotice ?? `通知操作失败${code ? ` (${code})` : ''}；请检查权限或存储后重试 / Notification operation failed; check permission or storage and retry`
    this.update({ phase: 'error', detail })
  }

  /** Control requests coalesce; exactly one batch may be retained or processed. */
  private drive(): Promise<void> {
    if (this.operation) return this.operation
    const operation = Promise.resolve().then(async () => {
      while (this.pendingRefresh || this.pendingPermission || this.pendingBatch) {
        try {
          if (!this.active || !this.options.preferences().enabled) {
            this.pendingRefresh = false
            this.pendingPermission = false
            this.pendingBatch = null
            await this.release()
          } else if (this.pendingRefresh) {
            this.pendingRefresh = false
            await this.initialize()
          } else if (this.pendingPermission) {
            this.pendingPermission = false
            if (!this.native || !this.controller || this.blocked) await this.initialize()
            if (this.native && this.controller) {
              const permission = await this.native.permission(true, this.controller.signal)
              throwIfAborted(this.controller.signal)
              this.permissionNotice = null
              this.update({ permission, detail: null })
              this.availability()
            }
          } else {
            const batch = this.pendingBatch!
            this.pendingBatch = null
            this.processingBatch = true
            try { if (!this.blocked && this.journal && this.controller) await this.consume(batch, this.controller.signal) }
            finally { this.processingBatch = false }
          }
        } catch (error) {
          const permissionPending = error instanceof Error && 'code' in error && error.code === 'ERR_NOTIFICATION_PERMISSION_PENDING'
          if (isResourceAbort(error) && !isResourceCleanupFailure(error) && !permissionPending) {
            this.update({ lastOutcome: this.controller?.signal.aborted || this.sleeping ? 'cancelled' : 'unconfirmed' })
          } else this.recordFailure(error)
          if (this.cleanupPending) throw error
        }
      }
    }).finally(() => { if (this.operation === operation) this.operation = null })
    this.operation = operation
    return operation
  }

  private async initialize(): Promise<void> {
    if (this.cleanupPending) await this.release()
    if (!this.controller || this.controller.signal.aborted) this.controller = new AbortController()
    const signal = this.controller.signal
    this.update({ phase: 'starting', detail: null })
    const filename = this.options.filename()
    const journal = await readNotificationJournal(filename, signal)
    throwIfAborted(signal)
    this.journal = journal
    this.filename = filename
    this.blocked = false
    this.lastClock = null
    this.native ??= this.options.adapter()
    const permission = await this.native.permission(false, signal)
    throwIfAborted(signal)
    this.permissionNotice = null
    this.update({ permission, pendingCount: journal.summaryCount,
      lastOutcome: journal.cursor.unconfirmed ? 'unconfirmed' : this.state.lastOutcome,
      detail: journal.cursor.unconfirmed ? '上次发送未确认，不会重放 / Previous delivery unconfirmed; it will not be replayed' : null })
    this.availability()
  }

  private async release(): Promise<void> {
    this.controller?.abort()
    this.showController?.abort()
    const native = this.native
    let failure: unknown
    try {
      if (native) await native.close()
      this.native = null
    } catch (error) { failure = error }
    try {
      if (this.journal && this.filename && this.journal.summaryCount) {
        const cleared = { ...this.journal, summaryCount: 0 }
        await writeNotificationJournal(this.filename, cleared)
      }
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'Notification cleanup failed') : error }
    this.cleanupPending = !!failure
    if (!failure) {
      this.journal = null
      this.filename = null
    }
    this.controller = null
    this.lastClock = null
    this.blocked = false
    this.update({ phase: this.options.preferences().enabled ? 'events-disabled' : 'off', pendingCount: 0, detail: this.permissionNotice })
    if (failure) throw Object.assign(new Error('Notification cleanup failed', { cause: failure }), { code: 'OC_NOTIFICATION_CLEANUP' })
  }

  private quiet(settings: NotificationSettings, date: Date): boolean {
    if (!settings.quiet.enabled) return false
    const minute = date.getHours() * 60 + date.getMinutes()
    const { startMinute: start, endMinute: end } = settings.quiet
    return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end)
  }

  private availability(date = this.options.now?.() ?? new Date()): void {
    let phase: NotificationState['phase']
    let detail = this.state.detail
    if (this.state.permission === 'denied') { phase = 'denied'; detail = '系统通知权限被拒绝 / System notification permission denied' }
    else if (this.state.permission === 'unsupported') { phase = 'unavailable'; detail = '系统通知不可用 / System notifications unavailable' }
    else if (!['authorized', 'provisional'].includes(this.state.permission)) {
      phase = 'permission-required'; detail = '需要明确授权系统通知 / Explicit system notification permission required'
    } else phase = this.sleeping ? 'sleeping' : this.quiet(this.options.preferences(), date) ? 'quiet' : 'ready'
    this.update({ phase, detail })
  }

  private selected(event: LocalEvent, settings: NotificationSettings): boolean {
    const target = event.target
    return settings.types.includes(event.type) && (settings.sourceIds.includes(event.sourceId) ||
      (target?.kind === 'schedule' && settings.tasks.some(task => task.id === target.id && task.identity === target.identity)))
  }

  private message(event: LocalEvent, identity: string): NativeNotificationMessage {
    const settings = this.options.preferences()
    const language = this.options.language()
    const shortId = createHash('sha256').update(event.entityId).digest('hex').slice(0, 10)
    let name = `#${shortId}`
    if (settings.showTaskNames && event.target?.kind === 'schedule') {
      const resolved = this.options.taskName(event.target)
      if (resolved) name = resolved.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, ' ')
    }
    return { id: createHash('sha256').update(`${identity}:${event.id}`).digest('hex'), title: 'OC Chan',
      body: `${labels[language][event.type]} · ${name}`, target: event.target ?? { kind: 'page', page: 'events' } }
  }

  private async consume(batch: NotificationBatch, signal: AbortSignal): Promise<void> {
    const date = this.options.now?.() ?? new Date()
    const now = date.getTime()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid notification clock')
    const settings = this.options.preferences()
    const previous = this.journal!
    const changedIdentity = previous.identity !== null && previous.identity !== batch.identity
    const next: NotificationJournal = { ...previous, identity: batch.identity, cursor: { ...previous.cursor },
      cooldowns: previous.cooldowns.map(item => ({ ...item })), sentAt: [...previous.sentAt] }
    if (previous.identity !== batch.identity) {
      next.cursor = { sequence: 0, unconfirmed: false }
      next.cooldowns = []
      next.summaryCount = 0
      if (changedIdentity) this.update({ detail: '事件数据库身份已变更；已重置通知游标 / Event database identity changed; notification cursor reset' })
    }
    // Rebase a backwards clock conservatively: retain the remaining window, never replay rows.
    if (this.lastClock !== null && now < this.lastClock) {
      const delta = now - this.lastClock
      next.sentAt = next.sentAt.map(at => Math.max(0, at + delta))
      next.cooldowns = next.cooldowns.map(item => ({ ...item, at: Math.max(0, item.at + delta) }))
    } else if (this.lastClock === null) {
      next.sentAt = next.sentAt.map(at => Math.min(at, now))
      next.cooldowns = next.cooldowns.map(item => ({ ...item, at: Math.min(item.at, now) }))
    }
    this.lastClock = now
    next.sentAt = next.sentAt.filter(at => now - at < MINUTE)
    next.cooldowns = next.cooldowns.filter(item => now - item.at < COOLDOWN)
    const allowed = !this.sleeping && !this.quiet(settings, date) && ['authorized', 'provisional'].includes(this.state.permission)
    const messages: { message: NativeNotificationMessage; summary: boolean; count: number }[] = []
    if (allowed && next.summaryCount && next.sentAt.length < 3) {
      const count = next.summaryCount
      messages.push({ summary: true, count, message: { id: createHash('sha256').update(`${batch.identity}:summary:${next.cursor.sequence}:${now}`).digest('hex'),
        title: 'OC Chan', body: this.options.language() === 'zh-CN' ? `已合并 ${count} 条事件通知` : `${count} event notifications grouped`, target: { kind: 'page', page: 'events' } } })
      next.summaryCount = 0
      next.sentAt.push(now)
    }
    for (const { sequence, event } of batch.events) {
      if (sequence <= next.cursor.sequence) continue
      next.cursor.sequence = sequence
      const key = createHash('sha256').update(JSON.stringify([event.sourceId, event.entityId])).digest('hex')
      const index = next.cooldowns.findIndex(item => item.key === key)
      if (event.type === 'source-recovered' && index >= 0) next.cooldowns.splice(index, 1)
      if (!this.selected(event, settings)) continue
      const cooling = event.type !== 'source-recovered' && (index >= 0 || next.cooldowns.length >= 64)
      if (event.type !== 'source-recovered' && !cooling) next.cooldowns.push({ key, at: now })
      if (!allowed || cooling || next.sentAt.length >= 3) {
        if (next.summaryCount === MAX_COUNT) throw Object.assign(new Error('Notification summary count limit reached'), { code: 'OC_NOTIFICATION_SUMMARY_LIMIT' })
        next.summaryCount++
        continue
      }
      messages.push({ message: this.message(event, batch.identity), summary: false, count: 1 })
      next.sentAt.push(now)
    }
    const firstClaim = next.sentAt.length - messages.length
    if (messages.length) {
      next.cursor.unconfirmed = true
      // Reserve through the delivery deadline until an acknowledgement gives the actual send time.
      for (let index = firstClaim; index < next.sentAt.length; index++) next.sentAt[index] = now + 8_000
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      await writeNotificationJournal(this.filename!, next, signal)
      this.journal = next
    }
    throwIfAborted(signal)
    this.update({ pendingCount: next.summaryCount, ...(next.summaryCount ? { lastOutcome: 'suppressed' as const } : {}) })
    this.availability(date)
    if (!messages.length) return
    const controller = new AbortController()
    this.showController = controller
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted || this.sleeping) controller.abort()
    // One bounded deadline for all three displays, below the event collector's 15-second budget.
    const deadline = setTimeout(cancel, 8_000)
    let attempted = 0
    let failure: unknown
    try {
      for (let index = 0; index < messages.length; index++) {
        const entry = messages[index]
        throwIfAborted(controller.signal)
        attempted = index + 1
        await this.native!.show(entry.message, controller.signal)
        throwIfAborted(controller.signal)
        const sent = this.options.now?.() ?? new Date()
        next.sentAt[firstClaim + index] = Math.max(now, sent.getTime())
        this.update({ lastSentAt: sent.toISOString(), lastOutcome: entry.summary ? 'summary' : 'sent' })
      }
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', cancel)
      this.showController = null
      if (failure) this.update({ lastOutcome: signal.aborted || this.sleeping ? 'cancelled' : 'unconfirmed',
        detail: '发送未确认，不会重放 / Delivery unconfirmed; it will not be replayed' })
    }
    if (failure) {
      if ((this.sleeping || controller.signal.reason === 'sleep') && !signal.aborted && attempted < messages.length) {
        const suppressed = messages.slice(attempted).reduce((count, entry) => count + entry.count, 0)
        if (suppressed > MAX_COUNT - next.summaryCount) throw Object.assign(new Error('Notification summary count limit reached'), { code: 'OC_NOTIFICATION_SUMMARY_LIMIT', cause: failure })
        const sleeping = { ...next, summaryCount: next.summaryCount + suppressed, sentAt: next.sentAt.slice(0, firstClaim + attempted) }
        try {
          await writeNotificationJournal(this.filename!, sleeping, signal)
          this.journal = sleeping
          this.update({ pendingCount: sleeping.summaryCount })
        } catch (saveError) { throw new AggregateError([failure, saveError], 'Notification sleep accounting failed') }
      }
      throw failure
    }
    const acknowledged = { ...next, cursor: { ...next.cursor, unconfirmed: false } }
    await writeNotificationJournal(this.filename!, acknowledged, signal)
    this.journal = acknowledged
  }
}

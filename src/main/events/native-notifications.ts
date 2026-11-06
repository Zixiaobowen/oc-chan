import { app, Notification, powerMonitor } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { NavigationTarget } from '../../shared/navigation'
import type { NotificationPermission } from '../../shared/notifications'
import type { NativeNotificationAdapter, NativeNotificationMessage } from './notification-contracts'

const QUERY_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 30_000
const SHOW_TIMEOUT_MS = 3_000
const LIVE_NOTIFICATION_LIMIT = 8

type NativePermission = Exclude<NotificationPermission, 'unsupported'>
interface PermissionBinding {
  start(request: boolean, callback: (error: Error | null, permission: NativePermission) => void): number
  /** Releases JS callback ownership; true means a system authorization request is still pending. */
  cancel(token: number): boolean
}
interface LiveNotification { dispose(reason: Error): Error | undefined }

function abortError(message: string, cause?: unknown): Error {
  const error = new Error(message, { cause })
  error.name = 'AbortError'
  return error
}

export function createNativeNotificationAdapter(options: {
  headless: boolean
  onNavigate: (target: NavigationTarget) => void
  onSleeping: (sleeping: boolean) => void
}): NativeNotificationAdapter {
  let closed = false
  let native: PermissionBinding | undefined
  let lastPermission: NotificationPermission = 'unknown'
  let cancelPermission: ((reason: Error) => Error | undefined) | null = null
  let retryPermissionCancel: (() => void) | null = null
  let cleanupError: Error | undefined
  const live = new Set<LiveNotification>()
  const supportedEnvironment = !options.headless && process.platform === 'darwin'
  const suspend = () => options.onSleeping(true)
  const resume = () => options.onSleeping(false)
  if (supportedEnvironment) {
    powerMonitor.on('suspend', suspend)
    powerMonitor.on('resume', resume)
  }

  function assertOpen(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (closed) throw abortError('通知适配器已关闭')
    if (cleanupError) throw cleanupError
  }

  function binding(): PermissionBinding {
    if (!native) {
      const resources = app.isPackaged ? process.resourcesPath
        : process.env.OC_CHAN_DEV_INSTANCE ? path.join(process.env.OC_CHAN_DEV_INSTANCE, 'resources')
          : path.join(app.getAppPath(), 'resources')
      const loaded: PermissionBinding = createRequire(path.join(app.getAppPath(), 'package.json'))(
        path.join(resources, 'notification-permission/notification-permission.node'))
      if (typeof loaded?.start !== 'function' || typeof loaded?.cancel !== 'function')
        throw new Error('通知权限原生模块接口无效')
      native = loaded
    }
    return native
  }

  async function permission(request: boolean, signal: AbortSignal): Promise<NotificationPermission> {
    assertOpen(signal)
    if (!supportedEnvironment || !Notification.isSupported()) return 'unsupported'
    if (cancelPermission) throw Object.assign(new Error('已有通知权限操作正在进行'), { code: 'ERR_NOTIFICATION_PERMISSION_PENDING' })
    lastPermission = 'unknown'
    const addon = binding()
    const { promise, resolve, reject } = Promise.withResolvers<NotificationPermission>()
    let token: number | undefined
    let settled = false
    const finish = (error: Error | null, value: NotificationPermission = 'unknown') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      cancelPermission = null
      lastPermission = error ? 'unknown' : value
      if (error) reject(error)
      else resolve(value)
    }
    const cancel = (reason: Error): Error | undefined => {
      if (settled) return
      let failure: Error | undefined
      try {
        if (token !== undefined && addon.cancel(token))
          reason = Object.assign(new Error(`${reason.message}；macOS 授权请求仍在进行，系统弹窗无法由应用关闭，请在系统弹窗完成选择`, { cause: reason }), { name: reason.name, code: 'ERR_NOTIFICATION_PERMISSION_PENDING' })
      } catch (error) {
        failure = Object.assign(new Error('取消原生通知权限等待失败', { cause: error }), { code: 'OC_NOTIFICATION_NATIVE_FAILURE' })
        cleanupError = failure
        const pendingToken = token!
        retryPermissionCancel = () => { addon.cancel(pendingToken) }
        reason = Object.assign(new AggregateError([reason, failure], reason.message), { name: reason.name, code: 'OC_NOTIFICATION_NATIVE_FAILURE' })
      }
      finish(reason)
      return failure
    }
    const onAbort = () => { cancel(abortError('通知权限等待已取消', signal.reason)) }
    const timer = setTimeout(() => {
      cancel(Object.assign(new Error(`通知权限${request ? '授权请求' : '查询'}超时；尚未完成的系统请求会阻止重试，等待系统回调后才能继续`), { code: 'OC_NOTIFICATION_PERMISSION_TIMEOUT' }))
    }, request ? REQUEST_TIMEOUT_MS : QUERY_TIMEOUT_MS)
    cancelPermission = cancel
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return promise }
    try {
      token = addon.start(request, (error, value) => {
        if (error) {
          finish(Object.assign(error, { code: (error as NodeJS.ErrnoException).code ?? 'OC_NOTIFICATION_NATIVE_FAILURE' }))
          return
        }
        if (!['not-determined', 'denied', 'authorized', 'provisional', 'unknown'].includes(value)) {
          finish(Object.assign(new Error('原生模块返回了无效通知权限状态'), { code: 'OC_NOTIFICATION_NATIVE_FAILURE' }))
          return
        }
        finish(null, value)
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('读取原生通知权限失败', { cause: error })
      finish(Object.assign(failure, { code: (failure as NodeJS.ErrnoException).code ?? 'OC_NOTIFICATION_NATIVE_FAILURE' }))
    }
    return promise
  }

  async function show(message: NativeNotificationMessage, signal: AbortSignal): Promise<void> {
    assertOpen(signal)
    if (!supportedEnvironment || !Notification.isSupported()) throw new Error('当前环境不支持系统通知')
    if (lastPermission !== 'authorized' && lastPermission !== 'provisional')
      throw new Error('系统通知权限尚未确认允许；请先读取权限，授权请求必须由用户显式发起')
    if (live.size >= LIVE_NOTIFICATION_LIMIT) {
      const oldest = live.values().next().value!
      const error = oldest.dispose(abortError('通知已被更新的通知替换'))
      if (error) throw error
    }
    const notification = new Notification({ id: message.id, title: message.title, body: message.body, silent: true })
    // Keep the original source/task identity even if the caller later replaces its object.
    const target = { ...message.target }
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let settled = false
    let disposed = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      notification.removeListener('show', onShow)
      notification.removeListener('failed', onFailed)
      if (error) reject(error)
      else resolve()
    }
    const dispose = (reason: Error): Error | undefined => {
      if (disposed && !live.has(entry)) return
      if (!disposed) {
        disposed = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        notification.removeListener('show', onShow)
        notification.removeListener('failed', onFailed)
        notification.removeListener('click', onClick)
        notification.removeListener('close', onClose)
      }
      let failure: Error | undefined
      try {
        notification.close()
        live.delete(entry)
      } catch (error) {
        // Keep at most eight failed handles, without listeners, for close() to retry.
        failure = new Error('关闭系统通知失败', { cause: error })
        cleanupError ??= failure
      }
      settle(failure ? new AggregateError([reason, failure], reason.message) : reason)
      return failure
    }
    const onShow = () => { settle() }
    const onFailed = (_event: Electron.Event, error: string) => { dispose(new Error(`系统通知显示失败：${error}`)) }
    const onClose = () => { dispose(new Error('系统通知在确认显示前已关闭')) }
    const onClick = () => {
      if (disposed || closed) return
      dispose(new Error('系统通知在确认显示前已被点击'))
      options.onNavigate(target)
    }
    const onAbort = () => { dispose(abortError('系统通知已取消', signal.reason)) }
    const timer = setTimeout(() => { dispose(new Error('系统通知显示超时，未收到实际 show 确认')) }, SHOW_TIMEOUT_MS)
    const entry: LiveNotification = { dispose }
    live.add(entry)
    notification.once('show', onShow)
    notification.once('failed', onFailed)
    notification.once('click', onClick)
    notification.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return promise }
    try { notification.show() } catch (error) {
      dispose(error instanceof Error ? error : new Error('系统通知显示失败', { cause: error }))
    }
    return promise
  }

  async function close(): Promise<void> {
    closed = true
    cleanupError = undefined
    if (supportedEnvironment) {
      powerMonitor.removeListener('suspend', suspend)
      powerMonitor.removeListener('resume', resume)
    }
    if (retryPermissionCancel) {
      try {
        retryPermissionCancel()
        retryPermissionCancel = null
      } catch (error) {
        cleanupError = new Error('取消原生通知权限等待失败', { cause: error })
      }
    } else {
      cancelPermission?.(abortError('通知适配器已关闭，权限等待已取消'))
    }
    for (const entry of live) entry.dispose(abortError('通知适配器已关闭'))
    lastPermission = 'unknown'
    if (cleanupError) throw cleanupError
    native = undefined
  }

  return { permission, show, close }
}

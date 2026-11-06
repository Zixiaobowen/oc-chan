import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { NavigationTarget } from '../../shared/navigation'
import type { NotificationPermission } from '../../shared/notifications'
import type { NativeNotificationAdapter, NativeNotificationMessage } from './notification-contracts'
import type * as NativeNotifications from './native-notifications'

type PermissionCallback = (error: Error | null, permission: Exclude<NotificationPermission, 'unsupported'>) => void
const darwin = { skip: process.platform !== 'darwin' ? 'The non-headless adapter is macOS-only' : false }

// This boundary models an independently completing OS request, not the addon:
// releasing its JS callback does not make the underlying request cancellable.
class PermissionBoundary {
  callback: PermissionCallback | null = null
  osPending = false
  promptPending = false
  accepted = 0
  cancelCalls = 0
  cancelFailures = 0
  start(_request: boolean, callback: PermissionCallback): number {
    if (this.osPending) throw Object.assign(new Error('Existing system request is still pending'), { code: 'ERR_NOTIFICATION_PERMISSION_PENDING' })
    this.osPending = true
    this.callback = callback
    return ++this.accepted
  }
  cancel(token: number): boolean {
    assert.equal(token, this.accepted)
    this.cancelCalls++
    if (this.cancelFailures > 0) { this.cancelFailures--; throw new Error('Native callback release failed') }
    this.callback = null
    return this.promptPending
  }
  complete(permission: Exclude<NotificationPermission, 'unsupported'> = 'authorized', error: Error | null = null): void {
    const callback = this.callback
    this.callback = null
    this.osPending = false
    this.promptPending = false
    callback?.(error, permission)
  }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const timers = new Set<NodeJS.Timeout>()
  const clockSetTimeout = globalThis.setTimeout
  const clockClearTimeout = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    const handle = clockSetTimeout(() => { timers.delete(handle); callback(...args) }, milliseconds)
    timers.add(handle)
    return handle
  }) as typeof setTimeout)
  t.mock.method(globalThis, 'clearTimeout', ((handle: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(handle as NodeJS.Timeout)
    clockClearTimeout(handle)
  }) as typeof clearTimeout)

  const permission = new PermissionBoundary()
  const powerMonitor = new EventEmitter()
  const navigation: NavigationTarget[] = []
  const sleeping: boolean[] = []
  const active = new Set<NotificationBoundary>()
  const instances: NotificationBoundary[] = []
  const access = { app: 0, supported: 0, addon: 0 }
  class NotificationBoundary extends EventEmitter {
    closeCalls = 0
    closeFailures = 0
    showCalls = 0
    constructor(readonly options: Electron.NotificationConstructorOptions) {
      super()
      instances.push(this)
      active.add(this)
    }
    static isSupported(): boolean { access.supported++; return true }
    show(): void { this.showCalls++ }
    close(): void {
      this.closeCalls++
      if (this.closeFailures > 0) { this.closeFailures--; throw new Error('Native close failed') }
      active.delete(this)
      this.emit('close', {})
    }
  }

  // tsx loads this package as CommonJS. Intercept only the Electron module and
  // binary boundary; execute the unmodified production adapter through its loader.
  const require = createRequire(__filename)
  const filename = require.resolve('./native-notifications.ts')
  const cached = require.cache[filename]
  delete require.cache[filename]
  const loader = Module as unknown as { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown }
  const originalLoad = loader._load
  const intercepted = t.mock.method(loader, '_load', function (this: typeof loader, request: string, parent: NodeModule | undefined, isMain: boolean) {
    if (request === 'electron') return {
      Notification: NotificationBoundary,
      powerMonitor,
      app: {
        get isPackaged() { access.app++; return false },
        getAppPath() { access.app++; return process.cwd() }
      }
    }
    if (request.endsWith(path.join('notification-permission', 'notification-permission.node'))) {
      access.addon++
      return permission
    }
    return originalLoad.call(this, request, parent, isMain)
  })
  const adapters: NativeNotificationAdapter[] = []
  t.after(async () => {
    try {
      permission.cancelFailures = 0
      for (const notification of instances) notification.closeFailures = 0
      for (const adapter of adapters) await adapter.close()
      permission.complete()
    } finally {
      delete require.cache[filename]
      if (cached) require.cache[filename] = cached
      intercepted.mock.restore()
    }
  })
  const adapterModule: typeof NativeNotifications = require(filename)
  const make = (headless = false) => {
    const adapter = adapterModule.createNativeNotificationAdapter({ headless, onNavigate: target => navigation.push(target), onSleeping: value => sleeping.push(value) })
    adapters.push(adapter)
    return adapter
  }
  const authorize = async (adapter: NativeNotificationAdapter) => {
    const controller = new AbortController()
    const result = adapter.permission(false, controller.signal)
    permission.complete()
    assert.equal(await result, 'authorized')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(timers.size, 0)
  }
  const assertReleased = (signal?: AbortSignal) => {
    assert.equal(active.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(permission.callback, null)
    assert.equal(powerMonitor.listenerCount('suspend'), 0)
    assert.equal(powerMonitor.listenerCount('resume'), 0)
    for (const notification of instances) assert.deepEqual(notification.eventNames(), [])
    if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
  return { make, authorize, assertReleased, permission, powerMonitor, navigation, sleeping, active, instances, access, timers }
}

function message(id = 'event-1'): NativeNotificationMessage {
  return { id, title: '任务执行失败', body: '任务执行失败，请在应用内查看', target: { kind: 'schedule', id: 'task-1', identity: 'original-task-identity' } }
}

test('module import and headless adapters never access Electron capabilities, native bindings or power listeners', async t => {
  const f = fixture(t)
  assert.deepEqual(f.access, { app: 0, supported: 0, addon: 0 })
  assert.deepEqual(f.powerMonitor.eventNames(), [])
  const adapter = f.make(true)
  const signal = new AbortController().signal
  assert.equal(await adapter.permission(false, signal), 'unsupported')
  assert.equal(await adapter.permission(true, signal), 'unsupported')
  await assert.rejects(adapter.show(message(), signal), /不支持系统通知/)
  await adapter.close()
  assert.deepEqual(f.access, { app: 0, supported: 0, addon: 0 })
  assert.equal(f.instances.length, 0)
  f.assertReleased(signal)
})

test('show waits for actual confirmation and navigates once with the original identity only on click', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  await f.authorize(adapter)
  const input = message()
  const expected = { ...input.target }
  const showing = adapter.show(input, controller.signal)
  let confirmed = false
  void showing.then(() => { confirmed = true })
  await setImmediate()
  assert.equal(confirmed, false)
  assert.equal(f.instances[0].showCalls, 1)
  assert.equal(f.timers.size, 1)
  assert.deepEqual(f.navigation, [])
  f.instances[0].emit('show', {})
  await showing
  assert.equal(confirmed, true)
  assert.equal(f.timers.size, 0)
  assert.equal(f.active.size, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  assert.equal(f.instances[0].options.silent, true)
  if (input.target.kind === 'schedule') input.target.identity = 'reused-task-identity'
  f.instances[0].emit('click', {})
  f.instances[0].emit('click', {})
  assert.deepEqual(f.navigation, [expected])
  assert.equal(f.active.size, 0)
  await adapter.close()
  f.assertReleased(controller.signal)
})

test('unconfirmed show expires at three seconds and releases its notification, timer and abort listener', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  await f.authorize(adapter)
  const showing = adapter.show(message(), controller.signal)
  const rejected = assert.rejects(showing, /显示超时.*show/)
  t.mock.timers.tick(2_999)
  assert.equal(f.active.size, 1)
  assert.equal(f.instances[0].closeCalls, 0)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(f.active.size, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  f.instances[0].emit('show', {})
  f.instances[0].emit('click', {})
  assert.deepEqual(f.navigation, [])
  await adapter.close()
  f.assertReleased(controller.signal)
})

for (const confirmed of [false, true]) {
  test(`abort releases a ${confirmed ? 'confirmed' : 'pending'} notification without navigation`, darwin, async t => {
    const f = fixture(t), adapter = f.make(), controller = new AbortController()
    await f.authorize(adapter)
    const showing = adapter.show(message(), controller.signal)
    const outcome = confirmed ? showing : assert.rejects(showing, { name: 'AbortError' })
    if (confirmed) { f.instances[0].emit('show', {}); await showing }
    controller.abort(new Error('Plugin stopped'))
    await outcome
    f.instances[0].emit('click', {})
    assert.deepEqual(f.navigation, [])
    assert.equal(f.instances[0].closeCalls, 1)
    await adapter.close()
    f.assertReleased(controller.signal)
  })
}

for (const event of ['failed', 'close'] as const) {
  test(`${event} before confirmation rejects and releases the notification`, darwin, async t => {
    const f = fixture(t), adapter = f.make(), controller = new AbortController()
    await f.authorize(adapter)
    const showing = adapter.show(message(), controller.signal)
    const rejected = assert.rejects(showing, event === 'failed' ? /显示失败：OS delivery failure/ : /确认显示前已关闭/)
    f.instances[0].emit(event, {}, 'OS delivery failure')
    await rejected
    await adapter.close()
    f.assertReleased(controller.signal)
  })
}

test('one hundred confirmed deliveries retain at most eight objects and eviction detaches old click handlers', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  await f.authorize(adapter)
  for (let index = 0; index < 100; index++) {
    const showing = adapter.show(message(`event-${index}`), controller.signal)
    f.instances[index].emit('show', {})
    await showing
    assert.equal(f.active.size, Math.min(index + 1, 8))
    assert.equal(getEventListeners(controller.signal, 'abort').length, Math.min(index + 1, 8))
    assert.equal(f.timers.size, 0)
    if (index >= 8) {
      const evicted = f.instances[index - 8]
      assert.equal(evicted.closeCalls, 1)
      assert.deepEqual(evicted.eventNames(), [])
      evicted.emit('click', {})
    }
  }
  assert.deepEqual(f.navigation, [])
  controller.abort()
  await adapter.close()
  f.assertReleased(controller.signal)
})

test('failed eviction retains the handle, blocks new work and close retries the failure', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  await f.authorize(adapter)
  for (let index = 0; index < 8; index++) {
    const showing = adapter.show(message(`event-${index}`), controller.signal)
    f.instances[index].emit('show', {})
    await showing
  }
  f.instances[0].closeFailures = 1
  await assert.rejects(adapter.show(message('overflow'), controller.signal), /关闭系统通知失败/)
  assert.equal(f.active.size, 8)
  assert.equal(f.instances.length, 8)
  assert.deepEqual(f.instances[0].eventNames(), [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 7)
  await assert.rejects(adapter.show(message('blocked'), controller.signal), /关闭系统通知失败/)
  await assert.rejects(adapter.permission(false, controller.signal), /关闭系统通知失败/)
  assert.equal(f.instances.length, 8)
  assert.equal(f.permission.accepted, 1)
  await adapter.close()
  assert.equal(f.instances[0].closeCalls, 2)
  f.assertReleased(controller.signal)
})

test('close cleans other objects after a failure, removes listeners and can be retried', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  await f.authorize(adapter)
  for (let index = 0; index < 3; index++) {
    const showing = adapter.show(message(`event-${index}`), controller.signal)
    f.instances[index].emit('show', {})
    await showing
  }
  f.instances[0].closeFailures = 1
  await assert.rejects(adapter.close(), /关闭系统通知失败/)
  assert.equal(f.active.size, 1)
  assert.equal(f.instances[1].closeCalls, 1)
  assert.equal(f.instances[2].closeCalls, 1)
  for (const notification of f.instances) assert.deepEqual(notification.eventNames(), [])
  assert.deepEqual(f.powerMonitor.eventNames(), [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await assert.rejects(adapter.show(message('closed'), controller.signal), { name: 'AbortError' })
  await assert.rejects(adapter.permission(false, controller.signal), { name: 'AbortError' })
  await adapter.close()
  await adapter.close()
  assert.equal(f.instances[0].closeCalls, 2)
  f.assertReleased(controller.signal)
})

for (const request of [false, true]) {
  test(`${request ? 'permission request' : 'permission query'} has a fixed timeout and releases JS ownership while OS remains pending`, darwin, async t => {
    const f = fixture(t), adapter = f.make(), controller = new AbortController()
    const waiting = adapter.permission(request, controller.signal)
    const rejected = assert.rejects(waiting, { code: 'OC_NOTIFICATION_PERMISSION_TIMEOUT' })
    t.mock.timers.tick((request ? 30_000 : 2_000) - 1)
    assert.equal(f.permission.cancelCalls, 0)
    assert.notEqual(f.permission.callback, null)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(f.permission.callback, null)
    assert.equal(f.permission.osPending, true)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(f.timers.size, 0)
    await assert.rejects(adapter.permission(request, controller.signal), { code: 'ERR_NOTIFICATION_PERMISSION_PENDING' })
    assert.equal(f.permission.accepted, 1)
    assert.equal(f.timers.size, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    f.permission.complete()
    await f.authorize(adapter)
    await adapter.close()
    f.assertReleased(controller.signal)
  })
}

for (const action of ['abort', 'timeout', 'close'] as const) {
  test(`${action} during a system authorization request preserves the pending code and releases JS resources`, darwin, async t => {
    const f = fixture(t), adapter = f.make(), controller = new AbortController()
    const waiting = adapter.permission(true, controller.signal)
    f.permission.promptPending = true
    const rejected = assert.rejects(waiting, (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ERR_NOTIFICATION_PERMISSION_PENDING')
      assert.equal(error.name, action === 'timeout' ? 'Error' : 'AbortError')
      assert.match(error.message, /系统弹窗无法由应用关闭/)
      return true
    })
    if (action === 'abort') controller.abort()
    else if (action === 'timeout') t.mock.timers.tick(30_000)
    else await adapter.close()
    await rejected
    assert.equal(f.permission.osPending, true)
    assert.equal(f.permission.callback, null)
    assert.equal(f.permission.cancelCalls, 1)
    await adapter.close()
    f.assertReleased(controller.signal)
  })
}

test('native completion failures remain explicit and do not authorize notification display', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  const waiting = adapter.permission(false, controller.signal)
  const rejected = assert.rejects(waiting, { code: 'OC_NOTIFICATION_NATIVE_FAILURE', message: 'OS settings failed' })
  f.permission.complete('unknown', new Error('OS settings failed'))
  await rejected
  await assert.rejects(adapter.show(message(), controller.signal), /权限尚未确认允许/)
  assert.equal(f.instances.length, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await f.authorize(adapter)
  await adapter.close()
  f.assertReleased(controller.signal)
})

test('failed native cancellation removes JS listeners, blocks new work and is released by close retry', darwin, async t => {
  const f = fixture(t), adapter = f.make(), controller = new AbortController()
  const waiting = adapter.permission(true, controller.signal)
  f.permission.cancelFailures = 1
  const rejected = assert.rejects(waiting, { name: 'AbortError', code: 'OC_NOTIFICATION_NATIVE_FAILURE' })
  controller.abort()
  await rejected
  assert.notEqual(f.permission.callback, null)
  assert.equal(f.timers.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const next = new AbortController().signal
  await assert.rejects(adapter.permission(false, next), /取消原生通知权限等待失败/)
  await assert.rejects(adapter.show(message(), next), /取消原生通知权限等待失败/)
  assert.equal(f.permission.accepted, 1)
  await adapter.close()
  assert.equal(f.permission.cancelCalls, 2)
  f.assertReleased(controller.signal)
})

test('one hundred adapter create/close cycles do not accumulate power listeners or initialize permissions', darwin, async t => {
  const f = fixture(t)
  for (let index = 0; index < 100; index++) {
    const adapter = f.make()
    assert.equal(f.powerMonitor.listenerCount('suspend'), 1)
    assert.equal(f.powerMonitor.listenerCount('resume'), 1)
    f.powerMonitor.emit('suspend')
    f.powerMonitor.emit('resume')
    assert.deepEqual(f.sleeping.slice(-2), [true, false])
    assert.equal(f.sleeping.length, (index + 1) * 2)
    await adapter.close()
    f.powerMonitor.emit('suspend')
    f.powerMonitor.emit('resume')
    assert.equal(f.sleeping.length, (index + 1) * 2)
    f.assertReleased()
  }
  assert.deepEqual(f.access, { app: 0, supported: 0, addon: 0 })
})

test('close cancels an unconfirmed display and a permission query together without retaining JS resources', darwin, async t => {
  const f = fixture(t), adapter = f.make()
  const display = new AbortController(), query = new AbortController()
  await f.authorize(adapter)
  const showing = adapter.show(message(), display.signal)
  const rejectedShow = assert.rejects(showing, { name: 'AbortError' })
  const waiting = adapter.permission(false, query.signal)
  const rejectedQuery = assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(f.timers.size, 2)
  await adapter.close()
  await Promise.all([rejectedShow, rejectedQuery])
  assert.equal(f.permission.osPending, true)
  f.instances[0].emit('click', {})
  assert.deepEqual(f.navigation, [])
  f.assertReleased(display.signal)
  assert.equal(getEventListeners(query.signal, 'abort').length, 0)
})

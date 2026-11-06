import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { LocalEvent } from '../../shared/events'
import { DEFAULT_NOTIFICATIONS, type NotificationPermission, type NotificationSettings } from '../../shared/notifications'
import type { EventNotificationOptions, NativeNotificationAdapter, NativeNotificationMessage, NotificationBatch } from './notification-contracts'
import { emptyNotificationJournal, readNotificationJournal, writeNotificationJournal } from './notification-journal'
import { EventNotifications } from './notifications'
import { resourceAbortError } from '../resource-budget'

class Adapter implements NativeNotificationAdapter {
  permissionValue: NotificationPermission = 'authorized'
  requests: boolean[] = []
  shown: NativeNotificationMessage[] = []
  closeCalls = 0
  showBehavior: (message: NativeNotificationMessage, signal: AbortSignal) => Promise<void> = async () => {}
  closeBehavior: () => Promise<void> = async () => {}
  async permission(request: boolean): Promise<NotificationPermission> { this.requests.push(request); return this.permissionValue }
  async show(message: NativeNotificationMessage, signal: AbortSignal): Promise<void> {
    await this.showBehavior(message, signal)
    this.shown.push(message)
  }
  async close(): Promise<void> { this.closeCalls++; await this.closeBehavior() }
}
function row(sequence: number, entity = `private-task-${sequence}`, type: LocalEvent['type'] = 'execution-failed'): NotificationBatch['events'][number] {
  return { sequence, event: { id: `event-${sequence}`, sourceId: 'hermes', entityId: entity, type,
    observedAt: '2026-11-05T00:00:00.000Z', occurredAt: null, resultCode: 'PRIVATE_ERROR_BODY',
    target: { kind: 'schedule', id: entity, identity: 'task-identity' } } }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oc-notifications-'))
  const filename = path.join(directory, 'private', 'journal.json')
  const preferences: NotificationSettings = { ...DEFAULT_NOTIFICATIONS, enabled: true, sourceIds: ['hermes'], tasks: [],
    types: [...DEFAULT_NOTIFICATIONS.types], quiet: { ...DEFAULT_NOTIFICATIONS.quiet } }
  const clock = { value: new Date(2026, 10, 5, 12, 0), changes: 0, factories: 0, filenames: 0, names: 0 }
  const native = new Adapter()
  const options: EventNotificationOptions = { filename: () => { clock.filenames++; return filename }, preferences: () => preferences,
    language: () => 'zh-CN', adapter: () => { clock.factories++; return native }, taskName: target => {
      clock.names++; return target.identity === 'task-identity' ? 'Visible task name' : null
    }, changed: () => { clock.changes++ }, now: () => clock.value }
  const instances: EventNotifications[] = []
  const make = () => { const service = new EventNotifications(options); instances.push(service); return service }
  const service = make()
  t.after(async () => {
    native.closeBehavior = async () => {}
    for (const instance of instances) await instance.stop()
    await rm(directory, { recursive: true, force: true })
  })
  const commit = (events: NotificationBatch['events'], identity = '1:2:3') => service.committed({ identity, events })
  const advance = (milliseconds: number) => { clock.value = new Date(clock.value.getTime() + milliseconds) }
  return { directory, filename, preferences, clock, native, options, make, service, commit, advance }
}

test('construction and disabled operation never touch preferences, adapter or journal', async t => {
  let callbacks = 0
  const untouched = () => { callbacks++; throw new Error('constructor must not call options') }
  const constructed = new EventNotifications({ filename: untouched, preferences: untouched, language: untouched,
    adapter: untouched, taskName: untouched, changed: untouched })
  assert.equal(constructed.snapshot().phase, 'off')
  assert.equal(callbacks, 0)
  const f = await fixture(t)
  f.preferences.enabled = false
  await f.service.start(new AbortController().signal)
  await f.commit([row(1)])
  await f.service.refresh()
  await f.service.requestPermission()
  await f.service.stop()
  assert.equal(f.clock.factories, 0)
  assert.equal(f.clock.filenames, 0)
  assert.equal(f.native.closeCalls, 0)
})

test('claim is durable before show; duplicate sequences never deliver again and empty batches do not emit unchanged state', async t => {
  const f = await fixture(t)
  f.native.showBehavior = async () => {
    const saved = await readNotificationJournal(f.filename)
    assert.equal(saved.cursor.sequence, 1)
    assert.equal(saved.cursor.unconfirmed, true)
  }
  await f.service.start(new AbortController().signal)
  await f.commit([row(1), row(1)])
  await f.commit([row(1)])
  assert.equal(f.native.shown.length, 1)
  const changes = f.clock.changes
  await f.commit([])
  await f.commit([])
  assert.equal(f.clock.changes, changes)
  assert.equal((await readNotificationJournal(f.filename)).cursor.unconfirmed, false)
})

test('100 failures produce at most three deliveries per rolling minute including the later summary', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  await f.commit(Array.from({ length: 100 }, (_, index) => row(index + 1)))
  assert.equal(f.native.shown.length, 3)
  assert.equal(f.service.snapshot().pendingCount, 97)
  assert.equal((await readNotificationJournal(f.filename)).cooldowns.length, 64)
  f.advance(59_999)
  await f.commit([])
  assert.equal(f.native.shown.length, 3)
  f.advance(1)
  await f.commit([row(101, 'recovery-1', 'source-recovered'), row(102, 'recovery-2', 'source-recovered'), row(103, 'recovery-3', 'source-recovered')])
  assert.equal(f.native.shown.length, 6)
  assert.match(f.native.shown[3].body, /97/)
  assert.deepEqual(f.native.shown[3].target, { kind: 'page', page: 'events' })
  assert.equal(f.service.snapshot().pendingCount, 1)
  f.advance(59_999)
  await f.commit([])
  assert.equal(f.native.shown.length, 6)
  f.advance(1)
  await f.commit([])
  assert.equal(f.native.shown.length, 7)
  assert.equal(f.service.snapshot().lastOutcome, 'summary')
})

test('quiet hours span midnight, release one summary, and a backwards clock never replays claimed rows', async t => {
  const f = await fixture(t)
  f.preferences.quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 }
  f.clock.value = new Date(2026, 10, 5, 23, 30)
  await f.service.start(new AbortController().signal)
  await f.commit([row(1)])
  f.clock.value = new Date(2026, 10, 6, 0, 30)
  await f.commit([row(2)])
  assert.equal(f.native.shown.length, 0)
  assert.equal(f.service.snapshot().phase, 'quiet')
  f.clock.value = new Date(2026, 10, 6, 8, 0)
  await f.commit([])
  assert.equal(f.native.shown.length, 1)
  assert.match(f.native.shown[0].body, /2/)
  f.clock.value = new Date(2026, 10, 6, 7, 0)
  await f.commit([row(1), row(2), row(3)])
  assert.equal(f.native.shown.length, 1)
  f.clock.value = new Date(2026, 10, 6, 8, 0)
  await f.commit([])
  await f.commit([])
  assert.equal(f.native.shown.length, 2)
  assert.match(f.native.shown[1].body, /1/)
})

test('backwards wall clock retains rate and cooldown windows; timezone change only changes quiet eligibility', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  await f.commit([row(1), row(2), row(3)])
  f.advance(-60 * 60_000)
  await f.commit([row(4, 'recovered', 'source-recovered')])
  assert.equal(f.native.shown.length, 3)
  f.advance(60_000)
  f.preferences.quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 }
  const sameInstant = f.clock.value.getTime()
  f.clock.value.getHours = () => 23
  await f.commit([])
  assert.equal(f.native.shown.length, 3)
  f.clock.value = new Date(sameInstant)
  f.clock.value.getHours = () => 9
  await f.commit([])
  assert.equal(f.native.shown.length, 4)
  await f.commit([row(1), row(2), row(3), row(4, 'recovered', 'source-recovered')])
  assert.equal(f.native.shown.length, 4)
})

test('recovery clears matching failure cooldown even when recovery notifications are not subscribed', async t => {
  const f = await fixture(t)
  f.preferences.types = ['execution-failed']
  await f.service.start(new AbortController().signal)
  await f.commit([row(1, 'same')])
  f.advance(1_000)
  await f.commit([row(2, 'same')])
  assert.equal(f.native.shown.length, 1)
  assert.equal(f.service.snapshot().pendingCount, 1)
  await f.commit([row(3, 'same', 'source-recovered')])
  assert.equal((await readNotificationJournal(f.filename)).cooldowns.length, 0)
  f.advance(60_000)
  await f.commit([row(4, 'same')])
  assert.match(f.native.shown.at(-1)!.body, /任务执行失败/)
  assert.equal(f.native.shown.filter(message => message.target.kind === 'schedule').length, 2)
})

test('source or full task identity subscription and type filter protect task reuse; names require explicit opt-in', async t => {
  const f = await fixture(t)
  f.preferences.sourceIds = []
  f.preferences.tasks = [{ kind: 'schedule', id: 'secret-task', identity: 'task-identity' }]
  f.preferences.types = ['execution-failed']
  await f.service.start(new AbortController().signal)
  const wrongIdentity = row(1, 'secret-task')
  wrongIdentity.event.target = { kind: 'schedule', id: 'secret-task', identity: 'reused-identity' }
  await f.commit([wrongIdentity, row(2, 'other-task'), row(3, 'secret-task', 'delivery-failed'), row(4, 'secret-task')])
  assert.equal(f.native.shown.length, 1)
  assert.equal(f.clock.names, 0)
  assert(!JSON.stringify(f.native.shown[0].body).includes('secret-task'))
  assert(!f.native.shown[0].body.includes('PRIVATE_ERROR_BODY'))
  assert.deepEqual(f.native.shown[0].target, { kind: 'schedule', id: 'secret-task', identity: 'task-identity' })
  assert(!((await readFile(f.filename, 'utf8')).includes('secret-task')))
  f.preferences.showTaskNames = true
  f.advance(5 * 60_000)
  await f.commit([row(5, 'secret-task')])
  assert.equal(f.clock.names, 1)
  assert.match(f.native.shown.at(-1)!.body, /Visible task name/)
})

test('journal write failure refuses delivery and exposes an error without rejecting collection', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  await mkdir(f.filename, { recursive: true })
  await f.commit([row(1)])
  assert.equal(f.native.shown.length, 0)
  assert.equal(f.service.snapshot().phase, 'error')
  assert(f.service.snapshot().detail)
  await f.commit([row(2)])
  assert.equal(f.native.shown.length, 0)
})

test('failed delivery remains unconfirmed across restart and the claimed batch is never replayed', async t => {
  const f = await fixture(t)
  let attempts = 0
  f.native.showBehavior = async () => { attempts++; throw new Error('native failed') }
  await f.service.start(new AbortController().signal)
  await f.commit([row(1), row(2)])
  assert.equal(attempts, 1)
  assert.equal((await readNotificationJournal(f.filename)).cursor.sequence, 2)
  assert.equal(f.service.snapshot().lastOutcome, 'unconfirmed')
  await f.service.stop()
  const restarted = f.make()
  await restarted.start(new AbortController().signal)
  assert.equal(restarted.snapshot().lastOutcome, 'unconfirmed')
  assert.match(restarted.snapshot().detail!, /不会重放/)
  await restarted.committed({ identity: '1:2:3', events: [row(1), row(2)] })
  assert.equal(attempts, 1)
})

test('database replacement resets its cursor explicitly while preserving the global rolling rate limit', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  await f.commit([row(100)])
  await f.commit([row(1)], '1:9:10')
  assert.equal(f.native.shown.length, 2)
  assert.match(f.service.snapshot().detail!, /身份已变更/)
  const journal = await readNotificationJournal(f.filename)
  assert.equal(journal.identity, '1:9:10')
  assert.equal(journal.cursor.sequence, 1)
  assert.equal(journal.sentAt.length, 2)
})

test('sleep accumulates counts and waking sends a single summary on the next committed tick', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  f.service.setSleeping(true)
  await f.commit([row(1), row(2)])
  assert.equal(f.native.shown.length, 0)
  assert.equal(f.service.snapshot().phase, 'sleeping')
  f.service.setSleeping(false)
  assert.equal(f.native.shown.length, 0)
  await f.commit([])
  await f.commit([])
  assert.equal(f.native.shown.length, 1)
  assert.equal(f.service.snapshot().pendingCount, 0)
  assert.equal(f.service.snapshot().lastOutcome, 'summary')
})

test('permission queries never prompt; only explicit request authorizes and denied events remain observable', async t => {
  const f = await fixture(t)
  f.native.permissionValue = 'denied'
  await f.service.start(new AbortController().signal)
  assert.deepEqual(f.native.requests, [false])
  await f.commit([row(1)])
  assert.equal(f.service.snapshot().phase, 'denied')
  assert(f.service.snapshot().detail)
  assert.equal(f.native.shown.length, 0)
  f.native.permissionValue = 'authorized'
  await f.service.requestPermission()
  assert.deepEqual(f.native.requests, [false, true])
  await f.commit([])
  assert.equal(f.native.shown.length, 1)
})

test('disabling aborts in-flight show immediately, rejects overlapping batches, clears summary and permits reuse', async t => {
  const f = await fixture(t)
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>()
  let observedSignal: AbortSignal | undefined
  f.native.showBehavior = async (_message, signal) => {
    observedSignal = signal
    enter()
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.reject(resourceAbortError()), { once: true })
    await aborted.promise
  }
  await f.service.start(new AbortController().signal)
  const flight = f.commit(Array.from({ length: 100 }, (_, index) => row(index + 1)))
  await entered
  for (let index = 0; index < 50; index++) await f.commit([row(101 + index)])
  assert.match(f.service.snapshot().detail!, /忙/)
  f.preferences.enabled = false
  const disabling = f.service.refresh()
  assert.equal(observedSignal?.aborted, true)
  await Promise.all([flight, disabling])
  assert.equal(f.native.shown.length, 0)
  assert.equal(f.native.closeCalls, 1)
  assert.equal(f.service.snapshot().phase, 'off')
  assert.equal(f.service.snapshot().pendingCount, 0)
  const journal = await readNotificationJournal(f.filename)
  assert.equal(journal.summaryCount, 0)
  assert.equal(journal.cursor.sequence, 100)
  f.native.showBehavior = async () => {}
  f.preferences.enabled = true
  await f.service.refresh()
  f.advance(68_000)
  await f.commit([row(150, 'new-recovery', 'source-recovered')])
  assert.equal(f.native.shown.length, 1)
})

test('parent abort cancels work and cleanup failures stay visible and retryable', async t => {
  const f = await fixture(t)
  const parent = new AbortController()
  await f.service.start(parent.signal)
  f.native.closeBehavior = async () => { throw new Error('native cleanup failure') }
  parent.abort()
  await assert.rejects(f.service.stop(), { code: 'OC_NOTIFICATION_CLEANUP' })
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /OC_NOTIFICATION_CLEANUP/)
  f.native.closeBehavior = async () => {}
  await f.service.stop()
  assert.equal(f.native.closeCalls, 2)
  assert.equal(f.service.snapshot().phase, 'events-disabled')
  await f.service.start(new AbortController().signal)
  await f.commit([row(1)])
  assert.equal(f.native.shown.length, 1)
})

test('sleep during a batch aggregates only not-yet-attempted notifications and never retries the interrupted show', async t => {
  const f = await fixture(t)
  const entered = Promise.withResolvers<void>()
  let attempts = 0
  f.native.showBehavior = async (_message, signal) => {
    attempts++
    entered.resolve()
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.reject(resourceAbortError()), { once: true })
    await aborted.promise
  }
  await f.service.start(new AbortController().signal)
  const flight = f.commit([row(1), row(2), row(3)])
  await entered.promise
  f.service.setSleeping(true)
  await flight
  assert.equal(attempts, 1)
  assert.equal(f.service.snapshot().pendingCount, 2)
  assert.equal((await readNotificationJournal(f.filename)).sentAt.length, 1)
  f.native.showBehavior = async () => { attempts++ }
  f.service.setSleeping(false)
  await f.commit([])
  assert.equal(attempts, 2)
  assert.equal(f.native.shown.length, 1)
  assert.match(f.native.shown[0].body, /2/)
  await f.commit([row(1), row(2), row(3)])
  assert.equal(attempts, 2)
})

test('permission pending survives AbortError and shutdown without pretending the system request ended', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  f.native.permission = async () => { throw Object.assign(resourceAbortError(), { code: 'ERR_NOTIFICATION_PERMISSION_PENDING' }) }
  await f.service.requestPermission()
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /请求尚未结束/)
  assert.match(f.service.snapshot().detail!, /可能仍有系统弹窗/)
  await f.service.stop()
  assert.equal(f.service.snapshot().phase, 'events-disabled')
  assert.match(f.service.snapshot().detail!, /无法保证关闭/)
  f.native.permission = async () => 'authorized'
  await f.service.start(new AbortController().signal)
  assert.equal(f.service.snapshot().phase, 'ready')
  assert.equal(f.service.snapshot().detail, null)
})

test('permission timeout keeps authorization unconfirmed and does not fall through to generic storage advice', async t => {
  const f = await fixture(t)
  f.native.permission = async () => { throw Object.assign(new Error('native timeout'), { code: 'OC_NOTIFICATION_PERMISSION_TIMEOUT' }) }
  await f.service.start(new AbortController().signal)
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /授权状态尚未确认/)
  assert.match(f.service.snapshot().detail!, /检查系统提示/)
  assert(!f.service.snapshot().detail!.includes('存储'))
  await f.commit([row(1)])
  assert.equal(f.native.shown.length, 0)
})

test('summary overflow rejects the batch visibly without truncating its count or claiming its cursor', async t => {
  const f = await fixture(t)
  const journal = emptyNotificationJournal()
  journal.identity = '1:2:3'
  journal.summaryCount = Number.MAX_SAFE_INTEGER
  await writeNotificationJournal(f.filename, journal)
  f.preferences.quiet = { enabled: true, startMinute: 0, endMinute: 0 }
  await f.service.start(new AbortController().signal)
  await f.commit([row(1)])
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /OC_NOTIFICATION_SUMMARY_LIMIT/)
  assert.equal(f.service.snapshot().pendingCount, Number.MAX_SAFE_INTEGER)
  assert.equal(f.native.shown.length, 0)
  const saved = await readNotificationJournal(f.filename)
  assert.equal(saved.summaryCount, Number.MAX_SAFE_INTEGER)
  assert.equal(saved.cursor.sequence, 0)
})

test('collection remains isolated when simultaneous shutdown reports a genuine cleanup failure', async t => {
  const f = await fixture(t)
  const entered = Promise.withResolvers<void>()
  f.native.showBehavior = async (_message, signal) => {
    const aborted = Promise.withResolvers<void>()
    signal.addEventListener('abort', () => aborted.reject(resourceAbortError()), { once: true })
    entered.resolve()
    await aborted.promise
  }
  f.native.closeBehavior = async () => { throw new Error('cleanup failed') }
  await f.service.start(new AbortController().signal)
  const collecting = f.commit([row(1)])
  await entered.promise
  await assert.rejects(f.service.stop(), { code: 'OC_NOTIFICATION_CLEANUP' })
  await collecting
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /OC_NOTIFICATION_CLEANUP/)
})

test('refresh after saved disable reports cleanup error without rejecting successful settings, while stop still rejects', async t => {
  const f = await fixture(t)
  await f.service.start(new AbortController().signal)
  f.native.closeBehavior = async () => { throw new Error('close failed after preferences were saved') }
  f.preferences.enabled = false
  await f.service.refresh()
  assert.equal(f.preferences.enabled, false)
  assert.equal(f.service.snapshot().phase, 'error')
  assert.match(f.service.snapshot().detail!, /OC_NOTIFICATION_CLEANUP/)
  await f.service.refresh()
  assert.equal(f.native.closeCalls, 2)
  assert.equal(f.service.snapshot().phase, 'error')
  await assert.rejects(f.service.stop(), { code: 'OC_NOTIFICATION_CLEANUP' })
  f.native.closeBehavior = async () => {}
  await f.service.refresh()
  assert.equal(f.native.closeCalls, 4)
  assert.equal(f.service.snapshot().phase, 'off')
  assert.equal(f.service.snapshot().detail, null)
})

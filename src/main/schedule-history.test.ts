import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET, type ScheduledJob, type ScheduleHistory } from '../shared/types'
import { ScheduleHistoryReader, type ScheduleHistoryProvider } from './schedule-history'
import { ResourceCleanupError, resourceAbortError } from './resource-budget'

const job: ScheduledJob = { id: 'hermes-job:daily', name: 'Daily', source: 'Hermes', scope: 'user',
  origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }

function page(id: string, offset: number): ScheduleHistory {
  return { jobId: id, source: 'hermes', entries: [], offset, limit: HISTORY_PAGE_SIZE,
    hasMore: false, collectedAt: '2026-11-04T00:00:00.000Z' }
}

function controlledProvider(): {
  provider: ScheduleHistoryProvider
  calls: { id: string; signal: AbortSignal; release: () => void; fail: (error: Error) => void }[]
  peak: () => number
} {
  const calls: { id: string; signal: AbortSignal; release: () => void; fail: (error: Error) => void }[] = []
  let active = 0
  let peak = 0
  return { calls, peak: () => peak, provider: {
    supports: () => true,
    read: (current, offset, signal) => {
      active++
      peak = Math.max(peak, active)
      const { promise, resolve, reject } = Promise.withResolvers<ScheduleHistory>()
      calls.push({ id: current.id, signal,
        release: () => { active--; resolve(page(current.id, offset)) },
        fail: error => { active--; reject(error) } })
      return promise
    }
  } }
}

test('unsupported launchd and cron histories stay unavailable despite exit codes', async () => {
  const reader = new ScheduleHistoryReader({ providers: [] })
  for (const id of ['user:nightly', 'crontab:nightly']) {
    const result = await reader.read({ ...job, id, lastExitCode: 0 })
    assert.equal(result.source, 'unavailable')
    assert.deepEqual(result.entries, [])
    assert.equal(result.hasMore, false)
    assert.equal(result.jobId, id)
  }
})

test('a burst retains only the latest pending request and never overlaps provider cleanup', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const first = assert.rejects(reader.read(job), { name: 'AbortError' })
  const replaced: Promise<void>[] = []
  for (let index = 0; index < 2000; index++) {
    replaced.push(assert.rejects(reader.read({ ...job, id: `hermes-job:replace-${index}` }), { name: 'AbortError' }))
  }
  const latest = reader.read({ ...job, id: 'hermes-job:latest' }, 50)
  assert.equal(control.calls.length, 1)
  assert.equal(control.calls[0].signal.aborted, true)
  await Promise.all([first, ...replaced])
  control.calls[0].release()
  await setImmediate()
  assert.equal(control.calls.length, 2)
  assert.equal(control.calls[1].id, 'hermes-job:latest')
  control.calls[1].release()
  assert.equal((await latest).offset, 50)
  assert.equal(control.peak(), 1)
})

test('cancel settles active and pending callers, waits for release, and supports repeated reuse', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  for (let index = 0; index < 100; index++) {
    const active = assert.rejects(reader.read(job), { name: 'AbortError' })
    const pending = assert.rejects(reader.read(job, 25), { name: 'AbortError' })
    reader.cancel()
    reader.cancel()
    await Promise.all([active, pending])
    assert.equal(control.calls.length, index + 1)
    let drained = false
    const idle = reader.idle().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false, '调用者收到取消不等于 provider 已释放')
    assert.deepEqual(reader.diagnostics(), { closed: false, active: true, pending: false, phase: 'cancelling' })
    control.calls[index].release()
    await idle
    assert.equal(control.calls.length, index + 1)
  }
  assert.equal(control.peak(), 1)
  await reader.close()
})

test('invalid offsets and job identifiers fail before starting a provider', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  for (const offset of [-1, 0.5, 1, NaN, Infinity, MAX_HISTORY_OFFSET + 1])
    await assert.rejects(reader.read(job, offset), /History offset out of range/)
  for (const id of ['', 'x'.repeat(257), 'job\0suffix', 'job\nsuffix']) await assert.rejects(reader.read({ ...job, id }), /Invalid job identifier/)
  assert.equal(control.calls.length, 0)
})

test('read failure rejects instead of being represented as empty or unsupported history', async () => {
  const reader = new ScheduleHistoryReader({ providers: [{ supports: () => true,
    read: async () => { throw new Error('读取失败 / Read failed') } }] })
  await assert.rejects(reader.read(job), /Read failed/)
  await assert.rejects(reader.read(job), /Read failed/)
})

test('idle waits through active release and the latest replacement without cancelling it', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const first = assert.rejects(reader.read(job), { name: 'AbortError' })
  const replacement = reader.read({ ...job, id: 'hermes-job:replacement' }, 25)
  let drained = false
  const idle = reader.idle()
  assert.equal(reader.idle(), idle)
  const observed = idle.then(() => { drained = true })
  await first
  assert.equal(drained, false)
  assert.equal(reader.diagnostics().pending, true)
  control.calls[0].release()
  await setImmediate()
  assert.equal(drained, false)
  assert.equal(control.calls.length, 2)
  assert.equal(control.calls[1].signal.aborted, false)
  control.calls[1].release()
  assert.equal((await replacement).jobId, 'hermes-job:replacement')
  await observed
  assert.deepEqual(reader.diagnostics(), { closed: false, active: false, pending: false, phase: 'idle' })
  await reader.close()
})

test('close permanently closes admission, shares one promise and drains late provider results', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const active = assert.rejects(reader.read(job), { name: 'AbortError' })
  const pending = assert.rejects(reader.read({ ...job, id: 'hermes-job:never-start' }), { name: 'AbortError' })
  let drained = false
  const closing = reader.close()
  assert.equal(reader.close(), closing)
  const observed = closing.then(() => { drained = true })
  reader.cancel()
  await Promise.all([active, pending])
  assert.equal(drained, false)
  assert.deepEqual(reader.diagnostics(), { closed: true, active: true, pending: false, phase: 'cancelling' })
  await assert.rejects(reader.read(job), /History reader closed/)
  await assert.rejects(reader.read(job, -1), /History reader closed/)
  control.calls[0].release()
  await observed
  await reader.idle()
  assert.equal(reader.close(), closing)
  assert.equal(control.calls.length, 1, '晚到旧 provider 不得启动已取消 pending')
  assert.deepEqual(reader.diagnostics(), { closed: true, active: false, pending: false, phase: 'closed' })
  assert.doesNotMatch(JSON.stringify(reader.diagnostics()), /hermes|daily|never-start|job|path|entries/)
})

test('one hundred independent start/close cycles release providers without overlap or reusable admission', async () => {
  const control = controlledProvider()
  for (let index = 0; index < 100; index++) {
    const reader = new ScheduleHistoryReader({ providers: [control.provider] })
    const request = assert.rejects(reader.read(job), { name: 'AbortError' })
    const closing = reader.close()
    reader.cancel()
    assert.equal(reader.close(), closing)
    await request
    assert.equal(reader.diagnostics().active, true)
    control.calls[index].fail(resourceAbortError())
    await closing
    assert.equal(reader.diagnostics().active, false)
    await assert.rejects(reader.read(job), /History reader closed/)
  }
  assert.equal(control.peak(), 1)
  assert.equal(control.calls.length, 100)
})

test('non-cancellation provider failure during release reaches idle and close after caller cancellation', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const request = assert.rejects(reader.read(job), { name: 'AbortError' })
  reader.cancel()
  await request
  const failure = new Error('provider resource close failed')
  const idleFailure = assert.rejects(reader.idle(), error => error === failure)
  const closing = reader.close()
  const closeFailure = assert.rejects(closing, error => error === failure)
  control.calls[0].fail(failure)
  await Promise.all([idleFailure, closeFailure])
  assert.equal(reader.close(), closing)
  await assert.rejects(reader.idle(), error => error === failure)
  assert.deepEqual(reader.diagnostics(), { closed: true, active: false, pending: false, phase: 'failed' })
  assert.doesNotMatch(JSON.stringify(reader.diagnostics()), /provider resource close failed/)
})

test('cleanup failure is retained even when no idle observer existed at the time', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const request = assert.rejects(reader.read(job), { name: 'AbortError' })
  reader.cancel()
  await request
  const failure = new Error('late cleanup failure')
  control.calls[0].fail(failure)
  await setImmediate()
  await assert.rejects(reader.idle(), error => error === failure)
  await assert.rejects(reader.close(), error => error === failure)
})

test('ordinary read errors reach the caller while idle and close still confirm resource release', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const failure = new Error('ordinary database read failed')
  const request = assert.rejects(reader.read(job), error => error === failure)
  const idle = reader.idle()
  control.calls[0].fail(failure)
  await Promise.all([request, idle])
  assert.equal(reader.diagnostics().phase, 'idle')
  await reader.close()
})

test('empty and unsupported readers close immediately with stable promise identity', async () => {
  const reader = new ScheduleHistoryReader({ providers: [] })
  assert.equal((await reader.read(job)).source, 'unavailable')
  await reader.idle()
  const closing = reader.close()
  assert.equal(reader.close(), closing)
  await closing
  await assert.rejects(reader.read(job), /History reader closed/)
})

test('resource cleanup failures reject shutdown even when no cancellation was requested', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const failure = new ResourceCleanupError('file', new Error('close failed'))
  const request = assert.rejects(reader.read(job), error => error === failure)
  const idle = assert.rejects(reader.idle(), error => error === failure)
  control.calls[0].fail(failure)
  await Promise.all([request, idle])
  await assert.rejects(reader.close(), error => error === failure)
  assert.equal(reader.diagnostics().phase, 'failed')
})

test('nested abort and cleanup errors retain cleanup evidence instead of becoming expected cancellation', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const request = assert.rejects(reader.read(job), { name: 'AbortError' })
  const failure = new AggregateError([resourceAbortError(),
    new AggregateError([new ResourceCleanupError('command', new Error('pipe close failed'))], 'nested release')], 'read and release')
  const closing = reader.close()
  const rejected = assert.rejects(closing, error => error === failure)
  control.calls[0].fail(failure)
  await Promise.all([request, rejected])
  assert.equal(reader.diagnostics().phase, 'failed')
})

test('an aggregate containing only real aborts drains successfully', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  const request = assert.rejects(reader.read(job), { name: 'AbortError' })
  const closing = reader.close()
  control.calls[0].fail(new AggregateError([resourceAbortError(), new AggregateError([resourceAbortError()])]))
  await Promise.all([request, closing])
  assert.equal(reader.diagnostics().phase, 'closed')
})

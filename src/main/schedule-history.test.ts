import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { ScheduledJob, ScheduleHistory } from '../shared/types'
import { HISTORY_PAGE_SIZE, MAX_HISTORY_OFFSET, ScheduleHistoryReader, type ScheduleHistoryProvider } from './schedule-history'

const job: ScheduledJob = { id: 'hermes-job:daily', name: 'Daily', source: 'Hermes', scope: 'user',
  origin: 'personal', kind: 'calendar', schedule: 'daily', state: 'waiting' }

function page(id: string, offset: number): ScheduleHistory {
  return { jobId: id, source: 'hermes', entries: [], offset, limit: HISTORY_PAGE_SIZE,
    hasMore: false, collectedAt: '2026-11-04T00:00:00.000Z' }
}

function controlledProvider(): {
  provider: ScheduleHistoryProvider
  calls: { id: string; signal: AbortSignal; release: () => void }[]
  peak: () => number
} {
  const calls: { id: string; signal: AbortSignal; release: () => void }[] = []
  let active = 0
  let peak = 0
  return { calls, peak: () => peak, provider: {
    supports: () => true,
    read: (current, offset, signal) => {
      active++
      peak = Math.max(peak, active)
      return new Promise(resolve => {
        calls.push({ id: current.id, signal, release: () => { active--; resolve(page(current.id, offset)) } })
      })
    }
  } }
}

test('unsupported launchd and cron histories stay unavailable despite exit codes', async () => {
  const reader = new ScheduleHistoryReader()
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
  for (let index = 0; index < 30; index++) {
    const active = assert.rejects(reader.read(job), { name: 'AbortError' })
    const pending = assert.rejects(reader.read(job, 25), { name: 'AbortError' })
    reader.cancel()
    reader.cancel()
    await Promise.all([active, pending])
    assert.equal(control.calls.length, index + 1)
    control.calls[index].release()
    await setImmediate()
    assert.equal(control.calls.length, index + 1)
  }
  assert.equal(control.peak(), 1)
})

test('invalid offsets and job identifiers fail before starting a provider', async () => {
  const control = controlledProvider()
  const reader = new ScheduleHistoryReader({ providers: [control.provider] })
  for (const offset of [-1, 0.5, NaN, Infinity, MAX_HISTORY_OFFSET + 1])
    await assert.rejects(reader.read(job, offset), /History offset out of range/)
  for (const id of ['', 'x'.repeat(257)]) await assert.rejects(reader.read({ ...job, id }), /Invalid job identifier/)
  assert.equal(control.calls.length, 0)
})

test('read failure rejects instead of being represented as empty or unsupported history', async () => {
  const reader = new ScheduleHistoryReader({ providers: [{ supports: () => true,
    read: async () => { throw new Error('读取失败 / Read failed') } }] })
  await assert.rejects(reader.read(job), /Read failed/)
  await assert.rejects(reader.read(job), /Read failed/)
})

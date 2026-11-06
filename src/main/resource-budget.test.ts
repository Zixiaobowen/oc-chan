import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { ResourceBudget, ResourceBudgetError, ResourceCleanupError, resourceAbortError, settleResourceWork, type ResourceRequest } from './resource-budget'

const file = (source: string, bytes = 1, signal?: AbortSignal): ResourceRequest => ({ source, kind: 'file', bytes, signal })
const command = (source: string, stdoutBytes: number, stderrBytes: number): ResourceRequest => ({ source, kind: 'command', stdoutBytes, stderrBytes })

test('raw stream reservations and slots are charged atomically and returned once', async () => {
  const budget = new ResourceBudget({ commands: 2, commandBytes: 10 })
  const first = await budget.acquire(command('first', 4, 3))
  const second = budget.acquire(command('second', 2, 2))
  assert.equal(budget.snapshot().global.current.commands, 1)
  assert.equal(budget.snapshot().global.current.commandBytes, 7)
  assert.equal(budget.snapshot().global.current.queued, 1)
  first.release()
  first.release('failed')
  const admitted = await second
  assert.equal(budget.snapshot().global.current.commandBytes, 4)
  admitted.release('failed')
  const state = budget.snapshot().global
  assert.equal(state.current.commandBytes, 0)
  assert.equal(state.current.commands, 0)
  assert.equal(state.completed, 1)
  assert.equal(state.failed, 1)
  assert.equal(state.peak.commandBytes, 7)
})

test('sources alternate turns and a large request cannot be starved by smaller arrivals', async () => {
  const budget = new ResourceBudget({ files: 2, fileBytes: 10 })
  const a = await budget.acquire(file('hold-a', 5))
  const b = await budget.acquire(file('hold-b', 5))
  const large = budget.acquire(file('large', 10))
  const small = budget.acquire(file('small', 1))
  a.release()
  assert.equal(budget.snapshot().global.current.files, 1)
  assert.equal(budget.snapshot().global.current.queued, 2)
  b.release()
  const l = await large
  assert.equal(budget.snapshot().global.current.fileBytes, 10)
  l.release()
  ;(await small).release()

  const serial = new ResourceBudget({ files: 1 })
  const held = await serial.acquire(file('hold'))
  const order: string[] = []
  const request = (source: string, id: string) => serial.acquire(file(source)).then(lease => { order.push(id); return lease })
  const first = request('a', 'a1'), second = request('a', 'a2'), third = request('b', 'b1'), fourth = request('b', 'b2')
  held.release()
  ;(await first).release()
  ;(await third).release()
  ;(await second).release()
  ;(await fourth).release()
  assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2'])
})

test('128 queued reads share one abort listener and cancellation starts no IO', async () => {
  const budget = new ResourceBudget({ files: 1 })
  const held = await budget.acquire(file('hold'))
  const controller = new AbortController()
  let started = 0
  const work = Array.from({ length: 128 }, () => budget.run(file('activity', 1, controller.signal), async () => { started++ }))
  const settled = Promise.allSettled(work)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  assert.equal(budget.snapshot().global.current.queued, 128)
  controller.abort()
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'ABORT_ERR'))
  assert.equal(started, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  held.release()
  assert.equal(budget.snapshot().global.current.queued, 0)
  assert.equal(budget.snapshot().global.cancelled, 128)
})

test('global and per-source queues reject before invoking work and retain no rejected payload', async () => {
  const budget = new ResourceBudget({ files: 1, queued: 3, queuedPerSource: 2 })
  const held = await budget.acquire(file('hold'))
  const controller = new AbortController()
  const work = [budget.run(file('a', 1, controller.signal), async () => {}), budget.run(file('a', 1, controller.signal), async () => {})]
  let started = false
  await assert.rejects(budget.run(file('a'), async () => { started = true }), (error: ResourceBudgetError) => error.reason === 'source-queue-full')
  work.push(budget.run(file('b', 1, controller.signal), async () => {}))
  await assert.rejects(budget.run(file('c'), async () => { started = true }), (error: ResourceBudgetError) => error.reason === 'queue-full')
  const settled = Promise.allSettled(work)
  controller.abort()
  await settled
  held.release()
  assert.equal(started, false)
  assert.equal(budget.snapshot().global.peak.queued, 3)
  assert.equal(budget.snapshot().global.rejected, 2)
})

test('queue expiry is separate from execution and the resource remains owned until release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const budget = new ResourceBudget({ files: 1, queueTimeoutMs: 15 })
  const held = await budget.acquire(file('hold'))
  let started = false
  const expired = assert.rejects(budget.run(file('waiter'), async () => { started = true }), (error: ResourceBudgetError) => error.code === 'OC_RESOURCE_QUEUE_TIMEOUT')
  now = 15
  t.mock.timers.tick(15)
  await expired
  const waiting = budget.snapshot().sources.find(source => source.source === 'waiter')!
  assert.equal(started, false)
  assert.equal(waiting.totalExecutionMs, 0)
  assert.equal(waiting.totalWaitMs, 15)
  assert.equal(budget.snapshot().global.current.files, 1)
  held.release()
  assert.equal(budget.snapshot().global.current.files, 0)
})

test('oversized, cancelled and nested work cannot start or deadlock', async () => {
  const budget = new ResourceBudget({ fileBytes: 8, sources: 2 })
  let started = 0
  await assert.rejects(budget.run(file('oversized', 9), async () => { started++ }), (error: ResourceBudgetError) => error.reason === 'request-too-large')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(budget.run(file('cancelled', 1, controller.signal), async () => { started++ }), { name: 'AbortError', code: 'ABORT_ERR' })
  await assert.rejects(budget.run(file('outer'), async () => budget.run(file('inner'), async () => { started++ })), (error: ResourceBudgetError) => error.reason === 'nested-request')
  await budget.run(file('second'), async () => {})
  await assert.rejects(budget.run(file('third'), async () => { started++ }), (error: ResourceBudgetError) => error.reason === 'source-limit')
  assert.equal(started, 0)
  assert.equal(budget.snapshot().global.current.files, 0)
  assert.equal(budget.snapshot().global.failed, 1)
})

test('queued requests and diagnostics cannot be mutated to change charged capacity', async () => {
  const budget = new ResourceBudget({ files: 1, fileBytes: 8 })
  const held = await budget.acquire(file('hold'))
  const request = file('pending', 4)
  const pending = budget.acquire(request)
  request.bytes = 1000
  request.source = 'changed'
  const exposed = budget.snapshot()
  Reflect.set(exposed.global.current, 'fileBytes', 1000)
  held.release()
  const lease = await pending
  assert.equal(budget.snapshot().global.current.fileBytes, 4)
  lease.release()
  assert.equal(budget.snapshot().global.current.fileBytes, 0)
})

test('command input waits for both resource kinds without holding a partial reservation', async t => {
  for (const blocked of ['file', 'command'] as const) {
    const budget = new ResourceBudget({ commands: 1, files: 1, fileBytes: 10, commandBytes: 12 })
    const held = await budget.acquire(blocked === 'file' ? file('hold', 10) : command('hold', 6, 6))
    const controller = new AbortController()
    t.after(() => { controller.abort(); held.release() })
    const pending = budget.acquire({ ...command('compound', 3, 4), inputBytes: 8, signal: controller.signal })
    const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' })
    const waiting = budget.snapshot()
    assert.equal(waiting.global.current.commands, blocked === 'command' ? 1 : 0)
    assert.equal(waiting.global.current.files, blocked === 'file' ? 1 : 0)
    assert.equal(waiting.global.current.commandBytes, blocked === 'command' ? 12 : 0)
    assert.equal(waiting.global.current.fileBytes, blocked === 'file' ? 10 : 0)
    const own = waiting.sources.find(source => source.source === 'compound')!.current
    assert.equal(own.commands + own.files + own.commandBytes + own.fileBytes, 0)
    assert.equal(own.queued, 1)
    controller.abort()
    await rejected
    held.release()
    assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
  }
})

test('command input reserves independent byte budgets and returns both exactly once on failure', async () => {
  const budget = new ResourceBudget({ commands: 1, files: 1, commandBytes: 12, fileBytes: 10 })
  await assert.rejects(budget.run({ ...command('compound', 6, 6), inputBytes: 10 }, async () => {
    const current = budget.snapshot().global.current
    assert.equal(current.commands, 1)
    assert.equal(current.files, 1)
    assert.equal(current.commandBytes, 12)
    assert.equal(current.fileBytes, 10)
    throw new Error('input consumer failed')
  }), /input consumer failed/)
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
  assert.equal(budget.snapshot().global.failed, 1)
  await assert.rejects(budget.acquire({ ...file('invalid'), inputBytes: 1 }), (error: ResourceBudgetError) => error.reason === 'invalid-request')
  await assert.rejects(budget.acquire({ source: 'invalid', kind: 'socket', bytes: 0, inputBytes: 1 }), (error: ResourceBudgetError) => error.reason === 'invalid-request')
  await assert.rejects(budget.acquire({ ...command('oversized', 1, 1), inputBytes: 11 }), (error: ResourceBudgetError) => error.reason === 'request-too-large')
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('a waiting compound command cannot be starved by later small file arrivals', async t => {
  const budget = new ResourceBudget({ commands: 1, files: 2, fileBytes: 10 })
  const first = await budget.acquire(file('hold-first', 5))
  const second = await budget.acquire(file('hold-second', 5))
  const controller = new AbortController()
  const leases = [first, second]
  t.after(() => { controller.abort(); for (const lease of leases) lease.release() })
  const order: string[] = []
  const queue = (request: ResourceRequest) => {
    const pending = budget.acquire({ ...request, signal: controller.signal }).then(lease => {
      leases.push(lease)
      order.push(request.source)
      return lease
    })
    void pending.catch(() => {})
    return pending
  }
  const compound = queue({ ...command('compound', 1, 1), inputBytes: 10 })
  first.release()
  const small = queue(file('later-small', 1))
  assert.equal(budget.snapshot().global.current.files, 1)
  assert.equal(budget.snapshot().global.current.fileBytes, 5)
  assert.equal(budget.snapshot().global.current.commands, 0)
  assert.equal(budget.snapshot().global.current.queued, 2)
  second.release()
  const combined = await compound
  assert.deepEqual(order, ['compound'])
  assert.equal(budget.snapshot().global.current.fileBytes, 10)
  combined.release()
  ;(await small).release()
  assert.deepEqual(order, ['compound', 'later-small'])
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('queued compound requests snapshot input bytes before callers mutate them', async t => {
  const budget = new ResourceBudget({ commands: 1, files: 1, fileBytes: 10 })
  const held = await budget.acquire(file('hold', 1))
  t.after(() => held.release())
  const request: ResourceRequest = { ...command('compound', 1, 2), inputBytes: 8 }
  const waiting = budget.acquire(request)
  request.inputBytes = 1000
  request.kind = 'file'
  held.release()
  const lease = await waiting
  t.after(() => lease.release())
  assert.equal(budget.snapshot().global.current.commands, 1)
  assert.equal(budget.snapshot().global.current.files, 1)
  assert.equal(budget.snapshot().global.current.fileBytes, 8)
  assert.equal(budget.snapshot().global.current.commandBytes, 3)
  lease.release()
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('an earlier file waiter keeps priority over a later compound command', async t => {
  const budget = new ResourceBudget({ commands: 1, files: 2, fileBytes: 10 })
  const first = await budget.acquire(file('hold-first', 5))
  const second = await budget.acquire(file('hold-second', 5))
  const controller = new AbortController()
  const leases = [first, second]
  t.after(() => { controller.abort(); for (const lease of leases) lease.release() })
  const earlier = budget.acquire(file('earlier-file', 10, controller.signal)).then(lease => { leases.push(lease); return lease })
  const compound = budget.acquire({ ...command('compound', 1, 1), inputBytes: 10, signal: controller.signal }).then(lease => { leases.push(lease); return lease })
  void earlier.catch(() => {})
  void compound.catch(() => {})
  first.release()
  second.release()
  assert.equal(budget.snapshot().global.current.commands, 0)
  assert.equal(budget.snapshot().global.current.files, 1)
  assert.equal(budget.snapshot().global.current.fileBytes, 10)
  const prior = await earlier
  prior.release()
  const combined = await compound
  assert.equal(budget.snapshot().global.current.commands, 1)
  assert.equal(budget.snapshot().global.current.files, 1)
  combined.release()
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('cancelling a compound waiter removes its file priority immediately', async t => {
  const budget = new ResourceBudget({ commands: 1, files: 2, fileBytes: 10 })
  const held = await budget.acquire(file('hold', 5))
  const controller = new AbortController()
  const smallController = new AbortController()
  t.after(() => { controller.abort(); smallController.abort(); held.release() })
  const compound = assert.rejects(budget.acquire({ ...command('compound', 1, 1), inputBytes: 10, signal: controller.signal }), { code: 'ABORT_ERR' })
  const small = budget.acquire(file('later-small', 1, smallController.signal))
  void small.catch(() => {})
  assert.equal(budget.snapshot().global.current.fileBytes, 5)
  assert.equal(budget.snapshot().global.current.queued, 2)
  controller.abort()
  await compound
  assert.equal(budget.snapshot().global.current.fileBytes, 6)
  assert.equal(budget.snapshot().global.current.commands, 0)
  const admitted = await small
  t.after(() => admitted.release())
  admitted.release()
  held.release()
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('expiry of a compound waiter removes its file priority before later requests expire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const budget = new ResourceBudget({ commands: 1, files: 2, fileBytes: 10, queueTimeoutMs: 15 })
  const held = await budget.acquire(file('hold', 5))
  const controller = new AbortController()
  t.after(() => { controller.abort(); held.release() })
  const expired = assert.rejects(budget.acquire({ ...command('compound', 1, 1), inputBytes: 10 }), (error: ResourceBudgetError) => error.code === 'OC_RESOURCE_QUEUE_TIMEOUT')
  t.mock.timers.tick(5)
  const small = budget.acquire(file('later-small', 1, controller.signal))
  void small.catch(() => {})
  assert.equal(budget.snapshot().global.current.fileBytes, 5)
  t.mock.timers.tick(10)
  await expired
  assert.equal(budget.snapshot().global.current.fileBytes, 6)
  const admitted = await small
  t.after(() => admitted.release())
  admitted.release()
  held.release()
  assert.equal(budget.snapshot().global.queueTimeouts, 1)
  assert.ok(Object.values(budget.snapshot().global.current).every(value => value === 0))
})

test('an I/O cleanup failure remains failed even when cancellation has already arrived', async () => {
  const budget = new ResourceBudget()
  const controller = new AbortController()
  const failure = new ResourceCleanupError('file', Object.assign(new Error('close failed'), { code: 'EIO' }))
  await assert.rejects(budget.run(file('closing', 1, controller.signal), async () => {
    controller.abort()
    throw new AggregateError([resourceAbortError(), failure])
  }), error => error instanceof AggregateError && error.errors[1] === failure)
  const state = budget.snapshot().global
  assert.equal(state.failed, 1)
  assert.equal(state.cancelled, 0)
  assert.equal(state.current.files, 0)
})

test('a failed branch cannot complete its owner while a sibling still holds a lease', async () => {
  const budget = new ResourceBudget()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let settled = false
  const failure = new ResourceCleanupError('file', Object.assign(new Error(), { code: 'EIO' }))
  const closing = settleResourceWork([
    budget.run(file('first'), async () => { throw resourceAbortError() }),
    budget.run(file('second'), async () => { entered.resolve(); await release.promise; throw failure })
  ])
  const rejected = assert.rejects(closing, error => {
    settled = true
    return error instanceof AggregateError && error.errors[1] === failure
  })
  await entered.promise
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(budget.snapshot().global.current.files, 1)
  release.resolve()
  await rejected
  assert.equal(budget.snapshot().global.current.files, 0)
})

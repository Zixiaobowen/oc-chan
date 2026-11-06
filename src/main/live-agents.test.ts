import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { AgentSnapshot } from '../shared/types'
import { SessionActivityReader } from './collectors/agent-activity'
import type { AgentDiscovery } from './collectors/agents'
import { LiveAgents } from './live-agents'
import { collectionResources, isResourceCleanupFailure, resourceAbortError } from './resource-budget'

// The project targets ES2022, before Promise.withResolvers is available in its lib.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function observations() {
  const events = new EventEmitter()
  const updates: AgentSnapshot[] = []
  return {
    updates,
    publish(snapshot: AgentSnapshot) { updates.push(snapshot); events.emit('update', snapshot) },
    next(predicate: (snapshot: AgentSnapshot) => boolean, from = updates.length): Promise<AgentSnapshot> {
      const existing = updates.slice(from).find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const onUpdate = (snapshot: AgentSnapshot) => {
          if (!predicate(snapshot)) return
          clearTimeout(timer)
          events.off('update', onUpdate)
          resolve(snapshot)
        }
        const timer = setTimeout(() => {
          events.off('update', onUpdate)
          reject(new Error('No matching live session update within 1500ms'))
        }, 1500)
        events.on('update', onUpdate)
      })
    },
  }
}

function discovery(files: string[], name = 'OMP'): AgentDiscovery {
  return {
    snapshot: {
      collectedAt: new Date().toISOString(), activeSubagentCount: null, sources: [],
      agents: files.map((_, i) => ({ id: `omp:session-${i}`, sessionId: `session-${i}`, name, runtime: 'OMP', kind: 'main', state: 'running', pid: 40 + i, source: 'owned test session' })),
    },
    sessions: files.map((file, i) => ({ file, sessionId: `session-${i}` })),
  }
}

function tool(name: string, id = name): string {
  return `${JSON.stringify({ type: 'custom', customType: 'tool_execution_start', timestamp: new Date().toISOString(), data: { toolName: name, toolCallId: id } })}\n`
}
const terminal = `${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } })}\n`

// The real fs.watch and bounded reader are used throughout; DI only holds a read
// after its actual I/O to exercise ordering, or raises a watcher OS error.
// These integration cases exercise native fs.watch delivery and its 90ms window;
// fake clocks cannot advance the kernel's file notifications. Waits are event driven.
test('real append pushes within the discovery interval and bursts deliver the final activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  const seen = observations()
  let discoveries = 0
  const live = new LiveAgents(seen.publish, { discover: async () => { discoveries++; return discovery([file]) } })
  t.after(async () => { await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', 0)
  const from = seen.updates.length
  const start = Date.now()
  await appendFile(file, tool('read'))
  await seen.next(snapshot => snapshot.agents[0].activity?.name === 'read', from)
  assert.ok(Date.now() - start < 1500, 'append must not wait for 2s discovery')
  assert.equal(discoveries, 1)
  const completed = seen.updates.length
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendFile(file, tool(`tool${i}`))))
  await appendFile(file, terminal)
  await seen.next(snapshot => !snapshot.agents[0].activity && snapshot.sources.at(-1)?.state === 'ok', completed)
  assert.equal(discoveries, 1)
})

test('an in-flight session retains later events, does not block other files, and merges into newest discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-race-'))
  const files = [join(directory, 'slow.jsonl'), join(directory, 'fast.jsonl')]
  await Promise.all(files.map(file => writeFile(file, '')))
  const entered = deferred<void>()
  const release = deferred<void>()
  const seen = observations()
  let hold = false
  let name = 'before'
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(files, name),
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path: string, now?: number, signal?: AbortSignal) {
        const result = await reader.read(path, now, signal)
        if (hold && path === files[0]) { hold = false; entered.resolve(); await release.promise }
        return result
      } }
    },
  })
  t.after(async () => { release.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', 0)
  hold = true
  await appendFile(files[0], tool('first'))
  await entered.promise
  const from = seen.updates.length
  await appendFile(files[0], terminal + tool('latest'))
  await appendFile(files[1], tool('independent'))
  await seen.next(snapshot => snapshot.agents[1].activity?.name === 'independent', from)
  name = 'after'
  await live.reconcile()
  release.resolve()
  const latest = await seen.next(snapshot => snapshot.agents[0].activity?.name === 'latest', from)
  assert.equal(latest.agents[0].name, 'after')
  assert.equal(latest.agents[1].activity?.name, 'independent')
})

test('parent cancellation and stop close watchers and cancel pending reads and discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-stop-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  const entered = deferred<void>()
  const release = deferred<void>()
  const seen = observations()
  let closed = 0
  const lifetime = new AbortController()
  let readSignal: AbortSignal | undefined
  const live = new LiveAgents(seen.publish, {
    signal: lifetime.signal,
    discover: async () => discovery([file]),
    watchFile: (path, listener) => {
      const watcher = watch(path, listener)
      watcher.on('close', () => { closed++ })
      return watcher
    },
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path: string, now?: number, signal?: AbortSignal) {
        readSignal = signal
        const result = await reader.read(path, now, signal)
        entered.resolve()
        await release.promise
        return result
      } }
    },
  })
  t.after(async () => { release.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await entered.promise
  await appendFile(file, tool('pending'))
  lifetime.abort()
  assert.equal(readSignal?.aborted, true)
  const count = seen.updates.length
  release.resolve()
  await live.stop()
  assert.equal(seen.updates.length, count)
  assert.equal(closed, 1)
  const discoveryGate = deferred<AgentDiscovery>()
  let discoverySignal: AbortSignal | undefined
  const another = new LiveAgents(seen.publish, { discover: signal => { discoverySignal = signal; return discoveryGate.promise } })
  const work = another.reconcile()
  const stopping = another.stop()
  assert.equal(discoverySignal?.aborted, true)
  discoveryGate.resolve(discovery([file]))
  await Promise.all([work, stopping])
  assert.equal(seen.updates.length, count)
})

test('watcher errors clear activity and surface source error until normal discovery reattaches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-error-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('read'))
  const seen = observations()
  let watcher: FSWatcher | undefined
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery([file]),
    watchFile: (path, listener) => { watcher = watch(path, listener); return watcher },
  })
  t.after(async () => { await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.agents[0].activity?.name === 'read', 0)
  const from = seen.updates.length
  watcher!.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }))
  const failed = await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'error', from)
  assert.equal(failed.agents[0].activity, undefined)
  assert.match(failed.sources.at(-1)!.detail, /EACCES/)
  const retry = seen.updates.length
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', retry)
})

test('replacement inode is reported and normal discovery binds the new file for later appends', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-inode-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('old'))
  const seen = observations()
  const live = new LiveAgents(seen.publish, { discover: async () => discovery([file]) })
  t.after(async () => { await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.agents[0].activity?.name === 'old', 0)
  const from = seen.updates.length
  await rename(file, `${file}.old`)
  await writeFile(file, terminal)
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'error', from)
  await live.reconcile()
  await seen.next(snapshot => /文件被截断或替换/.test(snapshot.sources.at(-1)!.detail), from)
  const rebound = seen.updates.length
  await appendFile(file, tool('new'))
  const updated = await seen.next(snapshot => snapshot.agents[0].activity?.name === 'new', rebound)
  assert.equal(updated.sources.at(-1)?.state, 'ok')
})

test('a real read failure is surfaced even when the watch remains attached', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-read-error-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  const seen = observations()
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery([file]),
    createReader: () => {
      const reader = new SessionActivityReader()
      return { read: () => reader.read(join(directory, 'missing.jsonl')) }
    },
  })
  t.after(async () => { await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  const failed = await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'error', 0)
  assert.match(failed.sources.at(-1)!.detail, /ENOENT/)
  assert.equal(failed.agents[0].activity, undefined)
})

test('session removal cancels queued activity IO before capacity becomes available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r01-live-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('pending'))
  const release = deferred<void>()
  const ready = deferred<void>()
  let opened = 0
  const holding = Promise.all(Array.from({ length: 8 }, () => collectionResources.run({ source: 'agent-test-live', kind: 'file', bytes: 0 }, async () => {
    const handle = await open(file, 'r')
    try {
      if (++opened === 8) ready.resolve()
      await release.promise
    } finally { await handle.close() }
  })))
  const entered = deferred<void>()
  const cancelled = deferred<void>()
  const seen = observations()
  let present = true
  let readSignal: AbortSignal | undefined
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(present ? [file] : []),
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path: string, now?: number, signal?: AbortSignal) {
        readSignal = signal
        entered.resolve()
        try { return await reader.read(path, now, signal) }
        catch (error) {
          assert.equal((error as Error).name, 'AbortError')
          cancelled.resolve()
          throw error
        }
      } }
    },
  })
  t.after(async () => { release.resolve(); await live.stop(); await holding; await rm(directory, { recursive: true, force: true }) })
  await ready.promise
  await live.reconcile()
  await entered.promise
  present = false
  await live.reconcile()
  await cancelled.promise
  assert.equal(readSignal?.aborted, true)
  assert.equal(seen.updates.at(-1)?.agents.length, 0)
  const count = seen.updates.length
  release.resolve()
  await holding
  assert.equal(seen.updates.length, count)
})

function assertDrained(live: LiveAgents): void {
  assert.deepEqual(live.diagnostics(), { stopped: true, pendingDiscovery: false, pendingReads: 0, watchers: 0, timers: 0, closing: 0 })
}

test('100 start/stop cycles await actual watchers and reads, remove listeners and reuse the stop promise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-cycles-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const lifetime = new AbortController()
  for (let cycle = 0; cycle < 100; cycle++) {
    const readFinished = deferred<void>()
    let watcher!: FSWatcher
    const live = new LiveAgents(() => {}, {
      signal: lifetime.signal,
      discover: async () => discovery([file]),
      watchFile: (path, listener) => { watcher = watch(path, listener); return watcher },
      createReader: () => {
        const reader = new SessionActivityReader()
        return { async read(path, now, signal) {
          try { return await reader.read(path, now, signal) }
          finally { readFinished.resolve() }
        } }
      },
    })
    try {
      await live.reconcile()
      assert.equal(getEventListeners(lifetime.signal, 'abort').length, 1)
      assert.equal(live.diagnostics().watchers, 1)
      assert.equal(live.diagnostics().timers, 1)
      assert.equal(JSON.stringify(live.diagnostics()).includes(file), false)
      t.mock.timers.tick(90)
      await readFinished.promise
      const stopping = live.stop()
      assert.equal(live.stop(), stopping)
      await stopping
      assert.equal(live.stop(), stopping)
      assertDrained(live)
      assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
      assert.equal(watcher.listenerCount('change'), 0)
      assert.equal(watcher.listenerCount('error'), 0)
      assert.equal(watcher.listenerCount('close'), 0)
      assert.equal(collectionResources.snapshot().global.current.files, 0)
      assert.equal(collectionResources.snapshot().global.current.fileBytes, 0)
    } finally { await live.stop() }
  }
})

test('stop waits for a cancelled real file read to settle and publishes no late result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-read-stop-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('late'))
  const probe = await open(file, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  const entered = deferred<void>()
  const release = deferred<void>()
  let captured: typeof probe | undefined
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    captured = this
    entered.resolve()
    await release.promise
    return Reflect.apply(original, this, args)
  })
  const seen = observations()
  const live = new LiveAgents(seen.publish, { discover: async () => discovery([file]) })
  t.after(async () => { release.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await entered.promise
  const published = seen.updates.length
  let settled = false
  const stopping = live.stop()
  void stopping.then(() => { settled = true })
  assert.equal(live.diagnostics().stopped, true)
  assert.equal(live.diagnostics().timers, 0)
  assert.equal(live.diagnostics().pendingReads, 1)
  await nextTurn()
  assert.equal(settled, false)
  release.resolve()
  await stopping
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assert.equal(seen.updates.length, published)
  assertDrained(live)
  assert.equal(collectionResources.snapshot().global.current.files, 0)
})

test('removed entries remain tracked until their real watcher closes and stop waits for them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-retired-'))
  const files = [join(directory, 'healthy.jsonl'), join(directory, 'removed.jsonl')]
  await Promise.all(files.map(file => writeFile(file, '')))
  const closeRequested = deferred<void>()
  const allowClose = deferred<void>()
  const seen = observations()
  let present = true
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(present ? files : [files[0]]),
    watchFile: (path, listener) => {
      const watcher = watch(path, listener)
      if (path === files[1]) {
        const close = watcher.close.bind(watcher)
        watcher.close = () => { closeRequested.resolve(); void allowClose.promise.then(close) }
      }
      return watcher
    },
  })
  t.after(async () => { allowClose.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', 0)
  present = false
  const removing = live.reconcile()
  await closeRequested.promise
  assert.equal(live.diagnostics().closing, 1)
  assert.equal(live.diagnostics().watchers, 2)
  const stopping = live.stop()
  let settled = false
  void stopping.then(() => { settled = true })
  await nextTurn()
  assert.equal(settled, false)
  assert.equal(live.diagnostics().watchers, 1)
  allowClose.resolve()
  await Promise.all([removing, stopping])
  assertDrained(live)
})

test('a failed watcher drains before reattachment while a healthy session still publishes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-reattach-'))
  const files = [join(directory, 'healthy.jsonl'), join(directory, 'failed.jsonl')]
  await Promise.all(files.map(file => writeFile(file, '')))
  const allowClose = deferred<void>()
  const closeRequested = deferred<void>()
  let failed!: FSWatcher
  let created = 0
  const seen = observations()
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(files),
    watchFile: (path, listener) => {
      created++
      const watcher = watch(path, listener)
      if (path === files[1] && !failed) {
        failed = watcher
        const close = watcher.close.bind(watcher)
        watcher.close = () => { closeRequested.resolve(); void allowClose.promise.then(close) }
      }
      return watcher
    },
  })
  t.after(async () => { allowClose.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', 0)
  failed.emit('error', Object.assign(new Error('watch failed'), { code: 'EIO' }))
  await closeRequested.promise
  const retry = live.reconcile()
  const from = seen.updates.length
  await appendFile(files[0], tool('healthy'))
  await seen.next(snapshot => snapshot.agents[0].activity?.name === 'healthy', from)
  assert.equal(created, 2)
  assert.equal(live.diagnostics().watchers, 2)
  assert.equal(live.diagnostics().closing, 1)
  allowClose.resolve()
  await retry
  assert.equal(created, 3)
  assert.equal(live.diagnostics().watchers, 2)
  await live.stop()
  assertDrained(live)
})

test('pending discovery cancellation is expected but a non-abort failure rejects the retained stop promise', async () => {
  for (const error of [resourceAbortError(), new Error('discovery cleanup failed')]) {
    const gate = deferred<AgentDiscovery>()
    const seen = observations()
    let signal: AbortSignal | undefined
    const live = new LiveAgents(seen.publish, { discover: activeSignal => { signal = activeSignal; return gate.promise } })
    const discovering = assert.rejects(live.reconcile(), cause => cause === error)
    const stopping = live.stop()
    assert.equal(live.stop(), stopping)
    assert.equal(signal?.aborted, true)
    assert.equal(live.diagnostics().pendingDiscovery, true)
    gate.reject(error)
    await discovering
    if (error.name === 'AbortError') await stopping
    else {
      await assert.rejects(stopping, (failure: unknown) => failure instanceof AggregateError && failure.errors[0] === error)
      await assert.rejects(live.stop(), (failure: unknown) => failure instanceof AggregateError && failure.errors[0] === error)
    }
    assert.equal(seen.updates.length, 0)
    assertDrained(live)
  }
})

test('watcher close failures survive parent cancellation after every actual watcher has closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-watch-close-'))
  const files = [join(directory, 'failed.jsonl'), join(directory, 'healthy.jsonl')]
  await Promise.all(files.map(file => writeFile(file, '')))
  const closeFailure = new Error('native watcher close failed')
  const lifetime = new AbortController()
  let closed = 0
  const live = new LiveAgents(() => {}, {
    signal: lifetime.signal,
    discover: async () => discovery(files),
    watchFile: (path, listener) => {
      const watcher = watch(path, listener)
      watcher.once('close', () => { closed++ })
      if (path === files[0]) {
        const close = watcher.close.bind(watcher)
        watcher.close = () => { close(); throw closeFailure }
      }
      return watcher
    },
  })
  t.after(async () => { await assert.rejects(live.stop(), isResourceCleanupFailure); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  lifetime.abort()
  // Give the parent-signal observer a turn before anyone explicitly awaits stop().
  await nextTurn()
  const stopping = live.stop()
  await assert.rejects(stopping, isResourceCleanupFailure)
  assert.equal(live.stop(), stopping)
  assert.equal(closed, 2)
  assertDrained(live)
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
})

test('real file close failure is retained without blocking healthy activity or leaking the descriptor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-file-close-'))
  const files = [join(directory, 'failed.jsonl'), join(directory, 'healthy.jsonl')]
  await Promise.all(files.map(file => writeFile(file, tool('read'))))
  const probe = await open(files[0], 'r')
  const badInode = (await probe.stat()).ino
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  let captured: typeof probe | undefined
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    if (!captured && (await this.stat()).ino === badInode) {
      captured = this
      const close = this.close.bind(this)
      this.close = async () => { await close(); throw new Error('file close failed') }
    }
    return Reflect.apply(original, this, args)
  })
  const seen = observations()
  const live = new LiveAgents(seen.publish, { discover: async () => discovery(files) })
  t.after(async () => { await assert.rejects(live.stop(), isResourceCleanupFailure); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'error' && snapshot.agents[1].activity?.name === 'read', 0)
  await assert.rejects(live.stop(), isResourceCleanupFailure)
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assertDrained(live)
  assert.equal(collectionResources.snapshot().global.current.files, 0)
  assert.equal(collectionResources.snapshot().global.current.fileBytes, 0)
})

test('abort cannot mask a real file close failure while an activity read is in flight', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-r03-abort-close-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('pending'))
  const probe = await open(file, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const original = prototype.read
  await probe.close()
  const entered = deferred<void>()
  const release = deferred<void>()
  let captured: typeof probe | undefined
  t.mock.method(prototype, 'read', async function (this: typeof probe, ...args: unknown[]) {
    captured = this
    const close = this.close.bind(this)
    this.close = async () => { await close(); throw new Error('close failed during abort') }
    entered.resolve()
    await release.promise
    return Reflect.apply(original, this, args)
  })
  const live = new LiveAgents(() => {}, { discover: async () => discovery([file]) })
  t.after(async () => { release.resolve(); await assert.rejects(live.stop(), isResourceCleanupFailure); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await entered.promise
  const stopped = assert.rejects(live.stop(), isResourceCleanupFailure)
  release.resolve()
  await stopped
  assert.ok(captured)
  await assert.rejects(captured.stat(), { code: 'EBADF' })
  assertDrained(live)
  assert.equal(collectionResources.snapshot().global.current.files, 0)
  assert.equal(collectionResources.snapshot().global.current.fileBytes, 0)
})

test('128 completed session reads publish one batch and retain unchanged agent objects', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-p02-batch-'))
  const files = Array.from({ length: 128 }, (_, index) => join(directory, `${index}.jsonl`))
  await Promise.all(files.map(file => writeFile(file, '')))
  const seen = observations()
  const entered = deferred<void>()
  const release = deferred<void>()
  let hold = false
  let readers = 0
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(files),
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path, now, signal) {
        const result = await reader.read(path, now, signal)
        if (hold) {
          if (++readers === files.length) entered.resolve()
          await release.promise
        }
        return result
      } }
    },
  })
  t.after(async () => { release.resolve(); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'ok', 0)
  hold = true
  const from = seen.updates.length
  await Promise.all(files.map(file => appendFile(file, tool('batched'))))
  await entered.promise
  hold = false
  release.resolve()
  const batch = await seen.next(snapshot => snapshot.agents.every(agent => agent.activity?.name === 'batched'), from)
  assert.equal(seen.updates.length - from, 1)
  await live.reconcile()
  assert.equal(seen.updates.at(-1)!.agents[1], batch.agents[1])
  const clearing = seen.updates.length
  await appendFile(files[0], terminal)
  const cleared = await seen.next(snapshot => !snapshot.agents[0].activity, clearing)
  assert.equal(cleared.agents[1], batch.agents[1])
  assert.equal(cleared.agents[127], batch.agents[127])
})

test('later read completions cannot extend the first publication deadline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-p02-deadline-'))
  const files = [join(directory, 'first.jsonl'), join(directory, 'second.jsonl')]
  await Promise.all(files.map(file => writeFile(file, tool('active'))))
  const ready = files.map(() => deferred<void>())
  const release = files.map(() => deferred<void>())
  const seen = observations()
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery(files),
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path, now, signal) {
        const result = await reader.read(path, now, signal)
        const index = files.indexOf(path)
        ready[index].resolve()
        await release[index].promise
        return result
      } }
    },
  })
  t.after(async () => { release.forEach(gate => gate.resolve()); await live.stop(); await rm(directory, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await live.reconcile()
  const initial = seen.updates.length
  t.mock.timers.tick(90)
  await Promise.all(ready.map(gate => gate.promise))
  release[0].resolve()
  await nextTurn()
  t.mock.timers.tick(8)
  release[1].resolve()
  await nextTurn()
  t.mock.timers.tick(8)
  assert.equal(seen.updates.length, initial + 1)
  assert.deepEqual(seen.updates.at(-1)!.agents.map(agent => agent.activity?.name), ['active', 'active'])
})

test('stopping or removing a session cancels its completed but unpublished batch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-p02-cancel-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, tool('retired'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const action of ['stop', 'remove'] as const) {
    let present = true
    const finished = deferred<void>()
    const seen = observations()
    const live = new LiveAgents(seen.publish, {
      discover: async () => discovery(present ? [file] : []),
      createReader: () => {
        const reader = new SessionActivityReader()
        return { async read(path, now, signal) {
          try { return await reader.read(path, now, signal) }
          finally { finished.resolve() }
        } }
      },
    })
    try {
      await live.reconcile()
      t.mock.timers.tick(90)
      await finished.promise
      await nextTurn()
      assert.equal(live.diagnostics().pendingReads, 0)
      assert.equal(seen.updates.at(-1)!.agents[0].activity, undefined)
      if (action === 'stop') await live.stop()
      else { present = false; await live.reconcile(); assert.equal(seen.updates.at(-1)!.agents.length, 0) }
      const count = seen.updates.length
      t.mock.timers.tick(1000)
      assert.equal(seen.updates.length, count)
    } finally { await live.stop() }
    assertDrained(live)
  }
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSnapshot } from '../shared/types'
import { SessionActivityReader } from './collectors/agent-activity'
import type { AgentDiscovery } from './collectors/agents'
import { LiveAgents } from './live-agents'

// The project targets ES2022, before Promise.withResolvers is available in its lib.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
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
  t.after(async () => { live.stop(); await rm(directory, { recursive: true, force: true }) })
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
      return { async read(path: string) {
        const result = await reader.read(path)
        if (hold && path === files[0]) { hold = false; entered.resolve(); await release.promise }
        return result
      } }
    },
  })
  t.after(async () => { release.resolve(); live.stop(); await rm(directory, { recursive: true, force: true }) })
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

test('stop closes watchers and suppresses a pending read and pending discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-chan-live-stop-'))
  const file = join(directory, 'session.jsonl')
  await writeFile(file, '')
  const entered = deferred<void>()
  const release = deferred<void>()
  const seen = observations()
  let closed = 0
  const live = new LiveAgents(seen.publish, {
    discover: async () => discovery([file]),
    watchFile: (path, listener) => {
      const watcher = watch(path, listener)
      watcher.on('close', () => { closed++ })
      return watcher
    },
    createReader: () => {
      const reader = new SessionActivityReader()
      return { async read(path: string) { const result = await reader.read(path); entered.resolve(); await release.promise; return result } }
    },
  })
  t.after(async () => { release.resolve(); live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  await entered.promise
  await appendFile(file, tool('pending'))
  live.stop()
  const count = seen.updates.length
  release.resolve()
  // Observe silence across two real coalescing windows after releasing pending I/O.
  await delay(180)
  assert.equal(seen.updates.length, count)
  assert.equal(closed, 1)
  const discoveryGate = deferred<AgentDiscovery>()
  const another = new LiveAgents(seen.publish, { discover: () => discoveryGate.promise })
  const work = another.reconcile()
  another.stop()
  discoveryGate.resolve(discovery([file]))
  await work
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
  t.after(async () => { live.stop(); await rm(directory, { recursive: true, force: true }) })
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
  t.after(async () => { live.stop(); await rm(directory, { recursive: true, force: true }) })
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
  t.after(async () => { live.stop(); await rm(directory, { recursive: true, force: true }) })
  await live.reconcile()
  const failed = await seen.next(snapshot => snapshot.sources.at(-1)?.state === 'error', 0)
  assert.match(failed.sources.at(-1)!.detail, /ENOENT/)
  assert.equal(failed.agents[0].activity, undefined)
})
